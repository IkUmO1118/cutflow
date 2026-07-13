// lib/overlayFade.ts — 素材オーバーレイ/挿入クリップの時間関数(Remotion 描画と
// ffmpeg 高速パスが共有する唯一の定義)。remotion/Main.tsx から機械的に移設した。

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
