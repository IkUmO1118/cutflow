// H1(pull型知覚)+ H2(検証の主経路化)の有界 tool-use ループ本体。
// §docs/plans/2026-07-11-h1-h2-agentic-perception-loop-design.md
//
// 判断 LLM に read-only の知覚 tool(describe/frames/av/materials/ocr)+
// set_cuts/run_assert(検証)を握らせ、「生成 → tool 往復 → 最終 cuts」の
// 1ターンを回す。tool は既存の知覚コマンド関数の薄いラッパで、新しい知覚
// 計算はここでは行わない。最終出力は既存の CUTS_RESPONSE_SCHEMA(番号選択)
// のみで、任意区間の書込みは無い(R0 は不変)。
//
// plan.harness.agentic が off のときはこのモジュール自体が呼ばれない
// (stages/plan.ts の分岐)。§1-1 バイト等価はそちらで担保される。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../exec.ts";
import { profileForRoute, resolveAiRuntimeConfig } from "../config.ts";
import { adapterFor } from "./registry.ts";
import { completeWithJsonSchema } from "../llm.ts";
import { buildCutplan, toCutplanIdContext } from "../buildCutplan.ts";
import { CUTS_RESPONSE_SCHEMA, parseCutsResponse } from "../cutsResponse.ts";
import { describeJson } from "../../stages/describe.ts";
import { frames } from "../../stages/frames.ts";
import { av, formatAvSummary } from "../../stages/av.ts";
import { materials } from "../../stages/materials.ts";
import { assert } from "../../stages/assert.ts";
import { computeSegmentOcr } from "../perception.ts";
import type { Config } from "../config.ts";
import type { NumberedSegment } from "../../stages/plan.ts";
import type { CutPlan, Manifest, PlanSegment } from "../../types.ts";
import type { AiAdapter, AiAgenticToolHandler, AiImagePart } from "./types.ts";

/** read-only 知覚 + 検証 tool 1件の定義(§2.1 の7 tool)。handler は既存
 * ステージ関数の薄いラッパで、副作用は set_cuts の cutplan.json 書込だけ */
export interface CutTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: unknown, ctx: AgenticCtx): Promise<{ text?: string; images?: AiImagePart[]; isError?: boolean }>;
}

export interface AgenticCtx {
  dir: string;
  cfg: Config;
  numbered: NumberedSegment[];
  idCtx?: { used: Set<string>; existingCutplanSegments: PlanSegment[] };
  budget: { maxToolCalls: number; used: number };
  warn: (msg: string) => void;
  trace: AgenticTraceEntry[];
  /** plan.harness.tools。省略キーは on 扱い(resolvePlanHarnessCfg が既定を埋める) */
  toolsEnabled: { frames: boolean; av: boolean; materials: boolean; ocr: boolean };
}

export interface AgenticTraceEntry {
  tool: string;
  argsDigest: string;
  resultDigest: string;
}

export interface AgenticResult {
  cuts: { id: number; reason: string }[];
  trace: AgenticTraceEntry[];
  raw: string;
  /** フォールバックした理由(あれば)。null=agentic 完走 */
  degraded: string | null;
}

/* --------------------------- 補助関数(fs 読み) --------------------------- */

/** 現在の cutplan.json(存在すれば)から、numbered の各候補 id の action/reason
 * を span(start:end)一致で引く。cutplan.json が無ければ空 Map(=全 keep 扱い) */
function currentCutActions(
  dir: string,
  numbered: NumberedSegment[],
): Map<number, { action: "keep" | "cut"; reason: string }> {
  const map = new Map<number, { action: "keep" | "cut"; reason: string }>();
  const path = join(dir, "cutplan.json");
  if (!existsSync(path)) return map;
  const cutplan = JSON.parse(readFileSync(path, "utf8")) as CutPlan;
  for (const n of numbered) {
    const seg = cutplan.segments.find((s) => s.start === n.start && s.end === n.end);
    if (seg) map.set(n.id, { action: seg.action, reason: seg.reason });
  }
  return map;
}

/** describe/set_cuts/run_assert が cutplan.json 依存の読み取りをできるよう、
 * agentic ターン開始前に(無ければ)全 keep の cutplan.json を用意する。
 * 既にある(前 iteration の最終結果・rerun 等)ときは触らない */
