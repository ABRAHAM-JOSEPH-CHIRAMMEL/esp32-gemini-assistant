PATCH server.js — REQUIRED BEFORE USING THE NO-TOKEN SIMULATOR

Important:
- Keep the existing /api/solve endpoint and DEVICE_TOKEN authentication for the ESP32.
- This adds /api/browser-solve for the local browser simulator.
- The browser route does not ask for DEVICE_TOKEN. It is publicly reachable, so it is limited to 3 scans per IP per 5 minutes, plus the existing 5 MB image limit.
- This is not user-account authentication. Anyone who discovers the endpoint may attempt to use it within the rate limit. Monitor Gemini usage in Google AI Studio.

CHANGE 1 — trust the Render proxy
Find:
  app.disable("x-powered-by");

Replace with:
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

CHANGE 2 — allow a local HTML file origin
Find this CORS condition:
    if (!origin || allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)) {

Replace with:
    if (!origin || origin === "null" || allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)) {

CHANGE 3 — add this browser rate limiter
Insert this block after the existing rateLimit(req, res, next) function and before the IMAGE UPLOAD section:

// Public browser route: strict per-IP limit because it does not ask for a token.
const browserRequestCounts = new Map();

function browserRateLimit(req, res, next) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxRequests = 3;
  const ip = req.ip || "unknown";
  let record = browserRequestCounts.get(ip);

  if (!record || now - record.start >= windowMs) {
    record = { start: now, count: 0 };
  }

  record.count++;
  browserRequestCounts.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      error: "Browser scan limit reached. Please wait five minutes before trying again."
    });
  }

  next();
}

CHANGE 4 — change the existing /api/solve route middleware
Find the beginning of the existing route:
  app.post(
    "/api/solve",
    rateLimit,
    authenticateDevice,
    upload.single("image"),

Replace only those lines with:
  app.post(
    ["/api/solve", "/api/browser-solve"],
    (req, res, next) => {
      if (req.path === "/api/browser-solve") {
        return browserRateLimit(req, res, () => {
          if (!process.env.DEVICE_TOKEN) {
            return res.status(503).json({
              error: "Server DEVICE_TOKEN is not configured."
            });
          }

          // The secret stays on Render; it is never sent to the browser.
          req.headers["x-device-token"] = process.env.DEVICE_TOKEN;
          next();
        });
      }

      return rateLimit(req, res, next);
    },
    authenticateDevice,
    upload.single("image"),

Do not change the rest of the route handler. It must continue into the existing async (req, res) => { ... } code.

After saving server.js:
1. Commit/push the change to the GitHub main branch (or upload the revised server.js).
2. Wait for Render to finish deploying.
3. Open https://esp32-gemini-assistant.onrender.com/ and confirm it says status online.
4. Open Gemini_OLED_Simulator_NoToken.html in Chrome.
5. Select an image and click SCAN WITH GEMINI. No device token is entered in the simulator.

If you receive a CORS error, check that CHANGE 2 was deployed.
If you receive 404 for /api/browser-solve, CHANGE 4 was not deployed.
If you receive 429, wait five minutes before trying again.
