
import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

// ======================================================
// CONFIGURATION
// ======================================================

const app = express();

const PORT = process.env.PORT || 10000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 16000;

const MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const MAX_OUTPUT_TOKENS = Number(
  process.env.MAX_OUTPUT_TOKENS || 8192
);

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// ======================================================
// SAME-ORIGIN STATIC WEBSITE
// ======================================================

app.use(express.static(PUBLIC_DIR));

// Browser simulator and API use the same Render origin.
// CORS middleware is not required for same-origin requests.

// ======================================================
// RATE LIMITING
// ======================================================

const requestCounts = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 60000;
  const maxRequests = 10;

  const ip = req.ip || "unknown";

  let record = requestCounts.get(ip);

  if (!record || now - record.start >= windowMs) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count++;
  requestCounts.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait and retry."
    });
  }

  if (requestCounts.size > 5000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start >= windowMs) {
        requestCounts.delete(key);
      }
    }
  }

  next();
}

// ======================================================
// MULTIPART IMAGE UPLOAD
// IMPORTANT: NO PARTS OR FIELDS LIMIT
// ======================================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1

    // Intentionally no "parts" limit.
    // Intentionally no "fields" limit.
    // This prevents LIMIT_PART_COUNT errors caused
    // by the simulator sending additional form fields.
  },

  fileFilter(req, file, callback) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(
        new Error("Only JPG, PNG and WEBP images are accepted.")
      );
    }

    callback(null, true);
  }
});

// ======================================================
// IMAGE SIGNATURE VALIDATION
// ======================================================

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  // JPEG
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  // PNG
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a
      ])
    )
  ) {
    return "image/png";
  }

  // WEBP
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

// ======================================================
// PERMANENT DEFAULT GEMINI INSTRUCTION
// ======================================================

const DEFAULT_GEMINI_PROMPT = `
You are an expert educational assistant specialising in
engineering subjects and university examination question papers.

YOUR TASK:

Read the uploaded study question paper carefully.
Identify every visible question and provide accurate,
detailed, examination-ready educational answers.

1. COMPLETE QUESTION PAPER

- Examine the entire uploaded image.
- Identify every readable question.
- Preserve original question numbers.
- Preserve module numbers and subquestion labels.
- Answer every question in the original order.
- Answer BOTH sides of every OR alternative.
- Do not skip questions at the bottom of the image.
- Do not combine separate questions.
- Do not invent unreadable text.
- Explicitly identify unclear questions.

2. EXAMINATION-READY ANSWERS

Provide detailed answers appropriate to the marks allotted.

Include relevant:
- Definitions
- Principles
- Explanations
- Formulas
- Derivations
- Diagrams or clear diagram descriptions
- Applications
- Advantages and disadvantages
- Comparisons
- Important technical points

Cover relevant marking points as completely as possible.
Do not guarantee a particular examination score.

3. NUMERICAL PROBLEMS

For every numerical problem, provide:

- Given data
- Required quantity
- Relevant formula
- Explanation of the formula
- Substitution of values
- Step-by-step calculations
- Correct units
- Clearly identified final answer

Never skip calculation steps.

4. MATHEMATICAL DERIVATIONS

For every derivation:

- State the required result.
- Begin with the correct principle or equation.
- State assumptions where necessary.
- Show intermediate mathematical steps.
- Explain important transformations.
- Do not jump directly to the final result.
- Clearly identify the final derived expression.

5. MATHEMATICAL FORMATTING

Use standard LaTeX mathematical notation.

Use \\( ... \\) for inline equations.
Use $$ ... $$ for displayed equations.

Use proper LaTeX commands for:
- Greek letters
- Fractions
- Integrals
- Summations
- Vectors
- Subscripts
- Superscripts
- Matrices
- Derivatives

Examples:

\\alpha
\\beta
\\lambda
\\psi
\\theta
\\pi
\\Delta
\\frac{a}{b}
\\int
\\sum
\\vec{E}
\\beta_{phase}

Never spell a Greek symbol as an English word inside an equation.

Write \\beta_{phase}, NOT beta_phase.

Keep mathematical expressions accurate.
Do not omit derivation steps.

6. OLED DISPLAY COMPATIBILITY

The physical display is a small 0.91-inch
128 x 32 pixel OLED.

It can display approximately four text lines at a time.

Therefore:

- Use short, readable lines.
- Break long explanations into logical sections.
- Break long equations into smaller steps.
- Avoid excessively wide tables.
- Avoid unnecessary decorative symbols.
- Preserve question numbers.
- Keep formulas understandable.
- Do not remove important content merely to fit the display.
- Do not assume every Unicode or LaTeX character
  is supported by the physical OLED font.

The firmware is responsible for wrapping and scrolling.
The answer must retain its complete educational meaning.

7. ANSWER ORGANISATION

Use this structure where appropriate:

MODULE / SECTION

Question number

Question label only; do not reproduce the full question statement.

Answer:

Definition / Principle:

Explanation:

Formula:

Derivation / Calculation:

Final result:

Repeat for every question in the original order.

8. COMPLETENESS CHECK

Before finishing:

- Check every visible question.
- Check every subquestion.
- Check both OR alternatives.
- Check numerical calculations.
- Check derivation steps.
- Check mathematical notation.
- Identify unreadable questions.

Never claim that all questions are answered
if any readable question remains unanswered.

9. OUTPUT LENGTH

Prioritise complete answers over short summaries.

Do not intentionally shorten answers to save tokens.

If the response reaches its output limit:
- State the last completely answered question.
- Identify the next unanswered question.
- Clearly indicate that continuation is required.

Do not pretend that an incomplete response is complete.

Provide accurate, detailed and technically sound answers.
`;

