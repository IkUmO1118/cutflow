import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import type { JsonSchemaTextFormat } from "../lib/llm.ts";
import { mergeBodyOverDisk, planApply } from "../lib/applyEdits.ts";
import type { ApplyPlan } from "../lib/applyEdits.ts";
import type { ReviewDocs } from "../lib/docDiff.ts";
import type { Config } from "../lib/config.ts";
import { sliceReviewContext, type ReviewFrameRequest, type ReviewRange } from "../lib/review.ts";
import type { EditorAiReviewPlan } from "../lib/editorAiReview.ts";
import { describeJson } from "./describe.ts";
import type { DescribeProjection, CaptionEntry, MappedInterval } from "./describe.ts";
import type { ApplyBody, ApplyPatch, Bgm, CutPlan, Manifest, Overlays, Region, Shorts, Transcript } from "../types.ts";
import { planIntentEdits, type EditIntent } from "../lib/editIntent.ts";
import { retrievalSearch } from "./retrievalSearch.ts";

export type AiScope = "global" | "playhead" | "selection";

export interface AiSelectionContext {
  scope: AiScope;
  playheadSec?: number;
  outputSec?: number;
  activeShortName?: string | null;
  selectedIds?: string[];
  selectedRange?: { startSec: number; endSec: number };
  selectedText?: string;
  selectedKind?: "cut" | "caption" | "overlay" | "blur" | "annotation" | "short" | "range";
}

export interface AiProposeRequest {
  instruction: string;
  selection?: AiSelectionContext;
  activeShortName?: string | null;
}

export interface AiProposeResponse {
  title: string;
  summary: string[];
  patch: ApplyPatch;
  tasks?: EditIntent[];
  applyPlan: ApplyPlan;
  proposedDocs: ReviewDocs;
  review: EditorAiReviewPlan;
}

export interface ParsedAiPatchResponse {
  title: string;
  summary: string[];
  patch: ApplyPatch;
  tasks?: EditIntent[];
  review: EditorAiReviewPlan;
}

interface RefineEditorAiInput {
  mode: "normal" | "warning-fix";
  originalInstruction: string;
  additionalInstruction?: string;
  baseDocs: ReviewDocs;
  candidateDocs: ReviewDocs;
  applyWarnings: string[];
  acceptedHunkLabels: string[];
  rejectedHunkLabels: string[];
  priorProposalDiff: {
    label: string;
    kind: string;
    current: unknown;
    proposed: unknown;
  }[];
  priorProposal: AiProposeResponse;
  reviewBundle: {
    observation: {
      checks: unknown[];
      delta: unknown;
    };
    vlm?: {
      summary: string[];
      observations: unknown[];
      confidence: string;
    };
  };
}

interface RefineEditorAiPromptOptions {
  patchOnly?: boolean;
  retryReason?: string;
}

interface ProposeEditorAiPromptOptions {
  patchOnly?: boolean;
  patchOnlyReason?: string;
}

export class EditorAiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function normalizeIntentRange(
  rawRange: unknown,
): { startSec: number; endSec: number } | undefined {
  if (isObj(rawRange) && isFiniteNonNegative(rawRange.startSec) && isFiniteNonNegative(rawRange.endSec)) {
    return { startSec: rawRange.startSec, endSec: rawRange.endSec };
  }
  if (isObj(rawRange) && isFiniteNonNegative(rawRange.start) && isFiniteNonNegative(rawRange.end)) {
    return { startSec: rawRange.start, endSec: rawRange.end };
  }
  return undefined;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeAnnotationPayload(rawTask: Record<string, unknown>): unknown {
  const nested = isObj(rawTask.annotation) ? rawTask.annotation : null;
  const type = nested?.type ?? rawTask.annotationType ?? rawTask.annotation_type ?? rawTask.kind ?? rawTask.type;
  if (type === "add-annotation") return nested ?? rawTask.annotation;
  if (type === "arrow") {
    return omitUndefined({
      type: "arrow",
      from: nested?.from ?? rawTask.from,
      to: nested?.to ?? rawTask.to,
      color: nested?.color ?? rawTask.color,
      widthPx: nested?.widthPx ?? rawTask.widthPx,
      headPx: nested?.headPx ?? rawTask.headPx,
    });
  }
  if (type === "box") {
    return omitUndefined({
      type: "box",
      rect: nested?.rect ?? rawTask.rect,
      color: nested?.color ?? rawTask.color,
      widthPx: nested?.widthPx ?? rawTask.widthPx,
      radiusPx: nested?.radiusPx ?? rawTask.radiusPx,
      fill: nested?.fill ?? rawTask.fill,
    });
  }
  if (type === "spotlight") {
    return omitUndefined({
      type: "spotlight",
      rect: nested?.rect ?? rawTask.rect,
      shape: nested?.shape ?? rawTask.shape,
      dim: nested?.dim ?? rawTask.dim,
      featherPx: nested?.featherPx ?? rawTask.featherPx,
      radiusPx: nested?.radiusPx ?? rawTask.radiusPx,
    });
  }
  return nested ?? rawTask.annotation;
}

function normalizeAnnotationAddValue(value: unknown): unknown {
  if (!isObj(value)) return value;
  const range =
    normalizeIntentRange(value.range)
    ?? normalizeIntentRange(value)
    ?? normalizeIntentRange(isObj(value.annotation) ? value.annotation : null);
  const rawAnnotation = normalizeAnnotationPayload(value);
  const annotation = isObj(rawAnnotation)
    ? (({ start: _start, end: _end, startSec: _startSec, endSec: _endSec, ...rest }) => rest)(rawAnnotation)
    : rawAnnotation;
  if (!isObj(annotation) || !range) return value;
  return {
    ...annotation,
    start: range.startSec,
    end: range.endSec,
  };
}

function normalizeApplyPatchValue(patch: ApplyPatch): ApplyPatch {
  if (!Array.isArray(patch.ops)) return patch;
  return {
    ...patch,
    ops: patch.ops.map((op) => {
      if (
        op.op === "add"
        && op.target === "overlays.annotations"
        && isObj(op.value)
      ) {
        return { ...op, value: normalizeAnnotationAddValue(op.value) as Record<string, unknown> };
      }
      return op;
    }),
  };
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizePoint(value: unknown, bounds: Region): unknown {
  if (!isObj(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return value;
  return {
    ...value,
    x: clamp(Math.round(value.x), 0, bounds.w),
    y: clamp(Math.round(value.y), 0, bounds.h),
  };
}

function normalizeRect(value: unknown, bounds: Region): unknown {
  if (!isObj(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.w) || !isFiniteNumber(value.h)) {
    return value;
  }
  const w = clamp(Math.round(value.w), 1, bounds.w);
  const h = clamp(Math.round(value.h), 1, bounds.h);
  const maxX = Math.max(0, bounds.w - w);
  const maxY = Math.max(0, bounds.h - h);
  return {
    ...value,
    x: clamp(Math.round(value.x), 0, maxX),
    y: clamp(Math.round(value.y), 0, maxY),
    w,
    h,
  };
}

function normalizeMaterialKeyframes(value: unknown, bounds: Region): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isObj(item) || !isObj(item.values)) return item;
    const rect = normalizeRect({
      x: item.values.x,
      y: item.values.y,
      w: item.values.w,
      h: item.values.h,
    }, bounds);
    if (!isObj(rect)) return item;
    return {
      ...item,
      values: {
        ...item.values,
        ...(isFiniteNumber(item.values.x) ? { x: rect.x } : {}),
        ...(isFiniteNumber(item.values.y) ? { y: rect.y } : {}),
        ...(isFiniteNumber(item.values.w) ? { w: rect.w } : {}),
        ...(isFiniteNumber(item.values.h) ? { h: rect.h } : {}),
      },
    };
  });
}

