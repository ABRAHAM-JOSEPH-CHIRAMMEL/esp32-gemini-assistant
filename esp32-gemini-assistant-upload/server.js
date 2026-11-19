
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
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// ESP32 requests do not require browser CORS.
// Add trusted browser origins through ALLOWED_ORIGINS if needed.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-device-token"]
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again shortly."
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 1,
    parts: 2,
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

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" ||
      typeof expected !== "string") {
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

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Authenticate BEFORE accepting the image upload.
app.post(
  "/api/solve",
  limiter,
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

      // Verify actual file signature, not just the supplied MIME type.
      const detected = await fileTypeFromBuffer(req.file.buffer);

      if (
        !detected ||
        !ALLOWED_TYPES.has(detected.mime) ||
        detected.mime !== req.file.mimetype
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

      const ai = new GoogleGenAI({ apiKey });

      const prompt = [
        "You are an educational study assistant for learning and practice.",
        "Read the uploaded material carefully.",
        "Explain the visible subject clearly.",
        "Give relevant formulas and concise step-by-step reasoning.",
        "Do not invent unreadable information.",
        "Use plain text suitable for a small OLED display.",
        userPrompt || "Explain the uploaded material."
      ].join("\n");

      const result = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        contents: [
          prompt,
          {
            inlineData: {
              mimeType: detected.mime,
              data: req.file.buffer.toString("base64")
            }
          }
        ],
        config: {
          maxOutputTokens: 1200
        }
      });

      return res.json({
        success: true,
        answer: result.text || "No answer returned."
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

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

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
    error: error.status === 413
      ? "Request too large."
      : "Request could not be processed."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
});
