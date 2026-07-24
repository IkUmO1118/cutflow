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
import {
  resolveEffectPlacementCfg,
  resolveEffectReviewCfg,
  resolvePlanCursorCfg,
  resolveReasonIdsCfg,
} from "../lib/config.ts";
import {
  buildEffectAnchors,
  clampRect,
  decisionsToOverlays,
  growToMinZoom,
  limitNoneDecisions,
} from "../lib/effectAnchors.ts";
import type {
  CursorAnchorLike,
  EffectAnchor,
  EffectDecision,
  EffectOverlayCfg,
  MotionLike,
  OcrSidecar,
} from "../lib/effectAnchors.ts";
import {
  cursorFocusToLocalPoint,
  cursorFocusToRect,
  detectDwellCandidates,
  filterScrollSamples,
  resolveDwellWindowMs,
} from "../lib/cursorAnchors.ts";
import type { CursorDwellSample, ScrollMotionSample } from "../lib/cursorAnchors.ts";
import { CURSOR_SIDECAR_SUFFIX } from "./record.ts";
import type { CursorSidecar } from "./record.ts";
import { effectWarningsToObservation } from "../lib/effectReview.ts";
import type { EffectWarning } from "../lib/effectCheck.ts";
import {
  renderEffectReasonIdsBlock,
  renderEffectReasonIdsOutputBlock,
} from "../lib/effectReasonIdInjection.ts";
import { EFFECT_REASON_IDS } from "../lib/effectReasonIds.ts";
import { buildFirstEffectsPlan, writeFirstEffectsPlan } from "../lib/firstEffectsPlan.ts";
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

/** reasonIds off は導入前の inline schema と同じオブジェクト。 */
export const PLAN_EFFECTS_RESPONSE_SCHEMA = {
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
} as const;

