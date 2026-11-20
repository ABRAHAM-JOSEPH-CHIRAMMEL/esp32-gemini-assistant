
import express from "express";
import cors from "cors";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 10000;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_USER_PROMPT_LENGTH = 2000;
const MAX_OUTPUT_TOKENS = 8192;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// --------------------------------------------------
// PERMANENT DEFAULT GEMINI INSTRUCTION
// --------------------------------------------------

const DEFAULT_PROMPT = `
You are an expert educational assistant specialising in
engineering subjects and university examination question papers.

Your task is to read the uploaded question paper and provide
accurate, detailed, examination-ready educational answers.

==================================================
1. COMPLETE QUESTION PAPER COVERAGE
==================================================

- Examine the entire uploaded question paper carefully.
- Identify EVERY visible question and subquestion.
- Preserve original question numbers, module numbers,
  subquestion labels and marks wherever visible.
- Answer every question in exactly the original order.
- Include all questions marked OR.
- Answer BOTH sides of every OR alternative separately.
- Never skip numerical problems, derivations or short questions.
- Include questions at the bottom of the image.
- Never invent unreadable or missing question text.
- Identify unclear questions and explain that a clearer image
  is required.

==================================================
2. EXAMINATION-READY ANSWER QUALITY
==================================================

- Provide detailed, technically correct answers.
- Aim to cover all relevant marking points for the marks allotted.
- Include definitions, principles, explanations and applications.
- Include relevant formulas and important technical details.
- Explain the reasoning behind important results.
- Include labelled diagrams or clear diagram descriptions
  wherever required.
- Use comparison tables where appropriate in the full answer.
- Do not unnecessarily shorten high-mark answers.
- Do not fabricate facts, values or assumptions.
- Prioritise correctness, completeness and clarity.

Do not guarantee full marks. Provide the most complete,
accurate answer supported by the question.

==================================================
3. NUMERICAL PROBLEMS
==================================================

For every numerical problem, provide:

1. Given data.
2. Required quantity.
3. Relevant formula.
4. Substitution of values.
5. Step-by-step calculation.
6. Correct units.
7. Clearly identified final answer.

Never provide only the final numerical result.
Do not omit important calculation steps.

==================================================
4. MATHEMATICAL FORMATTING
==================================================

Use standard mathematical notation.

- Use LaTeX notation for equations and mathematical expressions.
- Use \\( ... \\) for inline mathematics.
- Use $$ ... $$ for displayed equations.
- Use Greek letters with proper commands:
  \\alpha, \\beta, \\lambda, \\psi, \\theta, \\pi, \\Delta.
- Use proper fractions: \\frac{a}{b}.
- Use integrals: \\int.
- Use summations: \\sum.
- Use vectors: \\vec{E}.
- Use subscripts: \\beta_{phase}.
- Use superscripts, powers, matrices and derivatives correctly.
- Never spell Greek symbols as English words inside equations.
- Never replace a mathematical expression with an incorrect
  plain-text approximation.
- Preserve mathematical meaning and derivation steps.

==================================================
5. DERIVATIONS
==================================================

For every derivation:

1. State the required result.
2. State the governing principle or starting equation.
3. Explain assumptions where applicable.
4. Show each important mathematical step.
5. Explain substitutions and transformations.
6. Highlight the final derived expression.

Do not jump directly to the final result.

==================================================
6. OLED DISPLAY COMPATIBILITY
==================================================

The physical display is a 0.91-inch OLED with
128 x 32 pixel resolution.

The firmware displays approximately four lines at a time.

Therefore:

- Use short, readable lines.
- Avoid excessively wide equations.
- Break long equations into logical steps.
- Avoid wide tables in the OLED-oriented answer.
- Preserve question numbering and mathematical meaning.
- Avoid unnecessary decorative characters.
- Avoid excessively long unbroken words or expressions.
- Keep explanatory sentences suitable for a narrow display.
- Organise the answer for sequential scrolling.
- Do not remove important answer content just to fit
  one OLED screen.
- Do not sacrifice derivation steps or numerical calculations.

IMPORTANT:
The answer must remain complete. The OLED firmware is
responsible for wrapping and scrolling the complete response.

Retain mathematically correct notation in the answer.
Do not silently replace mathematical symbols with words.

==================================================
7. COMPLETION CHECK
==================================================

Before finishing:

- Verify every detected question has an answer.
- Verify both sides of every OR alternative are covered.
- Verify all numerical calculations are complete.
- Verify important derivation steps are present.
- Verify mathematical notation is correct.
- Identify unreadable or partially visible questions.
- Do not claim the paper is complete if questions remain.

==================================================
8. OUTPUT LENGTH AND CONTINUATION
==================================================

- Prioritise completeness over brevity.
- Do not deliberately omit questions to shorten the response.
- Answer in the original question-paper sequence.
- If the response limit is approaching, finish at a logical
  question boundary and identify the next unanswered question.
- Never repeat completed answers unnecessarily.
- Never claim that unanswered questions have been completed.

FINAL REQUIREMENT:

Answer the complete readable question paper from beginning
to end, preserving its original order.

Include every visible question, every OR alternative,
detailed derivations, complete numerical solutions,
correct mathematical notation and clear explanations.
`;

