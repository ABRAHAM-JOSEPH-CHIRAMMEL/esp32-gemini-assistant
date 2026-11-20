
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
const MAX_OUTPUT_TOKENS = 60000;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
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
  message: { error: "Too many requests. Please try again shortly." }
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
      return callback(new Error("Only JPG, PNG and WEBP images are accepted."));
    }
    callback(null, true);
  }
});

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authenticateDevice(req, res, next) {
  const expected = process.env.DEVICE_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: "Device authentication is not configured." });
  }
  if (!tokenMatches(req.get("x-device-token"), expected)) {
    return res.status(401).json({ error: "Unauthorized device." });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "online", service: "ESP32 Gemini Study Assistant" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/solve", limiter, authenticateDevice, upload.single("image"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "Gemini API is not configured." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No image received. Use the image field." });
    }

    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ALLOWED_TYPES.has(detected.mime) || detected.mime !== req.file.mimetype) {
      return res.status(415).json({ error: "Invalid or unsupported image file." });
    }

    const userPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (userPrompt.length > 1000) {
      return res.status(400).json({ error: "Prompt must be 1000 characters or fewer." });
    }

    const ai = new GoogleGenAI({ apiKey });

    const prompt = [
      "You are a careful university-level educational tutor. The uploaded image is an examination question-paper page.",
      "Inspect the entire image and identify every question and sub-question that is actually visible.",
      "Answer every fully or partly visible question in the same order. Preserve printed question numbers and subpart labels.",
      "Do not answer questions that are not visible. If any line, value, symbol, or question is cropped or unreadable, explicitly mark that exact part as unclear instead of guessing.",
      "Give technically correct, complete, exam-ready answers at a depth appropriate to the marks printed beside each question.",
      "For derivations, show assumptions, the starting equation, meaningful intermediate steps, and the final expression. Define variables after equations.",
      "For numerical problems, list given data, formula, substitution with units, calculation, and final answer with units.",
      "For diagrams or graphs, describe exactly what to draw and label the important parts. Do not claim an unseen diagram is present.",
      "Preserve mathematical symbols and distinguish similar symbols carefully.",
      "Do not invent facts, formulas, numerical values, or missing question text. If uncertain, say so.",
      "Do not compress the answer merely to fit an OLED. The device will paginate the full response across multiple screens.",
      "Use clear plain text with headings and line breaks. Avoid markdown tables because the response is intended for a small display.",
      userPrompt || "Read and answer all visible questions accurately."
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
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2
      }
    });

    const answer = result.text || "";
    const finishReason = result.candidates?.[0]?.finishReason || "UNKNOWN";
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
    return res.status(502).json({ error: "AI processing failed. Check server logs." });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: error.message });
  }

  if (error?.message === "Origin not allowed.") {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  console.error("Request error:", error?.message);
  return res.status(error.status || 400).json({
    error: error.status === 413 ? "Request too large." : "Request could not be processed."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server running on port ${PORT}`);
});
