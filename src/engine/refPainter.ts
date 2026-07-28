// src/engine/refPainter.ts — FrameDescriptor を canvas2d へ描く参照ペインタ
// (M2 Phase4)。テスト/parity ハーネス専用だがブラウザ安全に書く(node import
// 禁止。M3a で rendered テクスチャ(テロップ等)のラスタライザに昇格するため
// 捨てにならない)。
//
// M2 の合格基準は「位置・レイヤ構成の一致」(フォントラスタ差は許容。
// 厳密な画素 parity は M3a のコンポジタで判定する)。blurRegion/spotlight の
// feather 等、正確な画素表現より位置/構成の再現を優先した簡易実装がある
// (各 draw 関数のコメント参照)。
import { arrowHeadPoints } from "../lib/annotation.ts";
import type {
  AnnotationArrowContent,
  AnnotationBoxContent,
  AnnotationSpotlightContent,
  BlurRegionContent,
  CaptionContent,
  ExternalItem,
  FillContent,
  FrameDescriptor,
  Rect,
  RenderedItem,
} from "./descriptor.ts";

/** external item のソースを解決する関数。テストでは静止画/単色でよい。
 * item.sourceTimeSec に応じたシーク(動画のどのフレームを見せるか)は
 * 呼び出し側の責務(このペインタは「今渡された絵をそのまま貼る」だけ) */
export type ExternalResolver = (item: ExternalItem) => CanvasImageSource | null;

/** ダックタイピングで実寸を読む(instanceof だと DOM の無いテスト環境で
 * モックを判別できないため。<video>/<img>/ImageBitmap/canvas のいずれも
 * このプロパティ名の組で判別できる) */
function naturalSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  if (typeof s.videoWidth === "number") return { w: s.videoWidth, h: s.videoHeight ?? 0 };
  if (typeof s.naturalWidth === "number") return { w: s.naturalWidth, h: s.naturalHeight ?? 0 };
  if (typeof s.width === "number" && typeof s.height === "number") return { w: s.width, h: s.height };
  return { w: 0, h: 0 };
}

/**
 * contain/cover の sourceRect+quad をペインタ側(実寸判明後)で解決する。
 * describeFrame.ts の resolveFit と同じ式(重複だが、片方は「JSON側で既知の
 * 寸法」、もう片方は「デコードして初めて分かる実寸」を扱うという役割の違いが
 * あるための意図的な重複。§descriptor.ts の ExternalPlacement コメント参照)
 */
