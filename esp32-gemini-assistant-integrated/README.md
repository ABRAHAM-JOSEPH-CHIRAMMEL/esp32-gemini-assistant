# ESP32 Gemini Study Assistant — integrated backend and browser simulator

Deploy this folder as the Render service root directory using Node 22.

## Render environment variables

Keep these existing variables:
- `GEMINI_API_KEY` — Gemini API key (secret)
- `DEVICE_TOKEN` — long random device token (secret)
- `GEMINI_MODEL` — keep the model currently configured for this service

Optional:
- `MAX_OUTPUT_TOKENS` — answer generation token ceiling; default 8192

Do not put either secret in browser code or firmware source committed to GitHub. Configure them in Render's Environment settings.

## Routes

- `/` — browser simulator
- `/health` — health check
- `/api/browser-solve` — browser simulator, no device token
- `/api/solve` — physical ESP32 endpoint, requires `x-device-token`

Both solve endpoints accept multipart form data:
- file field: `image` (JPG, PNG or WebP, maximum 5 MB)
- optional text field: `prompt`

## Question-paper pipeline

1. Extract question labels and descriptions from the full uploaded image.
2. Build an ordered inventory, retaining subquestions and both OR alternatives as separate items.
3. Generate one combined answer sheet using that inventory.
4. Audit the answer sheet against unique inventory IDs.
5. If the audit reports missing items, request one targeted repair and audit the combined answer again.

The response keeps the existing `answer` field for API compatibility and adds `questionCount`, `questionNumbers`, `questionInventory`, `missingQuestions`, `unclearQuestions`, `completenessVerified`, and audit metadata.

A successful HTTP response does not mean the answer is complete. The client must check `completenessVerified`, review missing/unreadable items, and treat `finishReason: "MAX_TOKENS"` as incomplete. Gemini can misread scans or audits; human review is still required. Multi-stage processing uses multiple Gemini requests and can consume API quota.

## Local validation

From this folder:
```bash
npm install
npm run check
npm start
```

A GitHub Actions workflow runs the syntax check on changes to this folder.

## Physical ESP32 firmware status

The repository currently contains no ESP32 `.ino` firmware source. Therefore the physical device's multipart upload, JSON response handling, full-answer buffering, OLED wrapping and page navigation have not yet been verified or updated here.

The device must read the complete `answer` string from `/api/solve`, not stop at the first JSON fragment or first OLED page. It should paginate the entire answer and display the audit status. Please add the exact firmware sketch used on your XIAO ESP32-S3 Sense so it can be integrated against your actual camera, button and OLED wiring. Do not assume OLED controller or pin mapping without checking the module and wiring.
