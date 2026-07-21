import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { playbackSegmentsOf } from "./timeline.ts";
import { videoEncodeArgs } from "./videoEncode.ts";
import type { Config } from "./config.ts";
import type { CutPlan } from "../types.ts";

export const PREVIEW_CUT_FILE = "preview-cut.mp4";
export const PREVIEW_CUT_KEY_FILE = "preview-cut.key.json";
export const PREVIEW_CUT_CACHE_SCHEMA_VERSION = 1;
export const PREVIEW_CUT_ALGORITHM_VERSION = "proxy-keeps-trim-concat-v1";
export const PREVIEW_CUT_AUDIO_ARGS = ["-c:a", "aac", "-ar", "48000"] as const;

export interface PreviewCutKeep {
  start: number;
  end: number;
  speed?: number;
}

export interface PreviewCutFileStat {
  mtimeMs: number;
  size: number;
}

export interface PreviewCutCacheKey {
  schemaVersion: number;
  algorithmVersion: string;
  keeps: PreviewCutKeep[];
  proxy: PreviewCutFileStat & { file: string };
  videoArgs: string[];
  audioArgs: string[];
}

export interface PreviewCutSidecar {
  key: PreviewCutCacheKey;
  output: PreviewCutFileStat;
}

export function normalizePreviewCutKeeps(cutplan: CutPlan): PreviewCutKeep[] {
  return playbackSegmentsOf(cutplan).map((keep) => ({
    start: keep.start,
    end: keep.end,
    ...(keep.speed !== 1 ? { speed: keep.speed } : {}),
  }));
}

/** 未保存 cutplan と server 応答を照合するための、表示理由等を含まない署名。 */
export function previewCutKeepSignature(cutplan: CutPlan): string {
  return JSON.stringify(normalizePreviewCutKeeps(cutplan));
}

export function buildPreviewCutCacheKey(args: {
  cfg: Config;
  cutplan: CutPlan;
  proxyFile?: string;
  proxyMtimeMs: number;
  proxySize: number;
  schemaVersion?: number;
  algorithmVersion?: string;
  videoArgs?: readonly string[];
  audioArgs?: readonly string[];
}): PreviewCutCacheKey {
  return {
    schemaVersion: args.schemaVersion ?? PREVIEW_CUT_CACHE_SCHEMA_VERSION,
    algorithmVersion: args.algorithmVersion ?? PREVIEW_CUT_ALGORITHM_VERSION,
    keeps: normalizePreviewCutKeeps(args.cutplan),
    proxy: {
      file: args.proxyFile ?? "proxy.mp4",
      mtimeMs: args.proxyMtimeMs,
      size: args.proxySize,
    },
    videoArgs: [...(args.videoArgs ?? videoEncodeArgs(args.cfg))],
    audioArgs: [...(args.audioArgs ?? PREVIEW_CUT_AUDIO_ARGS)],
  };
}

export function previewCutCacheKeyEquals(
  a: PreviewCutCacheKey,
  b: PreviewCutCacheKey,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** JSON.parse できても形が壊れている sidecar を fresh と誤認しないための境界検査。 */
export function parsePreviewCutSidecar(value: unknown): PreviewCutSidecar | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sidecar = value as Partial<PreviewCutSidecar>;
  const key = sidecar.key as Partial<PreviewCutCacheKey> | undefined;
  const output = sidecar.output as Partial<PreviewCutFileStat> | undefined;
  if (!key || typeof key !== "object" || !output || typeof output !== "object") return null;
  if (!isFiniteNumber(key.schemaVersion) || typeof key.algorithmVersion !== "string") return null;
  if (!Array.isArray(key.keeps) || !key.keeps.every((keep) => {
    if (!keep || typeof keep !== "object") return false;
    const k = keep as Partial<PreviewCutKeep>;
    return isFiniteNumber(k.start) && isFiniteNumber(k.end) &&
      (k.speed === undefined || isFiniteNumber(k.speed));
  })) return null;
  const proxy = key.proxy as Partial<PreviewCutCacheKey["proxy"]> | undefined;
  if (!proxy || typeof proxy.file !== "string" ||
      !isFiniteNumber(proxy.mtimeMs) || !isFiniteNumber(proxy.size)) return null;
  if (!isStringArray(key.videoArgs) || !isStringArray(key.audioArgs)) return null;
  if (!isFiniteNumber(output.mtimeMs) || !isFiniteNumber(output.size)) return null;
  return value as PreviewCutSidecar;
}

export type PreviewCutFreshness =
  | { fresh: true }
  | { fresh: false; reason: "proxy-stale" | "output-missing" | "sidecar-malformed" | "key-mismatch" | "output-stat-mismatch" };

export function evaluatePreviewCutFreshness(args: {
  proxyFresh: boolean;
  currentKey: PreviewCutCacheKey;
  sidecar: unknown;
  outputStat: PreviewCutFileStat | null;
}): PreviewCutFreshness {
  if (!args.proxyFresh) return { fresh: false, reason: "proxy-stale" };
  if (!args.outputStat) return { fresh: false, reason: "output-missing" };
  const sidecar = parsePreviewCutSidecar(args.sidecar);
  if (!sidecar) return { fresh: false, reason: "sidecar-malformed" };
  if (!previewCutCacheKeyEquals(sidecar.key, args.currentKey)) {
    return { fresh: false, reason: "key-mismatch" };
  }
  if (sidecar.output.mtimeMs !== args.outputStat.mtimeMs ||
      sidecar.output.size !== args.outputStat.size) {
    return { fresh: false, reason: "output-stat-mismatch" };
  }
  return { fresh: true };
}

/** 欠落・壊れた JSON・stat 失敗はいずれも例外ではなく stale に落とす。 */
export function inspectPreviewCutFreshness(args: {
  dir: string;
  currentKey: PreviewCutCacheKey;
  proxyFresh: boolean;
}): PreviewCutFreshness {
  const outputPath = join(args.dir, PREVIEW_CUT_FILE);
  const keyPath = join(args.dir, PREVIEW_CUT_KEY_FILE);
  let outputStat: PreviewCutFileStat | null = null;
  let sidecar: unknown = null;
  try {
    if (existsSync(outputPath)) {
      const stat = statSync(outputPath);
      outputStat = { mtimeMs: stat.mtimeMs, size: stat.size };
    }
  } catch {
    outputStat = null;
  }
  try {
    if (existsSync(keyPath)) sidecar = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    sidecar = null;
  }
  return evaluatePreviewCutFreshness({
    proxyFresh: args.proxyFresh,
    currentKey: args.currentKey,
    sidecar,
    outputStat,
  });
}