function normalizeArrowKeyframes(value: unknown, bounds: Region): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isObj(item) || !isObj(item.values)) return item;
    const from = normalizePoint({ x: item.values.fromX, y: item.values.fromY }, bounds);
    const to = normalizePoint({ x: item.values.toX, y: item.values.toY }, bounds);
    if (!isObj(from) || !isObj(to)) return item;
    return {
      ...item,
      values: {
        ...item.values,
        ...(isFiniteNumber(item.values.fromX) ? { fromX: from.x } : {}),
        ...(isFiniteNumber(item.values.fromY) ? { fromY: from.y } : {}),
        ...(isFiniteNumber(item.values.toX) ? { toX: to.x } : {}),
        ...(isFiniteNumber(item.values.toY) ? { toY: to.y } : {}),
      },
    };
  });
}

function normalizeRectKeyframes(value: unknown, bounds: Region): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isObj(item) || !isObj(item.values)) return item;
    const rect = normalizeRect({
      x: item.values.x,
      y: item.values.y,
      w: item.values.w,
      h: item.values.h,
    }, bounds);
    if (!isObj(rect)) return item;
    return {
      ...item,
      values: {
        ...item.values,
        ...(isFiniteNumber(item.values.x) ? { x: rect.x } : {}),
        ...(isFiniteNumber(item.values.y) ? { y: rect.y } : {}),
        ...(isFiniteNumber(item.values.w) ? { w: rect.w } : {}),
        ...(isFiniteNumber(item.values.h) ? { h: rect.h } : {}),
      },
    };
  });
}

function normalizeTranscriptDoc(value: Transcript | undefined, bounds: Region): Transcript | undefined {
  if (!value) return value;
  return {
    ...value,
    segments: value.segments.map((segment) => (
      segment.pos ? { ...segment, pos: normalizePoint(segment.pos, bounds) as typeof segment.pos } : segment
    )),
  };
}

function normalizeCaptionTracks<T extends { captionTracks?: { x?: number; y?: number }[] }>(value: T | null | undefined, bounds: Region): T | null | undefined {
  if (!value?.captionTracks) return value;
  return {
    ...value,
    captionTracks: value.captionTracks.map((track) => {
      const point = normalizePoint({ x: track.x, y: track.y }, bounds);
      return isObj(point)
        ? {
            ...track,
            ...(isFiniteNumber(track.x) ? { x: point.x } : {}),
            ...(isFiniteNumber(track.y) ? { y: point.y } : {}),
          }
        : track;
    }),
  };
}