/** reasonIds on は全 decision に7分類の effectReasonId を必須化できる strict schema。 */
export const PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS = {
  name: "cutflow_plan_effects_reason_ids",
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
          required: ["anchorId", "effect", "effectReasonId", "reason"],
          properties: {
            anchorId: { type: "integer" },
            effect: { type: "string", enum: ["zoom", "blur", "annotation", "none"] },
            effectReasonId: { type: "string", enum: EFFECT_REASON_IDS },
            reason: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export function planEffectsResponseSchema(
  reasonIdsEnabled: boolean,
): typeof PLAN_EFFECTS_RESPONSE_SCHEMA | typeof PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS {
  return reasonIdsEnabled ? PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS : PLAN_EFFECTS_RESPONSE_SCHEMA;
}

/** plan.reasonIds の共有 pattern を演出用注入へ伝播する純関数。 */
export function resolveEffectReasonIdInjection(cfg: Config): {
  enabled: boolean;
  pattern: ReturnType<typeof resolveReasonIdsCfg>["pattern"];
  block: string;
  outputBlock: string;
} {
  const reasonIds = resolveReasonIdsCfg(cfg);
  return {
    ...reasonIds,
    block: renderEffectReasonIdsBlock(reasonIds.enabled, reasonIds.pattern),
    outputBlock: renderEffectReasonIdsOutputBlock(reasonIds.enabled),
  };
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
      const o = (d ?? {}) as {
        anchorId?: unknown;
        effect?: unknown;
        effectReasonId?: unknown;
        reason?: unknown;
      };
      return {
        anchorId: o.anchorId,
        effect: o.effect,
        ...(typeof o.effectReasonId === "string" ? { effectReasonId: o.effectReasonId } : {}),
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
export function renderEffectsPrompt(
  dir: string,
  anchors: EffectAnchor[],
  observation: string = "",
  reasonIds: string = "",
  reasonIdsOutput: string = "",
): string {
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

  const classified = `${base}${reasonIds}${reasonIdsOutput}`;
  if (observation === "") return classified;
  return `${classified}\n## 前回の演出検品からの観測(E7・参考情報。必ず直せという指示ではありません)\n\n${observation}\n`;
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
export function readMotion(dir: string): MotionLike | null {
  const p = join(dir, "av.probe", "motion.json");
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as {
    motion?: { outSec: number; sourceSec: number; sceneScore: number }[];
    frozen?: { outSec: number; endOutSec: number; lenSec: number }[];
  };
  return { motion: raw.motion ?? [], frozen: raw.frozen ?? [] };
}

/** `<recording base>.cursor.json`(D1 の record --watch が書くサイドカー)を読む。
 *  無ければ null(D2: カーソル由来アンカーを生成しないだけで、この機能導入前と
 *  バイト等価)。壊れたサイドカーも同様に無視する */
export function readCursorSidecar(dir: string, manifest: Manifest): CursorSidecar | null {
  const base = manifest.source.replace(/\.[^.]+$/, "");
  const p = join(dir, `${base}${CURSOR_SIDECAR_SUFFIX}`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CursorSidecar;
  } catch {
    return null;
  }
}

/** スクロール誤爆抑制(枝D)の前段除去の窓(サンプル時刻の前後この秒数)。
 *  av の scene score サンプリング間隔より広めに取り、閾値超区間の縁の
 *  サンプルも確実に拾う。config化はしない(閾値本体の
 *  plan.cursor.scrollMotionThreshold とは別軸の内部定数) */
const SCROLL_SUPPRESSION_WINDOW_SEC = 1.0;

/**
 * サイドカーの生テレメトリから演出アンカー化できるカーソル候補を組む(D2/D4/D5)。
 * `samples[].recTimeMs` は一時停止圧縮済みの録画内時刻で、OBS の一時停止は
 * 録画ファイル自体からもその区間を除くため「元収録の秒」とバイト等価に扱える
 * (motion.json の frozen のように timeline 経由の変換は不要)。
 * `motion`(av.probe/motion.json。無ければ null)がある場合、dwell 検出の前に
 * スクロール区間(画面モーション大)に重なるサンプルを除去する(枝D)。
 * `motion.motion[].sourceSec` は元収録の秒で cursor サンプルと同じ軸なので
 * timeline 経由の写像は不要。detectDwellCandidates 自体は無改変(逐語)。
 * rect は D2(focus→rect)+ clampRect/growToMinZoom まで適用済みで返す
 * (buildEffectAnchors は解像度を知らないため、ここで済ませておく)。
 */
export function buildCursorAnchorCandidates(
  sidecar: CursorSidecar,
  manifest: Manifest,
  placementCfg: ReturnType<typeof resolveEffectPlacementCfg>,
  cursorCfg: ReturnType<typeof resolvePlanCursorCfg>,
  motion: MotionLike | null,
): CursorAnchorLike[] {
  const rawSamples: CursorDwellSample[] = sidecar.samples.map((s) => ({
    recTimeMs: s.recTimeMs,
    cx: s.cx,
    cy: s.cy,
    inBounds: s.inBounds,
    leftButtonPressed: s.leftButtonPressed,
  }));
  const motionTrack: ScrollMotionSample[] = motion
    ? motion.motion.map((m) => ({ sourceSec: m.sourceSec, sceneScore: m.sceneScore }))
    : [];
  const samples = filterScrollSamples(rawSamples, motionTrack, {
    scrollMotionThreshold: cursorCfg.scrollMotionThreshold,
    windowSec: SCROLL_SUPPRESSION_WINDOW_SEC,
  });
  if (samples.length < rawSamples.length) {
    console.warn(
      `${rawSamples.length - samples.length} 件のカーソルサンプルをスクロール区間(画面モーション大)として除外しました`,
    );
  }
  const windowMs = resolveDwellWindowMs(manifest.durationSec * 1000, cursorCfg.maxWindowMs);
  const candidates = detectDwellCandidates(samples, {
    minDwellMs: cursorCfg.minDwellMs,
    maxDwellMs: cursorCfg.maxDwellMs,
    moveThreshold: cursorCfg.moveThreshold,
    spacingMs: cursorCfg.spacingMs,
    clickBoost: cursorCfg.clickBoost,
    windowMs,
  });
  // resolveProfile(screenRegion, "default") は width/height=screenRegion.w/h
  // そのものなので、ここでは screenRegion を直接「出力解像度」として使える
  const geom = {
    layout: manifest.layout ?? ("obs-canvas" as const),
    screenRegion: manifest.video.screenRegion,
    recordingWidth: manifest.video.width,
    recordingHeight: manifest.video.height,
    defaultScale: cursorCfg.defaultScale,
  };
  return candidates.map((c) => {
    const point = cursorFocusToLocalPoint(c.focus, geom);
    const rect = clampRect(
      growToMinZoom(cursorFocusToRect(c.focus, geom), placementCfg.minZoomRect),
      manifest.video.screenRegion.w,
      manifest.video.screenRegion.h,
    );
    return {
      sourceSec: c.centerMs / 1000,
      start: c.startMs / 1000,
      end: c.endMs / 1000,
      point,
      rect,
      clickBoosted: c.clickBoosted,
    };
  });
}

export interface PlanEffectsResult {
  overlays: Overlays;
  zooms: NonNullable<Overlays["zooms"]>;
  blurs: NonNullable<Overlays["blurs"]>;
  annotations: NonNullable<Overlays["annotations"]>;
  anchorCount: number;
}

type CompleteEffectsFn = (
  prompt: string,
  cfg: Config,
  schema: ReturnType<typeof planEffectsResponseSchema>,
) => Promise<string>;

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
  opts: { observe?: boolean; complete?: CompleteEffectsFn } = {},
): Promise<PlanEffectsResult> {
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const transcript = readStageJson<Transcript>(join(dir, "transcript.json"), "transcribe");
  const manifest = readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");

  const ocrSidecars = readOcrSidecars(dir);
  const motion = readMotion(dir);
  const cursorSidecar = readCursorSidecar(dir, manifest);
  if (ocrSidecars.length === 0 && motion === null && cursorSidecar === null) {
    throw new Error(
      "画面OCR・動き検出・カーソル座標のいずれも未生成です。先に " +
        `\`${cliCmd()} frames ${dir} --every 10 --ocr\` と ` +
        `\`${cliCmd()} av ${dir}\` のどちらか(両方推奨)を実行してください` +
        "(カーソル座標は `record --watch` の収録にのみ付随します)",
    );
  }

  const placementCfg = resolveEffectPlacementCfg(cfg);
  const cursorCandidates = cursorSidecar
    ? buildCursorAnchorCandidates(cursorSidecar, manifest, placementCfg, resolvePlanCursorCfg(cfg), motion)
    : [];
  const anchors = buildEffectAnchors(
    cutplan,
    transcript,
    ocrSidecars,
    motion,
    placementCfg,
    cursorCandidates,
  );
  if (anchors.length === 0) {
    throw new Error(
      "演出アンカーが0件です(cutplan.json の keep 区間・frames --ocr・av の知覚を確認してください)",
    );
  }

  const observe = opts.observe ?? resolveEffectReviewCfg(cfg).observe;
  const observation = observe ? effectWarningsToObservation(readEffectCheckWarnings(dir)) : "";
  const reasonIds = resolveEffectReasonIdInjection(cfg);
  const prompt = renderEffectsPrompt(
    dir,
    anchors,
    observation,
    reasonIds.block,
    reasonIds.outputBlock,
  );
  const responseSchema = planEffectsResponseSchema(reasonIds.enabled);
  const raw = opts.complete
    ? await opts.complete(prompt, cfg, responseSchema)
    : await completeWithJsonSchema(prompt, cfg, responseSchema, "other");
  // LLM の生応答は必ず残す(パース失敗時の調査と、選定過程の記録のため)
  writeFileSync(join(dir, "plan-effects.raw.txt"), raw);

  const parsed = parseDecisionsResponse(raw);
  const decisions = limitNoneDecisions(parsed.decisions, anchors.length, reasonIds.enabled);
  const profile = resolveProfile(manifest.video.screenRegion, "default");
  const overlayCfg: EffectOverlayCfg = {
    ...placementCfg,
    outW: profile.width,
    outH: profile.height,
  };
  const generated = decisionsToOverlays(decisions, anchors, overlayCfg);

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
  writeFirstEffectsPlan(
    dir,
    buildFirstEffectsPlan({
      effectReasonIdsEnabled: reasonIds.enabled,
      pattern: reasonIds.pattern,
      anchors,
      decisions,
      generated,
    }),
  );

  return {
    overlays: merged,
    zooms: generated.zooms ?? [],
    blurs: generated.blurs ?? [],
    annotations: generated.annotations ?? [],
    anchorCount: anchors.length,
  };
}
