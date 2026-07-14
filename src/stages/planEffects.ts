// E1(+E2): 演出アンカー候補の生成(plan-effects コマンド)。
// §docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md
//
// plan-materials(M1)と同じ「番号選択」方式: 演出アンカー(OCR/motion/speech
// 由来)に番号を振って LLM に渡し、LLM は (anchorId, effect) のペアだけを
// 返す。座標・時刻・色は一切 LLM に書かせず、実体への変換(effectAnchors.ts の
// 純関数)と書き込み前の validate 検査(all-or-nothing)はすべてコード側で行う。
// 生成する zooms/blurs/annotations は全件下書き(未承認)。approvals.json には
// 一切触れない。
import { cliCmd } from "../lib/cliName.ts";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import { resolveEffectPlacementCfg, resolveEffectReviewCfg } from "../lib/config.ts";
import {
  buildEffectAnchors,
  decisionsToOverlays,
} from "../lib/effectAnchors.ts";
import type {
  EffectAnchor,
  EffectDecision,
  EffectOverlayCfg,
  MotionLike,
  OcrSidecar,
} from "../lib/effectAnchors.ts";
import { effectWarningsToObservation } from "../lib/effectReview.ts";
import type { EffectWarning } from "../lib/effectCheck.ts";
import { readRules } from "./plan.ts";
import { validateDocs } from "./validate.ts";
import type { LoadedDocs } from "./validate.ts";
import { resolveProfile } from "../lib/profile.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Manifest, Overlays, Region, Transcript } from "../types.ts";

/** LLM 応答スキーマ(prompts/plan-effects.md の出力形式と対応) */
export interface DecisionsSelection {
  decisions: EffectDecision[];
}

/**
 * LLM 応答から JSON を取り出して演出選定に整える。plan-materials の
 * parsePlacementsResponse と同じ堅牢さ(コードフェンスや前後の説明文が
 * 混ざっても最初の { 〜 最後の } を拾う)。壊れた/欠けたフィールドは
 * 握りつぶし、後段(decisionsToOverlays)の機械検証(番号存在チェック)に
 * 委ねる:
 * - decisions が無い/配列でなければ空配列
 * - anchorId が数値でない要素は落とす
 * - effect が enum 外の要素は落とす
 * - reason が文字列でなければ空文字
 */
export function parseDecisionsResponse(raw: string): DecisionsSelection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan-effects.raw.txt を確認してください)",
    );
  }
  let parsed: { decisions?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { decisions?: unknown };
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan-effects.raw.txt を確認してください)",
    );
  }
  const EFFECTS = new Set(["zoom", "blur", "annotation", "none"]);
  const list = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const decisions: EffectDecision[] = list
    .map((d) => {
      const o = (d ?? {}) as { anchorId?: unknown; effect?: unknown; reason?: unknown };
      return {
        anchorId: o.anchorId,
        effect: o.effect,
        reason: typeof o.reason === "string" ? o.reason : "",
      };
    })
    .filter(
      (d): d is EffectDecision =>
        typeof d.anchorId === "number" &&
        Number.isFinite(d.anchorId) &&
        typeof d.effect === "string" &&
        EFFECTS.has(d.effect),
    );
  return { decisions };
}

/** アンカー一覧からプロンプトを組む。plan.ts の renderPrompt は numbered
 * (1リスト)専用で、rules/brief 注入は plan.ts / plan-materials と揃える。
 *
 * `observation`(E7): 前回 effect-check の警告サマリ(参考情報。命令ではない)。
 * **空文字のときはテンプレートの置換結果のみを返す**(SD-E1 とバイト等価。
 * §docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md 不変条件3)。
 * 設計書 §3-A の pseudocode は `{{observation}}` をテンプレート内の固定
 * プレースホルダーにする案だったが、空文字時に prompts/plan-effects.md へ
 * 常駐する改行/空行が残ってバイト等価が崩れうるため、ここでは observation
 * が非空のときだけテンプレート出力の後ろへブロックを追記する形に変えた
 * (バイト等価をコードで機械的に保証するため。意味的な不変条件は同じ) */
