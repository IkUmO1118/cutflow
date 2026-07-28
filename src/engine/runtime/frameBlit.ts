// src/engine/runtime/frameBlit.ts — VideoSample(mediabunny。≒VideoFrame)を
// OffscreenCanvas へ blit する層(M3a Phase2)。母艦§9「M3a方針確定」で
// 決めた blit の3役をここで担う:
//   1. 静的 crop(screenRegion の cover-fit。sourceRect)
//   2. colorFilter(ctx.filter で CSS filter と同じ意味論を適用)
//   3. 色空間(P3 収録→sRGB は 2d context の描画で自然に発生する)
//
// 呼び出し側(compositorWorker。Phase3)は blit 完了直後に必ず
// sample.close() する(§5 落とし穴。ここでは close しない=所有権は渡さない)。
//
// ブラウザ専用(OffscreenCanvas 前提)。
import type { VideoSample } from "mediabunny";
import type { ColorFilterEffect, ExternalPlacement, Rect } from "../descriptor.ts";

/**
 * "resolved" 配置の sourceRect/quad は manifest.video.canvas(拡張キャンバス)の
 * 座標空間で計算されている(describeFrame.ts の resolveFit・
 * src/lib/panelStyle.ts の cropFitStyle と同じ空間)。この空間は Remotion 版
 * では `<video>` 要素を canvas.w×canvas.h の CSS サイズへ引き伸ばし+
 * overflow:hidden でクロップすることで実現していた(video 自身のデコード
 * 解像度=proxy の実ピクセル数とは無関係だった)。
 *
 * WebCodecs 経路ではブラウザが自動でこの引き伸ばしをしてくれないため、
 * ここで明示的に「canvas 空間の矩形 → 実デコード解像度(sample.displayWidth/
 * Height)のピクセル空間」へスケールする。proxy はオールイントラ化のため
 * canvas.w/h と異なる解像度になりうる(config.yaml `preview.width`)。
 */
export function scaleRectToPixelSpace(
  rect: Rect,
  canvasSize: { w: number; h: number },
  pixelSize: { w: number; h: number },
): Rect {
  const scaleX = pixelSize.w / canvasSize.w;
  const scaleY = pixelSize.h / canvasSize.h;
  return { x: rect.x * scaleX, y: rect.y * scaleY, w: rect.w * scaleX, h: rect.h * scaleY };
}

/**
 * contain/cover の sourceRect+quad を実デコード解像度判明後に解決する。
 * describeFrame.ts の resolveFit・refPainter.ts の resolveFitAtPaint と
 * 同じ式の意図的な重複(descriptor.ts の ExternalPlacement コメント・
 * refPainter.ts 冒頭コメント参照。§役割: 実寸はデコードして初めて分かる)。
 */
export function resolveFitFromNatural(
  natural: { w: number; h: number },
  box: Rect,
  fit: "contain" | "cover",
): { sourceRect: Rect; quad: Rect } {
  const scaleX = box.w / natural.w;
  const scaleY = box.h / natural.h;
  if (fit === "cover") {
    const scale = Math.max(scaleX, scaleY);
    const visW = box.w / scale;
    const visH = box.h / scale;
    return {
      sourceRect: { x: (natural.w - visW) / 2, y: (natural.h - visH) / 2, w: visW, h: visH },
      quad: { x: box.x, y: box.y, w: box.w, h: box.h },
    };
  }
  const scale = Math.min(scaleX, scaleY);
  const quadW = natural.w * scale;
  const quadH = natural.h * scale;
  return {
    sourceRect: { x: 0, y: 0, w: natural.w, h: natural.h },
    quad: { x: box.x + (box.w - quadW) / 2, y: box.y + (box.h - quadH) / 2, w: quadW, h: quadH },
  };
}

/** colorFilter を CSS filter 文字列へ(refPainter.ts drawExternal と同じ式) */
export function colorFilterCss(effect: ColorFilterEffect): string {
  return `brightness(${effect.brightness}) contrast(${effect.contrast}) saturate(${effect.saturate})`;
}

let ctxFilterSupported: boolean | null = null;

/** `ctx.filter` の feature detect(§5 落とし穴。非対応時はクラッシュさせず
 * colorFilter 無適用+警告1回で劣化) */
