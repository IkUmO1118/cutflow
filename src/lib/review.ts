import type { Bgm, CutPlan, Overlays, Shorts, Transcript } from "../types.ts";
import type { ReviewDocs } from "./docDiff.ts";
import type { Problem } from "../stages/validate.ts";
import type { DescribeProjection } from "../stages/describe.ts";
import type { AiScope } from "../stages/editorAi.ts";

export interface EditSnapshot {
  cutplan: CutPlan;
  transcript: Transcript;
  overlays: Overlays;
  bgm: Bgm | null;
  shorts: Shorts | null;
}

export type ReviewTimeAxis = "source" | "output";

export interface ReviewRange {
  axis: ReviewTimeAxis;
  startSec: number;
  endSec: number;
}

export interface ReviewFrameRequest {
  axis: ReviewTimeAxis;
  atSec: number;
  reason: string;
  ocr?: boolean;
  fullRes?: boolean;
}

export interface ReviewClipRequest {
  range: ReviewRange;
  includeBefore?: boolean;
  includeAfter?: boolean;
}

export interface ReviewSpec {
  range?: ReviewRange;
  frames: ReviewFrameRequest[];
  clip?: ReviewClipRequest;
  observations?: {
    structure?: boolean;
    motion?: boolean;
    sound?: boolean;
    ocr?: boolean;
  };
}

export const MAX_REVIEW_FRAMES = 8;
export const MAX_REVIEW_OCR_FRAMES = 4;
export const MAX_REVIEW_CLIP_SEC = 30;
export const DEFAULT_REVIEW_PAD_SEC = 2;
export const MAX_REVIEW_RANGE_SEC = 60;

export interface ReviewContext {
  sourceDurationSec: number;
  baseOutputDurationSec: number;
  candidateOutputDurationSec: number;
}

export interface NormalizedReviewFrameRequest extends ReviewFrameRequest {
  ocr: boolean;
  fullRes: boolean;
}

export interface NormalizedReviewClipRequest {
  range: ReviewRange;
  includeBefore: boolean;
  includeAfter: boolean;
}

export interface NormalizedReviewSpec {
  range: ReviewRange;
  frames: NormalizedReviewFrameRequest[];
  clip: NormalizedReviewClipRequest | null;
  observations: {
    structure: boolean;
    motion: boolean;
    sound: boolean;
    ocr: boolean;
  };
  warnings: string[];
}

export interface ReviewSelectionInput {
  scope: AiScope;
  playheadSec?: number;
  selectedRange?: { startSec: number; endSec: number };
  selectedIds?: string[];
  activeShortName?: string | null;
}

export interface SlicedReviewContext {
  sourceRange: { startSec: number; endSec: number };
  frameCandidates: {
    sourceSec: number;
    reason: "start" | "middle" | "end" | "cut-boundary" | "caption" | "selected-object";
  }[];
  warnings: string[];
}

export function snapshotOfReviewDocs(docs: ReviewDocs): EditSnapshot {
  return {
    cutplan: docs.cutplan,
    transcript: docs.transcript,
    overlays: docs.overlays,
    bgm: docs.bgm,
    shorts: docs.shorts,
  };
}

export function validateReviewSpec(spec: ReviewSpec): Problem[] {
  const errors: Problem[] = [];
  const err = (where: string, message: string): void => {
    errors.push({ file: "reviewSpec", where, message });
  };
  if (!Array.isArray(spec.frames)) {
    err("frames", "配列ではありません");
    return errors;
  }
  if (spec.frames.length === 0) err("frames", "1件以上必要です");
  spec.frames.forEach((frame, index) => {
    const where = `frames[${index}]`;
    if (frame.axis !== "source" && frame.axis !== "output") {
      err(`${where}.axis`, `"source" か "output" を指定してください`);
    }
    if (!Number.isFinite(frame.atSec) || frame.atSec < 0) {
      err(`${where}.atSec`, "0以上の数値を指定してください");
    }
    if (typeof frame.reason !== "string" || frame.reason.trim() === "") {
      err(`${where}.reason`, "空でない文字列を指定してください");
    }
    if (frame.ocr !== undefined && typeof frame.ocr !== "boolean") {
      err(`${where}.ocr`, "true / false を指定してください");
    }
    if (frame.fullRes !== undefined && typeof frame.fullRes !== "boolean") {
      err(`${where}.fullRes`, "true / false を指定してください");
    }
  });
  if (spec.range) validateRange(spec.range, "range", err);
  if (spec.clip) {
    validateRange(spec.clip.range, "clip.range", err);
    if (spec.clip.includeBefore !== undefined && typeof spec.clip.includeBefore !== "boolean") {
      err("clip.includeBefore", "true / false を指定してください");
    }
    if (spec.clip.includeAfter !== undefined && typeof spec.clip.includeAfter !== "boolean") {
      err("clip.includeAfter", "true / false を指定してください");
    }
  }
  return errors;
}