function normalizeOverlaysDoc(value: Overlays | undefined, bounds: Region): Overlays | undefined {
  if (!value) return value;
  return {
    ...value,
    overlays: value.overlays?.map((overlay) => ({
      ...overlay,
      ...(overlay.rect ? { rect: normalizeRect(overlay.rect, bounds) as Region } : {}),
      ...(overlay.keyframes ? { keyframes: normalizeMaterialKeyframes(overlay.keyframes, bounds) as typeof overlay.keyframes } : {}),
    })),
    captionTracks: normalizeCaptionTracks({ captionTracks: value.captionTracks }, bounds)?.captionTracks,
    zooms: value.zooms?.map((zoom) => ({
      ...zoom,
      rect: normalizeRect(zoom.rect, bounds) as Region,
    })),
    blurs: value.blurs?.map((blur) => ({
      ...blur,
      rect: normalizeRect(blur.rect, bounds) as Region,
      ...(blur.keyframes ? { keyframes: normalizeRectKeyframes(blur.keyframes, bounds) as typeof blur.keyframes } : {}),
    })),
    annotations: value.annotations?.map((annotation) => {
      if (annotation.type === "arrow") {
        return {
          ...annotation,
          from: normalizePoint(annotation.from, bounds) as typeof annotation.from,
          to: normalizePoint(annotation.to, bounds) as typeof annotation.to,
          ...(annotation.keyframes ? { keyframes: normalizeArrowKeyframes(annotation.keyframes, bounds) as typeof annotation.keyframes } : {}),
        };
      }
      return {
        ...annotation,
        rect: normalizeRect(annotation.rect, bounds) as Region,
        ...(annotation.keyframes ? { keyframes: normalizeRectKeyframes(annotation.keyframes, bounds) as typeof annotation.keyframes } : {}),
      };
    }),
  };
}

function normalizeShortsDoc(value: Shorts | null | undefined, bounds: Region): Shorts | null | undefined {
  if (!value) return value;
  return {
    ...value,
    shorts: value.shorts.map((short) => normalizeCaptionTracks(short, bounds) as typeof short),
  };
}

function normalizeAiApplyBody(body: ApplyBody, bounds: Region): ApplyBody {
  return {
    ...body,
    ...(body.transcript ? { transcript: normalizeTranscriptDoc(body.transcript, bounds) } : {}),
    ...(body.overlays ? { overlays: normalizeOverlaysDoc(body.overlays, bounds) } : {}),
    ...(body.shorts !== undefined ? { shorts: normalizeShortsDoc(body.shorts, bounds) } : {}),
  };
}

function hasPatchEdits(patch: ApplyPatch): boolean {
  return (Array.isArray(patch.ops) && patch.ops.length > 0)
    || (isObj(patch.replace) && Object.keys(patch.replace).length > 0);
}

function normalizeReviewFrames(v: unknown): ReviewFrameRequest[] {
  if (!Array.isArray(v)) return [];
  if (v.every((item) => typeof item === "string")) {
    return v.flatMap((item): ReviewFrameRequest[] => {
      const atSec = Number(item.trim());
      if (!Number.isFinite(atSec) || atSec < 0) return [];
      return [{ axis: "source", atSec, reason: "legacy-frame" }];
    });
  }
  return v.flatMap((item): ReviewFrameRequest[] => {
    if (!isObj(item) || !isFiniteNonNegative(item.atSec) || typeof item.reason !== "string") return [];
    return [{
      axis: item.axis === "output" ? "output" : "source",
      atSec: item.atSec,
      reason: item.reason.trim() || "review-frame",
      ...(typeof item.ocr === "boolean" ? { ocr: item.ocr } : {}),
      ...(typeof item.fullRes === "boolean" ? { fullRes: item.fullRes } : {}),
    }];
  });
}

function normalizeReviewRange(v: unknown): ReviewRange | undefined {
  if (!isObj(v) || !isFiniteNonNegative(v.startSec) || !isFiniteNonNegative(v.endSec)) return undefined;
  if (v.endSec <= v.startSec) return undefined;
  return {
    axis: v.axis === "output" ? "output" : "source",
    startSec: v.startSec,
    endSec: v.endSec,
  };
}

function normalizeEditIntents(value: unknown): EditIntent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (!isObj(item)) return item as unknown as EditIntent;
    if (item.type === "update_caption" || item.type === "set-caption-text") {
      const rawTarget =
        item.target ?? item.caption ?? item.captionId ?? item.caption_id ?? item.id ?? item.ref;
      const target =
        typeof rawTarget === "string" && rawTarget.startsWith("cap_")
          ? `@${rawTarget}`
          : rawTarget;
      return {
        ...item,
        type: "set-caption-text",
        target,
        text: item.text ?? item.value ?? item.newText ?? item.new_text ?? item.captionText,
      } as unknown as EditIntent;
    }
    if (item.type === "add-annotation") {
      const range =
        normalizeIntentRange(item.range)
        ?? normalizeIntentRange(item)
        ?? normalizeIntentRange(isObj(item.annotation) ? item.annotation : null);
      const rawAnnotation = normalizeAnnotationPayload(item);
      const annotation = isObj(rawAnnotation)
        ? (({ start: _start, end: _end, startSec: _startSec, endSec: _endSec, ...rest }) => rest)(rawAnnotation)
        : rawAnnotation;
      return {
        ...item,
        ...(range ? { range } : {}),
        annotation,
      } as unknown as EditIntent;
    }
    if (item.type === "add-blur" || item.type === "place-material" || item.type === "set-range-action") {
      const range = normalizeIntentRange(item.range) ?? normalizeIntentRange(item);
      return {
        ...item,
        ...(range ? { range } : {}),
      } as unknown as EditIntent;
    }
    if (item.type === "trim-pauses" && item.range !== undefined) {
      const range = normalizeIntentRange(item.range) ?? normalizeIntentRange(item);
      return {
        ...item,
        ...(range ? { range } : {}),
      } as unknown as EditIntent;
    }
    return item as unknown as EditIntent;
  });
}

