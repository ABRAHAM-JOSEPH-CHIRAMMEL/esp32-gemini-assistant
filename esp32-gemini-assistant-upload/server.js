import express from "express";
import cors from "cors";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { timingSafeEqual } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// Set ALLOWED_ORIGINS to a comma-separated list if you use a browser-based
// client. Direct ESP32 requests do not send an Origin header.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-device-token"],
  maxAge: 600
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait and try again." }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 1,
    parts: 2,
    fieldSize: 2048
  },
  fileFilter(_req, file, callback) {
    const accepted = ["image/jpeg", "image/png", "image/webp"];
    if (!accepted.includes(file.mimetype)) {
      return callback(new Error("Only JPG, PNG and WEBP images are accepted."));
    }
    callback(null, true);
  }
});

function safeTokenEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireDeviceToken(req, res, next) {
  const expected = process.env.DEVICE_TOKEN;
  if (!expected || !safeTokenEqual(req.get("x-device-token"), expected)) {
    return res.status(401).json({ error: "Unauthorized device." });
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/api/solve",
  limiter,
  requireDeviceToken,
  upload.single("image"),
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: "AI service is not configured." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No image received. Use form field 'image'." });
      }

      // Validate the actual file signature rather than trusting the MIME header.
      const detected = await fileTypeFromBuffer(req.file.buffer);
      const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
      if (!detected || !allowedTypes.has(detected.mime)) {
        return res.status(400).json({ error: "The uploaded file is not a supported image." });
      }

      const userPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (userPrompt.length > 1000) {
        return res.status(400).json({ error: "Prompt must be 1000 characters or fewer." });
      }

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `
You are an educational study assistant for learning and practice.
Read the uploaded study material carefully. Explain the visible concept or
practice question with concise, accurate reasoning. Include relevant formulas
when useful. If any text is unclear, say so rather than guessing.
Use plain text suitable for a small OLED display.

Additional request: ${userPrompt || "Explain the uploaded study material."}
`;

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
        config: { maxOutputTokens: 1200 }
      });

      return res.json({
        success: true,
        answer: result.text || "No response was returned."
      });
    } catch (error) {
      console.error("Request processing failed:", error?.message || error);
      return res.status(500).json({
        error: "AI processing failed. Check the service logs."
      });
    }
  }
);

// Consistent JSON errors for upload, CORS and request parsing failures.
app.use((error, _req, res, _next) => {
  const status = Number(error?.status) || 400;
  res.status(status).json({
    error: status >= 500 ? "Request failed." : (error?.message || "Request failed.")
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
});