function ensureInitialCutplan(ctx: AgenticCtx): void {
  const path = join(ctx.dir, "cutplan.json");
  if (existsSync(path)) return;
  const cutplan = buildCutplan(ctx.numbered, [], toCutplanIdContext(ctx.idCtx));
  writeFileSync(path, JSON.stringify(cutplan, null, 2));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 12);
}

function summarizeMaterials(index: { materials: { file: string; kind: string; present: boolean; used: boolean; probe?: { durationSec?: number } }[] }): string {
  if (index.materials.length === 0) return "素材なし(materials/ 配下が空、参照もなし)";
  return index.materials
    .map((m) => {
      const dur = m.probe?.durationSec !== undefined ? `${m.probe.durationSec.toFixed(1)}秒` : "尺不明";
      const flags = [
        m.present ? null : "dangling(参照はあるが実ファイルなし)",
        m.used ? null : "未使用",
      ].filter((f): f is string => f !== null);
      return `- ${m.file} (${m.kind}, ${dur})${flags.length ? ` [${flags.join(", ")}]` : ""}`;
    })
    .join("\n");
}

function formatOutcomes(outcomes: { status: string; label?: string; message: string }[]): string {
  if (outcomes.length === 0) return "assertions.json がありません(検査対象なし)";
  return outcomes.map((o) => `[${o.status}]${o.label ? ` ${o.label}:` : ""} ${o.message}`).join("\n");
}

/* ------------------------------- tool 定義 ------------------------------- */

const describeTimelineTool: CutTool = {
  name: "describe_timeline",
  description: "現在の暫定 cutplan の keep/cut・発話・出力尺を読む。候補全体の文脈を確認したいときに呼ぶ(引数なし)。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handle(_args, ctx) {
    const proj = describeJson(ctx.dir, ctx.cfg);
    const actions = currentCutActions(ctx.dir, ctx.numbered);
    const lines = ctx.numbered.map((n) => {
      const a = actions.get(n.id);
      const tag = a?.action === "cut" ? `cut(${a.reason || "無題"})` : "keep";
      return `#${n.id} [${n.start.toFixed(2)}-${n.end.toFixed(2)}] ${tag}: ${n.text || "(発言なし)"}`;
    });
    const summary = `出力尺: ${proj.summary.outDurationSec.toFixed(1)}秒 / keep区間: ${proj.summary.keepCount} / cut区間: ${proj.cuts.length}`;
    return { text: [summary, ...lines].join("\n") };
  },
};

const getFramesTool: CutTool = {
  name: "get_frames",
  description: "指定した元収録秒(最大4件)の最終合成フレームを画像で見る。迷った候補だけに使う(コスト高)。",
  inputSchema: {
    type: "object",
    required: ["times"],
    properties: {
      times: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 4 },
    },
    additionalProperties: false,
  },
  async handle(args, ctx) {
    const times = (args as { times?: unknown } | null)?.times;
    if (!Array.isArray(times) || times.some((t) => typeof t !== "number") || times.length === 0) {
      return { text: "times は数値配列(1〜4件)で指定してください", isError: true };
    }
    try {
      const shots = await frames(ctx.dir, { mode: "times", times: times as number[], axis: "source" }, ctx.cfg);
      const images: AiImagePart[] = shots.map((s) => ({
        type: "image",
        file: s.file,
        mediaType: "image/png",
        label: `frame @source=${s.requested.toFixed(2)}s (out=${s.outSec.toFixed(2)}s)${s.note ? ` ${s.note}` : ""}`,
      }));
      const text = shots
        .map((s) => `t=${s.requested.toFixed(2)} -> out=${s.outSec.toFixed(2)}${s.note ? ` (${s.note})` : ""}`)
        .join("\n");
      return { images, text };
    } catch (error) {
      ctx.warn(`get_frames に失敗しました: ${(error as Error).message}`);
      return { text: `get_frames に失敗しました: ${(error as Error).message}`, isError: true };
    }
  },
};

