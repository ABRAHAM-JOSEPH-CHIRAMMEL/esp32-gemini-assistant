
import express from "express";
import cors from "cors";
import multer from "multer";
import { timingSafeEqual } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 60000;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// --------------------------------------------------
// CORS
// --------------------------------------------------

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-device-token"]
}));

// --------------------------------------------------
// BASIC RATE LIMITING
// --------------------------------------------------

const requestCounts = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;
  const ip = req.ip || "unknown";

  let record = requestCounts.get(ip);

  if (!record || now - record.start >= windowMs) {
    record = { start: now, count: 0 };
  }

  record.count++;
  requestCounts.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      error: "Too many requests. Please try again shortly."
    });
  }

  next();
}

// --------------------------------------------------
// IMAGE UPLOAD
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 1,
    parts: 5,
    fieldSize: 2048
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
// VERIFY IMAGE CONTENT
// --------------------------------------------------

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  // JPEG
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xFF &&
    buffer[1] === 0xD8 &&
    buffer[2] === 0xFF
  ) {
    return "image/jpeg";
  }

  // PNG
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
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

  if (a.length !== b.length) return false;

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
// BASIC SERVER ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true
  });
});

// --------------------------------------------------
// GEMINI IMAGE PROCESSING
// --------------------------------------------------

app.post(
  "/api/solve",
  rateLimit,
  authenticateDevice,
  upload.single("image"),
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(503).json({
          error: "Gemini API is not configured."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "No image received. Use the image field."
        });
      }

      // Verify the actual image format.
      const detectedMime = detectImageType(req.file.buffer);

      if (
        !detectedMime ||
        !ALLOWED_TYPES.has(detectedMime) ||
        detectedMime !== req.file.mimetype
      ) {
        return res.status(415).json({
          error: "Invalid or unsupported image file."
        });
      }

      const userPrompt =
        typeof req.body?.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      if (userPrompt.length > 1000) {
        return res.status(400).json({
          error: "Prompt must be 1000 characters or fewer."
        });
      }

      const ai = new GoogleGenAI({
        apiKey
      });

      // --------------------------------------------------
      // HIGH-ACCURACY EDUCATIONAL PROMPT
      // --------------------------------------------------

      const prompt = [
        "ROLE: You are a highly accurate KTU university-level educational tutor.",

        "The uploaded image contains printed educational or examination questions.",

        "Inspect the entire image carefully from top to bottom and left to right.",

        "Identify every question, sub-question, alternative, instruction and visible mark allocation.",

        "Preserve the original question numbers, subpart labels and section headings.",

        "Answer every visible question in the same order. Do not silently skip questions.",

        "If OR alternatives are visible, answer both alternatives separately for study purposes.",

        "Match the depth of each answer to the marks printed beside that question.",

        "For short-answer questions, provide precise definitions and the essential points.",

        "For long-answer questions, provide a properly structured and detailed explanation.",

        "For derivations, state the assumptions, define variables, show the starting equation, explain intermediate steps and obtain the final expression.",

        "Never jump directly to the final result when a derivation is requested.",

        "For numerical problems, clearly show given data, required quantity, formula, substitution, calculation and final answer with correct units.",

        "Verify numerical calculations, signs, dimensions and units before presenting the result.",

        "For diagrams, explain exactly what should be drawn and identify important labels.",

        "For circuit diagrams, block diagrams and graphs, explain the function of their important sections.",

        "Preserve mathematical notation and distinguish similar symbols carefully.",

        "Do not invent missing question text, numerical values, diagrams, formulas or assumptions.",

        "If a question, symbol, value or line is cropped or unreadable, explicitly mark that exact part as [unclear in image].",

        "Do not guess unreadable content using general knowledge.",

        "If the image is incomplete, explain which portion is missing.",

        "Before finishing, check the original page again and verify that every visible question number has been addressed.",

        "Use clear headings, numbered steps and readable line breaks.",

        "Avoid markdown tables because the response will be displayed on a small OLED screen.",

        "Do not shorten answers merely to fit the OLED. The device will paginate the response.",

        "Prioritise factual accuracy, mathematical correctness and completeness over speed.",

        userPrompt || "Read and answer all visible questions accurately and completely."
      ].join("\n");

      // --------------------------------------------------
      // GEMINI REQUEST
      // --------------------------------------------------

      const result = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",

        contents: [
          prompt,
          {
            inlineData: {
              mimeType: detectedMime,
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

      const finishReason =
        result.candidates?.[0]?.finishReason || "UNKNOWN";

      const truncated = finishReason === "MAX_TOKENS";

      return res.json({
        success: Boolean(answer),
        answer: answer || "No answer returned.",
        finishReason,
        truncated,
        maxOutputTokens: MAX_OUTPUT_TOKENS
      });

    } catch (error) {
      console.error(
        "AI processing failed:",
        error?.status || "",
        error?.message || "Unknown error"
      );

      return res.status(502).json({
        error: "AI processing failed. Check server logs."
      });
    }
  }
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
      error: error.message
    });
  }

  if (error?.message === "Origin not allowed.") {
    return res.status(403).json({
      error: "Origin not allowed."
    });
  }

  console.error("Request error:", error?.message);

  return res.status(error.status || 400).json({
    error:
      error.status === 413
        ? "Request too large."
        : "Request could not be processed."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
});
