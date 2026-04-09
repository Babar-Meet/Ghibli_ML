const API_BASE_URL = (
  window.APP_CONFIG?.apiBaseUrl || "http://localhost:8787"
).replace(/\/$/, "");

const JOB_POLL_INTERVAL_MS = 1000;
const UPLOAD_WEIGHT_PERCENT = 22;

const cameraFeed = document.getElementById("cameraFeed");
const captureCanvas = document.getElementById("captureCanvas");
const capturePreview = document.getElementById("capturePreview");
const captureStatus = document.getElementById("captureStatus");

const startBtn = document.getElementById("startBtn");
const captureBtn = document.getElementById("captureBtn");
const retakeBtn = document.getElementById("retakeBtn");
const sendBtn = document.getElementById("sendBtn");

const pipelinePanel = document.getElementById("pipelinePanel");
const pipelineStage = document.getElementById("pipelineStage");
const pipelinePercent = document.getElementById("pipelinePercent");
const pipelineFill = document.getElementById("pipelineFill");
const pipelineEta = document.getElementById("pipelineEta");
const pipelineMeta = document.getElementById("pipelineMeta");

const resultPlaceholder = document.getElementById("resultPlaceholder");
const resultContent = document.getElementById("resultContent");
const serverInfo = document.getElementById("serverInfo");

const originalImage = document.getElementById("originalImage");
const originalQr = document.getElementById("originalQr");
const originalView = document.getElementById("originalView");
const originalDownload = document.getElementById("originalDownload");

const generatedImage = document.getElementById("generatedImage");
const generatedQr = document.getElementById("generatedQr");
const generatedView = document.getElementById("generatedView");
const generatedDownload = document.getElementById("generatedDownload");

const SERVER_STAGE_LABELS = {
  queued: "Queued on server",
  normalizing: "Preparing image",
  ai_generate: "Generating Ghibli image",
  brand_original: "Branding original",
  upload_original: "Uploading original",
  brand_generated: "Branding generated",
  upload_generated: "Uploading generated",
  qrcode: "Generating QR",
  done: "Completed",
  error: "Failed",
};

let mediaStream = null;
let capturedBlob = null;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatSeconds(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "--";
  }

  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function setStatus(message, tone = "neutral") {
  captureStatus.textContent = message;
  captureStatus.dataset.tone = tone;
}

function setBusy(isBusy) {
  sendBtn.disabled = isBusy;
  captureBtn.disabled = isBusy;
  retakeBtn.disabled = isBusy;
}

function updatePipeline({ stage, progress, etaSeconds, meta }) {
  pipelinePanel.classList.remove("hidden");

  const boundedProgress = Math.max(0, Math.min(100, Math.round(progress)));
  pipelineStage.textContent = stage;
  pipelinePercent.textContent = `${boundedProgress}%`;
  pipelineFill.style.width = `${boundedProgress}%`;
  pipelineEta.textContent = `ETA ${formatSeconds(etaSeconds)}`;
  pipelineMeta.textContent = meta;
}

function resetPipeline() {
  pipelinePanel.classList.add("hidden");
  pipelineStage.textContent = "Idle";
  pipelinePercent.textContent = "0%";
  pipelineFill.style.width = "0%";
  pipelineEta.textContent = "ETA --";
  pipelineMeta.textContent = "Waiting to start...";
}

async function startCamera() {
  if (mediaStream) {
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
      audio: false,
    });

    cameraFeed.srcObject = mediaStream;
    cameraFeed.classList.remove("hidden");
    capturePreview.classList.add("hidden");
    setStatus(
      "Camera is ready. Ask student to show V sign and click Capture.",
      "success",
    );
  } catch (error) {
    setStatus(`Unable to access camera: ${error.message}`, "error");
  }
}

function stopCamera() {
  if (!mediaStream) {
    return;
  }

  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function captureImageBlob() {
  const width = cameraFeed.videoWidth;
  const height = cameraFeed.videoHeight;

  if (!width || !height) {
    throw new Error("Camera frame not ready yet.");
  }

  captureCanvas.width = width;
  captureCanvas.height = height;

  const ctx = captureCanvas.getContext("2d");
  ctx.drawImage(cameraFeed, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    captureCanvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not capture image frame."));
          return;
        }

        resolve(blob);
      },
      "image/png",
      1,
    );
  });
}