// --------------------------------------------------
// CORS CONFIGURATION
// --------------------------------------------------

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include ESP32 requests.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-device-token"]
}));

// --------------------------------------------------
// RATE LIMITING
// --------------------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again shortly."
  }
});

// --------------------------------------------------
// IMAGE UPLOAD CONFIGURATION
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 1,
    parts: 2,
    fieldSize: MAX_USER_PROMPT_LENGTH
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

// --------------------------------------------------
// DEVICE AUTHENTICATION
// --------------------------------------------------

function tokenMatches(provided, expected) {
  if (
    typeof provided !== "string" ||
    typeof expected !== "string"
  ) {
    return false;
  }

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

function authenticateDevice(req, res, next) {
  const expected = process.env.DEVICE_TOKEN;

  if (!expected) {
    return res.status(503).json({
      error: "Device authentication is not configured."
    });
  }

  if (!tokenMatches(req.get("x-device-token"), expected)) {
    return res.status(401).json({
      error: "Unauthorized device."
    });
  }

  next();
}

// --------------------------------------------------
// HEALTH CHECKS
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ESP32 Gemini Study Assistant",
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash"
  });
});

// --------------------------------------------------
// SHARED GEMINI IMAGE PROCESSING
// --------------------------------------------------

async function processQuestionPaper(req, res) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: "Gemini API is not configured on Render."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image received. Use the image field."
      });
    }

    // Verify actual image signature.
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

    const userPrompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : "";

    if (userPrompt.length > MAX_USER_PROMPT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: "Additional prompt is too long."
      });
    }

    // Permanent instruction is ALWAYS included.
    const finalPrompt = [
      DEFAULT_PROMPT,
      userPrompt
        ? "\nADDITIONAL USER INSTRUCTIONS:\n" + userPrompt
        : ""
    ].join("\n");

    const ai = new GoogleGenAI({ apiKey });

    const model =
      process.env.GEMINI_MODEL || "gemini-3.6-flash";

    console.log("Starting Gemini image processing.");
    console.log("Model:", model);
    console.log("Image type:", detected.mime);
    console.log("Image size:", req.file.size, "bytes");

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

    console.log(
      "Gemini response received.",
      "Characters:",
      answer.length
    );

    return res.json({
      success: true,
      answer,
      model,
      truncated: false
    });

  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 0);

    console.error(
      "Gemini processing error:",
      status,
      error?.message || "Unknown error"
    );

    if (status === 429) {
      return res.status(429).json({
        success: false,
        error: "Gemini API quota or rate limit reached. Please wait and retry."
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
        error: "Gemini API authentication or permission error. Check Render environment variables."
      });
    }

    return res.status(502).json({
      success: false,
      error: "AI processing failed. Check Render logs."
    });
  }
}

// --------------------------------------------------
// ESP32 ROUTE - DEVICE TOKEN REQUIRED
// --------------------------------------------------

app.post(
  "/api/solve",
  limiter,
  authenticateDevice,
  upload.single("image"),
  processQuestionPaper
);

// --------------------------------------------------
// BROWSER ROUTE - NO DEVICE TOKEN REQUIRED
// --------------------------------------------------

app.post(
  "/api/browser-solve",
  limiter,
  upload.single("image"),
  processQuestionPaper
);

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

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

  if (error?.message === "Origin not allowed.") {
    return res.status(403).json({
      success: false,
      error: "Browser origin is not allowed. Check ALLOWED_ORIGINS."
    });
  }

  console.error("Request error:", error?.message || error);

  return res.status(error.status || 400).json({
    success: false,
    error: error.status === 413
      ? "Request too large."
      : "Request could not be processed."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("Gemini server running on port", PORT);
  console.log("Permanent study assistant prompt loaded.");
  console.log("ESP32 route: /api/solve");
  console.log("Browser route: /api/browser-solve");
});
