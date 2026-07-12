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
import { profileForRoute, resolveAiRuntimeConfig, resolveCandidatesCfg } from "../config.ts";
import { adapterFor } from "./registry.ts";
import { completeWithJsonSchema } from "../llm.ts";
import { buildCutplan, toCutplanIdContext } from "../buildCutplan.ts";
import { applyCandidateSplits, splitSegmentAtWords, wordsForCandidate } from "../candidateSplit.ts";
import type { CandidateSplitCfg, SplitOp } from "../candidateSplit.ts";
import { CUTS_RESPONSE_SCHEMA, parseCutsResponse } from "../cutsResponse.ts";
import { describeJson } from "../../stages/describe.ts";
import { frames } from "../../stages/frames.ts";
import { av, formatAvSummary } from "../../stages/av.ts";
import { materials } from "../../stages/materials.ts";
import { assert } from "../../stages/assert.ts";
import { validate } from "../../stages/validate.ts";
import { computeSegmentOcr } from "../perception.ts";
import type { Config } from "../config.ts";
import type { NumberedSegment } from "../../stages/plan.ts";
import type { CutPlan, Manifest, PlanSegment, WordTiming } from "../../types.ts";
import type { AiAdapter, AiAgenticToolHandler, AiImagePart } from "./types.ts";

export type { SplitOp } from "../candidateSplit.ts";

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
  /** 元収録の全長(秒)。cutplan の穴(無音)を cut で埋め全時間を連続被覆する */
  durationSec: number;
  idCtx?: { used: Set<string>; existingCutplanSegments: PlanSegment[] };
  budget: { maxToolCalls: number; used: number };
  warn: (msg: string) => void;
  trace: AgenticTraceEntry[];
  /** plan.harness.tools。省略キーは on 扱い(resolvePlanHarnessCfg が既定を埋める) */
  toolsEnabled: { frames: boolean; av: boolean; materials: boolean; ocr: boolean };
  /** plan.harness.applySplit(H6・既定 false)。true のときだけ list_words/
   * split_candidate がツールレジストリに現れる(§SD5design §1-1) */
  applySplit: boolean;
  /** 1ターンの分割上限(plan.harness.maxSplits) */
  maxSplits: number;
  /** 確定済み分割(候補内部の語境界 cut)。ターンを跨いで蓄積される
   * (呼び出し側=runCutsLoop が反復間で持ち回る) */
  splits: SplitOp[];
  /** このターンの split_candidate 呼び出しの試行ログ(採否問わず)。
   * plan.loop.json の splitOps トレース(中間生成物)の元 */
  splitTrace: SplitTraceEntry[];
  /** transcript 全体の語タイムスタンプ(collectWords 済み)。applySplit off の
   * ときは list_words/split_candidate 自体が登録されないため未使用 */
  words: WordTiming[];
}

export interface AgenticTraceEntry {
  tool: string;
  argsDigest: string;
  resultDigest: string;
}

/** split_candidate 1回の試行ログ(§1-8 中間生成物・ダイジェストのみ・生 args 不可) */
export interface SplitTraceEntry {
  candidateId: number;
  wordRanges: string;
  accepted: boolean;
  check?: string;
}

