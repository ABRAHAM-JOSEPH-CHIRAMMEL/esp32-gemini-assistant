# ESP32 Gemini Study Assistant backend

## Files
- `server.js` — Express API server
- `package.json` — pinned Node.js dependencies

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Node version: 22.x (also enforced by `package.json`)

## Required environment variables
Set these in Render → your service → Environment:
- `GEMINI_API_KEY` — your Google Gemini API key
- `DEVICE_TOKEN` — a long, random secret shared with your ESP32 firmware

Optional:
- `GEMINI_MODEL` — defaults to `gemini-3.6-flash`
- `ALLOWED_ORIGINS` — comma-separated browser origins, if using a browser client

Do not put API keys or device tokens in GitHub or share them in chat.

## API
- `GET /` — service status
- `GET /health` — health check
- `POST /api/solve` — multipart form upload; image field must be named `image`
  - Header: `x-device-token: YOUR_DEVICE_TOKEN`
  - Optional text field: `prompt`
  - Accepted images: JPEG, PNG, WEBP; maximum 5 MB

The `/health` endpoint confirms that the server is running; it does not verify Gemini credentials.
