// OpenScreen 移植 D2 — カーソル dwell(停留)検出 + focus→rect 変換。
// 移植元: OpenScreen `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
// (MIT・依存ゼロの純関数)。正規化→run検出→strength降順の貪欲採用というアルゴリズムは
// そのまま踏襲し、クリック起点ボーナス(D5)を追加した。
// §docs/plans/2026-07-24-openscreen-d2-dwell-suggestion-design.md
import { cursorToOutputPoint } from "./cursorGeom.ts";
import type { Region } from "../types.ts";

/** buildEffectAnchors が読む D1 サイドカーの1サンプル(必要フィールドだけ抜粋)。
 *  inBounds:false(撮影ディスプレイ外)は呼び出し前ではなく本関数内で除外する */
export interface CursorDwellSample {
  recTimeMs: number;
  cx: number;
  cy: number;
  inBounds: boolean;
  leftButtonPressed: boolean;
}

export interface DwellDetectionCfg {
  /** 停留とみなす最小継続時間(ms) */
  minDwellMs: number;
  /** 停留とみなす最大継続時間(ms。これを超えると意図的な作業とみなし除外) */
  maxDwellMs: number;
  /** 隣接サンプル間でこれを超える移動(正規化座標のユークリッド距離)があれば停留を打ち切る */
  moveThreshold: number;
  /** 採用済み候補の中心からこの間隔(ms)未満の候補は間引く */
  spacingMs: number;
  /** クリック起点(leftButtonPressed 直後)の dwell に与える strength 倍率。1 で無効化 */
  clickBoost: number;
  /** 候補の固定幅(ms)。呼び出し側が resolveDwellWindowMs で総尺から算出する */
  windowMs: number;
}

export interface DwellCandidate {
  /** dwell の中心時刻(録画内 ms。run の開始/終了の中点) */
  centerMs: number;
  /** 固定幅ウィンドウの開始/終了(録画内 ms) */
  startMs: number;
  endMs: number;
  /** run 内の平均カーソル位置(正規化座標) */
  focus: { cx: number; cy: number };
  /** 採用順位に使った強度(run の継続時間。クリック起点なら clickBoost 倍) */
  strength: number;
  /** クリックの立ち上がり直後に始まった dwell か */
  clickBoosted: boolean;
}

/** OpenScreen 本家のチューニング値(30Hz・製品デモ向け)。CutFlow の題材向けの
 *  再調整は収録本数を要するため、既定値はそのまま踏襲する(§2.4) */
export const DEFAULT_MIN_DWELL_MS = 450;
export const DEFAULT_MAX_DWELL_MS = 2600;
export const DEFAULT_MOVE_THRESHOLD = 0.02;
export const DEFAULT_SPACING_MS = 1800;
export const DEFAULT_CLICK_BOOST = 1.5;
export const DEFAULT_CURSOR_SCALE = 2.5;

/** OpenScreen 呼び側と同じ既定候補幅: max(1000ms, 総尺の5%) */
export function resolveDwellWindowMs(totalDurationMs: number): number {
  return Math.max(1000, totalDurationMs * 0.05);
}

/** クリック起点判定の遡り窓(ms)。run 開始のこの手前までに leftButtonPressed が
 *  あれば「押した結果を読んでいる」とみなす(D5)。config化はしない(閾値本体の
 *  plan.cursor.clickBoost とは別軸の内部定数) */
const CLICK_LOOKBACK_MS = 500;

function distance(a: { cx: number; cy: number }, b: { cx: number; cy: number }): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * dwell(カーソル停留)を検出し、strength(継続時間。クリック起点は clickBoost 倍)
 * 降順の貪欲採用で「既採用中心から spacingMs 以上・既存候補と時間非重複」な
 * 候補集合にする(OpenScreen のアルゴリズム+D5)。
 * - inBounds:false のサンプルは事前に除外(撮影ディスプレイ外=OBS操作中)。
 * - 隣接サンプル距離が moveThreshold を超えると run を切る。
 * - run 長が [minDwellMs, maxDwellMs] の外なら候補にしない。
 * - 返り値は centerMs 昇順(時系列順)。
 */
