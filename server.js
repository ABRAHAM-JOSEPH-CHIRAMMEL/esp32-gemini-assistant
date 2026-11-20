
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

// =====================================================
// CONFIGURATION
// =====================================================

const app = express();

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const MAX_OUTPUT_TOKENS = 60000;

const MAX_REQUESTS_PER_MINUTE = 10;

const genAI = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

// =====================================================
// CORS CONFIGURATION
// =====================================================

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-device-token"
    ]
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(express.urlencoded({ extended: true }));

// =====================================================
// IMAGE UPLOAD CONFIGURATION
// =====================================================

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error("Only JPEG, PNG and WebP images are allowed.")
      );
    }

    cb(null, true);
  }
});

// =====================================================
// IMAGE SIGNATURE VALIDATION
// =====================================================

function validateImage(buffer, mimeType) {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  // JPEG
  if (mimeType === "image/jpeg") {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  // PNG
  if (mimeType === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  // WEBP
  if (mimeType === "image/webp") {
    return (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

// =====================================================
// DEVICE AUTHENTICATION
// =====================================================

function authenticateDevice(req, res, next) {
  if (!DEVICE_TOKEN) {
    return res.status(503).json({
      success: false,
      error: "DEVICE_TOKEN is not configured on the server."
    });
  }

  const suppliedToken = req.headers["x-device-token"];

  if (
    typeof suppliedToken !== "string" ||
    suppliedToken.length !== DEVICE_TOKEN.length
  ) {
    return res.status(401).json({
      success: false,
      error: "Invalid device authentication."
    });
  }

  const valid = crypto.timingSafeEqual(
    Buffer.from(suppliedToken),
    Buffer.from(DEVICE_TOKEN)
  );

  if (!valid) {
    return res.status(401).json({
      success: false,
      error: "Invalid device authentication."
    });
  }

  next();
}

// =====================================================
// RATE LIMITING
// =====================================================

const requestCounts = new Map();

function rateLimit(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();

  let record = requestCounts.get(ip);

  if (!record || now - record.startTime >= 60000) {
    record = {
      count: 0,
      startTime: now
    };
  }

  record.count++;

  requestCounts.set(ip, record);

  if (record.count > MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait one minute."
    });
  }

  next();
}

// Periodically remove expired rate-limit records.
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of requestCounts.entries()) {
    if (now - record.startTime >= 60000) {
      requestCounts.delete(ip);
    }
  }
}, 60000);

cleanupInterval.unref();

// =====================================================
// GEMINI ERROR STATUS DETECTION
// =====================================================

function getErrorStatus(error) {
  const status =
    error?.status ??
    error?.statusCode ??
    error?.code ??
    error?.response?.status;

  const numericStatus = Number(status);

  if ([429, 500, 503, 504].includes(numericStatus)) {
    return numericStatus;
  }

  const message = String(
    error?.message || ""
  ).toUpperCase();

  if (
    message.includes("UNAVAILABLE") ||
    message.includes("HIGH DEMAND")
  ) {
    return 503;
  }

  if (
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("RATE LIMIT")
  ) {
    return 429;
  }

  if (
    message.includes("DEADLINE_EXCEEDED")
  ) {
    return 504;
  }

  return numericStatus || 500;
}

// =====================================================
// AUTOMATIC GEMINI RETRY SYSTEM
// =====================================================

async function generateWithRetry(
  generateFunction,
  maxRetries = 3
) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Gemini request attempt ${attempt + 1}/${maxRetries + 1}`
      );

      return await generateFunction();

    } catch (error) {
      lastError = error;

      const status = getErrorStatus(error);

      const retryableStatuses = [
        429,
        500,
        503,
        504
      ];

      if (
        !retryableStatuses.includes(status) ||
        attempt === maxRetries
      ) {
        throw error;
      }

      const delay =
        1500 * Math.pow(2, attempt);

      console.log(
        `Gemini error ${status}. Retrying in ${delay}ms...`
      );

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }

  throw lastError;
}

// =====================================================
// IMAGE ANALYSIS FUNCTION
// =====================================================

async function analyzeImage(file, customPrompt = "") {
  if (!genAI) {
    const error = new Error(
      "GEMINI_API_KEY is missing from Render environment variables."
    );

    error.status = 503;
    throw error;
  }

  if (!file || !file.buffer) {
    const error = new Error("No image was uploaded.");
    error.status = 400;
    throw error;
  }

  if (!validateImage(file.buffer, file.mimetype)) {
    const error = new Error(
      "Invalid image file. Please upload a valid JPEG, PNG or WebP image."
    );

    error.status = 400;
    throw error;
  }

  const imageBase64 = file.buffer.toString("base64");

  const prompt = customPrompt.trim() ||
    `Carefully analyze the uploaded image.