const probeAvTool: CutTool = {
  name: "probe_av",
  description: "出力(カット後)レンジの motion/sound(無音・freeze・mic/system の被り)を読む。引数省略で全体。",
  inputSchema: {
    type: "object",
    properties: {
      startSec: { type: "number" },
      endSec: { type: "number" },
    },
    additionalProperties: false,
  },
  async handle(args, ctx) {
    const { startSec, endSec } = (args ?? {}) as { startSec?: number; endSec?: number };
    const range = typeof startSec === "number" && typeof endSec === "number" ? { startSec, endSec } : undefined;
    try {
      const result = await av(ctx.dir, { range }, ctx.cfg);
      const lines = formatAvSummary(result);
      return { text: lines.length > 0 ? lines.join("\n") : "(結果なし)" };
    } catch (error) {
      ctx.warn(`probe_av に失敗しました: ${(error as Error).message}`);
      return { text: `probe_av に失敗しました: ${(error as Error).message}`, isError: true };
    }
  },
};

const probeMaterialsTool: CutTool = {
  name: "probe_materials",
  description: "素材(B-roll)のメタ(尺・参照・未使用/dangling)を読む(引数なし)。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handle(_args, ctx) {
    try {
      const result = await materials(ctx.dir, {}, ctx.cfg);
      return { text: summarizeMaterials(result.index) };
    } catch (error) {
      ctx.warn(`probe_materials に失敗しました: ${(error as Error).message}`);
      return { text: `probe_materials に失敗しました: ${(error as Error).message}`, isError: true };
    }
  },
};

const ocrScreenTool: CutTool = {
  name: "ocr_screen",
  description: "指定した候補 id の代表フレームの画面内テキストを OCR で読む(macOS 専用。非対応環境は空+警告)。",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "integer" } },
    additionalProperties: false,
  },
  async handle(args, ctx) {
    const { id } = (args ?? {}) as { id?: number };
    const seg = ctx.numbered.find((n) => n.id === id);
    if (!seg) return { text: `候補 id=${id} は存在しません`, isError: true };
    const manifestPath = join(ctx.dir, "manifest.json");
    if (!existsSync(manifestPath)) return { text: "manifest.json がありません", isError: true };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const results = await computeSegmentOcr(
      ctx.dir,
      manifest,
      [seg],
      { ocrMaxSegments: 1, ocrMaxLines: 10, languages: ctx.cfg.ocr?.languages },
      ctx.warn,
    );
    if (results.length === 0) return { text: `#${id} 画面テキストなし(非対応環境の可能性あり)` };
    return { text: `#${id} 画面: ${results[0]!.lines.map((l) => `"${l}"`).join(" / ")}` };
  },
};

