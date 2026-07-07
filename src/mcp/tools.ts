// makeTools(dir, cfg): ToolDef[] — dir/cfg を closure 捕捉した MCP tool
// レジストリ。docs/plans/2026-07-07-mcp-server-design.md §論点2・§論点5・§論点6。
//
// 露出するのは「読む」(describe/validate/frames/materials/assert)+
// 「承認スコープ外の安全編集」(apply/id-stamp)だけ。approve/unapprove/
// render/plan/remeta/plan-shorts/run/ingest/transcribe/detect/preview/
// thumbnail/editor/frames-serve/learn は**この配列に存在しない**
// (=tools/list に出ず、tools/call の name 引きでも見つからず -32602 になる。
// これが唯一確実な防御。運用ルールや description の注意書きに頼らない)。
//
// handler は「引数を検査 → 内部関数を呼ぶ → toToolResult でアダプト」の
// 薄い配線だけを行う。内部関数(applyEdits/planApply/validate/describeJson/
// frames/idStamp/materials/assert)は呼ぶだけで無改造(シグネチャも不変)。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../lib/config.ts";
import { applyEdits, planApply } from "../lib/applyEdits.ts";
import type { ApplyPlan, ApplyResult } from "../lib/applyEdits.ts";
import { describeJson } from "../stages/describe.ts";
import { frames } from "../stages/frames.ts";
import type { FrameRequest, FrameShot } from "../stages/frames.ts";
import { idStamp } from "../stages/idStamp.ts";
import type { IdStampResult } from "../stages/idStamp.ts";
import { validate } from "../stages/validate.ts";
import type { Problem, ValidateResult } from "../stages/validate.ts";
import { formatMaterialsSummary, materials } from "../stages/materials.ts";
import type { MaterialsOptions } from "../stages/materials.ts";
import type { MaterialsIndex } from "../lib/materials.ts";
import { av, formatAvSummary } from "../stages/av.ts";
import type { AvResult } from "../stages/av.ts";
import { assert as assertProject } from "../stages/assert.ts";
import type { AssertReport } from "../stages/assert.ts";
import { parseT } from "../lib/fmt.ts";
import type { ApplyPatch } from "../types.ts";
import { JsonRpcError } from "./types.ts";
import type { JsonSchema, ToolDef, ToolResult } from "./types.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** args(tools/call の `arguments`)を安全にオブジェクトとして扱う
 * (未指定の引数無し tool は `undefined` で呼ばれるため) */
function asRecord(v: unknown): Record<string, unknown> {
  return isObj(v) ? v : {};
}

function problemLines(problems: Problem[], icon: "⚠" | "✖"): string[] {
  return problems.map((p) => `${icon} ${p.file} ${p.where}: ${p.message}`);
}

/**
 * 内部関数の戻り値 → ToolResult への共通アダプタ(§design doc 論点5)。
 * 人間可読な要約行(humanLines)+ 機械可読 JSON(payload)の両方を content に
 * 積み、Claude 系(散文を読む)・codex 系(JSON を構造消費)の双方に応える
 * (§design doc 論点4)。isError は各 handler がドメイン結果から判定する。
 */
function toToolResult(humanLines: string[], payload: unknown, isError: boolean): ToolResult {
  const content: ToolResult["content"] = [
    { type: "text", text: humanLines.join("\n") },
    { type: "text", text: JSON.stringify(payload, null, 2) },
  ];
  return isError ? { content, isError: true } : { content };
}

/* ---------------- cutflow_validate ---------------- */

function validateHumanLines(r: ValidateResult): string[] {
  const lines = [...problemLines(r.warnings, "⚠"), ...problemLines(r.errors, "✖")];
  if (r.errors.length > 0) {
    lines.push(
      `エラー ${r.errors.length}件` +
        (r.warnings.length > 0 ? ` / 警告 ${r.warnings.length}件` : "") +
        "。上から順に修正してください。",
    );
  } else {
    lines.push(
      (r.warnings.length > 0 ? `警告 ${r.warnings.length}件(動作はします)\n` : "") +
        `✔ エラーなし: ${r.summary}`,
    );
  }
  return lines;
}

/* ---------------- cutflow_frames ---------------- */

interface FramesArgs {
  t?: string;
  captions?: boolean;
  every?: number;
  out?: boolean;
  short?: string;
  ocr?: boolean;
  fullRes?: boolean;
}