// ======================================================
// DEVICE TOKEN AUTHENTICATION
// ======================================================

function tokenMatches(given, expected) {
  if (
    typeof given !== "string" ||
    typeof expected !== "string"
  ) {
    return false;
  }

  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

function authenticateDevice(req, res, next) {
  const expectedToken = process.env.DEVICE_TOKEN;
  const suppliedToken = req.get("x-device-token");

  if (!expectedToken) {
    return res.status(503).json({
      success: false,
      error: "Device authentication is not configured."
    });
  }

  if (!tokenMatches(suppliedToken, expectedToken)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized device."
    });
  }

  next();
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    service: "ESP32 Gemini Study Assistant",
    model: MODEL,
    permanentPrompt: true,
    multipartPartsLimit: "unrestricted",
    browserRoute: "/api/browser-solve",
    deviceRoute: "/api/solve"
  });
});

// ======================================================
// GEMINI IMAGE PROCESSING
// ======================================================

async function processImage(req, res) {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success:false, error:"GEMINI_API_KEY is missing from Render." });
    if (!req.file) return res.status(400).json({ success:false, error:"No image received. Please select an image." });
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType || detectedType !== req.file.mimetype) return res.status(415).json({ success:false, error:"Invalid or unsupported image file." });
    const additionalPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (additionalPrompt.length > MAX_PROMPT_LENGTH) return res.status(400).json({ success:false, error:"Additional instruction is too long." });
    const ai = new GoogleGenAI({ apiKey:process.env.GEMINI_API_KEY });
    const imagePart = { inlineData:{ mimeType:detectedType, data:req.file.buffer.toString("base64") } };
    const callGemini = async (parts, tokenLimit=MAX_OUTPUT_TOKENS) => ai.models.generateContent({
      model:MODEL, contents:[{ role:"user", parts }], config:{ maxOutputTokens:tokenLimit, temperature:0.2 }
    });
    const parseJson = (raw) => {
      const value=String(raw||"").replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/ ,"").trim();
      const first=value.indexOf("{"), last=value.lastIndexOf("}");
      if(first<0||last<=first) throw new Error("Gemini did not return valid JSON for the question audit.");
      return JSON.parse(value.slice(first,last+1));
    };
    console.log("Starting complete-paper pipeline",{model:MODEL,imageSize:req.file.size});
    // Stage 1: inventory all printed labels and OR alternatives before answering.
    const extractionPrompt = [
      "Inspect the ENTIRE uploaded examination paper, including every column, page region, subquestion and OR alternative.",
      "Return ONLY JSON: {\"questions\":[{\"label\":\"12(a)\",\"description\":\"short topic or readable question description\"}]}.",
      "List every distinct subquestion in original reading order. Preserve printed labels exactly.",
      "Include BOTH sides of every OR choice as separate entries. If both sides share a printed label, distinguish them by description.",
      "Do not answer questions. Do not invent unreadable text. Include visible labels even when the question text is partly unreadable.",
      "If no question can be identified, return {\"questions\":[]} ."
    ].join("\n");
    const extractionResult=await callGemini([{text:extractionPrompt},imagePart],2048);
    const extracted=parseJson(extractionResult.text||"");
    if(!Array.isArray(extracted.questions)||!extracted.questions.length) return res.status(422).json({success:false,error:"No readable question numbers were extracted. Upload a clearer, straight-on image.",stage:"extraction"});
    const questions=extracted.questions.map((q,i)=>({
      id:"Q"+(i+1), label:String(q?.label||"").trim(), description:String(q?.description||"").trim()
    })).filter(q=>q.label);
    if(!questions.length) return res.status(422).json({success:false,error:"Question extraction returned no usable question labels.",stage:"extraction"});
    const inventory=questions.map(q=>q.id+" | "+q.label+" | "+q.description).join("\n");
    // Stage 2: one combined, ordered answer-sheet generation.
    const answerPrompt=[
      DEFAULT_GEMINI_PROMPT,
      "MANDATORY INVENTORY-FIRST RULES:",
      "Answer EVERY inventory item below in this exact order. Include both OR alternatives and all subparts.",
      "Use the exact printed label as each heading. Where a label repeats for OR alternatives, append a short distinguishing descriptor.",
      "Do NOT reproduce the complete question statements. Give the answer only under each question label.",
      "For numericals show Given, Required, formula, substitution, calculations, units and final result.",
      "For derivations show assumptions, starting equation, intermediate steps and final expression.",
      "Use LaTeX delimiters \\( ... \\) inline and \\[ ... \\] for display equations. Do not omit important steps to fit the OLED; firmware handles paging.",
      "If the image is unclear, state this under that item; never guess.",
      "End with a compact checklist using the inventory IDs Q1, Q2, etc. Mark ANSWERED or UNREADABLE only when justified. If truncated, state the last completed ID and next pending ID.",
      "COMPLETE EXTRACTED INVENTORY (preserve order):\n"+inventory,
      additionalPrompt?"OPTIONAL USER GUIDANCE (cannot override completeness, accuracy or order):\n"+additionalPrompt:""
    ].filter(Boolean).join("\n\n");
    const answerResult=await callGemini([{text:answerPrompt},imagePart]);
    let answer=answerResult.text||"";
    if(!answer.trim()) return res.status(502).json({success:false,error:"Gemini returned an empty answer sheet.",stage:"answer"});
    let finishReason=answerResult.candidates?.[0]?.finishReason||null;
    // Continue a token-limited answer without repeating already completed sections.
    let continuationCount=0;
    while(finishReason==="MAX_TOKENS" && continuationCount<2){
      continuationCount++;
      const continuationPrompt=[
        "Continue the SAME combined answer sheet from exactly where the previous output stopped.",
        "Do not repeat any completed answer. Continue in the original inventory order and include every remaining item.",
        "If the previous output ended mid-answer, finish that answer first. Keep the exact printed labels and full numerical/derivation steps.",
        "INVENTORY:\\n"+inventory,
        "PREVIOUS ANSWER ENDING (context):\\n"+answer.slice(-14000)
      ].join("\\n\\n");
      const continuation=await callGemini([{text:continuationPrompt},imagePart]);
      const nextText=continuation.text||"";
      if(nextText.trim()) answer+="\\n\\n"+nextText;
      finishReason=continuation.candidates?.[0]?.finishReason||null;
      if(!nextText.trim()) break;
    }
    // Stage 3: independent audit against unique inventory IDs, not labels alone.
    const auditPrompt=[
      "Audit whether each inventory ID has a substantive answer in the answer sheet.",
      "Return ONLY JSON: {\"answered\":[\"Q1\"],\"missing\":[\"Q2\"],\"unclear\":[\"Q3\"]}.",
      "A checklist mention alone does not count as an answer. A substantive solution or explicit unreadable statement is required.",
      "Treat OR alternatives as separate IDs. Never infer an answer from a neighbouring question.",
      "INVENTORY:\n"+inventory,
      "ANSWER SHEET:\n"+answer
    ].join("\n\n");
    const auditResult=await callGemini([{text:auditPrompt}],2048);
    const audit=parseJson(auditResult.text||"");
    const answered=Array.isArray(audit.answered)?audit.answered.map(String):[];
    let missing=Array.isArray(audit.missing)?audit.missing.map(String):questions.map(q=>q.id);
    const unclear=Array.isArray(audit.unclear)?audit.unclear.map(String):[];
    // Stage 4: one repair pass for missing inventory IDs.
    let repairAttempted=false;
    if(missing.length){
      repairAttempted=true;
      const repairPrompt=[
        "Answer ONLY these missing inventory IDs. Do not repeat existing answers.",
        "Use the original uploaded paper. Preserve printed question labels and give complete exam-ready explanations, numerical steps and derivations.",
        "If the image does not provide enough readable information, say so explicitly rather than guessing.",
        "MISSING INVENTORY ITEMS:\n"+questions.filter(q=>missing.includes(q.id)).map(q=>q.id+" | "+q.label+" | "+q.description).join("\n"),
        "EXISTING ANSWER SHEET FOR CONTEXT:\n"+answer
      ].join("\n\n");
      const repairResult=await callGemini([{text:repairPrompt},imagePart]);
      const repairText=repairResult.text||"";
      if(repairText.trim()) answer+="\n\n--- COMPLETION OF MISSING QUESTIONS ---\n\n"+repairText;
      // Re-audit the repaired combined answer; repair attempt alone is not proof.
      const finalAuditPrompt=[
        "Re-audit the combined answer after repair. Return ONLY JSON: {\"answered\":[\"Q1\"],\"missing\":[\"Q2\"],\"unclear\":[\"Q3\"]}.",
        "Only count a substantive answer or an explicit unreadable statement. Checklist mentions alone do not count.",
        "INVENTORY:\\n"+inventory,
        "COMBINED ANSWER:\\n"+answer
      ].join("\\n\\n");
      const finalAudit=parseJson((await callGemini([{text:finalAuditPrompt}],2048)).text||"");
      missing=Array.isArray(finalAudit.missing)?finalAudit.missing.map(String):questions.map(q=>q.id);
    }
    const completenessVerified=missing.length===0 && unclear.length===0 && finishReason!=="MAX_TOKENS";
    console.log("Paper pipeline finished",{items:questions.length,missing:missing.length,unclear:unclear.length,characters:answer.length,finishReason,completenessVerified});
    return res.json({success:true,answer,model:MODEL,finishReason,questionCount:questions.length,questionNumbers:questions.map(q=>q.label),questionInventory:questions,answeredQuestions:answered,missingQuestions:missing,unclearQuestions:unclear,completenessVerified,auditPerformed:true,repairAttempted});
  } catch(error) {
    const status=Number(error?.status||error?.statusCode||error?.code||0);
    console.error("Gemini processing error:",status,error?.message||error);
    if(status===429) return res.status(429).json({success:false,error:"Gemini quota or rate limit reached. Wait and retry."});
    if(status===503||status===502) return res.status(503).json({success:false,error:"Gemini is temporarily unavailable. Please retry."});
    if(status===401||status===403) return res.status(status).json({success:false,error:"Gemini authentication error. Check Render environment variables."});
    return res.status(502).json({success:false,error:"AI processing failed: "+(error?.message||"Check Render logs.")});
  }
}