export interface AgenticResult {
  cuts: { id: number; reason: string }[];
  trace: AgenticTraceEntry[];
  raw: string;
  /** フォールバックした理由(あれば)。null=agentic 完走 */
  degraded: string | null;
  /** このターン終了時点の確定済み分割(§2.4 の最終 cutplan 組み立てに使う) */
  splits: SplitOp[];
  splitTrace: SplitTraceEntry[];
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
  const cutplan = buildCutplan(ctx.numbered, [], toCutplanIdContext(ctx.idCtx), {
    duration: ctx.durationSec,
    reason: ctx.cfg.detect?.silenceCutReason,
  });
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

/** plan.harness.applySplit 用の CandidateSplitCfg(既存 candidates.minCandidateSec を
 * 再利用。新しい設定キーは足さない=§3 の change table どおり) */
function splitCfgOf(cfg: Config): CandidateSplitCfg {
  return { minCandidateSec: resolveCandidatesCfg(cfg).minCandidateSec };
}

/** 現在の cutplan.json(候補id単位の action)から set_cuts 形式の cuts 配列を復元する。
 * split_candidate が §2.4 の式(applyCandidateSplits(buildCutplan(現在cuts), ...))を
 * 組み立てる際の「現在の候補選択」の元。cutplan.json が無ければ空(全 keep 扱い) */
function currentCutsList(dir: string, numbered: NumberedSegment[]): { id: number; reason: string }[] {
  const actions = currentCutActions(dir, numbered);
  return numbered
    .filter((n) => actions.get(n.id)?.action === "cut")
    .map((n) => ({ id: n.id, reason: actions.get(n.id)!.reason }));
}

const listWordsTool: CutTool = {
  name: "list_words",
  description:
    "候補 #id 内の語を1始まり index 付きで返す(split_candidate の cutWordRanges で使う index の元)。語タイムスタンプが無い候補は分割不可を返す。",
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
    const words = wordsForCandidate({ start: seg.start, end: seg.end }, ctx.words);
    if (words.length === 0) {
      return { text: `#${id} は語タイムスタンプがありません(この候補は分割できません)` };
    }
    const lines = words.map((w, i) => `${i + 1} "${w.text}" [${w.start.toFixed(2)}-${w.end.toFixed(2)}]`);
    return { text: `#${id} の語(全${words.length}語):\n${lines.join("\n")}` };
  },
};

