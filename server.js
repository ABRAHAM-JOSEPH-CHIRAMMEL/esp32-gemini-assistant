
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";

// ======================================================
// 1. SERVER CONFIGURATION
// ======================================================

const app = express();

const PORT = process.env.PORT || 10000;

const API_KEY = process.env.GEMINI_API_KEY;

const MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const MAX_RETRIES = 3;

const genAI = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY })
  : null;

// ======================================================
// 2. CORS - IMPORTANT FIX
// ======================================================

// Allows requests from:
// - Local HTML files (Origin: null)
// - GitHub Pages
// - Render-hosted frontends
// - Other browser applications
//
// Do not enable credentials with wildcard origin.

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-device-token"
    ],
    optionsSuccessStatus: 204
  })
);

// CORS middleware above handles OPTIONS preflight.
// Do not add an Express wildcard OPTIONS route here.

app.use(express.json({ limit: "8mb" }));

app.use(express.urlencoded({
  extended: true,
  limit: "8mb"
}));

// ======================================================
// 3. GEMINI INITIALIZATION CHECK
// ======================================================

function checkGemini() {
  if (!API_KEY || !genAI) {
    const error = new Error(
      "GEMINI_API_KEY is missing. Configure it in Render Environment."
    );

    error.status = 503;
    throw error;
  }
}

// ======================================================
// 4. IMAGE UPLOAD CONFIGURATION
// ======================================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },

  fileFilter: (req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error(
          "Invalid image format. Use JPEG, PNG or WebP."
        )
      );
    }

    callback(null, true);
  }
});

// Support common frontend field names.
const imageUpload = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "photo", maxCount: 1 }
]);

function getUploadedFile(req) {
  if (!req.files) return null;

  return (
    req.files.image?.[0] ||
    req.files.file?.[0] ||
    req.files.photo?.[0] ||
    null
  );
}

// ======================================================
// 5. IMAGE VALIDATION
// ======================================================

function validateImage(buffer, mimeType) {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  if (mimeType === "image/jpeg") {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

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

  if (mimeType === "image/webp") {
    return (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    );
  }

  return false;
}

// ======================================================
// 6. JSON IMAGE SUPPORT
// ======================================================

function getImageFromRequest(req) {
  const uploaded = getUploadedFile(req);

  if (uploaded) {
    return {
      buffer: uploaded.buffer,
      mimeType: uploaded.mimetype
    };
  }

  // Also accept JSON base64 images.
  const rawImage =
    req.body?.imageBase64 ||
    req.body?.image;

  if (typeof rawImage !== "string") {
    return null;
  }

  let mimeType =
    req.body?.mimeType || "image/jpeg";

  let base64 = rawImage;

  const dataUrlMatch = rawImage.match(
    /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s
  );

  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    base64 = dataUrlMatch[2];
  }

  if (![
    "image/jpeg",
    "image/png",
    "image/webp"
  ].includes(mimeType)) {
    return null;
  }

  if (
    base64.length > Math.ceil(MAX_FILE_SIZE * 1.4) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    return null;
  }

  const buffer = Buffer.from(base64, "base64");

  if (buffer.length > MAX_FILE_SIZE) {
    const error = new Error(
      "Image exceeds the 5 MB limit."
    );

    error.status = 413;
    throw error;
  }

  return {
    buffer,
    mimeType
  };
}

// ======================================================
// 7. DEVICE AUTHENTICATION
// ======================================================

function authenticateDevice(req, res, next) {
  if (!DEVICE_TOKEN) {
    return res.status(503).json({
      success: false,
      error: "DEVICE_TOKEN is not configured."
    });
  }

  const supplied = req.headers["x-device-token"];

  if (
    typeof supplied !== "string" ||
    supplied.length !== DEVICE_TOKEN.length
  ) {
    return res.status(401).json({
      success: false,
      error: "Invalid device authentication."
    });
  }

  const valid = crypto.timingSafeEqual(
    Buffer.from(supplied),
    Buffer.from(DEVICE_TOKEN)
  );

  if (!valid) {
    return res.status(401).json({
      success: false,
      error: "Invalid device token."
    });
  }

  next();
}