const EDITOR_AI_PATCH_ITEM_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "target", "field", "value"],
      properties: {
        op: { const: "set" },
        target: { type: "string" },
        field: { type: "string" },
        value: {},
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "target"],
      properties: {
        op: { const: "remove" },
        target: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "target", "value"],
      properties: {
        op: { const: "add" },
        target: {
          enum: [
            "cutplan.segments",
            "transcript.segments",
            "overlays.overlays",
            "overlays.inserts",
            "overlays.zooms",
            "overlays.blurs",
            "overlays.annotations",
            "overlays.wipeFull",
            "overlays.hideCaption",
            "overlays.captionTracks",
            "chapters.chapters",
            "bgm.tracks",
            "thumbnail.texts",
          ],
        },
        value: { type: "object" },
        at: { type: "integer", minimum: 0 },
      },
    },
  ],
};

const EDITOR_AI_RESPONSE_SCHEMA: JsonSchemaTextFormat = {
  name: "editor_ai_proposal",
  // EditIntent is an extensible union with optional fields. OpenAI's strict
  // subset requires every object field to be required, so boundary planning
  // (`parseAiPatchResponse` + `planApply`) remains the authoritative validator.
  strict: false,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "edit", "review"],
    properties: {
      title: { type: "string" },
      summary: { type: "array", items: { type: "string" } },
      edit: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["mode", "tasks"],
            properties: {
              mode: { const: "tasks" },
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      enum: [
                        "set-range-action",
                        "trim-pauses",
                        "set-caption-text",
                        "add-blur",
                        "add-annotation",
                        "place-material",
                      ],
                    },
                    target: { type: "string" },
                    text: { type: "string" },
                    range: { type: "object" },
                    action: { enum: ["keep", "cut"] },
                    reason: { type: "string" },
                    minPauseSec: { type: "number" },
                    keepHeadSec: { type: "number" },
                    keepTailSec: { type: "number" },
                    rect: { type: "object" },
                    effect: { enum: ["blur", "mosaic"] },
                    strength: { type: "number" },
                    annotation: { type: "object" },
                    file: { type: "string" },
                    placement: { type: "object" },
                    audio: { type: "object" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["mode", "patch"],
            properties: {
              mode: { const: "patch" },
              patch: {
                type: "object",
                additionalProperties: false,
                properties: {
                  ops: { type: "array", items: EDITOR_AI_PATCH_ITEM_SCHEMA },
                  replace: { type: "object" },
                },
              },
            },
          },
        ],
      },
      review: {
        type: "object",
        additionalProperties: false,
        required: ["frames", "notes"],
        properties: {
          frames: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["atSec", "reason"],
              properties: {
                axis: { enum: ["source", "output"] },
                atSec: { type: "number", minimum: 0 },
                reason: { type: "string" },
                ocr: { type: "boolean" },
                fullRes: { type: "boolean" },
              },
            },
          },
          range: {
            type: "object",
            additionalProperties: false,
            required: ["startSec", "endSec"],
            properties: {
              axis: { enum: ["source", "output"] },
              startSec: { type: "number", minimum: 0 },
              endSec: { type: "number", minimum: 0 },
            },
          },
          clip: { type: "boolean" },
          observations: {
            type: "object",
            additionalProperties: false,
            properties: {
              motion: { type: "boolean" },
              sound: { type: "boolean" },
              ocr: { type: "boolean" },
            },
          },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function editorAiOutputSchemaText(): string {
  return JSON.stringify(EDITOR_AI_RESPONSE_SCHEMA.schema, null, 2);
}

function refineContextJson(input: RefineEditorAiInput): string {
  return JSON.stringify({
    mode: input.mode,
    originalInstruction: input.originalInstruction.trim(),
    additionalInstruction: input.additionalInstruction?.trim() || null,
    priorProposal: {
      title: input.priorProposal.title,
      summary: input.priorProposal.summary,
      review: input.priorProposal.review,
    },
    applyWarnings: input.applyWarnings,
    priorProposalDiff: input.priorProposalDiff,
    acceptedHunkLabels: input.acceptedHunkLabels,
    rejectedHunkLabels: input.rejectedHunkLabels,
    baseDocs: input.baseDocs,
    candidateDocs: input.candidateDocs,
    deterministicObservation: input.reviewBundle.observation,
    vlmSummary: input.reviewBundle.vlm
      ? {
          secondaryObservation: true,
          confidence: input.reviewBundle.vlm.confidence,
          summary: input.reviewBundle.vlm.summary,
          observations: input.reviewBundle.vlm.observations,
        }
      : null,
  }, null, 2);
}

const PLAYHEAD_CONTEXT_SEC = 12;
const SELECTION_CONTEXT_PAD_SEC = 4;
const GLOBAL_TIMELINE_LIMIT = 24;

function overlapsRange(v: { start: number; end: number }, start: number, end: number): boolean {
  return Math.min(v.end, end) - Math.max(v.start, start) > 0.05;
}

function outOverlapsRange(v: { out: { start: number; end: number }[] }, start: number, end: number): boolean {
  return v.out.some((o) => overlapsRange(o, start, end));
}

function mappedOverlapsRange(v: MappedInterval, start: number, end: number): boolean {
  return overlapsRange(v, start, end) || outOverlapsRange(v, start, end);
}

