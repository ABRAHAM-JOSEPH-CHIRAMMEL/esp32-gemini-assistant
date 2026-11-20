# ESP32 Gemini Study Assistant — integrated simulator

Deploy this folder as the Render service root directory using Node 22.

Keep existing Render environment variables:
- GEMINI_API_KEY
- DEVICE_TOKEN
- GEMINI_MODEL (keep your existing model value)

Optional:
- MAX_OUTPUT_TOKENS (default 8192)
- ALLOWED_ORIGINS (only for separately hosted trusted browser origins)

Routes:
- `/` — simulator hosted by this same Render service
- `/health` — health check
- `/api/browser-solve` — browser simulator, no device token
- `/api/solve` — ESP32, requires `x-device-token`

The simulator uses a relative URL (`/api/browser-solve`), so the browser
and API share the same origin. The permanent question-paper/OLED prompt
is stored in server.js and is included on every scan.

A single Gemini response can still hit its output limit. Automatic
multi-request continuation is not included. Physical OLED wrapping,
scrolling and glyph support remain firmware responsibilities.
