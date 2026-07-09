import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAiRuntimeConfig } from "./config.ts";
import { completeAi } from "./ai/client.ts";
import { run } from "./exec.ts";
import type { Config, ResolvedAiProfile } from "./config.ts";
import type { AiImagePart } from "./ai/types.ts";
import type { DeterministicReviewObservation } from "./reviewObservation.ts";

export type SecondaryObservationKind = "vlm";
export type SecondaryObservationCategory =
  | "layout"
  | "readability"
  | "occlusion"
  | "continuity"
  | "content";

export interface SecondaryObservationItem {
  frameId: string;
  side: "before" | "after";
  severity: "info" | "warn";
  category: SecondaryObservationCategory;
  message: string;
  conflictsWithPrimary: boolean;
}

export interface SecondaryObservation {
  schemaVersion: 1;
  kind: "vlm";
  summary: string[];
  items: SecondaryObservationItem[];
  uncertainties: string[];
  confidence: "low" | "medium" | "high";
  provenance: {
    profile: string;
    adapter: string;
    model: string;
    requestId?: string;
    observedAt: string;
    imageCount: number;
    inputDigest: string;
  };
}

export interface SecondaryObservationFrame {
  frameId: string;
  side: "before" | "after";
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sourceSec: number | null;
  outputSec: number;
  reason: string;
}

export interface SecondaryObservationRequest {
  frames: SecondaryObservationFrame[];
  primary: DeterministicReviewObservation;
  task: {
    instruction?: string;
    proposalTitle?: string;
    proposalSummary?: string[];
  };
  budget: {
    maxImages: number;
    maxOutputTokens: number;
  };
}

export interface SecondaryObservationProvider {
  observe(
    request: SecondaryObservationRequest,
    cfg: Config,
  ): Promise<SecondaryObservation>;
}

export const MAX_SECONDARY_IMAGES_PER_CALL = 4;
export const MAX_SECONDARY_OUTPUT_TOKENS = 1_200;
export const MAX_GUI_REFINEMENTS = 3;
export const MAX_PLAN_VLM_CALLS = 2;
export const MAX_SECONDARY_PROMPT_CHARS = 12_000;

interface ValidatedVlmPayload {
  summary: string[];
  items: Array<Omit<SecondaryObservationItem, "conflictsWithPrimary">>;
  uncertainties: string[];
  confidence: "low" | "medium" | "high";
  validationWarnings: string[];
}

function stableCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableCanonicalize(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function trimList(value: unknown, maxItems: number, maxChars: number, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maxItems) throw new Error(`${field} exceeds max items`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string`);
    if (item.length > maxChars) throw new Error(`${field}[${index}] exceeds max chars`);
    return item;
  });
}

export function reviewFrameId(args: {
  side: "before" | "after";
  sourceSec: number | null;
  outSec: number;
  reason: string;
}): string {
  return `rf_${sha256Hex(stableCanonicalize(args)).slice(0, 16)}`;
}

export function selectSecondaryObservationFrames(
  stills: ReadonlyArray<{
    requested: { reason: string };
    before: { file: string; sourceSec: number | null; outSec: number };
    after: { file: string; sourceSec: number | null; outSec: number };
  }>,
  maxImages: number,
): SecondaryObservationFrame[] {
  const limit = Math.max(1, Math.min(MAX_SECONDARY_IMAGES_PER_CALL, Math.trunc(maxImages)));
  if (stills.length === 0) return [];
  const sampleIndexes =
    stills.length <= limit
      ? stills.map((_, index) => index)
      : Array.from({ length: limit }, (_, i) => Math.min(stills.length - 1, Math.round(i * (stills.length - 1) / (limit - 1))));
  const seenFiles = new Set<string>();
  const selected: SecondaryObservationFrame[] = [];
  const push = (frame: SecondaryObservationFrame | null) => {
    if (!frame || seenFiles.has(frame.file) || selected.length >= limit) return;
    seenFiles.add(frame.file);
    selected.push(frame);
  };
  for (const index of sampleIndexes) {
    const still = stills[index]!;
    if (still.after.sourceSec === null) continue;
    push({
      frameId: reviewFrameId({
        side: "after",
        sourceSec: still.after.sourceSec,
        outSec: still.after.outSec,
        reason: still.requested.reason,
      }),
      side: "after",
      file: still.after.file,
      mediaType: "image/png",
      sourceSec: still.after.sourceSec,
      outputSec: still.after.outSec,
      reason: still.requested.reason,
    });
  }
  for (const index of sampleIndexes) {
    const still = stills[index]!;
    push({
      frameId: reviewFrameId({
        side: "before",
        sourceSec: still.before.sourceSec,
        outSec: still.before.outSec,
        reason: still.requested.reason,
      }),
      side: "before",
      file: still.before.file,
      mediaType: "image/png",
      sourceSec: still.before.sourceSec,
      outputSec: still.before.outSec,
      reason: still.requested.reason,
    });
  }
  return selected.slice(0, limit);
}

export function validateSecondaryObservationPayload(
  raw: unknown,
  frames: readonly SecondaryObservationFrame[],
): ValidatedVlmPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("response must be an object");
  const rec = raw as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const allowed = ["confidence", "items", "summary", "uncertainties"];
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error("response has unknown properties");
  }
  const knownFrames = new Map(frames.map((frame) => [frame.frameId, frame]));
  const summary = trimList(rec.summary, 4, 240, "summary");
  const uncertainties = trimList(rec.uncertainties, 4, 240, "uncertainties");
  if (!Array.isArray(rec.items)) throw new Error("items must be an array");
  if (rec.items.length > 12) throw new Error("items exceeds max items");
  const items: Array<Omit<SecondaryObservationItem, "conflictsWithPrimary">> = [];
  const validationWarnings: string[] = [];
  for (let index = 0; index < rec.items.length; index++) {
    const item = rec.items[index];
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`items[${index}] must be an object`);
      const obj = item as Record<string, unknown>;
      const itemKeys = Object.keys(obj).sort();
      const itemAllowed = ["category", "frameId", "message", "severity", "side"];
      if (itemKeys.length !== itemAllowed.length || itemKeys.some((key, i) => key !== itemAllowed[i])) {
        throw new Error(`items[${index}] has unknown properties`);
      }
      if (typeof obj.frameId !== "string") throw new Error(`items[${index}].frameId must be a string`);
      const frame = knownFrames.get(obj.frameId);
      if (!frame) throw new Error(`items[${index}] references unknown frameId`);
      if (obj.side !== frame.side) throw new Error(`items[${index}] side mismatch`);
      if (obj.severity !== "info" && obj.severity !== "warn") throw new Error(`items[${index}] severity is invalid`);
      if (!["layout", "readability", "occlusion", "continuity", "content"].includes(String(obj.category))) {
        throw new Error(`items[${index}] category is invalid`);
      }
      if (typeof obj.message !== "string" || obj.message.length > 400) throw new Error(`items[${index}] message is invalid`);
      items.push({
        frameId: obj.frameId,
        side: obj.side as "before" | "after",
        severity: obj.severity as "info" | "warn",
        category: obj.category as SecondaryObservationCategory,
        message: obj.message,
      });
    } catch (error) {
      validationWarnings.push((error as Error).message);
    }
  }
  if (rec.items.length > 0 && items.length === 0) {
    throw new Error(`all response items are invalid: ${validationWarnings.join(" / ")}`);
  }
  if (rec.confidence !== "low" && rec.confidence !== "medium" && rec.confidence !== "high") {
    throw new Error("confidence is invalid");
  }
  return { summary, items, uncertainties, confidence: rec.confidence, validationWarnings };
}

export function markPrimaryConflicts(
  raw: ValidatedVlmPayload,
  primary: DeterministicReviewObservation,
): SecondaryObservationItem[] {
  const checksByCategory = new Map<string, Set<string>>();
  for (const check of primary.checks) {
    const bucket = checksByCategory.get(check.source) ?? new Set<string>();
    if (check.status === "pass") bucket.add(check.message);
    checksByCategory.set(check.source, bucket);
  }
  return raw.items.map((item) => ({
    ...item,
    conflictsWithPrimary:
      item.severity === "warn" &&
      (
        (item.category === "layout" && hasPassCategory(primary, "structure")) ||
        (item.category === "continuity" && hasPassCategory(primary, "motion")) ||
        (item.category === "occlusion" && hasPassCategory(primary, "structure")) ||
        (item.category === "content" && hasPassCategory(primary, "structure")) ||
        (item.category === "readability" && hasPassCategory(primary, "ocr"))
      ),
  }));
}

function hasPassCategory(primary: DeterministicReviewObservation, source: string): boolean {
  return primary.checks.some((check) => check.source === source && check.status === "pass");
}

export function summarizeSecondaryObservation(observation: SecondaryObservation): string {
  const lines = [
    "## 画像モデルによる二次観測",
    "注意: 機械検査が一次情報です。以下は補足であり、座標・合否・承認判断ではありません。",
    `- provider: ${observation.provenance.profile} / ${observation.provenance.model}`,
    `- confidence: ${observation.confidence}`,
    ...observation.summary.map((line) => `- summary: ${line}`),
    ...observation.items.map((item) =>
      `- [${item.severity}][${item.category}][${item.side}][${item.frameId}] ${item.message}${
        item.conflictsWithPrimary ? " [conflictsWithPrimary]" : ""
      }`),
    ...observation.uncertainties.map((line) => `- uncertainty: ${line}`),
  ];
  let text = lines.join("\n");
  if (text.length <= 4_000) return text;
  const kept = [...lines.slice(0, 4)];
  for (const line of [...observation.summary.map((l) => `- summary: ${l}`), ...observation.items.map((item) =>
    `- [${item.severity}][${item.category}][${item.side}][${item.frameId}] ${item.message}`), ...observation.uncertainties.map((l) => `- uncertainty: ${l}`)]) {
    if (`${kept.join("\n")}\n${line}\n- truncated: true`.length > 4_000) break;
    kept.push(line);
  }
  kept.push("- truncated: true");
  text = kept.join("\n");
  return text;
}

function buildVisionPrompt(request: SecondaryObservationRequest): string {
  const prompt = [
    "Observe the labeled frames and return supplemental observations only.",
    "Never return patch, coordinates, approval recommendation, pass, fail, or auto-apply guidance.",
    "Deterministic checks are primary. If uncertain, write it in uncertainties.",
    JSON.stringify({
      task: request.task,
      primaryChecks: request.primary.checks,
      primaryDelta: request.primary.delta,
    }),
  ].join("\n");
  return prompt.length > MAX_SECONDARY_PROMPT_CHARS ? prompt.slice(0, MAX_SECONDARY_PROMPT_CHARS) : prompt;
}

function inputDigestOf(request: SecondaryObservationRequest, profile: ResolvedAiProfile): string {
  const frames = request.frames.map((frame) => ({
    frameId: frame.frameId,
    side: frame.side,
    sourceSec: frame.sourceSec,
    outputSec: frame.outputSec,
    reason: frame.reason,
    fileDigest: createHash("sha256").update(readFileSync(frame.file)).digest("hex"),
  }));
  return sha256Hex(stableCanonicalize({
    frames,
    primary: request.primary,
    task: request.task,
    profile: profile.name,
    model: profile.model,
  }));
}

export class VlmSecondaryObservationProvider implements SecondaryObservationProvider {
  async observe(request: SecondaryObservationRequest, cfg: Config): Promise<SecondaryObservation> {
    const runtime = resolveAiRuntimeConfig(cfg);
    const visionName = runtime.routes.vision;
    if (!visionName) throw new Error("vision route is not configured");
    const profile = runtime.profiles.get(visionName);
    if (!profile) throw new Error(`vision profile "${visionName}" is not configured`);
    const limit = Math.max(1, Math.min(request.budget.maxImages, MAX_SECONDARY_IMAGES_PER_CALL));
    const selected = request.frames.slice(0, limit);
    const tempDir = mkdtempSync(join(tmpdir(), "cutflow-vlm-"));
    try {
      const images: AiImagePart[] = [];
      for (let index = 0; index < selected.length; index++) {
        const frame = selected[index]!;
        const out = join(tempDir, `frame-${index + 1}.png`);
        await run("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y", "-i", frame.file,
          "-vf", "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease",
          "-frames:v", "1", out,
        ]);
        images.push({
          type: "image",
          file: out,
          mediaType: "image/png",
          label: `${frame.frameId} ${frame.side} source=${frame.sourceSec ?? "null"} output=${frame.outputSec.toFixed(2)} reason=${frame.reason}`,
        });
      }
      const response = await completeAi({
        route: "vision",
        parts: [{ type: "text", text: buildVisionPrompt(request) }, ...images],
        output: {
          kind: "json-schema",
          format: {
            name: "cutflow_secondary_observation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "items", "uncertainties", "confidence"],
              properties: {
                summary: { type: "array", maxItems: 4, items: { type: "string", maxLength: 240 } },
                items: {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["frameId", "side", "severity", "category", "message"],
                    properties: {
                      frameId: { type: "string" },
                      side: { enum: ["before", "after"] },
                      severity: { enum: ["info", "warn"] },
                      category: { enum: ["layout", "readability", "occlusion", "continuity", "content"] },
                      message: { type: "string", maxLength: 400 },
                    },
                  },
                },
                uncertainties: { type: "array", maxItems: 4, items: { type: "string", maxLength: 240 } },
                confidence: { enum: ["low", "medium", "high"] },
              },
            },
          },
        },
        purpose: "vision-review",
        maxOutputTokens: Math.min(MAX_SECONDARY_OUTPUT_TOKENS, request.budget.maxOutputTokens),
      }, cfg);
      const payload = validateSecondaryObservationPayload(JSON.parse(response.text), selected);
      return {
        schemaVersion: 1,
        kind: "vlm",
        summary: payload.summary,
        items: markPrimaryConflicts(payload, request.primary),
        uncertainties: [
          ...payload.uncertainties,
          ...payload.validationWarnings.slice(0, Math.max(0, 4 - payload.uncertainties.length))
            .map((warning) => `ignored invalid item: ${warning}`),
        ],
        confidence: payload.confidence,
        provenance: {
          profile: response.profile,
          adapter: response.adapter,
          model: response.model,
          ...(response.requestId ? { requestId: response.requestId } : {}),
          observedAt: new Date().toISOString(),
          imageCount: selected.length,
          inputDigest: inputDigestOf(request, profile),
        },
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
