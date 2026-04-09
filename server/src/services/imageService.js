import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "../config.js";
import {
  buildGhibliPromptFromImage,
  generateImageWithOllama,
} from "./ollamaService.js";
import { generateImageWithComfy } from "./comfyService.js";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function normalizeImage(buffer) {
  return sharp(buffer).rotate().png().toBuffer();
}

async function fallbackStylize(inputBuffer) {
  return sharp(inputBuffer)
    .rotate()
    .modulate({
      saturation: 1.45,
      brightness: 1.08,
      hue: 14,
    })
    .gamma(1.1)
    .median(1)
    .sharpen({
      sigma: 1.25,
      m1: 1.2,
      m2: 2.1,
      x1: 2,
      y2: 10,
      y3: 20,
    })
    .linear(1.04, -8)
    .blur(0.3)
    .png()
    .toBuffer();
}

async function getResizedLogo(width, stripHeight) {
  try {
    const source = await fs.readFile(config.watermark.logoPath);
    const logoWidth = Math.max(1, Math.round(width * 0.12));
    const logoHeight = Math.max(1, stripHeight - 8);

    return sharp(source)
      .resize({
        width: logoWidth,
        height: logoHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

export async function stampImageWithCollegeBrand(inputBuffer, label) {
  if (!config.watermark.showLabel) {
    return normalizeImage(inputBuffer);
  }

  const normalized = await normalizeImage(inputBuffer);
  const image = sharp(normalized);
  const metadata = await image.metadata();
  const width = metadata.width ?? 1024;
  const height = metadata.height ?? 1024;
  const stripHeight = Math.min(height, Math.max(24, Math.round(height * 0.11)));
  const textSize = Math.max(22, Math.round(width * 0.028));

  const watermarkSvg = `
<svg width="${width}" height="${stripHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${stripHeight}" fill="rgba(18, 26, 43, 0.64)" />
  <text x="${Math.round(width * 0.18)}" y="${Math.round(stripHeight * 0.63)}" fill="#f8fafc" font-size="${textSize}" font-family="Verdana, sans-serif" font-weight="600">${escapeXml(label)}</text>
</svg>`;

  const composites = [
    {
      input: Buffer.from(watermarkSvg),
      left: 0,
      top: height - stripHeight,
    },
  ];

  const logo = await getResizedLogo(width, stripHeight);
  if (logo) {
    const logoMeta = await sharp(logo).metadata();
    const logoWidth = logoMeta.width ?? 0;
    const logoHeight = logoMeta.height ?? 48;

    if (logoWidth <= width && logoHeight <= stripHeight) {
      composites.push({
        input: logo,
        left: Math.max(2, Math.round(width * 0.025)),
        top:
          height -
          stripHeight +
          Math.max(2, Math.round((stripHeight - logoHeight) / 2)),
      });
    }
  }

  return image.composite(composites).png().toBuffer();
}

export async function createGhibliImage(inputBuffer) {
  const normalized = await normalizeImage(inputBuffer);
  const prompt = await buildGhibliPromptFromImage(normalized);

  const backend = config.generation.imageBackend;
  const backendOrder =
    backend === "ollama"
      ? ["ollama"]
      : backend === "comfy"
        ? ["comfy"]
        : backend === "fallback"
          ? []
          : ["ollama", "comfy"];

  for (const currentBackend of backendOrder) {
    if (currentBackend === "ollama") {
      const generatedByOllama = await generateImageWithOllama({
        inputBuffer: normalized,
        prompt,
      });

      if (generatedByOllama) {
        return {
          imageBuffer: await normalizeImage(generatedByOllama),
          prompt,
          source: "ollama-image-model",
        };
      }
    }

    if (currentBackend === "comfy") {
      try {
        const generatedByComfy = await generateImageWithComfy({
          inputBuffer: normalized,
          prompt,
        });

        if (generatedByComfy) {
          return {
            imageBuffer: await normalizeImage(generatedByComfy),
            prompt,
            source: "comfyui-image-model",
          };
        }
      } catch (error) {
        console.error("ComfyUI image generation failed:", error.message);
      }
    }
  }

  if (backendOrder.length === 0) {
    return {
      imageBuffer: await fallbackStylize(normalized),
      prompt,
      source: "fallback-forced",
    };
  }

  if (backendOrder.length === 1 && backendOrder[0] === "ollama" && !config.ollama.imageModel) {
    return {
      imageBuffer: await fallbackStylize(normalized),
      prompt,
      source: "fallback-no-image-model",
    };
  }

  if (backendOrder.length === 1 && backendOrder[0] === "comfy" && !config.comfy.checkpoint) {
    return {
      imageBuffer: await fallbackStylize(normalized),
      prompt,
      source: "fallback-no-comfy-checkpoint",
    };
  }

  return {
    imageBuffer: await fallbackStylize(normalized),
    prompt,
    source: "fallback-ai-backend-failed",
  };
}
