import type { Region } from "../types.ts";

/** ヘルパの正規化カーソル座標(cx,cy∈[0,1]。撮影ディスプレイ内・左上原点)を
 * CutFlow の出力px(screenRegion 座標系)へ写像する(D8)。D2 が dwell 推薦の
 * rect 化に使う純関数。obs-canvas は撮影ディスプレイ全体が screenRegion
 * いっぱいに配置される前提(収録ガイドで倒す運用)、plain は出力=収録実寸。
 * §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md D8 */

export interface CursorPoint {
  cx: number;
  cy: number;
}

export interface CursorGeomInput extends CursorPoint {
  layout: "obs-canvas" | "plain";
  screenRegion: Region;
  /** plain レイアウトの出力サイズ(px)。obs-canvas では未使用 */
  outputWidth: number;
  outputHeight: number;
}

export interface OutputPoint {
  x: number;
  y: number;
}

export function cursorToOutputPoint(input: CursorGeomInput): OutputPoint {
  if (input.layout === "plain") {
    return {
      x: input.cx * input.outputWidth,
      y: input.cy * input.outputHeight,
    };
  }
  return {
    x: input.screenRegion.x + input.cx * input.screenRegion.w,
    y: input.screenRegion.y + input.cy * input.screenRegion.h,
  };
}

/** D4 テレメトリ推論フォールバック専用。ヘルパの生の Quartz グローバル座標
 * (ax,ay。spawn 時に displayId を解決できなかったときだけ意味を持つ)を、
 * 録画停止後に選ばれた対象ディスプレイの bounds へ事後的に正規化する。
 * ヘルパ内の normalizedCursorPosition と同じ式(Y 反転を重ねない)を
 * Node 側で再現したもの */
export function absolutePointToNormalized(
  point: { ax: number; ay: number },
  bounds: Region,
): CursorPoint & { inBounds: boolean } {
  if (bounds.w <= 0 || bounds.h <= 0) return { cx: 0, cy: 0, inBounds: false };
  const cx = (point.ax - bounds.x) / bounds.w;
  const cy = (point.ay - bounds.y) / bounds.h;
  return { cx, cy, inBounds: cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1 };
}

export interface DisplayCandidate {
  id: number;
  bounds: Region;
}

/**
 * D4 第3段: どのディスプレイの bounds に最も多くのサンプルが収まるかで
 * 対象ディスプレイを推論する(OBS 結合ゼロのフォールバック)。同数のときは
 * candidates の並び順で先勝ち(呼び出し側が isMain を先頭にする等で調整可)。
 * 候補が無い/サンプルが無いときは null
 */
export function pickDisplayByTelemetry(
  points: { ax: number; ay: number }[],
  candidates: DisplayCandidate[],
): { id: number; inBoundsCount: number } | null {
  if (candidates.length === 0 || points.length === 0) return null;
  let best: { id: number; inBoundsCount: number } | null = null;
  for (const candidate of candidates) {
    let count = 0;
    for (const p of points) {
      if (absolutePointToNormalized(p, candidate.bounds).inBounds) count++;
    }
    if (!best || count > best.inBoundsCount) {
      best = { id: candidate.id, inBoundsCount: count };
    }
  }
  return best;
}
