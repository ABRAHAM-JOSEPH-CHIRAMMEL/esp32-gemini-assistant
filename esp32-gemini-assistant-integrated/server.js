
import express from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();

const PORT = process.env.PORT || 10000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 2000;
const MAX_OUTPUT_TOKENS = Number(
  process.env.MAX_OUTPUT_TOKENS || 8192
);

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// CORS is deliberately not enabled here.
// The simulator and API are hosted on the SAME Render origin.
// Same-origin requests do not require CORS.
// The ESP32 HTTP client also does not require browser CORS.

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please wait and retry."
  }
});

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 1,
    parts: 2,
    fieldSize: MAX_PROMPT_LENGTH
  },

  fileFilter(req, file, callback) {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return callback(
        new Error("Only JPG, PNG and WEBP images are accepted.")
      );
    }

    callback(null, true);
  }
});

// ======================================================
// PERMANENT DEFAULT GEMINI INSTRUCTION
// Applied automatically to every image scan.
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
- Preserve the original question numbers.
- Preserve module numbers and subquestion labels.
- Answer every question in the original order.
- Answer BOTH sides of every OR alternative.
- Do not skip questions at the bottom of the image.
- Do not combine separate questions into one answer.
- Do not invent unreadable text.
- If a question is unclear, explicitly identify it.

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

Cover the relevant marking points as completely as possible.
Do not guarantee a particular examination score.

3. NUMERICAL PROBLEMS

For every numerical problem, provide:

- Given data
- Required quantity
- Relevant formula
- Formula explanation where necessary
- Substitution of values
- Step-by-step calculations
- Correct units
- Clearly highlighted final answer

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

Use this structure:

MODULE / SECTION

Question number

Question statement, if readable.

Answer:

Definition / Principle:

Explanation:

Formula:

Derivation / Calculation:

Final result:

Repeat this structure as appropriate for each question.

Keep the original question-paper order.

8. COMPLETENESS CHECK

Before finishing:

- Check every visible question.
- Check every subquestion.
- Check both OR alternatives.
- Check numerical calculations.
- Check derivation steps.
- Check mathematical notation.
- Identify any unreadable question.
- Never claim that all questions are answered
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
// Used only by the physical ESP32 endpoint.
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
// WEBSITE / SIMULATOR
// ======================================================

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    service: "ESP32 Gemini Study Assistant",
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    simulator: "same-origin",
    permanentPrompt: true
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
        error: "Gemini API key is not configured on Render."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image received. Please upload an image."
      });
    }

    // Verify the actual file signature.
    const detected = await fileTypeFromBuffer(req.file.buffer);

    if (
      !detected ||
      !ALLOWED_TYPES.has(detected.mime) ||
      detected.mime !== req.file.mimetype
    ) {
      return res.status(415).json({
        success: false,
        error: "Invalid or unsupported image file."
      });
    }

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

    // Permanent instruction is ALWAYS included.
    const finalPrompt =
      DEFAULT_GEMINI_PROMPT +
      (
        additionalPrompt
          ? "\n\nADDITIONAL USER INSTRUCTIONS:\n" +
            additionalPrompt
          : ""
      );

    const model =
      process.env.GEMINI_MODEL || "gemini-3.6-flash";

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY
    });

    console.log("Starting Gemini question-paper scan:", {
      model,
      imageType: detected.mime,
      imageSize: req.file.size
    });

    const result = await ai.models.generateContent({
      model,

      contents: [
        {
          text: finalPrompt
        },
        {
          inlineData: {
            mimeType: detected.mime,
            data: req.file.buffer.toString("base64")
          }
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
      model,
      answerCharacters: answer.length,
      finishReason
    });

    return res.json({
      success: true,
      answer,
      model,
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
// API ROUTES
// ======================================================

// Browser simulator:
// No DEVICE_TOKEN required.
// Uses same-origin requests from the Render website.

app.post(
  "/api/browser-solve",
  limiter,
  upload.single("image"),
  processImage
);

// Physical ESP32:
// DEVICE_TOKEN authentication is required.

app.post(
  "/api/solve",
  limiter,
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

  if (error instanceof multer.MulterError) {
    const status =
      error.code === "LIMIT_FILE_SIZE" ? 413 : 400;

    return res.status(status).json({
      success: false,
      error: error.message
    });
  }

  console.error(
    "Request error:",
    error?.message || error
  );

  return res.status(error.status || 400).json({
    success: false,
    error:
      error.status === 413
        ? "Request too large."
        : error.message || "Request could not be processed."
  });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
  console.log("Permanent study assistant prompt loaded.");
  console.log("Simulator: /");
  console.log("ESP32 route: /api/solve");
  console.log("Browser route: /api/browser-solve");
  console.log("Same-origin browser requests: CORS not required.");
});
