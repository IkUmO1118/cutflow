// lib/blur.ts — 領域ぼかし/モザイク(overlays.json の blurs)の座標変換と
// 強度→px 換算。remotion/Main.tsx が使う純関数。テストで数値を固定する。
import type { Region } from "../types.ts";

/** 出力px の rect を、ベース映像を再クロップするための canvas 領域へ写像する。
 * screenRegion(canvas 内の画面切り出し)を出力(width×height)へ一様に
 * 引き伸ばしている前提。返り値を CroppedVideo の region に渡すと、rect 部分の
 * ベース映像がそのまま出る(scale は base と同じ width/screenRegion.w)。 */
export function outputRectToCanvasRegion(
  rect: Region,
  screenRegion: Region,
  width: number,
  height: number,
): Region {
  return {
    x: screenRegion.x + (rect.x / width) * screenRegion.w,
    y: screenRegion.y + (rect.y / height) * screenRegion.h,
    w: (rect.w / width) * screenRegion.w,
    h: (rect.h / height) * screenRegion.h,
  };
}

/** blur のぼかし半径(出力px)。strength 0→軽い、1→強い。開発画面の等幅
 * フォントが読めなくなる程度を 0.5 の既定に置く。出力幅にほぼ依存しない
 * 絶対 px(小さい矩形でも十分ぼける) */
export function blurRadiusPx(strength: number): number {
  return Math.round(4 + clamp01(strength) * 36); // 0→4px, 0.5→22px, 1→40px
}

/** mosaic のブロック(セル)辺長(出力px)。strength 0→細かい、1→粗い */
export function mosaicBlockPx(strength: number): number {
  return Math.round(8 + clamp01(strength) * 56); // 0→8px, 0.5→36px, 1→64px
}

/** mosaic フォールバック(pixelated が効かない環境)用の等価ぼかし半径。
 * ブロック辺長の約 0.5 倍が視覚的に近い */
export function mosaicFallbackBlurPx(strength: number): number {
  return Math.round(mosaicBlockPx(strength) * 0.5);
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