function parseFramesArgs(raw: unknown): FramesArgs {
  const a = asRecord(raw);
  const args: FramesArgs = {};
  if (a.t !== undefined) {
    if (typeof a.t !== "string") throw new JsonRpcError(-32602, "t must be a string");
    args.t = a.t;
  }
  if (a.captions !== undefined) {
    if (typeof a.captions !== "boolean") throw new JsonRpcError(-32602, "captions must be a boolean");
    args.captions = a.captions;
  }
  if (a.every !== undefined) {
    if (typeof a.every !== "number") throw new JsonRpcError(-32602, "every must be a number");
    args.every = a.every;
  }
  if (a.out !== undefined) {
    if (typeof a.out !== "boolean") throw new JsonRpcError(-32602, "out must be a boolean");
    args.out = a.out;
  }
  if (a.short !== undefined) {
    if (typeof a.short !== "string") throw new JsonRpcError(-32602, "short must be a string");
    args.short = a.short;
  }
  if (a.ocr !== undefined) {
    if (typeof a.ocr !== "boolean") throw new JsonRpcError(-32602, "ocr must be a boolean");
    args.ocr = a.ocr;
  }
  if (a.fullRes !== undefined) {
    if (typeof a.fullRes !== "boolean") throw new JsonRpcError(-32602, "fullRes must be a boolean");
    args.fullRes = a.fullRes;
  }
  return args;
}

/** CLI(src/cli.ts の frames コマンド)と同じ排他規則: t/captions/every の
 * どれか1つだけ。out は t とだけ併用可 */
function buildFrameRequest(args: FramesArgs): FrameRequest {
  const picked = [args.t, args.captions, args.every].filter((v) => v !== undefined).length;
  if (picked !== 1) {
    throw new JsonRpcError(-32602, "exactly one of t / captions / every must be given");
  }
  if (args.out === true && args.t === undefined) {
    throw new JsonRpcError(-32602, "out requires t");
  }
  if (args.captions === true) return { mode: "captions" };
  if (args.every !== undefined) {
    if (!Number.isFinite(args.every)) throw new JsonRpcError(-32602, `cannot parse every: ${args.every}`);
    return { mode: "every", stepSec: args.every };
  }
  const times = args
    .t!.split(",")
    .map((s) => s.trim())
    .map((s) => {
      const t = parseT(s);
      if (t === null) throw new JsonRpcError(-32602, `cannot parse time: ${s}`);
      return t;
    });
  return { mode: "times", times, axis: args.out === true ? "output" : "source" };
}

function framesHumanLines(shots: FrameShot[]): string[] {
  const lines = shots.map((s) => `✔ ${s.file}` + (s.note ? `(${s.note})` : ""));
  lines.push(`${shots.length}枚を出力しました`);
  return lines;
}

/* ---------------- cutflow_apply ---------------- */

function applyPlanHumanLines(plan: ApplyPlan, dryRun: boolean): string[] {
  const lines = [...problemLines(plan.warnings, "⚠"), ...problemLines(plan.errors, "✖")];
  if (plan.errors.length > 0) {
    lines.push(`エラー ${plan.errors.length}件。1バイトも書いていません。`);
  } else if (plan.changedFiles.length === 0) {
    lines.push("変更なし(no-op パッチ)");
  } else {
    lines.push(
      `✔ 検査通過${dryRun ? "(dryRun。書いていません)" : ""}: ${plan.changedFiles.join(", ")}`,
    );
  }
  return lines;
}

function applyResultHumanLines(result: ApplyResult): string[] {
  const lines = [...problemLines(result.plan.warnings, "⚠"), ...problemLines(result.plan.errors, "✖")];
  if (result.plan.errors.length > 0) {
    lines.push(`エラー ${result.plan.errors.length}件。1バイトも書いていません。`);
  } else if (result.written.length === 0) {
    lines.push("変更なし(no-op パッチ)");
  } else {
    lines.push(
      `✔ 適用しました: ${result.written.join(", ")}` +
        (result.backupDir ? ` / 退避: ${result.backupDir}` : ""),
    );
  }
  return lines;
}

/* ---------------- cutflow_id_stamp ---------------- */

function idStampHumanLines(r: IdStampResult): string[] {
  const lines: string[] = [];
  if (r.changed.length === 0) {
    lines.push("変更なし(すべて採番済み、または対象ファイルがありません)");
  } else {
    lines.push(`id を採番しました: ${r.changed.join(", ")}`);
  }
  lines.push(...problemLines(r.validate.warnings, "⚠"));
  lines.push(...problemLines(r.validate.errors, "✖"));
  return lines;
}

/* ---------------- cutflow_materials ---------------- */

function materialsHumanLines(index: MaterialsIndex): string[] {
  return formatMaterialsSummary(index);
}

/* ---------------- cutflow_av ---------------- */

interface AvArgs {
  range?: string;
  every?: number;
  short?: string;
  fullRes?: boolean;
  motionOnly?: boolean;
  soundOnly?: boolean;
}

