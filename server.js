
import express from "express";
import cors from "cors";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG and WEBP images are accepted."));
    }
    cb(null, true);
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "ESP32 Gemini Study Assistant"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/solve", upload.single("image"), async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const deviceToken = process.env.DEVICE_TOKEN;

    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured."
      });
    }

    if (!deviceToken ||
        req.get("x-device-token") !== deviceToken) {
      return res.status(401).json({
        error: "Unauthorized device."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No image received."
      });
    }

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
You are an educational study assistant.
Read the uploaded image carefully.
Explain the visible question or subject clearly.
Give the relevant formulas and step-by-step reasoning.
Do not invent unreadable information.
Keep the response concise enough for a small OLED display.
Use plain text without complex formatting.

${req.body.prompt || "Explain the uploaded material."}
`;

    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: [
        prompt,
        {
          inlineData: {
            mimeType: req.file.mimetype,
            data: req.file.buffer.toString("base64")
          }
        }
      ],
      config: {
        maxOutputTokens: 1200
      }
    });

    res.json({
      success: true,
      answer: result.text || "No answer returned."
    });

  } catch (error) {
    console.error("AI error:", error.message);

    res.status(500).json({
      error: "AI processing failed. Check server logs."
    });
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 400).json({
    error: error.message || "Request failed."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Gemini server running on port " + PORT);
});
