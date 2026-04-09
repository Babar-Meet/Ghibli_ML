import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import QRCode from "qrcode";
import { config } from "./config.js";
import {
  ensureLocalStorageReady,
  getLocalStorageRoot,
  getDriveStatus,
  uploadImage,
} from "./services/driveService.js";
import {
  createGhibliImage,
  normalizeImage,
  stampImageWithCollegeBrand,
} from "./services/imageService.js";
import {
  ensureOllamaAndModelsReady,
  getOllamaStartupStatus,
} from "./services/ollamaService.js";
import { getComfyStatus } from "./services/comfyService.js";

const app = express();
app.timeout = config.serverTimeoutMs;

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const STAGE_PROGRESS = {
  queued: 5,
  normalizing: 18,
  ai_generate: 56,
  brand_original: 66,
  upload_original: 76,
  brand_generated: 86,
  upload_generated: 94,
  qrcode: 98,
  done: 100,
  error: 100,
};

const STAGE_LABELS = {
  queued: "Queued",
  normalizing: "Preparing input image",
  ai_generate: "Generating Ghibli image",
  brand_original: "Branding original image",
  upload_original: "Uploading original image",
  brand_generated: "Branding generated image",
  upload_generated: "Uploading generated image",
  qrcode: "Building QR downloads",
  done: "Completed",
  error: "Failed",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.limits.maxUploadMb * 1024 * 1024,
  },
});

const corsOrigin =
  config.clientOrigin === "*"
    ? true
    : config.clientOrigin.split(",").map((origin) => origin.trim());

app.use(
  cors({
    origin: corsOrigin,
  }),
);

app.use("/files", express.static(getLocalStorageRoot()));

function makeJobId() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function makeJobRecord(jobId, fileSizeBytes) {
  const now = Date.now();

  return {
    id: jobId,
    status: "processing",
    stage: "queued",
    message: "Image queued",
    progress: STAGE_PROGRESS.queued,
    fileSizeBytes,
    createdAtMs: now,
    startedAtMs: now,
    updatedAtMs: now,
    finishedAtMs: null,
    error: null,
    statusCode: null,
    result: null,
  };
}

function updateJobStage(job, stage, message) {
  job.stage = stage;
  job.message = message;
  job.progress = STAGE_PROGRESS[stage] ?? job.progress;
  job.updatedAtMs = Date.now();
}

function finishJobWithSuccess(job, result) {
  job.status = "completed";
  job.stage = "done";
  job.message = "Job completed";
  job.progress = STAGE_PROGRESS.done;
  job.result = result;
  job.finishedAtMs = Date.now();
  job.updatedAtMs = job.finishedAtMs;
}

function finishJobWithError(job, error) {
  const statusCode = Number(error?.statusCode || 500);
  const details = error?.details;

  job.status = "error";
  job.stage = "error";
  job.message = "Job failed";
  job.progress = STAGE_PROGRESS.error;
  job.error = error?.message || "Internal server error.";
  job.statusCode = statusCode;
  job.result = details ? { details } : null;
  job.finishedAtMs = Date.now();
  job.updatedAtMs = job.finishedAtMs;
}

function estimateEtaSeconds(job) {
  if (job.status !== "processing") {
    return 0;
  }

  if (job.progress < 8) {
    return null;
  }

  const elapsedSeconds = Math.max(1, (Date.now() - job.startedAtMs) / 1000);
  const remainingRatio = Math.max(0, (100 - job.progress) / job.progress);
  return Math.round(elapsedSeconds * remainingRatio);
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageLabel: STAGE_LABELS[job.stage] ?? job.stage,
    progress: job.progress,
    message: job.message,
    etaSeconds: estimateEtaSeconds(job),
    fileSizeBytes: job.fileSizeBytes,
    createdAt: new Date(job.createdAtMs).toISOString(),
    startedAt: new Date(job.startedAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    finishedAt: job.finishedAtMs
      ? new Date(job.finishedAtMs).toISOString()
      : null,
    error: job.error,
    statusCode: job.statusCode,
    result: job.status === "completed" ? job.result : null,
  };
}

