import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileForRoute, resolveAiRuntimeConfig } from "../config.ts";
import { run } from "../exec.ts";
import { AiProviderError, aiRequestSummary } from "./http.ts";
import { adapterFor } from "./registry.ts";
import { normalizeJsonText } from "./structured.ts";
import type { AiImagePart, AiRequest, AiResponse } from "./types.ts";
import type { Config, ResolvedAiProfile } from "../config.ts";

const MAX_PARTS = 32;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_IMAGE_BYTES_TOTAL = 12 * 1024 * 1024;
const MAX_SINGLE_IMAGE_BYTES = 8 * 1024 * 1024;

function loadRepoEnv(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  process.loadEnvFile?.(join(repoRoot, ".env"));
}

function detectImageType(buf: Buffer): AiImagePart["mediaType"] | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12
    && buf.toString("ascii", 0, 4) === "RIFF"
    && buf.toString("ascii", 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

function assertRouteCapabilities(profile: ResolvedAiProfile, request: AiRequest): void {
  if (request.output?.kind === "json-schema" && profile.capabilities.structuredOutput === "none") {
    throw new AiProviderError({
      code: "capability",
      profile: profile.name,
      adapter: profile.adapter,
      message: `AI profile "${profile.name}" は structuredOutput=none です`,
    });
  }
  const images = request.parts.filter((part): part is AiImagePart => part.type === "image");
  if (images.length > 0 && !profile.capabilities.imageInput) {
    throw new AiProviderError({
      code: "capability",
      profile: profile.name,
      adapter: profile.adapter,
      message: `AI profile "${profile.name}" は imageInput=false です`,
    });
  }
}

function validateRequest(request: AiRequest, profile: ResolvedAiProfile): void {
  if (request.parts.length > MAX_PARTS) throw new Error(`AI request parts は最大 ${MAX_PARTS} 件です`);
  const textChars = request.parts
    .filter((part): part is Extract<AiRequest["parts"][number], { type: "text" }> => part.type === "text")
    .reduce((sum, part) => sum + part.text.length, 0);
  if (textChars > MAX_TEXT_CHARS) throw new Error("AI request text が長すぎます");
  const images = request.parts.filter((part): part is AiImagePart => part.type === "image");
  if (images.length > Math.min(profile.capabilities.maxImages, 4)) {
    throw new Error(`AI profile "${profile.name}" は maxImages=${profile.capabilities.maxImages} です`);
  }
  let totalImageBytes = 0;
  for (const image of images) {
    if (!existsSync(image.file) || !statSync(image.file).isFile()) {
      throw new Error(`AI image file が見つかりません: ${image.file}`);
    }
    const size = statSync(image.file).size;
    if (size > MAX_SINGLE_IMAGE_BYTES) throw new Error(`AI image file が大きすぎます: ${image.file}`);
    totalImageBytes += size;
    const mediaType = detectImageType(readFileSync(image.file));
    if (mediaType !== image.mediaType) {
      throw new Error(`AI image file の mediaType が不正です: ${image.file}`);
    }
  }
  if (totalImageBytes > MAX_IMAGE_BYTES_TOTAL) throw new Error("AI image total bytes が上限を超えました");
}

export async function completeAi(req: AiRequest, cfg: Config): Promise<AiResponse> {
  loadRepoEnv();
  const runtime = resolveAiRuntimeConfig(cfg);
  const profile = profileForRoute(runtime, req.route);
  assertRouteCapabilities(profile, req);
  validateRequest(req, profile);
  console.log(aiRequestSummary(req, profile));
  const adapter = adapterFor(profile.adapter);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await adapter.complete(req, profile, {
      signal: controller.signal,
      fetch: globalThis.fetch,
      readFile: readFileSync,
      run,
    });
    if (req.output?.kind === "json-schema") {
      return { ...response, text: normalizeJsonText(response.text) };
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
