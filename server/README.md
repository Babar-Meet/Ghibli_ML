# Server

Node.js API for image intake, branding, Google Drive upload, and Ollama-based conversion.

## Endpoints

- `GET /api/health`
- `POST /api/convert` with multipart field `image`
- `POST /api/jobs` with multipart field `image` (async conversion job)
- `GET /api/jobs/:jobId` (job progress, stage, ETA, result)

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

## Environment

See `.env.example` for all options.

Important values:

- `OLLAMA_BASE_URL`
- `OLLAMA_VISION_MODEL`
- `OLLAMA_IMAGE_MODEL` (required for true AI image generation)
- `OLLAMA_STARTUP_CHECK=true` (check Ollama + required models on server boot)
- `OLLAMA_AUTO_PULL=true` (auto pull missing required models)
- `OLLAMA_PULL_OPTIONAL_MODELS=false` (if true, also auto pull optional vision model)
- `REQUIRE_AI_GENERATION=true` (if true, API returns error instead of fallback image)
- `IMAGE_BACKEND=auto|ollama|comfy|fallback`
- `COMFYUI_ENABLED=true`
- `COMFYUI_BASE_URL=http://127.0.0.1:8188`
- `COMFYUI_CHECKPOINT=DreamShaper_6.2_BakedVae_pruned.safetensors`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_DRIVE_ORIGINAL_FOLDER_ID`
- `GOOGLE_DRIVE_GENERATED_FOLDER_ID`
- `COLLEGE_LOGO_PATH`

## Ollama startup behavior

- On boot, server checks if Ollama is reachable at `OLLAMA_BASE_URL`.
- It verifies required model(s): `OLLAMA_IMAGE_MODEL`.
- It also reports optional model(s): `OLLAMA_VISION_MODEL`.
- If required model(s) are missing and `OLLAMA_AUTO_PULL=true`, it auto pulls them.
- Optional model(s) are pulled only when `OLLAMA_PULL_OPTIONAL_MODELS=true`.
- Status is exposed at `GET /api/health` and `GET /api/ollama/status`.

## Generation behavior

- If `REQUIRE_AI_GENERATION=true` and AI generation is unavailable, API returns `503` with a clear error.
- If `REQUIRE_AI_GENERATION=false`, server can return a fallback stylized filter image.
- API response includes `isAIGenerated` and `warnings` so client can show fallback vs true AI generation.

## Progress and ETA

- The async job API exposes stage progress (`progress`), stage name (`stageLabel`), and server ETA (`etaSeconds`).
- Client UI combines upload progress + server job progress for end-to-end pipeline tracking.

### Backend selection

- `IMAGE_BACKEND=auto`: try Ollama image model first, then ComfyUI.
- `IMAGE_BACKEND=ollama`: only Ollama image model path.
- `IMAGE_BACKEND=comfy`: only ComfyUI path.
- `IMAGE_BACKEND=fallback`: no AI generation, always filter fallback.

### ComfyUI notes

- Keep ComfyUI running before sending `/api/convert` requests.
- `COMFYUI_CHECKPOINT` must match a file in your ComfyUI checkpoints folder.
- If ComfyUI log says `Device: cpu`, generation can be very slow; install CUDA-enabled PyTorch in that environment for GPU use.

## Google Drive credentials setup

You must create a Google service account JSON once and place it at `server/secrets/service-account.json`.

1. Open Google Cloud Console and create/select a project.
2. Enable Google Drive API for that project.
3. Create a Service Account.
4. Create a JSON key and download it.
5. Save it as `server/secrets/service-account.json`.
6. In Google Drive, open your two folders and share both with the service account email (Editor role).
7. Set `.env`: `GOOGLE_APPLICATION_CREDENTIALS=./secrets/service-account.json`.

## Local fallback

If Google Drive is not configured or upload fails, files are saved to local storage and served at `/files/...`.
For local-only testing, set `GOOGLE_APPLICATION_CREDENTIALS=` (empty) to disable Drive mode intentionally.
