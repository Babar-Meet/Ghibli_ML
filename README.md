# Gibali ML Booth (Server + Client)

This project mimics your college photo booth flow with two folders:

- `server`: receives image, adds branding, uploads original and generated images, and returns QR download links.
- `client`: camera GUI with capture + send button.

## Flow

1. Student makes V hand sign.
2. Client captures photo from camera.
3. Client sends image to server (`POST /api/convert`).
4. Server uploads original image.
5. Server tries Ollama conversion to Ghibli style.
6. If Ollama image generation is unavailable, server applies a local stylized fallback filter.
7. Server uploads generated image.
8. Server returns links + QR for both images.

## Project structure

```text
server/
client/
```

## Quick start

### 1) Start server

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

### 2) Start client

```bash
cd client
python -m http.server 5500
```

Open `http://localhost:5500`.

## Ollama setup

Pull a vision model (for prompt extraction):

```bash
ollama pull llava:13b
```

Set in `server/.env`:

```env
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=llava:13b
```

If you have an Ollama model that can directly output images, set:

```env
OLLAMA_IMAGE_MODEL=your-image-model-name
```

If not set, fallback filter is used so testing still works.

## Google Drive setup

In `server/.env` configure:

```env
GOOGLE_APPLICATION_CREDENTIALS=./secrets/service-account.json
GOOGLE_DRIVE_ORIGINAL_FOLDER_ID=...
GOOGLE_DRIVE_GENERATED_FOLDER_ID=...
```

Notes:

- Share both folders with your service account email.
- If Drive config is missing, files are stored locally in `server/local-storage/`.

## Branding

- Default logo file: `client/assets/college-logo.svg`
- Replace it with your official college logo.
- Both original and generated outputs get a branded strip and logo by default.

## Deployment idea

- Keep the same `client`.
- Deploy `server` on your RTX 4000 host.
- Point `window.APP_CONFIG.apiBaseUrl` in `client/index.html` to server public URL.