Identify the question, problem, text or object shown.

If it contains an academic question:
1. Read the complete question accurately.
2. Identify what is being asked.
3. Solve it step by step.
4. Show the relevant formulas and substitutions.
5. Give the final answer clearly.
6. Do not invent unreadable information.

If it contains a diagram, circuit, graph or technical drawing,
explain its important features.

Keep the answer accurate, clear and useful.`;

  const response = await generateWithRetry(async () => {
    return await genAI.models.generateContent({
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
                mimeType: file.mimetype,
                data: imageBase64
              }
            }
          ]
        }
      ],

      config: {
        maxOutputTokens: MAX_OUTPUT_TOKENS
      }
    });
  });

  const answer = response.text || "";

  if (!answer.trim()) {
    const error = new Error(
      "Gemini returned an empty response. Please try again."
    );

    error.status = 502;
    throw error;
  }

  const candidate = response.candidates?.[0];

  const finishReason = candidate?.finishReason || "UNKNOWN";

  return {
    success: true,
    answer,
    finishReason,
    truncated: finishReason === "MAX_TOKENS",
    model: GEMINI_MODEL
  };
}

// =====================================================
// HOME ROUTE
// =====================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "ESP32 Gemini Assistant Server is running.",
    model: GEMINI_MODEL,
    endpoints: {
      health: "/health",
      esp32: "/api/solve",
      browser: "/api/browser-solve"
    }
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "online",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    timestamp: new Date().toISOString()
  });
});

// =====================================================
// ESP32 IMAGE SOLVING ROUTE
// POST /api/solve
// Requires x-device-token
// =====================================================

app.post(
  "/api/solve",
  authenticateDevice,
  rateLimit,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No image received. Use form-data field named image."
        });
      }

      const result = await analyzeImage(
        req.file,
        req.body?.prompt || ""
      );

      console.log("ESP32 image successfully processed.");

      return res.status(200).json(result);

    } catch (error) {
      console.error("ESP32 Gemini Error:", error);

      return sendError(res, error);
    }
  }
);

// =====================================================
// BROWSER IMAGE SOLVING ROUTE
// POST /api/browser-solve
// No device token required
// =====================================================

app.post(
  "/api/browser-solve",
  rateLimit,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No image received. Use form-data field named image."
        });
      }

      const result = await analyzeImage(
        req.file,
        req.body?.prompt || ""
      );

      console.log("Browser image successfully processed.");

      return res.status(200).json(result);

    } catch (error) {
      console.error("Browser Gemini Error:", error);

      return sendError(res, error);
    }
  }
);

// =====================================================
// CENTRAL ERROR HANDLER
// =====================================================

function sendError(res, error) {
  const status = getErrorStatus(error);

  let message = error?.message || "Unknown server error.";

  if (status === 429) {
    message =
      "Gemini API rate limit reached. Please wait and try again.";
  }

  if (status === 503) {
    message =
      "Gemini is temporarily experiencing high demand. Please try again shortly.";
  }

  if (status === 504) {
    message =
      "Gemini request timed out. Please try again.";
  }

  if (status === 401 || status === 403) {
    message =
      "Gemini API authentication failed. Check your API key and permissions.";
  }

  if (status === 502) {
    message =
      error?.message || "Gemini returned an invalid response.";
  }

  if (status === 400) {
    message = error?.message || "Invalid request.";
  }

  return res.status(status >= 400 && status <= 599 ? status : 500)
    .json({
      success: false,
      error: message,
      retryable: [429, 500, 503, 504].includes(status)
    });
}

// =====================================================
// MULTER AND GENERAL ERROR HANDLING
// =====================================================

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error("Server Middleware Error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Image is too large. Maximum size is 5 MB."
      });
    }

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  if (
    error.message?.includes("Only JPEG") ||
    error.message?.includes("Only")
  ) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  return res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------------");
  console.log("ESP32 GEMINI ASSISTANT SERVER STARTED");
  console.log("----------------------------------------");
  console.log(`Port: ${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Gemini API: ${GEMINI_API_KEY ? "Configured" : "MISSING"}`);
  console.log(`Device Token: ${DEVICE_TOKEN ? "Configured" : "MISSING"}`);
  console.log("----------------------------------------");
  console.log("GET  /");
  console.log("GET  /health");
  console.log("POST /api/solve");
  console.log("POST /api/browser-solve");
  console.log("----------------------------------------");
});
