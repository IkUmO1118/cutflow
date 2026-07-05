// remotion/Main.tsx の CroppedVideo が使う純関数。拡張キャンバス動画から
// region(screen/camera の切り出し範囲)を width x height の箱へ
// contain/cover で収めたときのスタイル(スケール後の動画の width/height/left/top)
// を計算する。region と箱のアスペクト比が一致するとき(既存の全画面呼び出し・
// ワイプ)は contain/cover の区別なく `scale = width / region.w` 直結の式と
// 完全に一致する(スケールが等しくセンタリング補正が0になるため)。
import type { Region } from "../types.ts";

export interface CropFitStyle {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function cropFitStyle(args: {
  canvas: { w: number; h: number };
  region: Region;
  width: number;
  height: number;
  fit: "contain" | "cover";
}): CropFitStyle {
  const { canvas, region, width, height, fit } = args;
  const scaleX = width / region.w;
  const scaleY = height / region.h;
  const scale = fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  return {
    width: canvas.w * scale,
    height: canvas.h * scale,
    left: -region.x * scale + (width - region.w * scale) / 2,
    top: -region.y * scale + (height - region.h * scale) / 2,
  };
}
