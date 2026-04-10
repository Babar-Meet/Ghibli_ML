import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const port = Number(process.env.PORT ?? 8787);

export const config = {
  port,
  serverTimeoutMs: Number(process.env.SERVER_TIMEOUT_MS ?? 120000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "*",
  publicBaseUrl: trimTrailingSlash(
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
  ),
  limits: {
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 10),
  },
  ollama: {
    baseUrl: trimTrailingSlash(
      process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ),
    visionModel: process.env.OLLAMA_VISION_MODEL ?? "llava:13b",
    imageModel: process.env.OLLAMA_IMAGE_MODEL ?? "",
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 90000),
    startupCheck: toBool(process.env.OLLAMA_STARTUP_CHECK, true),
    autoPullMissingModels: toBool(process.env.OLLAMA_AUTO_PULL, true),
    pullOptionalModels: toBool(process.env.OLLAMA_PULL_OPTIONAL_MODELS, false),
  },
  generation: {
    requireAi: toBool(process.env.REQUIRE_AI_GENERATION, false),
    imageBackend: String(process.env.IMAGE_BACKEND ?? "auto").toLowerCase(),
  },
  comfy: {
    enabled: toBool(process.env.COMFYUI_ENABLED, true),
    baseUrl: trimTrailingSlash(
      process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
    ),
    checkpoint: process.env.COMFYUI_CHECKPOINT ?? "",
    lora: {
      name: process.env.COMFYUI_LORA ?? "",
      strengthModel: Number(process.env.COMFYUI_LORA_STRENGTH ?? 0.8),
      strengthClip: Number(process.env.COMFYUI_LORA_STRENGTH ?? 0.8),
    },
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 240000),
    pollIntervalMs: Number(process.env.COMFYUI_POLL_INTERVAL_MS ?? 1200),
    steps: Number(process.env.COMFYUI_STEPS ?? 20),
    cfg: Number(process.env.COMFYUI_CFG ?? 6.5),
    denoise: Number(process.env.COMFYUI_DENOISE ?? 0.35),
    sampler: process.env.COMFYUI_SAMPLER ?? "euler",
    scheduler: process.env.COMFYUI_SCHEDULER ?? "normal",
    promptTemplate:
      process.env.COMFYUI_PROMPT_TEMPLATE ?? "",
    negativePrompt:
      process.env.COMFYUI_NEGATIVE_PROMPT ?? "",
  },
  googleDrive: {
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
    originalFolderId: process.env.GOOGLE_DRIVE_ORIGINAL_FOLDER_ID ?? "",
    generatedFolderId: process.env.GOOGLE_DRIVE_GENERATED_FOLDER_ID ?? "",
    makePublic: toBool(process.env.GOOGLE_DRIVE_MAKE_PUBLIC, true),
  },
  watermark: {
    logoPath: process.env.COLLEGE_LOGO_PATH
      ? path.resolve(process.cwd(), process.env.COLLEGE_LOGO_PATH)
      : path.resolve(
          process.cwd(),
          "..",
          "client",
          "assets",
          "college-logo.svg",
        ),
    showLabel: toBool(process.env.WATERMARK_SHOW_LABEL, true),
  },
};