export function detectDwellCandidates(
  samples: readonly CursorDwellSample[],
  cfg: DwellDetectionCfg,
): DwellCandidate[] {
  const normalized = samples
    .filter(
      (s) =>
        s.inBounds &&
        Number.isFinite(s.cx) &&
        Number.isFinite(s.cy) &&
        Number.isFinite(s.recTimeMs),
    )
    .map((s) => ({
      recTimeMs: s.recTimeMs,
      cx: Math.min(1, Math.max(0, s.cx)),
      cy: Math.min(1, Math.max(0, s.cy)),
      leftButtonPressed: s.leftButtonPressed,
    }))
    .sort((a, b) => a.recTimeMs - b.recTimeMs);

  if (normalized.length === 0) return [];

  const raw: DwellCandidate[] = [];

  const finalizeRun = (runStartIdx: number, runEndIdx: number): void => {
    const first = normalized[runStartIdx];
    const last = normalized[runEndIdx];
    const durationMs = last.recTimeMs - first.recTimeMs;
    if (durationMs < cfg.minDwellMs || durationMs > cfg.maxDwellMs) return;

    let sumCx = 0;
    let sumCy = 0;
    let clickBoosted = false;
    for (let i = runStartIdx; i <= runEndIdx; i++) {
      sumCx += normalized[i].cx;
      sumCy += normalized[i].cy;
      if (normalized[i].leftButtonPressed) clickBoosted = true;
    }
    if (!clickBoosted) {
      const lookbackFrom = first.recTimeMs - CLICK_LOOKBACK_MS;
      for (let i = runStartIdx - 1; i >= 0 && normalized[i].recTimeMs >= lookbackFrom; i--) {
        if (normalized[i].leftButtonPressed) {
          clickBoosted = true;
          break;
        }
      }
    }

    const count = runEndIdx - runStartIdx + 1;
    const centerMs = (first.recTimeMs + last.recTimeMs) / 2;
    const strength = clickBoosted ? durationMs * cfg.clickBoost : durationMs;
    raw.push({
      centerMs,
      startMs: centerMs - cfg.windowMs / 2,
      endMs: centerMs + cfg.windowMs / 2,
      focus: { cx: sumCx / count, cy: sumCy / count },
      strength,
      clickBoosted,
    });
  };

  let runStart = 0;
  for (let i = 1; i < normalized.length; i++) {
    if (distance(normalized[i], normalized[i - 1]) > cfg.moveThreshold) {
      finalizeRun(runStart, i - 1);
      runStart = i;
    }
  }
  finalizeRun(runStart, normalized.length - 1);

  raw.sort((a, b) => b.strength - a.strength);
  const accepted: DwellCandidate[] = [];
  for (const candidate of raw) {
    const tooClose = accepted.some(
      (a) => Math.abs(a.centerMs - candidate.centerMs) < cfg.spacingMs,
    );
    const overlapsWindow = accepted.some(
      (a) => candidate.startMs < a.endMs && a.startMs < candidate.endMs,
    );
    if (tooClose || overlapsWindow) continue;
    accepted.push(candidate);
  }

  return accepted.sort((a, b) => a.centerMs - b.centerMs);
}