const setCutsTool: CutTool = {
  name: "set_cuts",
  description:
    "暫定のカット選択(候補id配列)を cutplan.json に書き、assert と出力尺の観測を得る。存在しない候補idは拒否され書込みは行われない。",
  inputSchema: {
    type: "object",
    required: ["cuts"],
    properties: {
      cuts: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "reason"],
          properties: { id: { type: "integer" }, reason: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  async handle(args, ctx) {
    const list = ((args as { cuts?: { id: number; reason: string }[] } | null)?.cuts ?? []);
    const invalid = list.filter((c) => !ctx.numbered.some((n) => n.id === c.id));
    if (invalid.length > 0) {
      return {
        text: `拒否: 存在しない候補 id です: ${invalid.map((c) => c.id).join(", ")}(cutplan.json は更新していません)`,
        isError: true,
      };
    }
    const cutplan = buildCutplan(ctx.numbered, list, toCutplanIdContext(ctx.idCtx));
    writeFileSync(join(ctx.dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));
    const report = await assert(ctx.dir);
    const proj = describeJson(ctx.dir, ctx.cfg);
    const lines = [
      `出力尺: ${proj.summary.outDurationSec.toFixed(1)}秒 / keep区間: ${proj.summary.keepCount} / cut区間: ${proj.cuts.length}`,
      formatOutcomes(report.outcomes),
    ];
    return { text: lines.join("\n") };
  },
};

const runAssertTool: CutTool = {
  name: "run_assert",
  description: "決定論アサーション(assertions.json)だけ再評価する(引数なし)。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handle(_args, ctx) {
    const report = await assert(ctx.dir);
    return { text: formatOutcomes(report.outcomes) };
  },
};

/** ctx.toolsEnabled に従って有効な tool だけを返す。describe_timeline/
 * set_cuts/run_assert は常時有効(個別 off に対応する設定項目が無い) */
function buildToolRegistry(ctx: AgenticCtx): CutTool[] {
  const tools: CutTool[] = [describeTimelineTool];
  if (ctx.toolsEnabled.frames) tools.push(getFramesTool);
  if (ctx.toolsEnabled.av) tools.push(probeAvTool);
  if (ctx.toolsEnabled.materials) tools.push(probeMaterialsTool);
  if (ctx.toolsEnabled.ocr) tools.push(ocrScreenTool);
  tools.push(setCutsTool, runAssertTool);
  return tools;
}

/** off 時フォールバック(§1-4): tool 無しで単発 completeWithJsonSchema を叩く
 * (stages/plan.ts の completeStructuredCuts と同じ経路。循環 import を避けるため
 * plan.ts は経由せず lib/llm.ts を直接使う) */
async function completeStructuredCutsFallback(prompt: string, cfg: Config): Promise<string> {
  return await completeWithJsonSchema(prompt, cfg, CUTS_RESPONSE_SCHEMA, "plan");
}

/**
 * 1回の「生成ターン」= tool を使いながら最終 cuts を1つ得る
 * (runCutsLoop の per-iteration complete() を置き換える単位)。
 *
 * - `ctx.cfg` の structured route アダプタが `completeAgentic` を持たない、
 *   または実行中に回復不能なエラーが起きた場合は、警告のうえ tool 無しの
 *   単発 completeWithJsonSchema にフォールバックする(§1-4。例外を投げず
 *   必ず cuts を返す)。
 * - `adapterOverride` / `fallbackOverride` はテスト専用の注入点(fake アダプタ
 *   でループを駆動し、フォールバックも実ネットワークを叩かずに検証できる)。
 */
export async function agenticCutTurn(args: {
  firstPrompt: string;
  ctx: AgenticCtx;
  adapterOverride?: AiAdapter;
  fallbackOverride?: (prompt: string, cfg: Config) => Promise<string>;
}): Promise<AgenticResult> {
  const { firstPrompt, ctx } = args;
  const fallback = args.fallbackOverride ?? completeStructuredCutsFallback;
  const runtime = resolveAiRuntimeConfig(ctx.cfg);
  const profile = profileForRoute(runtime, "structured");
  const adapter = args.adapterOverride ?? adapterFor(profile.adapter);

  if (!adapter.completeAgentic) {
    ctx.warn(
      `AI アダプタ "${profile.adapter}" は tool-use(completeAgentic) に対応していません。単発経路にフォールバックします`,
    );
    const raw = await fallback(firstPrompt, ctx.cfg);
    return { cuts: parseCutsResponse(raw).cuts, trace: ctx.trace, raw, degraded: "adapter-not-agentic" };
  }

  ensureInitialCutplan(ctx);
  const tools = buildToolRegistry(ctx);

  const handleTool: AiAgenticToolHandler = async (name, input) => {
    if (ctx.budget.used >= ctx.budget.maxToolCalls) {
      return {
        text: "tool 呼び出し上限(maxToolCalls)に達しました。ここまでの set_cuts の結果で最終回答してください。",
        isError: true,
      };
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { text: `未知の tool です: ${name}`, isError: true };
    ctx.budget.used += 1;
    const result = await tool.handle(input, ctx);
    ctx.trace.push({ tool: name, argsDigest: digest(input), resultDigest: digest({ text: result.text, images: result.images?.length ?? 0 }) });
    return result;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await adapter.completeAgentic(
      {
        route: "structured",
        parts: [{ type: "text", text: firstPrompt }],
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        output: { kind: "json-schema", format: CUTS_RESPONSE_SCHEMA },
        maxOutputTokens: profile.maxOutputTokens,
        maxToolCalls: ctx.budget.maxToolCalls,
        purpose: "plan",
      },
      profile,
      { signal: controller.signal, fetch: globalThis.fetch, readFile: readFileSync, run },
      handleTool,
    );
    const parsed = parseCutsResponse(response.text);
    return { cuts: parsed.cuts, trace: ctx.trace, raw: response.text, degraded: null };
  } catch (error) {
    ctx.warn(`agentic ループが失敗しました。単発経路にフォールバックします: ${(error as Error).message}`);
    const raw = await fallback(firstPrompt, ctx.cfg);
    return { cuts: parseCutsResponse(raw).cuts, trace: ctx.trace, raw, degraded: (error as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
