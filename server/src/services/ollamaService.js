import { config } from "../config.js";

const DEFAULT_GHIBLI_PROMPT =
  "student portrait, V-sign hand pose, warm light, cinematic composition, gentle hand-painted Studio Ghibli style";
const knownMissingModels = new Set();
let warnedMissingImageModel = false;

const ollamaStartupStatus = {
  checkedAt: null,
  busy: false,
  reachable: null,
  baseUrl: config.ollama.baseUrl,
  requiredModels: [],
  optionalModels: [],
  installedModels: [],
  missingModels: [],
  missingOptionalModels: [],
  pulledModels: [],
  autoPullEnabled: config.ollama.autoPullMissingModels,
  pullOptionalEnabled: config.ollama.pullOptionalModels,
  error: null,
};

function parseMissingModelFromErrorMessage(message) {
  const match = String(message || "").match(/model '([^']+)' not found/i);
  return match?.[1] ?? null;
}

function addUnique(list, value) {
  if (!value || list.includes(value)) {
    return list;
  }

  return [...list, value];
}

function removeValue(list, value) {
  return list.filter((item) => item !== value);
}

function markModelAsMissing(modelName, isOptional) {
  if (!modelName) {
    return;
  }

  knownMissingModels.add(modelName);

  if (isOptional) {
    ollamaStartupStatus.missingOptionalModels = addUnique(
      ollamaStartupStatus.missingOptionalModels,
      modelName,
    );
    return;
  }

  ollamaStartupStatus.missingModels = addUnique(
    ollamaStartupStatus.missingModels,
    modelName,
  );
}

function markModelAsAvailable(modelName) {
  if (!modelName) {
    return;
  }

  knownMissingModels.delete(modelName);
  ollamaStartupStatus.missingModels = removeValue(
    ollamaStartupStatus.missingModels,
    modelName,
  );
  ollamaStartupStatus.missingOptionalModels = removeValue(
    ollamaStartupStatus.missingOptionalModels,
    modelName,
  );
}

function rebuildKnownMissingFromStatus() {
  knownMissingModels.clear();

  for (const modelName of [
    ...ollamaStartupStatus.missingModels,
    ...ollamaStartupStatus.missingOptionalModels,
  ]) {
    knownMissingModels.add(modelName);
  }
}

function endpoint(pathname) {
  return `${config.ollama.baseUrl}${pathname}`;
}