function resolveFitAtPaint(
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

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawExternal(ctx: CanvasRenderingContext2D, item: ExternalItem, resolve: ExternalResolver): void {
  const src = resolve(item);
  ctx.save();
  ctx.globalAlpha = item.opacity;
  const colorFilter = item.effects?.find((e) => e.kind === "colorFilter");
  if (colorFilter) {
    ctx.filter = `brightness(${colorFilter.brightness}) contrast(${colorFilter.contrast}) saturate(${colorFilter.saturate})`;
  }
  if (item.placement.mode === "resolved") {
    const { sourceRect, quad } = item.placement;
    if (item.radiusPx) roundRectPath(ctx, quad.x, quad.y, quad.w, quad.h, item.radiusPx);
    else ctx.rect(quad.x, quad.y, quad.w, quad.h);
    ctx.clip();
    if (src) {
      if (sourceRect) {
        ctx.drawImage(src, sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h, quad.x, quad.y, quad.w, quad.h);
      } else {
        ctx.drawImage(src, quad.x, quad.y, quad.w, quad.h);
      }
    }
  } else {
    const { box, fit, letterboxColor } = item.placement;
    if (letterboxColor) {
      ctx.fillStyle = letterboxColor;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    if (src) {
      const natural = naturalSize(src);
      if (natural.w > 0 && natural.h > 0) {
        const { sourceRect, quad } = resolveFitAtPaint(natural, box, fit);
        ctx.drawImage(src, sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h, quad.x, quad.y, quad.w, quad.h);
      }
    }
  }
  ctx.restore();
}

function drawCaption(ctx: CanvasRenderingContext2D, item: RenderedItem, content: CaptionContent): void {
  if (!item.placement || item.placement.mode !== "anchor") return;
  const { point, anchor, maxWidthPx } = item.placement;
  ctx.save();
  ctx.globalAlpha = item.opacity;
  ctx.font = `${content.fontWeight} ${content.fontSizePx}px ${content.fontFamily}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const textW = Math.min(ctx.measureText(content.text).width, maxWidthPx ?? Infinity);
  const textH = content.fontSizePx * 1.4;
  let boxX: number;
  let boxY: number;
  if (anchor === "topLeft") {
    boxX = point.x;
    boxY = point.y;
  } else if (anchor === "center") {
    boxX = point.x - textW / 2;
    boxY = point.y - textH / 2;
  } else {
    boxX = point.x - textW / 2;
    boxY = point.y - textH;
  }

  if (item.transform) {
    const cx = boxX + textW / 2;
    const cy = boxY + textH / 2;
    ctx.translate(cx, cy);
    ctx.translate(item.transform.translateX, item.transform.translateY);
    ctx.scale(item.transform.scale, item.transform.scale);
    ctx.translate(-cx, -cy);
  }

  if (content.background) {
    const pad = content.background.paddingPx;
    ctx.fillStyle = content.background.color;
    roundRectPath(ctx, boxX - pad, boxY - pad / 2, textW + pad * 2, textH + pad, content.background.radiusPx);
    ctx.fill();
  }

  const textY = boxY + textH / 2;
  if (content.words) {
    let cursorX = boxX;
    for (const w of content.words) {
      const wordW = ctx.measureText(w.text).width;
      if (w.fillProgress !== undefined) {
        // "fill" モードの塗り進み: clip で語の左側だけ activeColor にする近似
        const active = content.karaokeActiveColor ?? "#ffe14d";
        const inactive = content.karaokeInactiveColor ?? content.color;
        ctx.save();
        ctx.beginPath();
        ctx.rect(cursorX, boxY, wordW * w.fillProgress, textH);
        ctx.clip();
        ctx.fillStyle = active;
        ctx.fillText(w.text, cursorX, textY);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(cursorX + wordW * w.fillProgress, boxY, wordW * (1 - w.fillProgress), textH);
        ctx.clip();
        ctx.fillStyle = inactive;
        ctx.fillText(w.text, cursorX, textY);
        ctx.restore();
      } else {
        const color = w.active ? (content.karaokeActiveColor ?? "#ffe14d") : (content.karaokeInactiveColor ?? content.color);
        if (content.outlineColor !== "none") {
          ctx.strokeStyle = content.outlineColor;
          ctx.lineWidth = content.outlineWidthPx * 2;
          ctx.strokeText(w.text, cursorX, textY);
        }
        ctx.fillStyle = color;
        ctx.fillText(w.text, cursorX, textY);
      }
      cursorX += wordW;
    }
  } else {
    if (content.outlineColor !== "none") {
      ctx.strokeStyle = content.outlineColor;
      ctx.lineWidth = content.outlineWidthPx * 2;
      ctx.strokeText(content.text, boxX, textY);
    }
    ctx.fillStyle = content.color;
    ctx.fillText(content.text, boxX, textY);
  }
  ctx.restore();
}

function drawAnnotationArrow(ctx: CanvasRenderingContext2D, content: AnnotationArrowContent): void {
  ctx.save();
  ctx.strokeStyle = content.color;
  ctx.fillStyle = content.color;
  ctx.lineWidth = content.widthPx;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(content.from.x, content.from.y);
  ctx.lineTo(content.to.x, content.to.y);
  ctx.stroke();
  const { p1, p2 } = arrowHeadPoints(content.from, content.to, content.headPx);
  ctx.beginPath();
  ctx.moveTo(content.to.x, content.to.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawAnnotationBox(ctx: CanvasRenderingContext2D, content: AnnotationBoxContent): void {
  ctx.save();
  if (content.fill) {
    ctx.fillStyle = content.fill;
    roundRectPath(ctx, content.rect.x, content.rect.y, content.rect.w, content.rect.h, content.radiusPx);
    ctx.fill();
  }
  ctx.strokeStyle = content.color;
  ctx.lineWidth = content.widthPx;
  roundRectPath(ctx, content.rect.x, content.rect.y, content.rect.w, content.rect.h, content.radiusPx);
  ctx.stroke();
  ctx.restore();
}

/** feather(ぼかし)は近似しない(evenodd の硬い穴)。M2 の合格基準は
 * 位置/構成一致でぼかしの質そのものではないため */
function drawAnnotationSpotlight(ctx: CanvasRenderingContext2D, content: AnnotationSpotlightContent): void {
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${content.dim})`;
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (content.shape === "ellipse") {
    ctx.ellipse(
      content.rect.x + content.rect.w / 2,
      content.rect.y + content.rect.h / 2,
      content.rect.w / 2,
      content.rect.h / 2,
      0,
      0,
      Math.PI * 2,
      true,
    );
  } else {
    const rr = Math.max(0, Math.min(content.radiusPx, content.rect.w / 2, content.rect.h / 2));
    // evenodd で穴にするため逆回り(反時計)で足す
    ctx.moveTo(content.rect.x + rr, content.rect.y);
    ctx.arcTo(content.rect.x, content.rect.y, content.rect.x, content.rect.y + rr, rr);
    ctx.arcTo(content.rect.x, content.rect.y + content.rect.h, content.rect.x + rr, content.rect.y + content.rect.h, rr);
    ctx.arcTo(
      content.rect.x + content.rect.w,
      content.rect.y + content.rect.h,
      content.rect.x + content.rect.w,
      content.rect.y + content.rect.h - rr,
      rr,
    );
    ctx.arcTo(content.rect.x + content.rect.w, content.rect.y, content.rect.x + content.rect.w - rr, content.rect.y, rr);
    ctx.closePath();
  }
  ctx.fill("evenodd");
  ctx.restore();
}

/**
 * 領域ぼかし。backdrop-filter の厳密な再現ではなく、その場までに描かれた
 * canvas 自身を filter:blur() 付きで自分自身へ描き直す近似(chrome-headless-shell
 * では動作する)。自己参照 drawImage を禁止する環境では例外を握りつぶし
 * 何もしない(劣化。位置/構成一致という M2 の合格基準には影響しない)
 */
function drawBlurRegion(ctx: CanvasRenderingContext2D, content: BlurRegionContent): void {
  try {
    ctx.save();
    ctx.filter = `blur(${content.radiusPx}px)`;
    ctx.drawImage(
      ctx.canvas,
      content.rect.x,
      content.rect.y,
      content.rect.w,
      content.rect.h,
      content.rect.x,
      content.rect.y,
      content.rect.w,
      content.rect.h,
    );
    ctx.restore();
  } catch {
    // 環境非対応は無視(劣化)
  }
}

function drawFill(ctx: CanvasRenderingContext2D, content: FillContent, quad: Rect, opacity: number): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = content.color;
  ctx.fillRect(quad.x, quad.y, quad.w, quad.h);
  ctx.restore();
}

/** rendered item 1件だけを絶対フレーム座標で描く(M3a textureCache.ts が
 * 各アイテムを独立テクスチャへラスタライズする際の入口として昇格。
 * paintDescriptor のループ本体と同じ関数=挙動は不変) */
export function drawRendered(ctx: CanvasRenderingContext2D, item: RenderedItem): void {
  const { content } = item;
  switch (content.kind) {
    case "caption":
      drawCaption(ctx, item, content);
      return;
    case "annotationArrow":
      drawAnnotationArrow(ctx, content);
      return;
    case "annotationBox":
      drawAnnotationBox(ctx, content);
      return;
    case "annotationSpotlight":
      drawAnnotationSpotlight(ctx, content);
      return;
    case "blurRegion":
      drawBlurRegion(ctx, content);
      return;
    case "fill":
      if (item.placement?.mode === "quad") drawFill(ctx, content, item.placement.quad, item.opacity);
      return;
  }
}

/**
 * FrameDescriptor を canvas2d コンテキストへ描く(下から上へ items を辿るだけ。
 * レイヤ順の解決は describeFrame 側で済んでいる)。external の実体解決は
 * resolveExternal に委譲する(テストでは静止画/単色でよい。M3a の実装では
 * デコード済みフレームを渡す側になる)
 */
export function paintDescriptor(
  ctx: CanvasRenderingContext2D,
  descriptor: FrameDescriptor,
  resolveExternal: ExternalResolver,
): void {
  ctx.save();
  ctx.fillStyle = descriptor.backgroundColor;
  ctx.fillRect(0, 0, descriptor.size.w, descriptor.size.h);
  ctx.restore();
  for (const item of descriptor.items) {
    if (item.kind === "external") drawExternal(ctx, item, resolveExternal);
    else drawRendered(ctx, item);
  }
}
