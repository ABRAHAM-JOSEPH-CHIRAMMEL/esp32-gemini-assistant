
import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

// ======================================================
// SERVER CONFIGURATION
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
// SAME-ORIGIN BROWSER CONFIGURATION
// ======================================================

// The simulator and API are hosted on the same Render
// website. Browser requests to this same origin do not
// require CORS middleware.

app.use(express.static(PUBLIC_DIR));

// ======================================================
// REQUEST RATE LIMITING
// ======================================================

const requestCounts = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  const ip = req.ip || req.socket.remoteAddress || "unknown";

  let record = requestCounts.get(ip);

  if (!record || now - record.start > windowMs) {
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
      error: "Too many requests. Please wait one minute and retry."
    });
  }

  // Prevent the in-memory map from growing indefinitely.
  if (requestCounts.size > 5000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start > windowMs) {
        requestCounts.delete(key);
      }
    }
  }

  next();
}

// ======================================================
// IMAGE UPLOAD CONFIGURATION
// ======================================================

// FIX: Increased fields and parts limits.
// The simulator may send the image, prompt and other
// form fields in the same multipart request.

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 15,
    parts: 20,
    fieldSize: MAX_PROMPT_LENGTH
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
// No additional npm package required.
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
// PERMANENT GEMINI INSTRUCTION
// This instruction is automatically applied to every scan.
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

Question statement, if readable.

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
      error: "Device authentication is not configured on Render."
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
    browserRoute: "/api/browser-solve",
    deviceRoute: "/api/solve"
  });
});

// ======================================================
// GEMINI IMAGE PROCESSING
// ======================================================

async function processImage(req, res) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "GEMINI_API_KEY is missing from Render environment variables."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image received. Please select a question-paper image."
      });
    }

    const detectedType = detectImageType(req.file.buffer);

    if (
      !detectedType ||
      detectedType !== req.file.mimetype
    ) {
      return res.status(415).json({
        success: false,
        error: "The uploaded image is invalid or unsupported."
      });
    }

    // Optional extra user instruction.
    // The permanent instruction is always applied regardless.

    const additionalPrompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";

    if (additionalPrompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: "Additional instruction is too long."
      });
    }

    const finalPrompt =
      DEFAULT_GEMINI_PROMPT +
      (
        additionalPrompt
          ? "\n\nADDITIONAL USER INSTRUCTIONS:\n" +
            additionalPrompt
          : ""
      );

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    console.log("Starting question-paper scan:", {
      model: MODEL,
      imageType: detectedType,
      imageSize: req.file.size
    });

    const result = await ai.models.generateContent({
      model: MODEL,

      contents: [
        {
          role: "user",
          parts: [
            {
              text: finalPrompt
            },
            {
              inlineData: {
                mimeType: detectedType,
                data: req.file.buffer.toString("base64")
              }
            }
          ]
        }
      ],

      config: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2
      }
    });

    const answer = result.text || "";

    if (!answer.trim()) {
      return res.status(502).json({
        success: false,
        error: "Gemini returned an empty answer."
      });
    }

    const finishReason =
      result.candidates?.[0]?.finishReason || null;

    console.log("Gemini scan completed:", {
      model: MODEL,
      answerCharacters: answer.length,
      finishReason
    });

    return res.json({
      success: true,
      answer,
      model: MODEL,
      finishReason
    });

  } catch (error) {
    const status = Number(
      error?.status ||
      error?.statusCode ||
      error?.code ||
      0
    );

    console.error(
      "Gemini processing error:",
      status,
      error?.message || error
    );

    if (status === 429) {
      return res.status(429).json({
        success: false,
        error: "Gemini quota or rate limit reached. Wait and retry."
      });
    }

    if (status === 503 || status === 502) {
      return res.status(503).json({
        success: false,
        error: "Gemini is temporarily unavailable or overloaded. Please retry."
      });
    }

    if (status === 401 || status === 403) {
      return res.status(status).json({
        success: false,
        error: "Gemini authentication or permission error. Check Render environment variables."
      });
    }

    return res.status(502).json({
      success: false,
      error: "AI processing failed. Check Render logs."
    });
  }
}

// ======================================================
// BROWSER SIMULATOR ROUTE
// No DEVICE_TOKEN required.
// ======================================================

app.post(
  "/api/browser-solve",
  rateLimit,
  upload.single("image"),
  processImage
);

// ======================================================
// PHYSICAL ESP32 ROUTE
// DEVICE_TOKEN REQUIRED.
// ======================================================

app.post(
  "/api/solve",
  rateLimit,
  authenticateDevice,
  upload.single("image"),
  processImage
);

// ======================================================
// ERROR HANDLING
// ======================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error(
    "Request error:",
    error?.message || error
  );

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Image exceeds the 5 MB upload limit."
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
// ROOT FALLBACK
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
  console.log("Multipart limits: 1 image, 15 fields, 20 total parts.");
  console.log("Same-origin browser requests: CORS not required.");
});