// ======================================================
// 8. RATE LIMITING
// ======================================================

const requestCounts = new Map();

function rateLimit(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();

  let record = requestCounts.get(ip);

  if (!record || now - record.time > 60000) {
    record = {
      count: 0,
      time: now
    };
  }

  record.count++;

  requestCounts.set(ip, record);

  if (record.count > 10) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait."
    });
  }

  next();
}

const cleanup = setInterval(() => {
  const now = Date.now();

  for (const [ip, record] of requestCounts) {
    if (now - record.time > 60000) {
      requestCounts.delete(ip);
    }
  }
}, 60000);

cleanup.unref();

// ======================================================
// 9. GEMINI ERROR DETECTION
// ======================================================

function getErrorStatus(error) {
  const status = Number(
    error?.status ||
    error?.statusCode ||
    error?.code ||
    error?.response?.status ||
    0
  );

  if (status >= 400 && status <= 599) {
    return status;
  }

  const message = String(
    error?.message || ""
  ).toUpperCase();

  if (message.includes("UNAVAILABLE")) return 503;

  if (message.includes("RESOURCE_EXHAUSTED")) return 429;

  if (message.includes("DEADLINE_EXCEEDED")) return 504;

  if (message.includes("INVALID_ARGUMENT")) return 400;

  return 500;
}

// ======================================================
// 10. AUTOMATIC GEMINI RETRIES
// ======================================================

async function generateWithRetry(fn) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `Gemini attempt ${attempt + 1}/${MAX_RETRIES + 1}`
      );

      return await fn();

    } catch (error) {
      lastError = error;

      const status = getErrorStatus(error);

      const retryable = [
        429,
        500,
        503,
        504
      ].includes(status);

      if (!retryable || attempt === MAX_RETRIES) {
        throw error;
      }

      const delay =
        1500 * Math.pow(2, attempt) +
        Math.floor(Math.random() * 500);

      console.log(
        `Gemini returned ${status}. Retrying after ${delay}ms.`
      );

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }

  throw lastError;
}

// ======================================================
// 11. MAIN GEMINI IMAGE ANALYSIS
// ======================================================

async function analyzeImage(image, customPrompt = "") {
  checkGemini();

  if (!image) {
    const error = new Error("No image received.");
    error.status = 400;
    throw error;
  }

  if (!validateImage(image.buffer, image.mimeType)) {
    const error = new Error(
      "Image is invalid or corrupted."
    );

    error.status = 400;
    throw error;
  }

  const imageBase64 =
    image.buffer.toString("base64");

  const prompt = customPrompt.trim() || `
You are an intelligent visual problem-solving assistant.

Analyze the uploaded image carefully.

If it contains a mathematical question:
- Read the complete question.
- Solve it step by step.
- Show formulas and substitutions.
- Explain the calculation.
- Give the final answer clearly.

If it contains an electronics or engineering question:
- Identify the relevant concepts.
- Explain the working and derivations.
- Include equations and units.
- Provide a clear final answer.

If it contains a circuit, graph, diagram or text:
- Identify its important elements.
- Explain what is shown.
- Do not invent information that cannot be read.

Keep the response accurate, structured and concise.
`;

  const response = await generateWithRetry(async () => {
    return await genAI.models.generateContent({
      model: MODEL,

      contents: [
        {
          role: "user",

          parts: [
            {
              text: prompt
            },

            {
              inlineData: {
                mimeType: image.mimeType,
                data: imageBase64
              }
            }
          ]
        }
      ],

      config: {
        maxOutputTokens: 8192,
        temperature: 0.2
      }
    });
  });

  const answer = response.text || "";

  if (!answer.trim()) {
    const error = new Error(
      "Gemini returned an empty response."
    );

    error.status = 502;
    throw error;
  }

  return {
    success: true,
    answer: answer,
    text: answer,
    model: MODEL,
    finishReason:
      response.candidates?.[0]?.finishReason || "UNKNOWN",
    timestamp: new Date().toISOString()
  };
}

// ======================================================
// 12. CENTRAL ERROR RESPONSE
// ======================================================

