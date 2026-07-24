// OpenScreen 移植 — カーソルズームの自動配置(autozoom コマンド)。
// §docs/plans/2026-07-24-openscreen-autozoom-placement-design.md
//
// plan-effects(E1/D2)の「anchors を LLM に投げて (anchorId, effect) を選ばせる」
// 経路を、cursor アンカーだけを対象に「全採用」する決定論へ差し替えたもの。
// 新しい幾何・検出コードは書かない: detectDwellCandidates(cursorAnchors.ts)が
// 既に採用済み・間隔調整済み・非重複な最終集合を返すため、LLM ステップを
// コードでの機械採用に置き換えるだけで成立する。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveEffectPlacementCfg,
  resolvePlanCursorCfg,
} from "../lib/config.ts";
import {
  buildEffectAnchors,
  decisionsToOverlays,
} from "../lib/effectAnchors.ts";
import type { EffectDecision, EffectOverlayCfg } from "../lib/effectAnchors.ts";
import {
  buildCursorAnchorCandidates,
  readCursorSidecar,
  readMotion,
} from "./planEffects.ts";
import { resolveProfile } from "../lib/profile.ts";
import { validateDocs } from "./validate.ts";
import type { LoadedDocs } from "./validate.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Manifest, Overlays, Transcript } from "../types.ts";

/** 生成後の zoom を境界クランプした結果、これ未満の尺になったら捨てる(秒)。
 *  録画端の dwell はウィンドウが録画外へはみ出しうる(§D3) */
export const MIN_AUTO_ZOOM_SEC = 0.5;

export interface AutoZoomResult {
  overlays: Overlays;
  zooms: NonNullable<Overlays["zooms"]>;
  /** dwell 採用候補数(クランプ前) */
  candidateCount: number;
  /** クランプ・drop 後に実際に置いた zoom 数 */
  placedCount: number;
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

/**
 * カーソル dwell だけを入力に、決定論(LLM 不使用)で overlays.json の
 * zooms[] を下書き生成する。blurs/annotations/overlays/inserts/captionTracks
 * 等の他フィールドは触らない(既存値をそのまま保持)。
 *
 * cut/承認(cutplan.json / approvals.json)は読み書きしない。
 */
export function autoZoom(dir: string, cfg: Config): AutoZoomResult {
  const manifest = readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const transcript = readStageJson<Transcript>(join(dir, "transcript.json"), "transcribe");

  const cursorSidecar = readCursorSidecar(dir, manifest);
  if (!cursorSidecar) {
    throw new Error(
      "カーソル座標が未生成です。record --watch で収録してください",
    );
  }

  const motion = readMotion(dir);
  const placementCfg = resolveEffectPlacementCfg(cfg);
  const cursorCfg = resolvePlanCursorCfg(cfg);

  const cursorCandidates = buildCursorAnchorCandidates(
    cursorSidecar,
    manifest,
    placementCfg,
    cursorCfg,
    motion,
  );

  // buildEffectAnchors には空 OCR・motion=null を渡す(motion は
  // buildCursorAnchorCandidates 側でスクロール抑制に使い済みなので二重に渡さない)。
  // それでも cutplan/transcript から speech アンカーが足されるため、
  // decisions は source==="cursor" だけに絞る(番号は既存の安全網としてそのまま使う)
  const anchors = buildEffectAnchors(cutplan, transcript, [], null, placementCfg, cursorCandidates);
  const decisions: EffectDecision[] = anchors
    .filter((a) => a.source === "cursor")
    .map((a) => ({ anchorId: a.id, effect: "zoom" as const, reason: "" }));

  const profile = resolveProfile(manifest.video.screenRegion, "default");
  const overlayCfg: EffectOverlayCfg = {
    ...placementCfg,
    outW: profile.width,
    outH: profile.height,
  };
  const generated = decisionsToOverlays(decisions, anchors, overlayCfg);

  // §D3: 録画境界クランプ。detectDwellCandidates の固定幅ウィンドウは録画端で
  // 負 start / 尺超過 end になりうる(OpenScreen 呼び側のクランプに相当)
  const zooms = (generated.zooms ?? [])
    .map((z) => ({
      ...z,
      start: Math.max(0, z.start),
      end: Math.min(manifest.durationSec, z.end),
    }))
    .filter((z) => z.end - z.start >= MIN_AUTO_ZOOM_SEC)
    // §D4: decisionsToOverlays は decisions 順(anchors の時系列順)で push する
    // ため通常は既に昇順だが、クランプ後も昇順を保証しておく(validate の
    // 「zooms は時系列・重なり禁止」要求を満たす)
    .sort((a, b) => a.start - b.start);

  const overlaysPath = join(dir, "overlays.json");
  const existing = readJsonOrNull<Overlays>(overlaysPath) ?? {};
  const merged: Overlays = { ...existing };
  if (zooms.length > 0) merged.zooms = zooms;
  else delete merged.zooms;

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
    throw new Error(`生成した zoom が検査に失敗したため書き込みません:\n${lines.join("\n")}`);
  }

  writeFileSync(overlaysPath, JSON.stringify(merged, null, 2));

  return {
    overlays: merged,
    zooms,
    candidateCount: cursorCandidates.length,
    placedCount: zooms.length,
  };
}

/**
 * run(収録直後の初回一括)の末尾から呼ぶ非破壊の自動挿入(§D6)。次を
 * すべて満たすときだけ autoZoom を実行し、1つでも欠ければ null を返して
 * 何もしない(run を止めない・この機能導入前とバイト等価):
 *   1. plan.cursor.autoZoom(既定 true)、かつ
 *   2. cursor サイドカーが存在(record --watch 収録)、かつ
 *   3. overlays.json の zooms が空/不在(手編集済みなら触らない)
 * 判定ロジックはここに閉じ、run 側には持たせない。
 */
export function autoZoomIfFresh(dir: string, cfg: Config): AutoZoomResult | null {
  if (!resolvePlanCursorCfg(cfg).autoZoom) return null;

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (readCursorSidecar(dir, manifest) === null) return null;

  const existingOverlays = readJsonOrNull<Overlays>(join(dir, "overlays.json"));
  if ((existingOverlays?.zooms?.length ?? 0) > 0) return null;

  return autoZoom(dir, cfg);
}
