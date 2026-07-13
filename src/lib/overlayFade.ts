// lib/overlayFade.ts — 素材オーバーレイ/挿入クリップの時間関数(Remotion 描画と
// ffmpeg 高速パスが共有する唯一の定義)。remotion/Main.tsx から機械的に移設した。
// **このファイルはブラウザバンドル(Root.tsx → Main/OverlayLayer/OverlayStill)へ
// 引き込まれる**ので、node 専用モジュール(node:fs / node:crypto /
// @remotion/renderer 等)を絶対に import しないこと(webpack が解決できずに
// frames / editor / render のバンドルが丸ごと壊れる)。
import type { OverlayItem } from "../../remotion/props.ts";

/** フェード秒 → フレーム(Remotion の fadeFactor と同じ Math.round) */
export const fadeFrames = (sec: number | undefined, fps: number): number =>
  Math.round((sec ?? 0) * fps);

/** フェードイン/アウトの係数(0〜1)。区間の頭 fadeIn 秒で 0→1、
 * 末尾 fadeOut 秒で 1→0。両方が重なる短い区間では小さい方を採る。
 * Main.tsx から verbatim 移設(1文字も変えない) */
export const fadeFactor = (
  frame: number,
  durFrames: number,
  fps: number,
  fadeInSec?: number,
  fadeOutSec?: number,
): number => {
  let g = 1;
  const fin = Math.round((fadeInSec ?? 0) * fps);
  const fout = Math.round((fadeOutSec ?? 0) * fps);
  if (fin > 0) g = Math.min(g, Math.max(0, Math.min(1, frame / fin)));
  if (fout > 0) g = Math.min(g, Math.max(0, Math.min(1, (durFrames - frame) / fout)));
  return g;
};

/** Main.tsx から verbatim 移設(1文字も変えない) */
export const isImageFile = (f: string): boolean =>
  /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f);

/** overlay の出力フレーム区間。**Main.tsx の <Sequence from/durationInFrames> と
 * 同一式でなければならない**(round(end*fps) ではない。半端秒で 1 フレームずれる)。
 * fastPlan/fastSegment(P5-1 PR2)が SLOW 判定・enable 窓の算出に使う */
export function overlaySeqRange(
  o: { start: number; end: number },
  fps: number,
): { fromFrame: number; durFrames: number; toFrame: number } {
  const fromFrame = Math.round(o.start * fps);
  const durFrames = Math.max(1, Math.round((o.end - o.start) * fps));
  return { fromFrame, durFrames, toFrame: fromFrame + durFrames };
}

/** 時間変化する要素を剥がした「レイヤー画」用の素材(render 高速パスの
 * OverlayStill が焼く1枚)。fade / opacity / keyframes は ffmpeg 側が alpha として
 * 掛けるのでここでは 1 に固定。startFrom は画像では Remotion も無視するので落とす
 * (キャッシュキーの汚染防止)。
 * **ブラウザ側(remotion/OverlayStill.tsx)と node 側(src/lib/overlayStill.ts)の
 * 両方から使うので、node 依存の無いこのファイルに置く**(overlayStill.ts に置くと
 * node:fs / @remotion/renderer がブラウザバンドルへ引き込まれて壊れる) */
export function overlayStillItem(o: OverlayItem): OverlayItem {
  return {
    start: o.start, end: o.end, file: o.file, track: o.track, fit: o.fit,
    ...(o.rect ? { rect: o.rect } : {}),
  };
}
