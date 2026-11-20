import express from "express";
import cors from "cors";
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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_USER_PROMPT_LENGTH = 2000;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 8192);
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// CORS is only needed for separately hosted origins. The included simulator
// is served by this same service and uses a relative URL.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(v => v.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed."));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-device-token"]
}));

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait and retry." }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, parts: 2, fieldSize: MAX_USER_PROMPT_LENGTH },
  fileFilter(req, file, cb) {
    if (!ALLOWED_TYPES.has(file.mimetype)) return cb(new Error("Only JPG, PNG and WEBP images are accepted."));
    cb(null, true);
  }
});

const DEFAULT_PROMPT = `
You are an expert educational assistant specialising in engineering subjects
and university examination question papers.

COMPLETE QUESTION PAPER:
- Examine the entire uploaded paper and identify every visible question.
- Preserve question numbers, modules, subquestion labels and marks.
- Answer every question in the original order.
- Answer BOTH sides of every OR alternative.
- Never skip numerical problems, derivations or questions at the bottom.
- Never invent unreadable text; identify unclear questions explicitly.

EXAMINATION-READY ANSWERS:
- Give accurate, detailed answers appropriate to the marks allotted.
- Aim to cover relevant marking points; do not guarantee full marks.
- Include definitions, principles, explanations, applications and diagrams
  or clear diagram descriptions where relevant.
- Do not fabricate facts, values or assumptions.

NUMERICALS:
Give known data, required quantity, formula, substitution, step-by-step
calculations, units and a clearly identified final answer.

DERIVATIONS:
State the required result and starting principle/equation.
Show assumptions, substitutions and important intermediate steps.
Explain transformations and highlight the final expression.

MATHEMATICAL FORMATTING:
Use standard LaTeX: \\( ... \\) inline and $$ ... $$ displayed.
Use correct Greek letters, fractions, integrals, sums, vectors,
subscripts, superscripts, matrices and derivatives.
Never spell a Greek symbol as an English word inside an equation.
Preserve mathematical meaning and derivation steps.

OLED COMPATIBILITY:
Target display: 0.91-inch, 128 x 32 pixels, approximately four visible
lines at a time. Use short readable lines, avoid wide tables and
unbroken expressions, and break long equations into logical steps.
Keep question numbering and mathematical meaning. Avoid decorative
characters. Do not remove important content to fit one screen.
The firmware handles wrapping and scrolling. Do not assume all Unicode
or LaTeX glyphs are supported by the physical OLED.

COMPLETION:
Verify every detected question and both OR alternatives are answered.
Verify numerical calculations and derivations. Identify unreadable items.
Do not claim completion if questions remain.

OUTPUT LENGTH:
Prioritise completeness. If the output limit is reached, state the last
completed question and the next unanswered question. Do not claim
unanswered questions are complete. Answer the readable paper in order.
`;

function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function authenticateDevice(req, res, next) {
  const expected = process.env.DEVICE_TOKEN;
  if (!expected) return res.status(503).json({ success: false, error: "Device authentication is not configured." });
  if (!tokenMatches(req.get("x-device-token"), expected)) {
    return res.status(401).json({ success: false, error: "Unauthorized device." });
  }
  next();
}

app.use(express.static(path.join(ROOT, "public")));
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.get("/health", (req, res) => res.json({
  ok: true,
  service: "ESP32 Gemini Study Assistant",
  model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  simulator: "same-origin"
}));

async function solve(req, res) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ success: false, error: "Gemini API is not configured on Render." });
    }
    if (!req.file) return res.status(400).json({ success: false, error: "No image received. Use the image field." });

    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ALLOWED_TYPES.has(detected.mime) || detected.mime !== req.file.mimetype) {
      return res.status(415).json({ success: false, error: "Invalid or unsupported image file." });
    }

    const extra = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (extra.length > MAX_USER_PROMPT_LENGTH) {
      return res.status(400).json({ success: false, error: "Additional prompt is too long." });
    }

    const prompt = DEFAULT_PROMPT + (extra ? "\n\nADDITIONAL USER INSTRUCTIONS:\n" + extra : "");
    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    console.log("Gemini scan started", { model, mime: detected.mime, bytes: req.file.size });
    const result = await ai.models.generateContent({
      model,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: detected.mime, data: req.file.buffer.toString("base64") } }
      ],
      config: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 }
    });

    const answer = result.text || "";
    if (!answer.trim()) return res.status(502).json({ success: false, error: "Gemini returned an empty answer." });
    const finishReason = result.candidates?.[0]?.finishReason || null;
    console.log("Gemini scan finished", { characters: answer.length, finishReason });
    return res.json({ success: true, answer, model, finishReason });
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 0);
    console.error("Gemini processing error:", status, err?.message || err);
    if (status === 429) return res.status(429).json({ success: false, error: "Gemini quota or rate limit reached. Wait and retry." });
    if (status === 503 || status === 502) return res.status(503).json({ success: false, error: "Gemini is temporarily unavailable or overloaded. Please retry." });
    if (status === 401 || status === 403) return res.status(status).json({ success: false, error: "Gemini API authentication or permission error. Check Render environment variables." });
    return res.status(502).json({ success: false, error: "AI processing failed. Check Render logs." });
  }
}

// ESP32: token protected. Browser: no device token, same-origin.
app.post("/api/solve", limiter, authenticateDevice, upload.single("image"), solve);
app.post("/api/browser-solve", limiter, upload.single("image"), solve);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ success: false, error: err.message });
  }
  if (err?.message === "Origin not allowed.") {
    return res.status(403).json({ success: false, error: "Origin not allowed." });
  }
  console.error("Request error:", err?.message || err);
  return res.status(err.status || 400).json({
    success: false,
    error: err.status === 413 ? "Request too large." : "Request could not be processed."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini server listening on ${PORT}`);
  console.log("Permanent question-paper and OLED instruction loaded.");
  console.log("Simulator: / | ESP32 API: /api/solve | Browser API: /api/browser-solve");
});