export function normalizeReviewSpec(spec: ReviewSpec, context: ReviewContext): NormalizedReviewSpec {
  const warnings: string[] = [];
  const sourceRange = clampRange(
    spec.range ?? rangeFromFrames(spec.frames, "source", context.sourceDurationSec),
    context.sourceDurationSec,
    warnings,
    "range",
  );
  const maxOutputSec = Math.max(context.baseOutputDurationSec, context.candidateOutputDurationSec);
  let ocrCount = 0;
  const dedup = new Set<string>();
  const frames = spec.frames
    .slice(0, MAX_REVIEW_FRAMES)
    .flatMap((frame, index): NormalizedReviewFrameRequest[] => {
      if (index >= MAX_REVIEW_FRAMES) return [];
      const atSec = clampScalar(
        frame.atSec,
        frame.axis === "source" ? context.sourceDurationSec : maxOutputSec,
      );
      const key = `${frame.axis}:${round2(atSec)}:${frame.reason}`;
      if (dedup.has(key)) return [];
      dedup.add(key);
      let ocr = frame.ocr === true || spec.observations?.ocr === true;
      if (ocr) {
        ocrCount += 1;
        if (ocrCount > MAX_REVIEW_OCR_FRAMES) {
          ocr = false;
          warnings.push(`OCR は最大${MAX_REVIEW_OCR_FRAMES}枚までです。${index + 1}件目以降は無効化しました`);
        }
      }
      return [{
        axis: frame.axis,
        atSec: round2(atSec),
        reason: frame.reason.trim(),
        ocr,
        fullRes: frame.fullRes === true,
      }];
    });
  if (spec.frames.length > MAX_REVIEW_FRAMES) {
    warnings.push(`frames は最大${MAX_REVIEW_FRAMES}件です。先頭${MAX_REVIEW_FRAMES}件へ切り詰めました`);
  }
  const clip = spec.clip
    ? {
        range: clampRange(
          spec.clip.range,
          spec.clip.range.axis === "source" ? context.sourceDurationSec : maxOutputSec,
          warnings,
          "clip.range",
          MAX_REVIEW_CLIP_SEC,
        ),
        includeBefore: spec.clip.includeBefore !== false,
        includeAfter: spec.clip.includeAfter !== false,
      }
    : null;
  return {
    range: sourceRange,
    frames,
    clip,
    observations: {
      structure: spec.observations?.structure !== false,
      motion: spec.observations?.motion === true,
      sound: spec.observations?.sound === true,
      ocr: spec.observations?.ocr === true || frames.some((frame) => frame.ocr),
    },
    warnings,
  };
}

export function sliceReviewContext(
  projection: DescribeProjection,
  selection: ReviewSelectionInput,
): SlicedReviewContext {
  const warnings: string[] = [];
  const range = selection.selectedRange
    ? clampStartEnd(
        selection.selectedRange.startSec - DEFAULT_REVIEW_PAD_SEC,
        selection.selectedRange.endSec + DEFAULT_REVIEW_PAD_SEC,
        projection.source.durationSec,
      )
    : rangeFromSelectedIds(projection, selection.selectedIds ?? [])
      ?? (selection.scope === "playhead" && selection.playheadSec !== undefined
        ? clampStartEnd(selection.playheadSec - 6, selection.playheadSec + 6, projection.source.durationSec)
        : { startSec: 0, endSec: Math.min(projection.source.durationSec, 12) });
  const bounded = clampRange({ axis: "source", ...range }, projection.source.durationSec, warnings, "selectionRange");
  const frameCandidates = buildFrameCandidates(projection, bounded.startSec, bounded.endSec, selection.selectedIds ?? []);
  return {
    sourceRange: { startSec: bounded.startSec, endSec: bounded.endSec },
    frameCandidates,
    warnings,
  };
}

function validateRange(
  range: ReviewRange,
  where: string,
  err: (where: string, message: string) => void,
): void {
  if (range.axis !== "source" && range.axis !== "output") {
    err(`${where}.axis`, `"source" か "output" を指定してください`);
  }
  if (!Number.isFinite(range.startSec) || range.startSec < 0) {
    err(`${where}.startSec`, "0以上の数値を指定してください");
  }
  if (!Number.isFinite(range.endSec) || range.endSec <= range.startSec) {
    err(`${where}.endSec`, "startSec より大きい数値を指定してください");
  }
}

