import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import type { JsonSchemaTextFormat } from "../lib/llm.ts";
import { mergeBodyOverDisk, planApply } from "../lib/applyEdits.ts";
import type { ApplyPlan } from "../lib/applyEdits.ts";
import type { ReviewDocs } from "../lib/docDiff.ts";
import type { Config } from "../lib/config.ts";
import { describeJson } from "./describe.ts";
import type { DescribeProjection, CaptionEntry, MappedInterval } from "./describe.ts";
import type { ApplyPatch, Bgm, CutPlan, Overlays, Shorts, Transcript } from "../types.ts";

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
  applyPlan: ApplyPlan;
  proposedDocs: ReviewDocs;
  review: {
    frames: string[];
    notes: string[];
  };
}

export interface ParsedAiPatchResponse {
  title: string;
  summary: string[];
  patch: ApplyPatch;
  review: {
    frames: string[];
    notes: string[];
  };
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
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "patch", "review"],
    properties: {
      title: { type: "string" },
      summary: { type: "array", items: { type: "string" } },
      patch: {
        type: "object",
        additionalProperties: false,
        properties: {
          ops: { type: "array", items: EDITOR_AI_PATCH_ITEM_SCHEMA },
          replace: { type: "object" },
        },
      },
      review: {
        type: "object",
        additionalProperties: false,
        required: ["frames", "notes"],
        properties: {
          frames: { type: "array", items: { type: "string" } },
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
  const patch = parsed.patch;
  if (!isObj(patch)) {
    throw new EditorAiError(400, "AI 応答に patch オブジェクトがありません");
  }
  const review = isObj(parsed.review) ? parsed.review : {};
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "AI 提案",
    summary: stringsOf(parsed.summary),
    patch: patch as ApplyPatch,
    review: {
      frames: stringsOf(review.frames),
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
  return template
    .replace("{{outputSchema}}", editorAiOutputSchemaText())
    .replace("{{instruction}}", req.instruction.trim())
    .replace("{{selectionContext}}", JSON.stringify(selectionContext, null, 2))
    .replace("{{projectJson}}", JSON.stringify(projectProjection, null, 2));
}

export function planEditorAiPatch(
  dir: string,
  parsed: ParsedAiPatchResponse,
): AiProposeResponse {
  const applyPlan = planApply(dir, parsed.patch);
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
    patch: parsed.patch,
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
  const raw = await completeWithJsonSchema(prompt, cfg, EDITOR_AI_RESPONSE_SCHEMA);
  return planEditorAiPatch(dir, parseAiPatchResponse(raw));
}