export function renderEffectsPrompt(dir: string, anchors: EffectAnchor[], observation: string = ""): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", "plan-effects.md"), "utf8");

  const lines = anchors
    .map((a) => {
      const box = a.rect ? `[${a.rect.x},${a.rect.y} ${a.rect.w}x${a.rect.h}]` : "(領域なし)";
      return `#${a.id} [${a.start.toFixed(1)}-${a.end.toFixed(1)}] ${a.source} ${box} ${a.text || ""}`.trim();
    })
    .join("\n");

  const rules = readRules(dir);
  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "(見せ場リストなし)";

  const base = template
    .replaceAll("{{anchors}}", () => lines)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{brief}}", () => brief);

  if (observation === "") return base;
  return `${base}\n## 前回の演出検品からの観測(E7・参考情報。必ず直せという指示ではありません)\n\n${observation}\n`;
}

/** effect-check.json(SD-E2)の警告一覧を読む。無い/壊れているときは空配列
 * (検品未実行でも plan-effects は止めない。優雅な劣化) */
export function readEffectCheckWarnings(dir: string): EffectWarning[] {
  const path = join(dir, "effect-check.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { warnings?: unknown };
    return Array.isArray(raw.warnings) ? (raw.warnings as EffectWarning[]) : [];
  } catch {
    return [];
  }
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(`${path} がありません。先に ${requiredStage} を実行してください`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** frames/*.ocr.json(frames --ocr が書く画面 OCR サイドカー)を全件読む。
 * 無ければ空配列(未生成。呼び出し側が motion と合わせて存否判定する)。
 * 壊れたサイドカーは黙って無視する(frames の撮り直しは validate/describe が促す) */
function readOcrSidecars(dir: string): OcrSidecar[] {
  const framesDir = join(dir, "frames");
  if (!existsSync(framesDir)) return [];
  const files = readdirSync(framesDir).filter((f) => f.endsWith(".ocr.json"));
  const sidecars: OcrSidecar[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(framesDir, f), "utf8")) as {
        sourceSec?: number;
        lines?: { text: string; box: Region }[];
      };
      if (typeof raw.sourceSec === "number" && Array.isArray(raw.lines)) {
        sidecars.push({ sourceSec: raw.sourceSec, lines: raw.lines });
      }
    } catch {
      // 壊れたサイドカーはスキップ(0件でも例外にしない)
    }
  }
  return sidecars;
}

/** av.probe/motion.json(av <dir> が書く動き知覚)を読む。無ければ null */
function readMotion(dir: string): MotionLike | null {
  const p = join(dir, "av.probe", "motion.json");
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as {
    motion?: { outSec: number; sourceSec: number; sceneScore: number }[];
    frozen?: { outSec: number; endOutSec: number; lenSec: number }[];
  };
  return { motion: raw.motion ?? [], frozen: raw.frozen ?? [] };
}

export interface PlanEffectsResult {
  overlays: Overlays;
  zooms: NonNullable<Overlays["zooms"]>;
  blurs: NonNullable<Overlays["blurs"]>;
  annotations: NonNullable<Overlays["annotations"]>;
  anchorCount: number;
}

/**
 * cutplan(keep区間)+ transcript + frames/*.ocr.json + av.probe/motion.json
 * から番号付き演出アンカーを組み、LLM に (anchorId, effect) のペアだけを
 * 選ばせて overlays.json の zooms/blurs/annotations を下書き生成する。
 * read/complete/write の殻で、変換の中身は effectAnchors.ts(純関数)に委ねる。
 *
 * `opts.observe`(E7・opt-in): true のとき、前回 effect-check.json の警告を
 * 観測としてプロンプトへ渡す(参考情報。命令ではない)。省略時は
 * `config.yaml` の `effectReview.observe`(既定 false)に従う。**どちらも
 * false/未指定なら SD-E1 とバイト等価**(observation="" でテンプレートは
 * 追記されない)。
 */