const splitCandidateTool: CutTool = {
  name: "split_candidate",
  description:
    "候補 #id の中で、list_words の index i〜j(両端含む)の sub-span を cut にする(候補内部を語境界で分割・R0 突破)。境界は既存語境界へ自動スナップし、時刻は書かない。分割は validate+assert 通過時のみ確定し、失敗時は自動ロールバックされる(拒否理由が返る)。1ターンの分割数には上限(maxSplits)がある。",
  inputSchema: {
    type: "object",
    required: ["id", "cutWordRanges"],
    properties: {
      id: { type: "integer" },
      cutWordRanges: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["i", "j", "reason"],
          properties: {
            i: { type: "integer" },
            j: { type: "integer" },
            reason: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  async handle(args, ctx) {
    const { id, cutWordRanges } = (args ?? {}) as {
      id?: number;
      cutWordRanges?: { i: number; j: number; reason: string }[];
    };
    if (ctx.splits.length >= ctx.maxSplits) {
      return {
        text: `分割上限(maxSplits=${ctx.maxSplits})に達しました。これ以上の分割はできません(候補単位の set_cuts は引き続き使えます)。`,
        isError: true,
      };
    }
    const seg = ctx.numbered.find((n) => n.id === id);
    if (!seg) {
      return { text: `拒否: 存在しない候補 id です: ${id}(cutplan.json は更新していません)`, isError: true };
    }
    if (!Array.isArray(cutWordRanges) || cutWordRanges.length === 0) {
      return { text: "拒否: cutWordRanges は1件以上必要です", isError: true };
    }
    const wordRangesLabel = cutWordRanges.map((r) => `${r.i}-${r.j}`).join(",");

    const cfg = splitCfgOf(ctx.cfg);
    const candWords = wordsForCandidate({ start: seg.start, end: seg.end }, ctx.words);
    const preCheck = splitSegmentAtWords({ start: seg.start, end: seg.end }, candWords, cutWordRanges, cfg);
    if ("error" in preCheck) {
      ctx.splitTrace.push({ candidateId: id!, wordRanges: wordRangesLabel, accepted: false, check: preCheck.error });
      return { text: `分割は却下: ${preCheck.error}(cutplan.json は更新していません)`, isError: true };
    }

    const op: SplitOp = { candidateId: id!, segStart: seg.start, segEnd: seg.end, cutWordRanges };
    const trialSplits = [...ctx.splits, op];

    const cutplanPath = join(ctx.dir, "cutplan.json");
    const before = existsSync(cutplanPath) ? readFileSync(cutplanPath, "utf8") : null;

    const base = buildCutplan(ctx.numbered, currentCutsList(ctx.dir, ctx.numbered), toCutplanIdContext(ctx.idCtx), {
      duration: ctx.durationSec,
      reason: ctx.cfg.detect?.silenceCutReason,
    });
    const trial = applyCandidateSplits(base, trialSplits, ctx.words, cfg, ctx.idCtx && { used: ctx.idCtx.used });
    writeFileSync(cutplanPath, JSON.stringify(trial, null, 2));

    const validation = validate(ctx.dir);
    const report = await assert(ctx.dir);
    const broken = validation.errors.length > 0 || report.outcomes.some((o) => o.status === "error");
    if (broken) {
      if (before !== null) writeFileSync(cutplanPath, before);
      const reasons = [
        ...validation.errors.map((e) => `[validate] ${e.file} ${e.where}: ${e.message}`),
        ...report.outcomes.filter((o) => o.status === "error").map((o) => `[assert] ${o.message}`),
      ];
      const check = reasons.join(" / ") || "不明なエラー";
      ctx.splitTrace.push({ candidateId: id!, wordRanges: wordRangesLabel, accepted: false, check });
      return { text: `分割は却下(検査エラーのためロールバック): ${check}`, isError: true };
    }

    ctx.splits.push(op);
    ctx.splitTrace.push({ candidateId: id!, wordRanges: wordRangesLabel, accepted: true });
    const proj = describeJson(ctx.dir, ctx.cfg);
    const lines = [
      `分割OK: 候補#${id} の語 ${wordRangesLabel} を cut`,
      `出力尺: ${proj.summary.outDurationSec.toFixed(1)}秒 / keep区間: ${proj.summary.keepCount} / cut区間: ${proj.cuts.length}`,
      formatOutcomes(report.outcomes),
    ];
    return { text: lines.join("\n") };
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
    // §2.4 の相互作用: set_cuts が後から候補を全 cut にした場合、その候補の
    // split は無意味になるため、常に applyCandidateSplits(buildCutplan(...), ctx.splits, ...)
    // で組み直す(単一の権威ある再構築)。ctx.splits が空(applySplit off)なら
    // applyCandidateSplits は base をそのまま返す恒等関数(§1-1 バイト等価の要)
    const base = buildCutplan(ctx.numbered, list, toCutplanIdContext(ctx.idCtx), {
      duration: ctx.durationSec,
      reason: ctx.cfg.detect?.silenceCutReason,
    });
    const cutplan = applyCandidateSplits(base, ctx.splits, ctx.words, splitCfgOf(ctx.cfg), ctx.idCtx && { used: ctx.idCtx.used });
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
 * set_cuts/run_assert は常時有効(個別 off に対応する設定項目が無い)。
 * list_words/split_candidate は ctx.applySplit(plan.harness.applySplit)が
 * true のときだけ現れる(§1-1: off なら SD4 と完全に同じ tool セット) */
function buildToolRegistry(ctx: AgenticCtx): CutTool[] {
  const tools: CutTool[] = [describeTimelineTool];
  if (ctx.toolsEnabled.frames) tools.push(getFramesTool);
  if (ctx.toolsEnabled.av) tools.push(probeAvTool);
  if (ctx.toolsEnabled.materials) tools.push(probeMaterialsTool);
  if (ctx.toolsEnabled.ocr) tools.push(ocrScreenTool);
  if (ctx.applySplit) tools.push(listWordsTool, splitCandidateTool);
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
    return {
      cuts: parseCutsResponse(raw).cuts,
      trace: ctx.trace,
      raw,
      degraded: "adapter-not-agentic",
      splits: ctx.splits,
      splitTrace: ctx.splitTrace,
    };
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
    return {
      cuts: parsed.cuts,
      trace: ctx.trace,
      raw: response.text,
      degraded: null,
      splits: ctx.splits,
      splitTrace: ctx.splitTrace,
    };
  } catch (error) {
    ctx.warn(`agentic ループが失敗しました。単発経路にフォールバックします: ${(error as Error).message}`);
    const raw = await fallback(firstPrompt, ctx.cfg);
    return {
      cuts: parseCutsResponse(raw).cuts,
      trace: ctx.trace,
      raw,
      degraded: (error as Error).message,
      splits: ctx.splits,
      splitTrace: ctx.splitTrace,
    };
  } finally {
    clearTimeout(timeout);
  }
}
