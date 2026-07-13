// remotion/AnnotationStill.tsx — render 高速パスが焼く「注釈グラフィック1件の
// 時間不変なレイヤー画」。**node 専用モジュールを import しないこと**
// (OverlayStill.tsx と同じ制約)。annotationStillItem は browser-safe な
// src/lib/annotation.ts から取る。
import { AbsoluteFill } from "remotion";
import { AnnotationItemView } from "./AnnotationLayer.tsx";
import { annotationStillItem } from "../src/lib/annotation.ts";
import type { ResolvedAnnotation } from "./props.ts";

export type AnnotationStillProps = {
  width: number;
  height: number;
  /** 注釈1件。時間変化する要素(keyframes)と時刻は annotationStillItem が剥がす */
  annotation: ResolvedAnnotation;
};

export const AnnotationStill = (p: AnnotationStillProps) => (
  <AbsoluteFill style={{ backgroundColor: "transparent" }}>
    <AnnotationItemView
      a={annotationStillItem(p.annotation)}
      t={0}
      width={p.width}
      height={p.height}
      index={0}
    />
  </AbsoluteFill>
);

export const annotationStillDefaultProps: AnnotationStillProps = {
  width: 1920,
  height: 1080,
  annotation: {
    type: "box", start: 0, end: 1,
    rect: { x: 100, y: 100, w: 400, h: 300 },
    color: "#ff3b30", widthPx: 6, radiusPx: 8,
  },
};
