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
import type { ApplyPatch, Bgm, CutPlan, Overlays, Shorts, Transcript } from "../types.ts";
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

const PLAYHEAD_CONTEXT_SEC = 12;
const SELECTION_CONTEXT_PAD_SEC = 4;

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

function sliceProjectProjection(proj: DescribeProjection, selection: AiSelectionContext): unknown {
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
      },
      note: "This is a project-level summary. Ask for a narrower scope if exact local timing context is needed.",
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
    patch: isObj(patch) ? patch as ApplyPatch : {},
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
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts/editor-ai-propose.md"), "utf8");
  const selectionContext = {
    scope: req.selection?.scope ?? (req.selection ? "selection" : "global"),
    ...(req.selection ?? {}),
    activeShortName: req.activeShortName ?? req.selection?.activeShortName ?? null,
  };
  const projectProjection = sliceProjectProjection(describeJson(dir, cfg), selectionContext);
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
    .replace("{{instruction}}", req.instruction.trim())
    .replace("{{selectionContext}}", JSON.stringify(selectionContext, null, 2))
    .replace("{{projectJson}}", JSON.stringify(projectProjection, null, 2))
    .replace("{{retrievalResults}}", JSON.stringify(retrieval, null, 2));
}

export function planEditorAiPatch(
  dir: string,
  parsed: ParsedAiPatchResponse,
): AiProposeResponse {
  const intentPlan = parsed.tasks ? planIntentEdits(dir, parsed.tasks) : null;
  const compiledPatch = intentPlan?.intentPlan.patch ?? parsed.patch;
  const applyPlan = intentPlan ?? planApply(dir, compiledPatch);
  if (applyPlan.errors.length > 0) {
    const detail = applyPlan.errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ");
    throw new EditorAiError(400, `AI 提案を適用できません: ${detail}`);
  }
  const unsupported = applyPlan.changedFiles.filter((f) => f === "chapters.json" || f === "thumbnail.json");
  if (unsupported.length > 0) {
    throw new EditorAiError(400, `GUI 提案では編集できないファイルです: ${unsupported.join(", ")}`);
  }
  const proposedDocs = reviewDocsOf(mergeBodyOverDisk(dir, applyPlan.body));
  return {
    title: parsed.title,
    summary: parsed.summary,
    patch: compiledPatch,
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
  const prompt = buildEditorAiPrompt(dir, cfg, req);
  const raw = await completeWithJsonSchema(prompt, cfg, EDITOR_AI_RESPONSE_SCHEMA, "editor-proposal");
  const parsed = parseAiPatchResponse(raw);
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
  return planEditorAiPatch(dir, parsed);
}