// ======================================================
// BROWSER SIMULATOR ROUTE
// No device token required.
// ======================================================

app.post(
  "/api/browser-solve",
  rateLimit,
  upload.single("image"),
  processImage
);

// ======================================================
// PHYSICAL ESP32 ROUTE
// Device token required.
// ======================================================

app.post(
  "/api/solve",
  rateLimit,
  authenticateDevice,
  upload.single("image"),
  processImage
);

// ======================================================
// UPLOAD ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error("Request error:", error?.message || error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Image exceeds the 5 MB upload limit."
      });
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        error: "Only one image can be uploaded at a time."
      });
    }

    return res.status(400).json({
      success: false,
      error: `Upload error: ${error.message}`
    });
  }

  return res.status(error.status || 400).json({
    success: false,
    error: error.message || "Request could not be processed."
  });
});

// ======================================================
// ROOT ROUTE
// ======================================================

app.get("/", (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, "index.html");

  if (fs.existsSync(indexFile)) {
    return res.sendFile(indexFile);
  }

  return res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
  console.log("Permanent study assistant prompt loaded.");
  console.log("Browser route: /api/browser-solve");
  console.log("ESP32 route: /api/solve");
  console.log("Multipart total-parts limit: REMOVED");
  console.log("Maximum image size: 5 MB");
});
