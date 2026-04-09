import crypto from "node:crypto";
import { config } from "../config.js";

let warnedComfyDisabled = false;
let warnedComfyNotConfigured = false;

function comfyEndpoint(pathname) {
  return `${config.comfy.baseUrl}${pathname}`;
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

async function comfyFetchJson(
  pathname,
  options = {},
  timeoutMs = config.comfy.timeoutMs,
) {
  const { controller, timeoutId } = withTimeoutSignal(timeoutMs);

  try {
    const response = await fetch(comfyEndpoint(pathname), {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `ComfyUI request failed (${response.status}): ${errorText}`,
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function comfyFetchBuffer(pathname, timeoutMs = config.comfy.timeoutMs) {
  const { controller, timeoutId } = withTimeoutSignal(timeoutMs);

  try {
    const response = await fetch(comfyEndpoint(pathname), {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `ComfyUI image fetch failed (${response.status}): ${errorText}`,
      );
    }

    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes);
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildWorkflow({ uploadedImageName, prompt }) {
  const positivePrompt = config.comfy.promptTemplate.replace(
    "{prompt}",
    prompt,
  );

  return {
    1: {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: config.comfy.checkpoint,
      },
    },
    2: {
      class_type: "LoadImage",
      inputs: {
        image: uploadedImageName,
        upload: "image",
      },
    },
    3: {
      class_type: "VAEEncode",
      inputs: {
        pixels: ["2", 0],
        vae: ["1", 2],
      },
    },
    4: {
      class_type: "CLIPTextEncode",
      inputs: {
        text: positivePrompt,
        clip: ["1", 1],
      },
    },
    5: {
      class_type: "CLIPTextEncode",
      inputs: {
        text: config.comfy.negativePrompt,
        clip: ["1", 1],
      },
    },
    6: {
      class_type: "KSampler",
      inputs: {
        seed: randomSeed(),
        steps: config.comfy.steps,
        cfg: config.comfy.cfg,
        sampler_name: config.comfy.sampler,
        scheduler: config.comfy.scheduler,
        denoise: config.comfy.denoise,
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["3", 0],
      },
    },
    7: {
      class_type: "VAEDecode",
      inputs: {
        samples: ["6", 0],
        vae: ["1", 2],
      },
    },
    8: {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "gibali",
        images: ["7", 0],
      },
    },
  };
}

async function uploadInputImage(inputBuffer) {
  const uploadName = `gibali-input-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
  const formData = new FormData();

  formData.append(
    "image",
    new Blob([inputBuffer], { type: "image/png" }),
    uploadName,
  );
  formData.append("type", "input");
  formData.append("overwrite", "true");

  const payload = await comfyFetchJson(
    "/upload/image",
    {
      method: "POST",
      body: formData,
    },
    config.comfy.timeoutMs,
  );

  return payload?.name ?? uploadName;
}

async function queuePrompt(promptWorkflow) {
  const clientId = crypto.randomUUID();

  const payload = await comfyFetchJson(
    "/prompt",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        prompt: promptWorkflow,
      }),
    },
    config.comfy.timeoutMs,
  );

  if (!payload?.prompt_id) {
    throw new Error("ComfyUI did not return prompt_id.");
  }

  return payload.prompt_id;
}

function extractOutputImageRef(historyEntry) {
  const outputs = historyEntry?.outputs ?? {};

  for (const nodeId of Object.keys(outputs)) {
    const images = outputs[nodeId]?.images;
    if (Array.isArray(images) && images[0]) {
      return images[0];
    }
  }

  return null;
}

async function waitForCompletion(promptId) {
  const start = Date.now();

  while (Date.now() - start < config.comfy.timeoutMs) {
    const history = await comfyFetchJson(
      `/history/${encodeURIComponent(promptId)}`,
    );
    const entry = history?.[promptId];

    if (entry) {
      const outputImage = extractOutputImageRef(entry);
      if (outputImage) {
        return outputImage;
      }

      const status = String(entry?.status?.status_str || "").toLowerCase();
      if (status === "error") {
        throw new Error("ComfyUI workflow failed.");
      }
    }

    await wait(config.comfy.pollIntervalMs);
  }

  throw new Error("ComfyUI generation timed out.");
}

async function fetchOutputImage(outputRef) {
  const params = new URLSearchParams({
    filename: outputRef.filename,
    subfolder: outputRef.subfolder ?? "",
    type: outputRef.type ?? "output",
  });

  return comfyFetchBuffer(`/view?${params.toString()}`);
}

export function getComfyStatus() {
  return {
    enabled: config.comfy.enabled,
    baseUrl: config.comfy.baseUrl,
    checkpoint: config.comfy.checkpoint,
    configured: Boolean(config.comfy.enabled && config.comfy.checkpoint),
  };
}

export async function generateImageWithComfy({ inputBuffer, prompt }) {
  if (!config.comfy.enabled) {
    if (!warnedComfyDisabled) {
      console.warn(
        "[comfy] COMFYUI_ENABLED=false. Skipping ComfyUI generation.",
      );
      warnedComfyDisabled = true;
    }
    return null;
  }

  if (!config.comfy.checkpoint) {
    if (!warnedComfyNotConfigured) {
      console.warn(
        "[comfy] COMFYUI_CHECKPOINT is empty. Skipping ComfyUI generation.",
      );
      warnedComfyNotConfigured = true;
    }
    return null;
  }

  const uploadedImageName = await uploadInputImage(inputBuffer);
  const workflow = buildWorkflow({
    uploadedImageName,
    prompt,
  });

  const promptId = await queuePrompt(workflow);
  const outputRef = await waitForCompletion(promptId);
  return fetchOutputImage(outputRef);
}