function rangeFromSelection(proj: DescribeProjection, selection: AiSelectionContext): { start: number; end: number } | null {
  if (selection.selectedRange) {
    return {
      start: Math.max(0, selection.selectedRange.startSec - SELECTION_CONTEXT_PAD_SEC),
      end: selection.selectedRange.endSec + SELECTION_CONTEXT_PAD_SEC,
    };
  }
  const ids = new Set(selection.selectedIds ?? []);
  if (ids.size === 0) return null;
  const candidates: { start: number; end: number }[] = [];
  for (const c of proj.captions) if (c.id && ids.has(c.id)) candidates.push({ start: c.start, end: c.end });
  for (const o of proj.overlays.materials) if (o.id && ids.has(o.id)) candidates.push({ start: o.start, end: o.end });
  for (const z of proj.overlays.zooms) if (z.id && ids.has(z.id)) candidates.push({ start: z.start, end: z.end });
  for (const b of proj.overlays.blurs) if (b.id && ids.has(b.id)) candidates.push({ start: b.start, end: b.end });
  for (const a of proj.overlays.annotations) if (a.id && ids.has(a.id)) candidates.push({ start: a.start, end: a.end });
  for (const w of proj.overlays.wipeFull) if (w.id && ids.has(w.id)) candidates.push({ start: w.start, end: w.end });
  for (const h of proj.overlays.hideCaption) if (h.id && ids.has(h.id)) candidates.push({ start: h.start, end: h.end });
  if (candidates.length === 0) return null;
  return {
    start: Math.max(0, Math.min(...candidates.map((c) => c.start)) - SELECTION_CONTEXT_PAD_SEC),
    end: Math.max(...candidates.map((c) => c.end)) + SELECTION_CONTEXT_PAD_SEC,
  };
}

function captionsInRange(captions: CaptionEntry[], start: number, end: number): CaptionEntry[] {
  return captions.filter((c) => overlapsRange(c, start, end) || outOverlapsRange(c, start, end));
}

function wantsGlobalTimelineContext(req: AiProposeRequest): boolean {
  if (req.selection && req.selection.scope !== "global") return false;
  return /(最適|タイミング|注釈|annotation|arrow|box|spotlight|ここ|強調|目立|示|指|highlight|callout)/i
    .test(req.instruction);
}

function globalTimelineCandidates(proj: DescribeProjection): unknown {
  const visibleCaptions = proj.captions
    .filter((c) => c.visible)
    .slice(0, GLOBAL_TIMELINE_LIMIT)
    .map((c) => ({
      kind: "caption",
      ...(c.id ? { id: c.id } : {}),
      start: c.start,
      end: c.end,
      text: c.text,
      out: c.out,
    }));
  const keeps = proj.keeps.slice(0, GLOBAL_TIMELINE_LIMIT).map((k) => ({
    kind: "keep",
    index: k.index,
    start: k.start,
    end: k.end,
    durationSec: k.durationSec,
    outStart: k.outStart,
    outEnd: k.outEnd,
  }));
  const chapters = proj.chapters.slice(0, GLOBAL_TIMELINE_LIMIT).map((c) => ({
    kind: "chapter",
    ...(c.id ? { id: c.id } : {}),
    start: c.start,
    out: c.out,
    title: c.title,
  }));
  return {
    note: "Use these candidates to choose best-effort timing for global edit requests. Do not claim local context is unavailable when these candidates are present.",
    visibleCaptions,
    keeps,
    chapters,
  };
}

function sliceProjectProjection(
  proj: DescribeProjection,
  selection: AiSelectionContext,
  options: { includeGlobalTimeline?: boolean } = {},
): unknown {
  if (selection.scope === "global") {
    return {
      schemaVersion: proj.schemaVersion,
      source: proj.source,
      summary: proj.summary,
      meta: proj.meta,
      bgm: proj.bgm,
      shorts: proj.shorts,
      tracks: {
        captionTracks: proj.overlays.captionTracks,
        layerOrder: proj.overlays.layerOrder,
        colorFilter: proj.overlays.colorFilter,
      },
      counts: {
        keeps: proj.keeps.length,
        cuts: proj.cuts.length,
        captions: proj.captions.length,
        materials: proj.overlays.materials.length,
        inserts: proj.overlays.inserts.length,
        zooms: proj.overlays.zooms.length,
        blurs: proj.overlays.blurs.length,
        annotations: proj.overlays.annotations.length,
      },
      note: options.includeGlobalTimeline
        ? "This is a project-level summary with timeline candidates. Choose a best-effort timing from the candidates for global edit requests."
        : "This is a project-level summary. Ask for a narrower scope if exact local timing context is needed.",
      ...(options.includeGlobalTimeline ? { timelineCandidates: globalTimelineCandidates(proj) } : {}),
    };
  }

  const center = selection.scope === "playhead" ? selection.playheadSec : undefined;
  const range =
    selection.scope === "selection"
      ? rangeFromSelection(proj, selection)
      : center !== undefined
        ? { start: Math.max(0, center - PLAYHEAD_CONTEXT_SEC), end: center + PLAYHEAD_CONTEXT_SEC }
        : null;
  if (!range) return proj;

  return {
    schemaVersion: proj.schemaVersion,
    source: proj.source,
    summary: proj.summary,
    contextRange: {
      axis: "source",
      start: range.start,
      end: range.end,
    },
    keeps: proj.keeps.filter((k) => overlapsRange(k, range.start, range.end)),
    cuts: proj.cuts.filter((c) => overlapsRange(c, range.start, range.end)),
    captions: captionsInRange(proj.captions, range.start, range.end),
    overlays: {
      materials: proj.overlays.materials.filter((o) => mappedOverlapsRange(o, range.start, range.end)),
      inserts: proj.overlays.inserts.filter((i) =>
        i.out ? overlapsRange(i.out, range.start, range.end) || overlapsRange({ start: i.at, end: i.at + i.durationSec }, range.start, range.end) : false,
      ),
      wipeFull: proj.overlays.wipeFull.filter((w) => mappedOverlapsRange(w, range.start, range.end)),
      zooms: proj.overlays.zooms.filter((z) => mappedOverlapsRange(z, range.start, range.end)),
      blurs: proj.overlays.blurs.filter((b) => mappedOverlapsRange(b, range.start, range.end)),
      annotations: proj.overlays.annotations.filter((a) => mappedOverlapsRange(a, range.start, range.end)),
      hideCaption: proj.overlays.hideCaption.filter((h) => mappedOverlapsRange(h, range.start, range.end)),
      captionTracks: proj.overlays.captionTracks,
      layerOrder: proj.overlays.layerOrder,
      colorFilter: proj.overlays.colorFilter,
    },
    bgm: proj.bgm.source === "bgm.json" && proj.bgm.tracks
      ? { ...proj.bgm, tracks: proj.bgm.tracks.filter((t) => overlapsRange(t, range.start, range.end)) }
      : proj.bgm,
    shorts: selection.activeShortName
      ? proj.shorts.filter((s) => s.name === selection.activeShortName)
      : proj.shorts,
  };
}