async function ollamaGet(pathname) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.ollama.timeoutMs,
  );

  try {
    const response = await fetch(endpoint(pathname), {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama request failed (${response.status}): ${errorText}`,
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ollamaPost(pathname, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.ollama.timeoutMs,
  );

  try {
    const response = await fetch(endpoint(pathname), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama request failed (${response.status}): ${errorText}`,
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function getModelSets() {
  const requiredModels = [...new Set([config.ollama.imageModel].filter(Boolean))];
  const optionalModels = [
    ...new Set([config.ollama.visionModel].filter((model) => model && !requiredModels.includes(model))),
  ];

  return { requiredModels, optionalModels };
}

async function listInstalledModelNames() {
  const payload = await ollamaGet("/api/tags");
  const names = new Set();

  for (const model of payload?.models ?? []) {
    if (model?.name) {
      names.add(model.name);
    }
  }

  return names;
}

function cloneStartupStatus() {
  return {
    ...ollamaStartupStatus,
    requiredModels: [...ollamaStartupStatus.requiredModels],
    optionalModels: [...ollamaStartupStatus.optionalModels],
    installedModels: [...ollamaStartupStatus.installedModels],
    missingModels: [...ollamaStartupStatus.missingModels],
    missingOptionalModels: [...ollamaStartupStatus.missingOptionalModels],
    pulledModels: [...ollamaStartupStatus.pulledModels],
  };
}

export function getOllamaStartupStatus() {
  return cloneStartupStatus();
}

export async function ensureOllamaAndModelsReady() {
  const { requiredModels, optionalModels } = getModelSets();

  ollamaStartupStatus.busy = true;
  ollamaStartupStatus.baseUrl = config.ollama.baseUrl;
  ollamaStartupStatus.requiredModels = requiredModels;
  ollamaStartupStatus.optionalModels = optionalModels;
  ollamaStartupStatus.autoPullEnabled = config.ollama.autoPullMissingModels;
  ollamaStartupStatus.pullOptionalEnabled = config.ollama.pullOptionalModels;
  ollamaStartupStatus.pulledModels = [];
  ollamaStartupStatus.error = null;

  try {
    const installedBeforePull = await listInstalledModelNames();

    ollamaStartupStatus.reachable = true;
    ollamaStartupStatus.installedModels = [...installedBeforePull].sort();
    ollamaStartupStatus.missingModels = requiredModels.filter(
      (model) => !installedBeforePull.has(model),
    );
    ollamaStartupStatus.missingOptionalModels = optionalModels.filter(
      (model) => !installedBeforePull.has(model),
    );
    rebuildKnownMissingFromStatus();

    if (
      ollamaStartupStatus.missingModels.length > 0 &&
      config.ollama.autoPullMissingModels
    ) {
      for (const modelName of ollamaStartupStatus.missingModels) {
        console.log(`[ollama] Pulling missing model: ${modelName}`);
        await ollamaPost("/api/pull", {
          model: modelName,
          stream: false,
        });
        ollamaStartupStatus.pulledModels.push(modelName);
      }

      const installedAfterRequiredPull = await listInstalledModelNames();
      ollamaStartupStatus.installedModels = [...installedAfterRequiredPull].sort();
      ollamaStartupStatus.missingModels = requiredModels.filter(
        (model) => !installedAfterRequiredPull.has(model),
      );
      ollamaStartupStatus.missingOptionalModels = optionalModels.filter(
        (model) => !installedAfterRequiredPull.has(model),
      );
      rebuildKnownMissingFromStatus();
    }

    if (
      ollamaStartupStatus.missingOptionalModels.length > 0 &&
      config.ollama.autoPullMissingModels &&
      config.ollama.pullOptionalModels
    ) {
      for (const modelName of ollamaStartupStatus.missingOptionalModels) {
        console.log(`[ollama] Pulling optional model: ${modelName}`);
        await ollamaPost("/api/pull", {
          model: modelName,
          stream: false,
        });
        ollamaStartupStatus.pulledModels.push(modelName);
      }

      const installedAfterPull = await listInstalledModelNames();
      ollamaStartupStatus.installedModels = [...installedAfterPull].sort();
      ollamaStartupStatus.missingModels = requiredModels.filter(
        (model) => !installedAfterPull.has(model),
      );
      ollamaStartupStatus.missingOptionalModels = optionalModels.filter(
        (model) => !installedAfterPull.has(model),
      );
      rebuildKnownMissingFromStatus();
    }

    if (ollamaStartupStatus.missingModels.length > 0) {
      ollamaStartupStatus.error = `Missing model(s): ${ollamaStartupStatus.missingModels.join(", ")}`;
    }
  } catch (error) {
    ollamaStartupStatus.reachable = false;
    ollamaStartupStatus.installedModels = [];
    ollamaStartupStatus.missingModels = requiredModels;
    ollamaStartupStatus.missingOptionalModels = optionalModels;
    ollamaStartupStatus.error = error.message;
    rebuildKnownMissingFromStatus();
  } finally {
    ollamaStartupStatus.checkedAt = new Date().toISOString();
    ollamaStartupStatus.busy = false;
  }

  return cloneStartupStatus();
}

function sanitizePromptText(value) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^"|"$/g, "")
    .trim();

  if (cleaned.length < 24) {
    return "";
  }

  const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
  if (alphaCount < 10) {
    return "";
  }

  return cleaned;
}

function extractBase64FromText(value) {
  if (!value) {
    return null;
  }

  const dataUriMatch = value.match(
    /data:image\/[a-zA-Z]+;base64,([A-Za-z0-9+/=\r\n]+)/,
  );
  if (dataUriMatch?.[1]) {
    return dataUriMatch[1].replace(/\s+/g, "");
  }

  const rawBase64Match = value.match(/([A-Za-z0-9+/=\r\n]{200,})/);
  if (rawBase64Match?.[1]) {
    return rawBase64Match[1].replace(/\s+/g, "");
  }

  return null;
}

export async function buildGhibliPromptFromImage(inputBuffer) {
  if (!config.ollama.visionModel) {
    return DEFAULT_GHIBLI_PROMPT;
  }

  if (knownMissingModels.has(config.ollama.visionModel)) {
    return DEFAULT_GHIBLI_PROMPT;
  }

  const imageBase64 = inputBuffer.toString("base64");

  const payload = {
    model: config.ollama.visionModel,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You write image-generation prompts. Reply with one short sentence only and no markdown.",
      },
      {
        role: "user",
        content:
          "Describe this person photo for a Studio Ghibli style conversion. Keep pose and identity context, mention warm colors, anime background, and hand-painted style.",
        images: [imageBase64],
      },
    ],
  };

  try {
    const response = await ollamaPost("/api/chat", payload);
    const content = sanitizePromptText(response?.message?.content);
    if (content) {
      markModelAsAvailable(config.ollama.visionModel);
      return content;
    }
  } catch (error) {
    const missingModel = parseMissingModelFromErrorMessage(error.message);
    if (missingModel) {
      const alreadyKnown = knownMissingModels.has(missingModel);
      markModelAsMissing(missingModel, true);
      if (!alreadyKnown) {
        console.warn(
          `[ollama] Vision model not available (${missingModel}). Using default prompt.`,
        );
      }
      return DEFAULT_GHIBLI_PROMPT;
    }

    console.error("Prompt generation with Ollama failed:", error.message);
  }

  return DEFAULT_GHIBLI_PROMPT;
}

export async function generateImageWithOllama({ inputBuffer, prompt }) {
  if (!config.ollama.imageModel) {
    if (!warnedMissingImageModel) {
      console.warn(
        "[ollama] OLLAMA_IMAGE_MODEL is empty. Returning fallback stylized image.",
      );
      warnedMissingImageModel = true;
    }
    return null;
  }

  if (knownMissingModels.has(config.ollama.imageModel)) {
    return null;
  }

  const referenceBase64 = inputBuffer.toString("base64");

  const payload = {
    model: config.ollama.imageModel,
    stream: false,
    prompt: `Transform the input image into a Studio Ghibli inspired portrait. Keep the same person and V-sign pose. Style prompt: ${prompt}`,
    images: [referenceBase64],
  };

  try {
    const response = await ollamaPost("/api/generate", payload);

    markModelAsAvailable(config.ollama.imageModel);

    if (Array.isArray(response?.images) && response.images[0]) {
      return Buffer.from(response.images[0], "base64");
    }

    const extracted = extractBase64FromText(response?.response);
    if (extracted) {
      return Buffer.from(extracted, "base64");
    }
  } catch (error) {
    const missingModel = parseMissingModelFromErrorMessage(error.message);
    if (missingModel) {
      const alreadyKnown = knownMissingModels.has(missingModel);
      markModelAsMissing(missingModel, false);
      if (!alreadyKnown) {
        console.warn(
          `[ollama] Image model not available (${missingModel}). Returning fallback stylized image.`,
        );
      }
      return null;
    }

    console.error("Image generation with Ollama failed:", error.message);
  }

  return null;
}