async function captureFrame() {
  try {
    if (!mediaStream) {
      await startCamera();
    }

    capturedBlob = await captureImageBlob();
    capturePreview.src = URL.createObjectURL(capturedBlob);
    capturePreview.classList.remove("hidden");
    cameraFeed.classList.add("hidden");
    setStatus("Photo captured. Click Send to Booth.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function resetCapture() {
  capturedBlob = null;
  capturePreview.removeAttribute("src");
  capturePreview.classList.add("hidden");
  cameraFeed.classList.remove("hidden");
  resultContent.classList.add("hidden");
  resultPlaceholder.classList.remove("hidden");
  resetPipeline();
  setStatus("Retake ready.", "neutral");
}

function renderResult(payload) {
  resultPlaceholder.classList.add("hidden");
  resultContent.classList.remove("hidden");

  originalImage.src = payload.original.previewUrl;
  originalQr.src = payload.original.qrCodeDataUrl;
  originalView.href = payload.original.viewUrl;
  originalDownload.href = payload.original.downloadUrl;

  generatedImage.src = payload.generated.previewUrl;
  generatedQr.src = payload.generated.qrCodeDataUrl;
  generatedView.href = payload.generated.viewUrl;
  generatedDownload.href = payload.generated.downloadUrl;

  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const generationLabel = payload.isAIGenerated
    ? "AI generation active"
    : "Fallback output (not true AI generation)";

  const infoLines = [
    `Job: ${payload.jobId}`,
    `Mode: ${generationLabel}`,
    `Source: ${payload.processingSource}`,
    `Storage: original=${payload.original?.storage || "unknown"}, generated=${payload.generated?.storage || "unknown"}`,
    `Prompt: ${payload.prompt}`,
  ];

  if (payload.timingsMs?.total) {
    infoLines.push(
      `Server total: ${formatSeconds(payload.timingsMs.total / 1000)}`,
    );
  }

  if (warnings.length > 0) {
    infoLines.push(`Warnings: ${warnings.join(" | ")}`);
  }

  serverInfo.textContent = infoLines.join("\n");
  serverInfo.dataset.tone = payload.isAIGenerated ? "success" : "error";
}

function startJobUpload(imageBlob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const uploadStart = performance.now();
    const formData = new FormData();

    formData.append("image", imageBlob, `capture-${Date.now()}.png`);

    xhr.open("POST", `${API_BASE_URL}/api/jobs`);
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      const uploadPercent =
        event.total > 0 ? (event.loaded / event.total) * 100 : 0;
      const elapsedSec = Math.max(
        0.001,
        (performance.now() - uploadStart) / 1000,
      );
      const speedBytesSec = event.loaded / elapsedSec;
      const bytesRemaining = Math.max(0, event.total - event.loaded);
      const etaSeconds =
        speedBytesSec > 0 ? bytesRemaining / speedBytesSec : null;
      const overallProgress = (uploadPercent / 100) * UPLOAD_WEIGHT_PERCENT;

      updatePipeline({
        stage: "Uploading image",
        progress: overallProgress,
        etaSeconds,
        meta: `${formatBytes(speedBytesSec)}/s`,
      });
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed. Please check connection and retry."));
    };

    xhr.ontimeout = () => {
      reject(new Error("Upload timed out."));
    };

    xhr.onload = () => {
      const payload =
        xhr.response && typeof xhr.response === "object"
          ? xhr.response
          : JSON.parse(xhr.responseText || "{}");

      if (xhr.status < 200 || xhr.status >= 300 || !payload.ok) {
        reject(
          new Error(
            payload.error || `Failed to create job (status ${xhr.status}).`,
          ),
        );
        return;
      }

      resolve(payload);
    };

    xhr.send(formData);
  });
}

async function waitForJobResult(jobId) {
  while (true) {
    const response = await fetch(
      `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}`,
    );

    const payload = await response.json().catch(() => ({
      ok: false,
      error: "Server returned invalid job status.",
    }));

    if (!response.ok || !payload.ok || !payload.job) {
      throw new Error(
        payload.error || `Job status failed with ${response.status}.`,
      );
    }

    const job = payload.job;
    const stageLabel =
      job.stageLabel || SERVER_STAGE_LABELS[job.stage] || "Processing";

    const serverProgress = Math.max(
      0,
      Math.min(100, Number(job.progress || 0)),
    );
    const overallProgress =
      UPLOAD_WEIGHT_PERCENT +
      (serverProgress / 100) * (100 - UPLOAD_WEIGHT_PERCENT);

    updatePipeline({
      stage: stageLabel,
      progress: job.status === "completed" ? 100 : overallProgress,
      etaSeconds: job.etaSeconds,
      meta: job.message || "Working...",
    });

    if (job.status === "completed") {
      return job.result;
    }

    if (job.status === "error") {
      throw new Error(job.error || "Generation failed.");
    }

    await delay(JOB_POLL_INTERVAL_MS);
  }
}

async function sendToBooth() {
  if (!capturedBlob) {
    setStatus("Capture a photo first.", "error");
    return;
  }

  setBusy(true);
  resultContent.classList.add("hidden");
  resultPlaceholder.classList.remove("hidden");
  updatePipeline({
    stage: "Starting",
    progress: 0,
    etaSeconds: null,
    meta: "Preparing upload...",
  });
  setStatus("Uploading image and waiting for conversion...", "neutral");

  const startedAt = performance.now();

  try {
    const createdJob = await startJobUpload(capturedBlob);

    updatePipeline({
      stage: "Queued on server",
      progress: UPLOAD_WEIGHT_PERCENT,
      etaSeconds: null,
      meta: `Job ${createdJob.jobId}`,
    });

    const result = await waitForJobResult(createdJob.jobId);
    renderResult(result);

    const totalSeconds = (performance.now() - startedAt) / 1000;
    updatePipeline({
      stage: "Completed",
      progress: 100,
      etaSeconds: 0,
      meta: `Total ${formatSeconds(totalSeconds)}`,
    });

    setStatus("Success. QR and links are ready for download.", "success");
  } catch (error) {
    updatePipeline({
      stage: "Failed",
      progress: 100,
      etaSeconds: 0,
      meta: error.message,
    });
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
}

startBtn.addEventListener("click", startCamera);
captureBtn.addEventListener("click", captureFrame);
retakeBtn.addEventListener("click", resetCapture);
sendBtn.addEventListener("click", sendToBooth);

window.addEventListener("beforeunload", () => {
  stopCamera();
});
