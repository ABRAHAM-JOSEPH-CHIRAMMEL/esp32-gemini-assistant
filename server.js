
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { fileTypeFromBuffer } from "file-type";
import { rateLimit } from "express-rate-limit";

const app = express();

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const MAX_OUTPUT_TOKENS = Number(
  process.env.MAX_OUTPUT_TOKENS || 60000
);

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

// --------------------------------------------------
// CORS
// --------------------------------------------------

app.use(
  cors({
    origin(origin, callback) {
      // Local HTML files send the origin "null".
      if (
        !origin ||
        origin === "null" ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "x-device-token"
    ]
  })
);

// --------------------------------------------------
// GEMINI INITIALIZATION
// --------------------------------------------------

const genAI = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

// --------------------------------------------------
// IMAGE UPLOAD CONFIGURATION
// --------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
});

// --------------------------------------------------
// RATE LIMITING
// --------------------------------------------------

// ESP32 endpoint: maximum 10 requests per minute.
const deviceRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait before trying again."
  }
});

// Browser simulator: maximum 3 scans per IP every 5 minutes.
const browserRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Browser scan limit reached. Please wait five minutes."
  }
});

// --------------------------------------------------
// DEVICE AUTHENTICATION
// --------------------------------------------------

function authenticateDevice(req, res, next) {
  if (!DEVICE_TOKEN) {
    return res.status(503).json({
      success: false,
      error: "DEVICE_TOKEN is not configured on Render."
    });
  }

  const suppliedToken = req.get("x-device-token") || "";

  const suppliedBuffer = Buffer.from(suppliedToken);
  const correctBuffer = Buffer.from(DEVICE_TOKEN);

  const valid =
    suppliedBuffer.length === correctBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, correctBuffer);

  if (!valid) {
    return res.status(401).json({
      success: false,
      error: "Invalid device token."
    });
  }

  next();
}

// --------------------------------------------------
// SHARED GEMINI IMAGE PROCESSING
// --------------------------------------------------

async function solveImage(req, res) {
  try {
    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: "GEMINI_API_KEY is not configured on Render."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image uploaded. Use the image field."
      });
    }

    // Verify the actual image signature.
    const detectedType = await fileTypeFromBuffer(
      req.file.buffer
    );

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (
      !detectedType ||
      !allowedTypes.includes(detectedType.mime)
    ) {
      return res.status(400).json({
        success: false,
        error: "Unsupported or invalid image. Use JPG, PNG or WebP."
      });
    }

    const prompt =
      typeof req.body?.prompt === "string" &&
      req.body.prompt.trim()
        ? req.body.prompt.trim()
        : `Read the uploaded study question paper carefully.
Identify every visible question and provide accurate,
detailed educational answers. Include relevant formulas,
derivations and calculation steps. Do not invent unreadable text.`;

    const imageBase64 = req.file.buffer.toString("base64");

    const result = await genAI.models.generateContent({
      model: GEMINI_MODEL,

      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            },
            {
              inlineData: {
                mimeType: detectedType.mime,
                data: imageBase64
              }
            }
          ]
        }
      ],

      config: {
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS
      }
    });

    const answer = result.text || "";

    if (!answer.trim()) {
      return res.status(502).json({
        success: false,
        error: "Gemini returned an empty answer.",
        finishReason:
          result.candidates?.[0]?.finishReason || null
      });
    }

    const finishReason =
      result.candidates?.[0]?.finishReason || null;

    return res.status(200).json({
      success: true,
      answer,
      finishReason,
      truncated: finishReason === "MAX_TOKENS",
      model: GEMINI_MODEL
    });

  } catch (error) {
    console.error("Gemini processing error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Image processing failed."
    });
  }
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    deviceAuthenticationConfigured: Boolean(DEVICE_TOKEN)
  });
});

// --------------------------------------------------
// ESP32 ENDPOINT - DEVICE TOKEN REQUIRED
// --------------------------------------------------

app.post(
  "/api/solve",
  deviceRateLimit,
  authenticateDevice,
  upload.single("image"),
  solveImage
);

// --------------------------------------------------
// BROWSER SIMULATOR ENDPOINT - NO TOKEN ENTRY
// --------------------------------------------------

app.post(
  "/api/browser-solve",
  browserRateLimit,
  upload.single("image"),
  solveImage
);

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Image exceeds the 5 MB upload limit."
      });
    }

    return res.status(400).json({
      success: false,
      error: err.message
    });
  }

  if (err.message === "Origin not allowed by CORS") {
    return res.status(403).json({
      success: false,
      error: "Browser origin is not allowed."
    });
  }

  return res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log("ESP32 GEMINI STUDY ASSISTANT ONLINE");
  console.log("Port:", PORT);
  console.log("Gemini model:", GEMINI_MODEL);
  console.log("Gemini configured:", Boolean(GEMINI_API_KEY));
  console.log("Device token configured:", Boolean(DEVICE_TOKEN));
  console.log("Browser endpoint: /api/browser-solve");
  console.log("ESP32 endpoint: /api/solve");
  console.log("====================================");
});