export async function planEffects(
  dir: string,
  cfg: Config,
  opts: { observe?: boolean } = {},
): Promise<PlanEffectsResult> {
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const transcript = readStageJson<Transcript>(join(dir, "transcript.json"), "transcribe");
  const manifest = readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");

  const ocrSidecars = readOcrSidecars(dir);
  const motion = readMotion(dir);
  if (ocrSidecars.length === 0 && motion === null) {
    throw new Error(
      "画面OCR・動き検出のどちらも未生成です。先に " +
        `\`${cliCmd()} frames ${dir} --every 10 --ocr\` と ` +
        `\`${cliCmd()} av ${dir}\` のどちらか(両方推奨)を実行してください`,
    );
  }

  const placementCfg = resolveEffectPlacementCfg(cfg);
  const anchors = buildEffectAnchors(cutplan, transcript, ocrSidecars, motion, placementCfg);
  if (anchors.length === 0) {
    throw new Error(
      "演出アンカーが0件です(cutplan.json の keep 区間・frames --ocr・av の知覚を確認してください)",
    );
  }

  const observe = opts.observe ?? resolveEffectReviewCfg(cfg).observe;
  const observation = observe ? effectWarningsToObservation(readEffectCheckWarnings(dir)) : "";
  const prompt = renderEffectsPrompt(dir, anchors, observation);
  const raw = await completeWithJsonSchema(
    prompt,
    cfg,
    {
      name: "cutflow_plan_effects",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["decisions"],
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["anchorId", "effect", "reason"],
              properties: {
                anchorId: { type: "integer" },
                effect: { type: "string", enum: ["zoom", "blur", "annotation", "none"] },
                reason: { type: "string" },
              },
            },
          },
        },
      },
    },
    "other",
  );
  // LLM の生応答は必ず残す(パース失敗時の調査と、選定過程の記録のため)
  writeFileSync(join(dir, "plan-effects.raw.txt"), raw);

  const parsed = parseDecisionsResponse(raw);
  const profile = resolveProfile(manifest.video.screenRegion, "default");
  const overlayCfg: EffectOverlayCfg = {
    ...placementCfg,
    outW: profile.width,
    outH: profile.height,
  };
  const generated = decisionsToOverlays(parsed.decisions, anchors, overlayCfg);

  const overlaysPath = join(dir, "overlays.json");
  const existingOverlays = readJsonOrNull<Overlays>(overlaysPath) ?? {};
  const merged: Overlays = {
    ...existingOverlays,
    zooms: generated.zooms,
    blurs: generated.blurs,
    annotations: generated.annotations,
  };

  const loaded: LoadedDocs = {
    manifest,
    cutplan,
    transcript,
    overlays: merged,
    bgm: readJsonOrNull<unknown>(join(dir, "bgm.json")),
    chapters: readJsonOrNull<unknown>(join(dir, "chapters.json")),
    meta: readJsonOrNull<unknown>(join(dir, "meta.json")),
    shorts: readJsonOrNull<unknown>(join(dir, "shorts.json")),
    thumbnail: readJsonOrNull<unknown>(join(dir, "thumbnail.json")),
  };
  const checked = validateDocs(dir, loaded);
  if (checked.errors.length > 0) {
    const lines = checked.errors.map((e) => `  ${e.file} ${e.where}: ${e.message}`);
    throw new Error(
      `生成した演出が検査に失敗したため書き込みません:\n${lines.join("\n")}`,
    );
  }

  writeFileSync(overlaysPath, JSON.stringify(merged, null, 2));

  return {
    overlays: merged,
    zooms: generated.zooms ?? [],
    blurs: generated.blurs ?? [],
    annotations: generated.annotations ?? [],
    anchorCount: anchors.length,
  };
}
