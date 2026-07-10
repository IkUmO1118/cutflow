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