function reviewDocsOf(docs: ReturnType<typeof mergeBodyOverDisk>): ReviewDocs {
  return {
    cutplan: docs.cutplan as CutPlan,
    overlays: (docs.overlays ?? {}) as Overlays,
    transcript: docs.transcript as Transcript,
    bgm: (docs.bgm ?? null) as Bgm | null,
    shorts: (docs.shorts ?? null) as Shorts | null,
  };
}

export function parseAiPatchResponse(raw: string): ParsedAiPatchResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EditorAiError(400, `AI 応答を JSON として読めません: ${(e as Error).message}`);
  }
  if (!isObj(parsed)) {
    throw new EditorAiError(400, "AI 応答が JSON オブジェクトではありません");
  }
  const edit = isObj(parsed.edit) ? parsed.edit : null;
  const tasks = edit?.mode === "tasks" ? normalizeEditIntents(edit.tasks) : undefined;
  const patch = edit?.mode === "patch" && isObj(edit.patch) ? edit.patch : parsed.patch;
  if (!tasks && !isObj(patch)) throw new EditorAiError(400, "AI 応答に edit または patch がありません");
  const review = isObj(parsed.review) ? parsed.review : {};
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "AI 提案",
    summary: stringsOf(parsed.summary),
    patch: isObj(patch) ? normalizeApplyPatchValue(patch as ApplyPatch) : {},
    ...(tasks ? { tasks } : {}),
    review: {
      frames: normalizeReviewFrames(review.frames),
      ...(normalizeReviewRange(review.range) ? { range: normalizeReviewRange(review.range) } : {}),
      ...(typeof review.clip === "boolean" ? { clip: review.clip } : {}),
      ...(isObj(review.observations)
        ? {
            observations: {
              ...(typeof review.observations.motion === "boolean" ? { motion: review.observations.motion } : {}),
              ...(typeof review.observations.sound === "boolean" ? { sound: review.observations.sound } : {}),
              ...(typeof review.observations.ocr === "boolean" ? { ocr: review.observations.ocr } : {}),
            },
          }
        : {}),
      notes: stringsOf(review.notes),
    },
  };
}

export function buildEditorAiPrompt(
  dir: string,
  cfg: Config,
  req: AiProposeRequest,
  options: ProposeEditorAiPromptOptions = {},
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts/editor-ai-propose.md"), "utf8");
  const selectionContext = {
    scope: req.selection?.scope ?? (req.selection ? "selection" : "global"),
    ...(req.selection ?? {}),
    activeShortName: req.activeShortName ?? req.selection?.activeShortName ?? null,
  };
  const projectProjection = sliceProjectProjection(
    describeJson(dir, cfg),
    selectionContext,
    { includeGlobalTimeline: wantsGlobalTimelineContext(req) },
  );
  const wantsRetrieval = /(素材|B-?roll|過去|以前|似た|画像|動画)/i.test(req.instruction);
  const retrieval = wantsRetrieval
    ? retrievalSearch(cfg.recordingsDir, {
        query: req.instruction,
        kind: "material",
        scope: "other",
        currentRecording: dir,
        limit: 5,
      })
    : [];
  return template
    .replace("{{outputSchema}}", editorAiOutputSchemaText())
    .replace("{{patchOnlyRules}}", options.patchOnly
      ? [
          "",
          "Patch-only requirement:",
          "- Return `edit.mode: \"patch\"` only. Do not return `edit.mode: \"tasks\"`.",
          "- For this request, generate concrete `ops` or `replace` edits directly.",
          "- For existing item edits, `set` and item `remove` targets must be stable ids like `@cap_xxxxxx`, `@mat_xxxxxx`, `@ins_xxxxxx`, `@bl_xxxxxx`, or `@ann_xxxxxx`.",
          "- Collection selectors such as `overlays.overlays`, `overlays.inserts`, and `overlays.annotations` are valid only for `add` ops or for clearing the whole collection with `remove`.",
          `- Reason: ${options.patchOnlyReason ?? "annotation edits must bypass intent compilation"}`,
        ].join("\n")
      : "")
    .replace("{{instruction}}", req.instruction.trim())
    .replace("{{selectionContext}}", JSON.stringify(selectionContext, null, 2))
    .replace("{{projectJson}}", JSON.stringify(projectProjection, null, 2))
    .replace("{{retrievalResults}}", JSON.stringify(retrieval, null, 2));
}