function buildConversionWarnings({ originalUpload, generatedUpload, source }) {
  const warnings = [];

  if (
    originalUpload.storage !== "drive" ||
    generatedUpload.storage !== "drive"
  ) {
    warnings.push(
      "Google Drive is not active. Files are currently stored on local server storage.",
    );
  }

  if (source === "fallback-no-image-model") {
    warnings.push(
      "OLLAMA_IMAGE_MODEL is empty. Generated output is a fallback stylized filter, not true AI image generation.",
    );
  }

  if (source === "fallback-no-comfy-checkpoint") {
    warnings.push(
      "ComfyUI checkpoint is not configured. Set COMFYUI_CHECKPOINT to your checkpoint filename.",
    );
  }

  if (source === "fallback-ai-backend-failed") {
    warnings.push(
      "Configured AI backend failed or model unavailable. Generated output is a fallback stylized filter.",
    );
  }

  if (source === "fallback-forced") {
    warnings.push(
      "Image backend is set to fallback. Configure IMAGE_BACKEND=auto, ollama, or comfy for AI generation.",
    );
  }

  return warnings;
}

async function runConversionPipeline({ jobId, inputBuffer, onStage }) {
  const aiSources = ["ollama-image-model", "comfyui-image-model"];
  const timingsMs = {};

  async function measure(name, fn) {
    const startMs = Date.now();
    const value = await fn();
    timingsMs[name] = Date.now() - startMs;
    return value;
  }

  onStage("normalizing", "Preparing input image");
  const normalizedOriginal = await measure("normalize", () =>
    normalizeImage(inputBuffer),
  );

  onStage("ai_generate", "Generating Ghibli image");
  const ghibli = await measure("aiGenerate", () =>
    createGhibliImage(normalizedOriginal),
  );

  if (config.generation.requireAi && !aiSources.includes(ghibli.source)) {
    const error = new Error(
      "AI image generation is required but not active. Configure OLLAMA_IMAGE_MODEL, or use IMAGE_BACKEND=comfy with COMFYUI_CHECKPOINT, or set REQUIRE_AI_GENERATION=false to allow temporary fallback.",
    );

    error.statusCode = 503;
    error.details = {
      processingSource: ghibli.source,
      prompt: ghibli.prompt,
      ollama: getOllamaStartupStatus(),
      comfy: getComfyStatus(),
    };

    throw error;
  }

  onStage("brand_original", "Branding original image");
  const originalBranded = await measure("brandOriginal", () =>
    stampImageWithCollegeBrand(normalizedOriginal, "Original | College Booth"),
  );

  onStage("upload_original", "Uploading original image");
  const originalUpload = await measure("uploadOriginal", () =>
    uploadImage({
      buffer: originalBranded,
      mimeType: "image/png",
      fileName: `${jobId}-original`,
      kind: "original",
    }),
  );

  onStage("brand_generated", "Branding generated image");
  const generatedBranded = await measure("brandGenerated", () =>
    stampImageWithCollegeBrand(ghibli.imageBuffer, "Ghibli | College Booth"),
  );

  onStage("upload_generated", "Uploading generated image");
  const generatedUpload = await measure("uploadGenerated", () =>
    uploadImage({
      buffer: generatedBranded,
      mimeType: "image/png",
      fileName: `${jobId}-ghibli`,
      kind: "generated",
    }),
  );

  onStage("qrcode", "Building QR downloads");
  const [originalQrCodeDataUrl, generatedQrCodeDataUrl] = await measure(
    "qrcode",
    () =>
      Promise.all([
        QRCode.toDataURL(originalUpload.downloadUrl, {
          width: 280,
          margin: 1,
        }),
        QRCode.toDataURL(generatedUpload.downloadUrl, {
          width: 280,
          margin: 1,
        }),
      ]),
  );

  const total = Object.values(timingsMs).reduce((sum, value) => sum + value, 0);
  const warnings = buildConversionWarnings({
    originalUpload,
    generatedUpload,
    source: ghibli.source,
  });

  return {
    jobId,
    processingSource: ghibli.source,
    isAIGenerated: aiSources.includes(ghibli.source),
    prompt: ghibli.prompt,
    warnings,
    timingsMs: {
      ...timingsMs,
      total,
    },
    original: {
      ...originalUpload,
      qrCodeDataUrl: originalQrCodeDataUrl,
    },
    generated: {
      ...generatedUpload,
      qrCodeDataUrl: generatedQrCodeDataUrl,
    },
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "Gibali ML server is running.",
    endpoints: {
      health: "/api/health",
      convert: "POST /api/convert (multipart field: image)",
      createJob: "POST /api/jobs (multipart field: image)",
      getJob: "GET /api/jobs/:jobId",
    },
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    ollamaBaseUrl: config.ollama.baseUrl,
    requireAiGeneration: config.generation.requireAi,
    imageBackend: config.generation.imageBackend,
    ollama: getOllamaStartupStatus(),
    comfy: getComfyStatus(),
    drive: getDriveStatus(),
  });
});