function sendError(res, error) {
  const status = error.status ||
    getErrorStatus(error);

  console.error("REQUEST ERROR:", {
    status,
    message: error.message
  });

  let message = error.message ||
    "An unexpected server error occurred.";

  if (status === 429) {
    message =
      "Gemini API rate limit reached. Please wait and try again.";
  }

  if (status === 503) {
    message =
      "Gemini is temporarily unavailable or overloaded. Please retry shortly.";
  }

  if (status === 504) {
    message =
      "Gemini request timed out. Please try again.";
  }

  if (status === 401 || status === 403) {
    message =
      "Gemini authentication failed. Check your API key and permissions.";
  }

  if (status === 500) {
    message =
      "Internal server error: " + message;
  }

  return res.status(
    status >= 400 && status <= 599 ? status : 500
  ).json({
    success: false,
    error: message,
    retryable: [
      429,
      500,
      503,
      504
    ].includes(status)
  });
}

// ======================================================
// 13. HOME PAGE
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "ESP32 Gemini Assistant is running.",
    model: MODEL,
    endpoints: [
      "/health",
      "/api/browser-solve",
      "/api/solve"
    ]
  });
});

// ======================================================
// 14. HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    geminiConfigured: Boolean(API_KEY),
    model: MODEL,
    timestamp: new Date().toISOString()
  });
});

// ======================================================
// 15. BROWSER IMAGE SCANNING
// POST /api/browser-solve
// ======================================================

app.post(
  "/api/browser-solve",
  rateLimit,
  (req, res, next) => {
    if (req.is("multipart/form-data")) {
      return imageUpload(req, res, next);
    }

    next();
  },
  async (req, res) => {
    try {
      console.log("Browser scan request received.");

      const image = getImageFromRequest(req);

      if (!image) {
        return res.status(400).json({
          success: false,
          error: "No valid image received. Upload using image, file or photo."
        });
      }

      const result = await analyzeImage(
        image,
        req.body?.prompt || ""
      );

      console.log("Browser scan successful.");

      return res.status(200).json(result);

    } catch (error) {
      return sendError(res, error);
    }
  }
);

// ======================================================
// 16. ESP32 IMAGE SCANNING
// POST /api/solve
// Requires x-device-token
// ======================================================

app.post(
  "/api/solve",
  authenticateDevice,
  rateLimit,
  (req, res, next) => {
    if (req.is("multipart/form-data")) {
      return imageUpload(req, res, next);
    }

    next();
  },
  async (req, res) => {
    try {
      console.log("ESP32 scan request received.");

      const image = getImageFromRequest(req);

      if (!image) {
        return res.status(400).json({
          success: false,
          error: "No valid image received."
        });
      }

      const result = await analyzeImage(
        image,
        req.body?.prompt || ""
      );

      console.log("ESP32 scan successful.");

      return res.status(200).json(result);

    } catch (error) {
      return sendError(res, error);
    }
  }
);

// ======================================================
// 17. UNKNOWN API ROUTES
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found.",
    path: req.path
  });
});

// ======================================================
// 18. GLOBAL ERROR HANDLER
// ======================================================

app.use((error, req, res, next) => {
  console.error("GLOBAL SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: "Image exceeds the 5 MB upload limit."
      });
    }

    return res.status(400).json({
      success: false,
      error: error.message
    });
  }

  if (error.status) {
    return sendError(res, error);
  }

  return res.status(500).json({
    success: false,
    error: error.message || "Internal server error."
  });
});

// ======================================================
// 19. START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log(" ESP32 GEMINI ASSISTANT");
  console.log(" SERVER STARTED SUCCESSFULLY");
  console.log("====================================");

  console.log("Port:", PORT);
  console.log("Gemini API:", API_KEY ? "CONFIGURED" : "MISSING");
  console.log("Gemini Model:", MODEL);
  console.log("Device Token:", DEVICE_TOKEN ? "CONFIGURED" : "MISSING");

  console.log("------------------------------------");
  console.log("GET  /");
  console.log("GET  /health");
  console.log("POST /api/browser-solve");
  console.log("POST /api/solve");
  console.log("====================================");
});
