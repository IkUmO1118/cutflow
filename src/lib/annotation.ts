// lib/annotation.ts — 注釈グラフィック(overlays.json の annotations)の
// 既定値解決と矢尻ポリゴンの算出。remotion/Main.tsx と renderProps.ts が使う
// 純関数。blur.ts と同じ流儀でテストの数値を固定する。
import {
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_ARROW_HEAD_PX,
  DEFAULT_ARROW_WIDTH_PX,
  DEFAULT_BOX_RADIUS_PX,
  DEFAULT_BOX_WIDTH_PX,
  DEFAULT_SPOTLIGHT_DIM,
  DEFAULT_SPOTLIGHT_FEATHER_PX,
  DEFAULT_SPOTLIGHT_SHAPE,
} from "../types.ts";
import type { Annotation } from "../types.ts";
import type { ResolvedAnnotation } from "../../remotion/props.ts";

/**
 * 種別ごとの既定値を埋め、start/end を差し替えた解決済み annotation を返す。
 * blurs の renderProps 解決(type/strength のフォールバック)と同じ考え方:
 * Main.tsx はここで解決済みの具体値だけを見て描く(フォールバックを持たない)。
 */
export function resolveAnnotation(
  a: Annotation,
  start: number,
  end: number,
): ResolvedAnnotation {
  switch (a.type) {
    case "arrow":
      return {
        type: "arrow",
        start,
        end,
        from: a.from,
        to: a.to,
        color: a.color ?? DEFAULT_ANNOTATION_COLOR,
        widthPx: a.widthPx ?? DEFAULT_ARROW_WIDTH_PX,
        headPx: a.headPx ?? DEFAULT_ARROW_HEAD_PX,
        ...(a.keyframes ? { keyframes: [] } : {}),
      };
    case "box":
      return {
        type: "box",
        start,
        end,
        rect: a.rect,
        color: a.color ?? DEFAULT_ANNOTATION_COLOR,
        widthPx: a.widthPx ?? DEFAULT_BOX_WIDTH_PX,
        radiusPx: a.radiusPx ?? DEFAULT_BOX_RADIUS_PX,
        ...(a.fill !== undefined ? { fill: a.fill } : {}),
        ...(a.keyframes ? { keyframes: [] } : {}),
      };
    case "spotlight":
      return {
        type: "spotlight",
        start,
        end,
        rect: a.rect,
        shape: a.shape ?? DEFAULT_SPOTLIGHT_SHAPE,
        dim: a.dim ?? DEFAULT_SPOTLIGHT_DIM,
        featherPx: a.featherPx ?? DEFAULT_SPOTLIGHT_FEATHER_PX,
        radiusPx: a.radiusPx ?? 0,
        ...(a.keyframes ? { keyframes: [] } : {}),
      };
  }
}

/**
 * 静的 annotation(render 高速パスの FAST 適格性)。null = 適格、
 * 文字列 = 不適格の理由(SLOW 送り)。overlayFade.ts の overlayFastReason と
 * 同じ流儀。**ブラウザ側は使わないが、fastPlan(node)と将来のエディタ表示の
 * 両方から参照しうる純関数なのでここ(browser-safe)に置く**。
 *
 * 適格条件は「時間変化しないこと」だけ:
 * - keyframes が無い(空配列 [] は "無い" と同義。renderProps.ts の
 *   resolveAnnotation が `a.keyframes ? { keyframes: [] } : {}` を置くため、
 *   断片によっては keyframes:[] が載る。valuesAt は空配列でベースラインを
 *   返すので描画上も静的)
 * 色/太さ/rect/dim/feather は解決済みの定数なので、種別(arrow/box/spotlight)
 * による区別は不要 = 3種別すべて FAST 適格。
 */
export function annotationFastReason(a: ResolvedAnnotation): string | null {
  if ((a.keyframes?.length ?? 0) > 0) return "keyframes"; // 時間変化する
  return null;
}

/**
 * 時間軸を剥がした「レイヤー画」用の annotation(高速パスの AnnotationStill が
 * 焼く1枚 / キャッシュキーの正規形)。start/end を [0,1) に正規化し keyframes を
 * 落とす(同じ絵は同じ PNG。時刻はキャッシュキーを汚さない)。
 * AnnotationStill は t=0 で描くので、start=0/end=1 は「常に可視」を意味する。
 * **ブラウザ(AnnotationStill.tsx)と node(annotationStill.ts)の両方から使うので
 * このファイルに置く**(annotationStill.ts に置くとバンドルが壊れる)。
 * フィールド順を固定しているのは JSON.stringify のキー安定性のため。
 */
export function annotationStillItem(a: ResolvedAnnotation): ResolvedAnnotation {
  switch (a.type) {
    case "arrow":
      return {
        type: "arrow", start: 0, end: 1, from: a.from, to: a.to,
        color: a.color, widthPx: a.widthPx, headPx: a.headPx,
      };
    case "box":
      return {
        type: "box", start: 0, end: 1, rect: a.rect, color: a.color,
        widthPx: a.widthPx, radiusPx: a.radiusPx,
        ...(a.fill !== undefined ? { fill: a.fill } : {}),
      };
    case "spotlight":
      return {
        type: "spotlight", start: 0, end: 1, rect: a.rect, shape: a.shape,
        dim: a.dim, featherPx: a.featherPx, radiusPx: a.radiusPx,
      };
  }
}

export interface Point {
  x: number;
  y: number;
}

/** 矢印の矢尻ポリゴンの2つのバーブ頂点(from→to の線に対して headPx の
 * 大きさ・左右 30° に開いた古典的な矢尻形状)。from と to が同一点のときは
 * 向きが定まらないため to をそのまま2点返す(validate がこのケースを
 * エラーにするので、描画に到達するのは正常系のみ) */
export function arrowHeadPoints(
  from: Point,
  to: Point,
  headPx: number,
): { p1: Point; p2: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { p1: { ...to }, p2: { ...to } };
  const angle = Math.atan2(dy, dx);
  const barb = Math.PI / 6; // 30°
  const p1 = {
    x: to.x - headPx * Math.cos(angle - barb),
    y: to.y - headPx * Math.sin(angle - barb),
  };
  const p2 = {
    x: to.x - headPx * Math.cos(angle + barb),
    y: to.y - headPx * Math.sin(angle + barb),
  };
  return { p1, p2 };
}