function shouldForcePatchOnly(req: AiProposeRequest): boolean {
  if (req.selection?.selectedKind === "annotation") return true;
  if (req.selection?.selectedIds?.some((id) => id.startsWith("ann_"))) return true;
  return /(注釈|annotation|arrow|box|spotlight)/i.test(req.instruction);
}

function isAiProposalRetryCandidate(message: string): boolean {
  return /AI 提案を適用できません: /.test(message)
    && (
      /\(intent\)/.test(message)
      || /overlays\.json annotations\[/.test(message)
      || /overlays\.json zooms\[\d+\]: rect /.test(message)
      || /\(patch\).*overlays\.annotations/.test(message)
      || /\(patch\).*overlays\.overlays/.test(message)
      || /\(patch\).*overlays\.inserts/.test(message)
      || /@ann_/.test(message)
    );
}

export function buildRefineEditorAiPrompt(
  input: RefineEditorAiInput,
  options: RefineEditorAiPromptOptions = {},
): string {
  const warningFixRules = input.mode === "warning-fix"
    ? [
        "",
        'When mode is "warning-fix":',
        "- The only goal is to reduce or resolve applyWarnings.",
        "- Do not perform general copy editing, caption shortening, cut changes, styling changes, or unrelated cleanup.",
        "- Keep acceptedHunkLabels unless the warning explicitly proves one is invalid.",
        "- Do not reintroduce rejectedHunkLabels unless the additional instruction explicitly asks for it.",
        "- Do not edit chapters.json in this implementation. If chapters.json should change, leave a review note instead.",
        "- Prefer transcript.json chapter telop edits over chapters.json edits for chapter/telop sync warnings.",
        "- For overlays.json zoom rect aspect ratio warnings, adjust only the affected zoom rect and preserve id/start/end.",
        "- For overlays.json zoom rect errors, keep the affected zoom rect inside the output resolution and preserve id/start/end.",
        "- If a warning cannot be fixed safely, leave the patch unchanged for that warning and explain it in review.notes.",
        "- In review.notes, state how many warnings you addressed.",
        "- In review.notes, explain every warning you did not address.",
        "- If fixing a warning would require chapters.json changes, write `chapters.json の編集が必要` in review.notes.",
      ]
    : [];
  const patchOnlyRules = options.patchOnly
      ? [
        "",
        "Retry requirement:",
        "- The previous attempt failed validation before apply.",
        "- Return `edit.mode: \"patch\"` only. Do not return `edit.mode: \"tasks\"` in this retry.",
        "- Use concrete `ops` or `replace` edits that can be applied directly.",
        "- For existing item edits, `set` and item `remove` targets must be stable ids like `@cap_xxxxxx`, `@mat_xxxxxx`, `@ins_xxxxxx`, `@bl_xxxxxx`, or `@ann_xxxxxx`.",
        "- Collection selectors such as `overlays.overlays`, `overlays.inserts`, and `overlays.annotations` are valid only for `add` ops or for clearing the whole collection with `remove`.",
        "- For overlays.json zoom rect failures, keep the affected zoom rect inside the output resolution and preserve id/start/end.",
        `- Previous failure: ${options.retryReason ?? "unknown"}`,
      ]
    : [];
  return [
    "You are revising a cutflow GUI edit proposal.",
    "Return exactly one JSON object. Do not wrap it in Markdown. Do not add prose before or after it.",
    "",
    "The JSON contract is the schema below. Treat it as authoritative:",
    "",
    editorAiOutputSchemaText(),
    "",
    "Rules:",
    "",
    '- Prefer `edit.mode: "tasks"` for supported operations. Use `edit.mode: "patch"` only as fallback.',
    '- Only edit `cutplan`, `transcript`, `overlays`, `bgm`, or `shorts`.',
    '- Do not use `target: "overlays.annotations"` for `set` edits to an existing annotation.',
    '- For existing annotation item edits, use the stable item id such as `@ann_xxxxxx`, or use `replace` when a whole-array rewrite is truly necessary.',
    '- Use `target: "overlays.annotations"` only for `add`, or for clearing the whole collection with `remove`.',
    "- Do not edit `approved` or `approvals.json`.",
    "- Do not edit generated artifacts.",
    "- `baseDocs` is the saved baseline on disk.",
    "- `candidateDocs` is the user's currently preferred candidate after keeping only accepted hunks from the prior proposal.",
    "- `acceptedHunkLabels` are prior proposal hunks the user currently plans to use.",
    "- `rejectedHunkLabels` are prior proposal hunks the user does not plan to use. Do not reintroduce those changes unless the additional instruction explicitly asks for them.",
    "- `priorProposalDiff` lists every hunk from the prior proposal with current and proposed values.",
    "- Deterministic checks are the primary observation. Treat them as authoritative over image impressions.",
    "- VLM summary is secondary observation only. It can describe visual concerns, but it is not the source of truth for coordinates, patches, or approval.",
    "- Never generate a patch directly from VLM observations alone.",
    "- Keep the revised patch focused on the original instruction plus any additional instruction.",
    ...warningFixRules,
    ...patchOnlyRules,
    "",
    "Refinement context:",
    "",
    refineContextJson(input),
  ].join("\n");
}

export function planEditorAiPatch(
  dir: string,
  parsed: ParsedAiPatchResponse,
): AiProposeResponse {
  const outputBounds = readManifest(dir).video.screenRegion;
  const intentPlan = parsed.tasks ? planIntentEdits(dir, parsed.tasks) : null;
  if (intentPlan && intentPlan.errors.length > 0 && hasPatchEdits(parsed.patch)) {
    const patchApplyPlan = planApply(dir, parsed.patch);
    if (patchApplyPlan.errors.length === 0) {
      const normalizedBody = normalizeAiApplyBody(patchApplyPlan.body, outputBounds);
      const normalizedApplyPlan = { ...patchApplyPlan, body: normalizedBody };
      const unsupported = normalizedApplyPlan.changedFiles.filter((f) => f === "chapters.json" || f === "thumbnail.json");
      if (unsupported.length > 0) {
        throw new EditorAiError(400, `GUI 提案では編集できないファイルです: ${unsupported.join(", ")}`);
      }
      const proposedDocs = reviewDocsOf(mergeBodyOverDisk(dir, normalizedApplyPlan.body));
      return {
        title: parsed.title,
        summary: parsed.summary,
        patch: { replace: normalizedBody },
        ...(parsed.tasks ? { tasks: parsed.tasks } : {}),
        applyPlan: normalizedApplyPlan,
        proposedDocs,
        review: parsed.review,
      };
    }
  }
  const compiledPatch = intentPlan?.intentPlan.patch ?? parsed.patch;
  const rawApplyPlan = intentPlan ?? planApply(dir, compiledPatch);
  if (rawApplyPlan.errors.length > 0) {
    const detail = rawApplyPlan.errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ");
    throw new EditorAiError(400, `AI 提案を適用できません: ${detail}`);
  }
  const normalizedBody = normalizeAiApplyBody(rawApplyPlan.body, outputBounds);
  const applyPlan = { ...rawApplyPlan, body: normalizedBody };
  const unsupported = applyPlan.changedFiles.filter((f) => f === "chapters.json" || f === "thumbnail.json");
  if (unsupported.length > 0) {
    throw new EditorAiError(400, `GUI 提案では編集できないファイルです: ${unsupported.join(", ")}`);
  }
  const proposedDocs = reviewDocsOf(mergeBodyOverDisk(dir, applyPlan.body));
  return {
    title: parsed.title,
    summary: parsed.summary,
    patch: { replace: normalizedBody },
    ...(parsed.tasks ? { tasks: parsed.tasks } : {}),
    applyPlan,
    proposedDocs,
    review: parsed.review,
  };
}

export async function proposeEditorAi(
  dir: string,
  cfg: Config,
  req: AiProposeRequest,
): Promise<AiProposeResponse> {
  if (!req.instruction.trim()) {
    throw new EditorAiError(400, "AI 指示が空です");
  }
  const fillReviewFrames = (parsed: ParsedAiPatchResponse): ParsedAiPatchResponse => {
    if (parsed.review.frames.length === 0 && req.selection) {
      const sliced = sliceReviewContext(describeJson(dir, cfg), {
        scope: req.selection.scope,
        playheadSec: req.selection.playheadSec,
        selectedRange: req.selection.selectedRange,
        selectedIds: req.selection.selectedIds,
        activeShortName: req.activeShortName,
      });
      parsed.review.frames = sliced.frameCandidates.map((frame) => ({
        axis: "source",
        atSec: frame.sourceSec,
        reason: frame.reason,
      }));
      parsed.review.range = { axis: "source", ...sliced.sourceRange };
    }
    return parsed;
  };
  const runAttempt = async (options: ProposeEditorAiPromptOptions = {}): Promise<AiProposeResponse> => {
    const prompt = buildEditorAiPrompt(dir, cfg, req, options);
    const raw = await completeWithJsonSchema(prompt, cfg, EDITOR_AI_RESPONSE_SCHEMA);
    const parsed = fillReviewFrames(parseAiPatchResponse(raw));
    return planEditorAiPatch(dir, parsed);
  };
  try {
    return await runAttempt(shouldForcePatchOnly(req)
      ? { patchOnly: true, patchOnlyReason: "annotation edits must bypass intent compilation" }
      : {});
  } catch (error) {
    if (
      error instanceof EditorAiError
      && (shouldForcePatchOnly(req) || isAiProposalRetryCandidate(error.message))
      && isAiProposalRetryCandidate(error.message)
    ) {
      return runAttempt({ patchOnly: true, patchOnlyReason: error.message });
    }
    throw error;
  }
}

export async function refineEditorAi(
  dir: string,
  cfg: Config,
  input: RefineEditorAiInput,
): Promise<AiProposeResponse> {
  if (!input.originalInstruction.trim()) {
    throw new EditorAiError(400, "AI 指示が空です");
  }
  const runAttempt = async (options: RefineEditorAiPromptOptions = {}): Promise<AiProposeResponse> => {
    const prompt = buildRefineEditorAiPrompt(input, options);
    const raw = await completeWithJsonSchema(prompt, cfg, EDITOR_AI_RESPONSE_SCHEMA);
    const parsed = parseAiPatchResponse(raw);
    return planEditorAiPatch(dir, parsed);
  };
  try {
    return await runAttempt();
  } catch (error) {
    if (
      error instanceof EditorAiError
      && (
        (input.mode === "warning-fix" && /AI 提案を適用できません: \(intent\)/.test(error.message))
        || isAiProposalRetryCandidate(error.message)
      )
    ) {
      return runAttempt({ patchOnly: true, retryReason: error.message });
    }
    throw error;
  }
}