function parseAvArgs(raw: unknown): AvArgs {
  const a = asRecord(raw);
  const args: AvArgs = {};
  if (a.range !== undefined) {
    if (typeof a.range !== "string") throw new JsonRpcError(-32602, "range must be a string");
    args.range = a.range;
  }
  if (a.every !== undefined) {
    if (typeof a.every !== "number") throw new JsonRpcError(-32602, "every must be a number");
    args.every = a.every;
  }
  if (a.short !== undefined) {
    if (typeof a.short !== "string") throw new JsonRpcError(-32602, "short must be a string");
    args.short = a.short;
  }
  if (a.fullRes !== undefined) {
    if (typeof a.fullRes !== "boolean") throw new JsonRpcError(-32602, "fullRes must be a boolean");
    args.fullRes = a.fullRes;
  }
  if (a.motionOnly !== undefined) {
    if (typeof a.motionOnly !== "boolean") throw new JsonRpcError(-32602, "motionOnly must be a boolean");
    args.motionOnly = a.motionOnly;
  }
  if (a.soundOnly !== undefined) {
    if (typeof a.soundOnly !== "boolean") throw new JsonRpcError(-32602, "soundOnly must be a boolean");
    args.soundOnly = a.soundOnly;
  }
  if (args.motionOnly === true && args.soundOnly === true) {
    throw new JsonRpcError(-32602, "motionOnly and soundOnly cannot both be true");
  }
  return args;
}

function parseRange(range: string | undefined): { startSec: number; endSec: number } | undefined {
  if (range === undefined) return undefined;
  const [startRaw, endRaw] = range.split("-");
  if (startRaw === undefined || endRaw === undefined) {
    throw new JsonRpcError(-32602, `cannot parse range: ${range}`);
  }
  const startSec = parseT(startRaw.trim());
  const endSec = parseT(endRaw.trim());
  if (startSec === null || endSec === null || endSec <= startSec) {
    throw new JsonRpcError(-32602, `cannot parse range: ${range}`);
  }
  return { startSec, endSec };
}

function avHumanLines(result: AvResult): string[] {
  return formatAvSummary(result);
}

/* ---------------- cutflow_assert ---------------- */

function assertHumanLines(report: AssertReport): string[] {
  if (report.outcomes.length === 0) {
    return ["アサーションがありません(assertions.json を置くと編集意図を宣言的に検査できます)"];
  }
  const icon = { pass: "✔", fail: "✖", error: "⚠", skip: "–" } as const;
  const lines = report.outcomes.map((o) => {
    const label = o.label ? `${o.label} ` : "";
    return `${icon[o.status]} [${o.type}] ${label}${o.message}`;
  });
  const { pass, fail, skip, error } = report.counts;
  lines.push(`pass ${pass} / fail ${fail} / skip ${skip} / error ${error}`);
  return lines;
}

/**
 * dir/cfg を closure 捕捉した ToolDef[] を組み立てる。§design doc 論点3の
 * 「サーバは1収録フォルダに束縛」を体現する唯一の入口(dir 引数を取る tool は
 * 存在しない)。
 */