function rangeFromFrames(
  frames: ReviewFrameRequest[],
  axis: ReviewTimeAxis,
  durationSec: number,
): ReviewRange {
  const targets = frames.filter((frame) => frame.axis === axis).map((frame) => frame.atSec);
  if (targets.length === 0) {
    return { axis, startSec: 0, endSec: Math.min(durationSec, 12) };
  }
  return {
    axis,
    startSec: Math.max(0, Math.min(...targets) - DEFAULT_REVIEW_PAD_SEC),
    endSec: Math.min(durationSec, Math.max(...targets) + DEFAULT_REVIEW_PAD_SEC),
  };
}

function clampRange(
  range: ReviewRange,
  durationSec: number,
  warnings: string[],
  label: string,
  maxDurationSec = MAX_REVIEW_RANGE_SEC,
): ReviewRange {
  const bounded = clampStartEnd(range.startSec, range.endSec, durationSec);
  const len = bounded.endSec - bounded.startSec;
  if (len > maxDurationSec) {
    const mid = (bounded.startSec + bounded.endSec) / 2;
    const half = maxDurationSec / 2;
    const clipped = clampStartEnd(mid - half, mid + half, durationSec);
    warnings.push(`${label} は最大${maxDurationSec}秒です。中央基準で切り詰めました`);
    return { axis: range.axis, ...clipped };
  }
  return { axis: range.axis, ...bounded };
}

function clampStartEnd(startSec: number, endSec: number, durationSec: number): { startSec: number; endSec: number } {
  const start = Math.max(0, Math.min(startSec, durationSec));
  const end = Math.max(start, Math.min(endSec, durationSec));
  if (end > start) return { startSec: round2(start), endSec: round2(end) };
  const next = Math.min(durationSec, start + 0.1);
  return { startSec: round2(Math.max(0, next - 0.1)), endSec: round2(next) };
}

function clampScalar(value: number, durationSec: number): number {
  return Math.max(0, Math.min(value, Math.max(0, durationSec)));
}

function rangeFromSelectedIds(
  projection: DescribeProjection,
  ids: string[],
): { startSec: number; endSec: number } | null {
  if (ids.length === 0) return null;
  const spans: Array<{ start: number; end: number }> = [];
  const idSet = new Set(ids);
  for (const caption of projection.captions) if (caption.id && idSet.has(caption.id)) spans.push(caption);
  for (const item of projection.overlays.materials) if (item.id && idSet.has(item.id)) spans.push(item);
  for (const item of projection.overlays.zooms) if (item.id && idSet.has(item.id)) spans.push(item);
  for (const item of projection.overlays.blurs) if (item.id && idSet.has(item.id)) spans.push(item);
  for (const item of projection.overlays.wipeFull) if (item.id && idSet.has(item.id)) spans.push(item);
  for (const item of projection.overlays.hideCaption) if (item.id && idSet.has(item.id)) spans.push(item);
  if (spans.length === 0) return null;
  return {
    startSec: Math.max(0, Math.min(...spans.map((span) => span.start)) - DEFAULT_REVIEW_PAD_SEC),
    endSec: Math.max(...spans.map((span) => span.end)) + DEFAULT_REVIEW_PAD_SEC,
  };
}

function buildFrameCandidates(
  projection: DescribeProjection,
  startSec: number,
  endSec: number,
  selectedIds: string[],
): SlicedReviewContext["frameCandidates"] {
  const out: SlicedReviewContext["frameCandidates"] = [];
  const seen = new Map<number, number>();
  const push = (sourceSec: number, reason: SlicedReviewContext["frameCandidates"][number]["reason"]): void => {
    const sec = round2(Math.max(startSec, Math.min(sourceSec, endSec)));
    const existing = seen.get(sec);
    if (existing !== undefined) {
      if (reason === "selected-object") out[existing] = { sourceSec: sec, reason };
      return;
    }
    seen.set(sec, out.length);
    out.push({ sourceSec: sec, reason });
  };
  push(startSec, "start");
  push((startSec + endSec) / 2, "middle");
  push(endSec, "end");
  const idSet = new Set(selectedIds);
  for (const caption of projection.captions) if (caption.id && idSet.has(caption.id)) push((caption.start + caption.end) / 2, "selected-object");
  for (const item of projection.overlays.blurs) if (item.id && idSet.has(item.id)) push((item.start + item.end) / 2, "selected-object");
  for (const item of projection.overlays.materials) if (item.id && idSet.has(item.id)) push((item.start + item.end) / 2, "selected-object");
  for (const keep of projection.keeps) {
    if (keep.start > startSec && keep.start < endSec) push(keep.start, "cut-boundary");
    if (keep.end > startSec && keep.end < endSec) push(Math.max(startSec, keep.end - 0.1), "cut-boundary");
  }
  for (const caption of projection.captions) {
    if (caption.start < endSec && caption.end > startSec) push((caption.start + caption.end) / 2, "caption");
  }
  return out.slice(0, MAX_REVIEW_FRAMES);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