export interface CursorRectGeom {
  layout: "obs-canvas" | "plain";
  screenRegion: Region;
  /** 元収録のフル解像度(px)。obs-canvas の cursorToOutputPoint 換算にのみ使う */
  recordingWidth: number;
  recordingHeight: number;
  /** focus点からズーム rect を作るときの倍率(w=screenRegion.w/scale) */
  defaultScale: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 撮影ディスプレイ正規化座標(focus)を出力px(screenRegion ローカル。
 * frames --ocr の box / overlays の rect と同じ座標系)へ写像する(D2/D8)。
 * cursorGeom.cursorToOutputPoint はキャンバス絶対座標(screenRegion のオフセット
 * を含む)を返すため、obs-canvas ではその後オフセット分を差し引く。plain は
 * cursorToOutputPoint 自体が screenRegion を無視して直接写像するため不要
 * (Manifest.layout の契約上、plain の screenRegion は常に全フレーム=オフセット0)
 */
export function cursorFocusToLocalPoint(
  focus: { cx: number; cy: number },
  geom: CursorRectGeom,
): { x: number; y: number } {
  const canvasPoint = cursorToOutputPoint({
    cx: focus.cx,
    cy: focus.cy,
    layout: geom.layout,
    screenRegion: geom.screenRegion,
    outputWidth: geom.recordingWidth,
    outputHeight: geom.recordingHeight,
  });
  if (geom.layout === "obs-canvas") {
    return { x: canvasPoint.x - geom.screenRegion.x, y: canvasPoint.y - geom.screenRegion.y };
  }
  return canvasPoint;
}

/**
 * focus点を中心に、screenRegion を defaultScale で割った固定サイズの矩形にする(D2)。
 * clampRect/growToMinZoom(effectAnchors.ts)には通していない素の矩形を返す
 * (呼び出し側がそれらを適用する。画面外はみ出し・最小サイズ確保はそちら側の責務)
 */
export function cursorFocusToRect(
  focus: { cx: number; cy: number },
  geom: CursorRectGeom,
): Region {
  const point = cursorFocusToLocalPoint(focus, geom);
  const w = geom.screenRegion.w / geom.defaultScale;
  const h = geom.screenRegion.h / geom.defaultScale;
  return { x: round2(point.x - w / 2), y: round2(point.y - h / 2), w: round2(w), h: round2(h) };
}

/** D7: props/render 経路へ載せるカーソル1点(録画内 ms + 正規化座標・小数3桁) */
export interface CursorTrackPoint {
  tMs: number;
  cx: number;
  cy: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * D7: サイドカーのフル(30Hz級)テレメトリを rateHz(既定10-15Hz目安)へ
 * 間引く。追従ズーム(母艦後段)の下地で、本 plan では rect 生成には使わない。
 * [startMs, endMs) の inBounds サンプルを 1000/rateHz ms 幅のバケットへ平均し、
 * サンプルが1件も無いバケットは出力しない(補間はしない=生テレメトリの
 * 忠実性を優先。ズーム局所キー側に載せる想定なので、載せない=差分レンダーの
 * グローバルキーには影響しない)。
 */
export function resampleCursorTrack(
  samples: readonly CursorDwellSample[],
  startMs: number,
  endMs: number,
  cfg: { rateHz: number },
): CursorTrackPoint[] {
  if (endMs <= startMs || cfg.rateHz <= 0) return [];
  const bucketMs = 1000 / cfg.rateHz;
  const inRange = samples
    .filter((s) => s.inBounds && s.recTimeMs >= startMs && s.recTimeMs < endMs)
    .sort((a, b) => a.recTimeMs - b.recTimeMs);
  if (inRange.length === 0) return [];

  const points: CursorTrackPoint[] = [];
  let idx = 0;
  for (let bucketStart = startMs; bucketStart < endMs; bucketStart += bucketMs) {
    const bucketEnd = Math.min(endMs, bucketStart + bucketMs);
    let sumCx = 0;
    let sumCy = 0;
    let count = 0;
    while (idx < inRange.length && inRange[idx].recTimeMs < bucketEnd) {
      sumCx += inRange[idx].cx;
      sumCy += inRange[idx].cy;
      count++;
      idx++;
    }
    if (count > 0) {
      points.push({
        tMs: Math.round((bucketStart + bucketEnd) / 2),
        cx: round3(sumCx / count),
        cy: round3(sumCy / count),
      });
    }
  }
  return points;
}