export function makeTools(dir: string, cfg: Config): ToolDef[] {
  const applyPatchSchema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas", "apply-patch.schema.json"), "utf8"),
  ) as JsonSchema;

  return [
    {
      name: "cutflow_describe",
      description:
        "Machine-readable, fully expanded projection of the current edit state " +
        "(raw<->output time mapping, full caption/title text, @id discovery). " +
        "Use this instead of reading the raw JSON files by hand.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        const proj = describeJson(dir, cfg);
        return toToolResult([`describe: ${dir}`], proj, false);
      },
    },
    {
      name: "cutflow_validate",
      description:
        "Structural and invariant checks on the editable files (cutplan/transcript/" +
        "overlays/etc). errors => isError:true (must fix); warnings are informational. " +
        "Run this after every edit.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        const r = validate(dir);
        return toToolResult(validateHumanLines(r), r, r.errors.length > 0);
      },
    },
    {
      name: "cutflow_frames",
      description:
        "Render still frames at given times with the exact final-composite look " +
        "(captions/wipes/overlays/zoom/blur/annotations) to PNG under frames/, so an " +
        "agent can visually self-check its own edits. Exactly one of t/captions/every " +
        "must be given.",
      inputSchema: {
        type: "object",
        properties: {
          t: { type: "string", description: "comma-separated times, e.g. \"90,2:30.5\"" },
          captions: { type: "boolean", description: "one shot per caption (full audit)" },
          every: { type: "number", description: "sample the output timeline every N seconds" },
          out: { type: "boolean", description: "interpret t as output (post-cut) seconds" },
          short: { type: "string", description: "render the named short's vertical layout instead" },
          ocr: { type: "boolean", description: "also OCR on-screen text (macOS only)" },
          fullRes: { type: "boolean", description: "use full-resolution base video instead of proxy" },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs) => {
        const args = parseFramesArgs(rawArgs);
        const req = buildFrameRequest(args);
        const shots = await frames(dir, req, cfg, args.short, args.ocr === true, args.fullRes === true);
        return toToolResult(framesHumanLines(shots), shots, false);
      },
    },
    {
      name: "cutflow_apply",
      description:
        "Checked, atomic application of an @id-addressed operation list and/or whole-file " +
        "replace patch. All-or-nothing: if any check fails, zero bytes are written " +
        "(isError:true with structured problems). `dryRun` previews the diff without " +
        "writing. Cannot change `approved`, and never touches approvals.json.",
      inputSchema: {
        type: "object",
        required: ["patch"],
        properties: {
          patch: applyPatchSchema,
          dryRun: { type: "boolean", description: "check and diff only; do not write" },
        },
        additionalProperties: false,
      },
      handler: (rawArgs) => {
        const args = asRecord(rawArgs);
        if (!isObj(args.patch)) {
          throw new JsonRpcError(-32602, "patch must be an object ({ ops?, replace? })");
        }
        const patch = args.patch as ApplyPatch;
        const dryRun = args.dryRun === true;
        if (dryRun) {
          const plan = planApply(dir, patch);
          return toToolResult(applyPlanHumanLines(plan, true), plan, plan.errors.length > 0);
        }
        const result = applyEdits(dir, patch);
        return toToolResult(applyResultHumanLines(result), result, result.plan.errors.length > 0);
      },
    },
    {
      name: "cutflow_id_stamp",
      description:
        "Assign stable @ids to addressable elements that don't have one yet (idempotent, " +
        "sticky: existing ids never change, approvals.json untouched). Needed before an " +
        "agent can address existing elements by @id in cutflow_apply.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: () => {
        const r = idStamp(dir);
        return toToolResult(idStampHumanLines(r), r, false);
      },
    },
    {
      name: "cutflow_materials",
      description:
        "Probe materials (B-roll) referenced by overlays/inserts/bgm or present in " +
        "materials/: duration/resolution/fps/audio presence, plus cross-linking that " +
        "flags unused or dangling references. Writes materials.probe/index.json.",
      inputSchema: {
        type: "object",
        properties: {
          frames: { type: "boolean", description: "also extract a representative still frame" },
          ocr: { type: "boolean", description: "OCR the frame/image (implies frames)" },
          transcribe: { type: "boolean", description: "transcribe audio-bearing materials" },
          all: { type: "boolean", description: "= frames + ocr + transcribe" },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs) => {
        const args = asRecord(rawArgs);
        const opts: MaterialsOptions = {
          frames: args.all === true || args.frames === true,
          ocr: args.all === true || args.ocr === true,
          transcribe: args.all === true || args.transcribe === true,
        };
        const { index } = await materials(dir, opts, cfg);
        return toToolResult(materialsHumanLines(index), index, false);
      },
    },
    {
      name: "cutflow_av",
      description:
        "Machine-readable motion/sound feedback on the kept output timeline. Writes " +
        "av.probe/motion.json, av.probe/sound.json, and a motion strip PNG.",
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", description: "output-time range, e.g. \"10-25.5\"" },
          every: { type: "number", description: "motion sample interval in seconds" },
          short: { type: "string", description: "named short from shorts.json" },
          fullRes: { type: "boolean", description: "use source video instead of proxy for motion" },
          motionOnly: { type: "boolean", description: "collect motion only" },
          soundOnly: { type: "boolean", description: "collect sound only" },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs) => {
        const args = parseAvArgs(rawArgs);
        const result = await av(dir, {
          range: parseRange(args.range),
          everySec: args.every,
          short: args.short,
          fullRes: args.fullRes,
          motionOnly: args.motionOnly,
          soundOnly: args.soundOnly,
        }, cfg);
        return toToolResult(avHumanLines(result), result, false);
      },
    },
    {
      name: "cutflow_assert",
      description:
        "Check declared editing intent (assertions.json) against the current edit state " +
        "(the same projection cutflow_describe returns). No assertions.json => an empty, " +
        "non-failing report. `visual` also evaluates OCR-based checks (macOS only).",
      inputSchema: {
        type: "object",
        properties: {
          visual: { type: "boolean", description: "also evaluate Tier 2 (screen-text/region) assertions" },
        },
        additionalProperties: false,
      },
      handler: async (rawArgs) => {
        const args = asRecord(rawArgs);
        const report = await assertProject(dir, { visual: args.visual === true });
        return toToolResult(
          assertHumanLines(report),
          report,
          report.counts.fail > 0 || report.counts.error > 0,
        );
      },
    },
  ];
}