app.get("/api/ollama/status", (_req, res) => {
  res.json({
    ok: true,
    ollama: getOllamaStartupStatus(),
  });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: "Job not found.",
    });
  }

  return res.json({
    ok: true,
    job: serializeJob(job),
  });
});

app.post("/api/convert", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error:
          "No image file found. Use multipart/form-data with field name 'image'.",
      });
    }

    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        ok: false,
        error: "Only image uploads are supported.",
      });
    }

    const jobId = makeJobId();
    const result = await runConversionPipeline({
      jobId,
      inputBuffer: req.file.buffer,
      onStage: () => {},
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error?.statusCode && error?.details) {
      return res.status(error.statusCode).json({
        ok: false,
        error: error.message,
        ...error.details,
      });
    }

    next(error);
  }
});

app.post("/api/jobs", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error:
        "No image file found. Use multipart/form-data with field name 'image'.",
    });
  }

  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({
      ok: false,
      error: "Only image uploads are supported.",
    });
  }

  const jobId = makeJobId();
  const job = makeJobRecord(jobId, req.file.size ?? req.file.buffer.length);
  jobs.set(jobId, job);

  const inputBuffer = Buffer.from(req.file.buffer);

  void (async () => {
    try {
      updateJobStage(job, "queued", "Image queued for processing");
      const result = await runConversionPipeline({
        jobId,
        inputBuffer,
        onStage: (stage, message) => updateJobStage(job, stage, message),
      });
      finishJobWithSuccess(job, result);
    } catch (error) {
      finishJobWithError(job, error);
      console.error(`[jobs] ${jobId} failed:`, error.message);
    }
  })();

  return res.status(202).json({
    ok: true,
    jobId,
    statusUrl: `/api/jobs/${jobId}`,
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      ok: false,
      error: `Image is too large. Max allowed: ${config.limits.maxUploadMb} MB.`,
    });
  }

  console.error(error);
  return res.status(500).json({
    ok: false,
    error: error.message || "Internal server error.",
  });
});

const sweepTimer = setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const finished = job.finishedAtMs ?? job.updatedAtMs;
    if (now - finished > JOB_RETENTION_MS) {
      jobs.delete(jobId);
    }
  }
}, JOB_SWEEP_INTERVAL_MS);

if (typeof sweepTimer.unref === "function") {
  sweepTimer.unref();
}

await ensureLocalStorageReady();
app.listen(config.port, () => {
  console.log(`Gibali ML server listening on http://localhost:${config.port}`);

  const usesOllamaBackend = ["auto", "ollama"].includes(
    config.generation.imageBackend,
  );
  const usesComfyBackend = ["auto", "comfy"].includes(
    config.generation.imageBackend,
  );

  const hasOllamaImagePath =
    usesOllamaBackend && Boolean(config.ollama.imageModel);
  const hasComfyImagePath =
    usesComfyBackend &&
    config.comfy.enabled &&
    Boolean(config.comfy.checkpoint);

  if (
    config.generation.requireAi &&
    !hasOllamaImagePath &&
    !hasComfyImagePath
  ) {
    console.warn(
      "[preflight] REQUIRE_AI_GENERATION=true but no AI backend is fully configured. Set OLLAMA_IMAGE_MODEL or COMFYUI_CHECKPOINT based on IMAGE_BACKEND.",
    );
  }

  if (usesComfyBackend && config.comfy.enabled && !config.comfy.checkpoint) {
    console.warn(
      "[preflight] ComfyUI backend is enabled but COMFYUI_CHECKPOINT is empty. Generation will fall back.",
    );
  }

  if (!config.googleDrive.credentialsPath) {
    console.warn(
      "[preflight] GOOGLE_APPLICATION_CREDENTIALS is empty. Files will use local storage until Drive credentials are configured.",
    );
  }

  if (config.ollama.startupCheck) {
    console.log("[ollama] Startup check is enabled.");
    void ensureOllamaAndModelsReady().then((status) => {
      if (!status.reachable) {
        console.warn(
          `[ollama] Not reachable at ${status.baseUrl}: ${status.error}`,
        );
        return;
      }

      if (status.missingModels.length > 0) {
        console.warn(
          `[ollama] Missing models after startup check: ${status.missingModels.join(", ")}`,
        );
        return;
      }

      if (status.pulledModels.length > 0) {
        console.log(
          `[ollama] Pulled models: ${status.pulledModels.join(", ")}`,
        );
      }

      console.log("[ollama] Ready with required models.");
    });
  }
});