function isCtxFilterSupported(ctx: OffscreenCanvasRenderingContext2D): boolean {
  if (ctxFilterSupported !== null) return ctxFilterSupported;
  ctxFilterSupported = typeof ctx.filter === "string";
  if (!ctxFilterSupported) {
    console.warn("frameBlit: ctx.filter 非対応環境のため colorFilter は無適用になります");
  }
  return ctxFilterSupported;
}

export interface BlitVideoOptions {
  placement: ExternalPlacement;
  /** "resolved" 配置の sourceRect/quad が定義されている座標空間
   * (manifest.video.canvas 相当)。"resolved" のときだけ必須 */
  canvasSize?: { w: number; h: number };
  colorFilter?: ColorFilterEffect;
  /** 角丸(design パネル・ワイプ)。省略時 0 */
  radiusPx?: number;
}

function integerSize(w: number, h: number): { w: number; h: number } {
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

export interface BlitVideoResult {
  canvas: OffscreenCanvas;
  /** このテクスチャを置くべき絶対フレーム座標の矩形(GPU レイヤーの
   * transform に直結する。w/h は canvas の実ピクセルサイズと一致) */
  quad: Rect;
  /** 実際に描画へ使ったクロップ矩形(実デコード解像度のピクセル空間。
   * "resolved" は scaleRectToPixelSpace 後、"fit" は resolveFitFromNatural の
   * 結果)。textureCache.externalTextureId のキーに含める(R4 Phase2。
   * §2 決定2「そのテクスチャの画を決める全入力」) */
  sourceRect: Rect;
}

/** 動画フレーム(VideoSample)か静止画(ImageBitmap。design 背景・画像
 * overlay 用)のどちらかを受け付ける。close() が要るのは VideoSample だけ
 * (§5 落とし穴。ImageBitmap は呼び出し側でキャッシュし続けてよい) */
export type BlitSource = VideoSample | ImageBitmap;

function isVideoSample(source: BlitSource): source is VideoSample {
  return "displayWidth" in source && "draw" in source;
}

/**
 * VideoSample または ImageBitmap を OffscreenCanvas へ blit する。同期処理
 * (このコールバック内でソースのピクセルを消費し終える)なので、
 * VideoSample の場合は呼び出し側が返り値を受け取ったらすぐ close() してよい。
 */
export function blitVideoSample(source: BlitSource, opts: BlitVideoOptions): BlitVideoResult {
  const natural = isVideoSample(source)
    ? { w: source.displayWidth, h: source.displayHeight }
    : { w: source.width, h: source.height };

  let sourceRect: Rect;
  let quad: Rect;
  if (opts.placement.mode === "resolved") {
    const canvasSize = opts.canvasSize ?? natural;
    quad = opts.placement.quad;
    sourceRect = opts.placement.sourceRect
      ? scaleRectToPixelSpace(opts.placement.sourceRect, canvasSize, natural)
      : { x: 0, y: 0, w: natural.w, h: natural.h };
  } else {
    const resolved = resolveFitFromNatural(natural, opts.placement.box, opts.placement.fit);
    sourceRect = resolved.sourceRect;
    quad = resolved.quad;
  }
  const destSize = integerSize(quad.w, quad.h);

  const canvas = new OffscreenCanvas(destSize.w, destSize.h);
  const ctx = canvas.getContext("2d", { colorSpace: "srgb" }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("frameBlit: OffscreenCanvas 2d context を取得できません");

  ctx.save();
  if (opts.colorFilter && isCtxFilterSupported(ctx)) {
    ctx.filter = colorFilterCss(opts.colorFilter);
  }
  if (opts.radiusPx && opts.radiusPx > 0) {
    ctx.beginPath();
    ctx.roundRect(0, 0, destSize.w, destSize.h, Math.min(opts.radiusPx, destSize.w / 2, destSize.h / 2));
    ctx.clip();
  }
  if (isVideoSample(source)) {
    source.draw(ctx, sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h, 0, 0, destSize.w, destSize.h);
  } else {
    ctx.drawImage(source, sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h, 0, 0, destSize.w, destSize.h);
  }
  ctx.restore();

  // GPU レイヤーの transform(§3 compositor.ts)は絶対フレーム座標の quad を要る
  // ため、blit 先の実ピクセルサイズ(destSize)とあわせて返す
  return { canvas, quad: { x: quad.x, y: quad.y, w: destSize.w, h: destSize.h }, sourceRect };
}
