// lib/colorFilter.ts — 簡易カラー調整(overlays.json の colorFilter)を CSS
// filter 文字列に変換する純関数。remotion/Main.tsx がベース映像(画面クロップ+
// カメラ=同一収録動画)だけに適用する。未指定・全既定(1.0)なら undefined
// (フィルタ無し=既存の描画と完全に同じ)。
import type { ColorFilter } from "../types.ts";

export function cssFilterOf(cf?: ColorFilter): string | undefined {
  if (!cf) return undefined;
  const brightness = cf.brightness ?? 1;
  const contrast = cf.contrast ?? 1;
  const saturate = cf.saturate ?? 1;
  if (brightness === 1 && contrast === 1 && saturate === 1) return undefined;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`;
}
