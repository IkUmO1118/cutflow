// remotion/AnnotationLayer.tsx — Main.tsx から verbatim 抽出した注釈グラフィック
// 1件の描画(AnnotationItemView)。Main.tsx と AnnotationStill.tsx(render 高速
// パスの静止画ラスタライズ)の唯一の描画定義。
// **node 専用モジュールを import しないこと**(Root.tsx からブラウザバンドルへ
// 入る。src/lib/annotationStill.ts のような node:fs / @remotion/renderer を引く
// 側を import すると frames / editor / render のバンドルが丸ごと壊れる)。
import { arrowHeadPoints } from "../src/lib/annotation.ts";
import { valuesAt } from "../src/lib/keyframes.ts";
import type { ResolvedAnnotation } from "./props.ts";

export type AnnotationItemViewProps = {
  a: ResolvedAnnotation;
  /** 出力タイムラインの秒(Main は frame/fps、Still は 0) */
  t: number;
  width: number;
  height: number;
  /** SVG の mask/filter id を一意にするための添字(絵には影響しない) */
  index: number;
};

/** 注釈1件。可視窓の外では null(硬い ON/OFF・遷移なし) */
export const AnnotationItemView = ({ a, t, width, height, index }: AnnotationItemViewProps) => {
  if (t < a.start || t >= a.end) return null; // 硬い ON/OFF(遷移なし)
  if (a.type === "arrow") {
    const now = a.keyframes
      ? valuesAt(
          {
            fromX: a.from.x,
            fromY: a.from.y,
            toX: a.to.x,
            toY: a.to.y,
            widthPx: a.widthPx,
            headPx: a.headPx,
          },
          a.keyframes,
          t,
        )
      : null;
    const from = now ? { x: now.fromX, y: now.fromY } : a.from;
    const to = now ? { x: now.toX, y: now.toY } : a.to;
    const widthPx = now?.widthPx ?? a.widthPx;
    const headPx = now?.headPx ?? a.headPx;
    const { p1, p2 } = arrowHeadPoints(from, to, headPx);
    return (
      <svg
        style={{
          position: "absolute", inset: 0,
          width: width, height: height, overflow: "visible",
        }}
      >
        <line
          x1={from.x} y1={from.y} x2={to.x} y2={to.y}
          stroke={a.color} strokeWidth={widthPx} strokeLinecap="round"
        />
        <polygon
          points={`${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`}
          fill={a.color}
        />
      </svg>
    );
  }
  if (a.type === "box") {
    const now = a.keyframes
      ? valuesAt(
          {
            x: a.rect.x,
            y: a.rect.y,
            w: a.rect.w,
            h: a.rect.h,
            widthPx: a.widthPx,
            radiusPx: a.radiusPx,
          },
          a.keyframes,
          t,
        )
      : null;
    return (
      <div
        style={{
          position: "absolute",
          left: now?.x ?? a.rect.x,
          top: now?.y ?? a.rect.y,
          width: now?.w ?? a.rect.w,
          height: now?.h ?? a.rect.h,
          boxSizing: "border-box",
          border: `${now?.widthPx ?? a.widthPx}px solid ${a.color}`,
          borderRadius: now?.radiusPx ?? a.radiusPx,
          ...(a.fill ? { backgroundColor: a.fill } : {}),
        }}
      />
    );
  }
  // spotlight: フルスクリーンの黒(fillOpacity=dim)に mask で rect(または
  // ellipse)の穴を開ける。featherPx は穴形状への feGaussianBlur で表現
  const maskId = `ann-spotlight-mask-${index}`;
  const blurId = `ann-spotlight-blur-${index}`;
  const now = a.keyframes
    ? valuesAt(
        {
          x: a.rect.x,
          y: a.rect.y,
          w: a.rect.w,
          h: a.rect.h,
          dim: a.dim,
          featherPx: a.featherPx,
          radiusPx: a.radiusPx,
        },
        a.keyframes,
        t,
      )
    : null;
  const rect = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : a.rect;
  const dim = now?.dim ?? a.dim;
  const featherPx = now?.featherPx ?? a.featherPx;
  const radiusPx = now?.radiusPx ?? a.radiusPx;
  return (
    <svg
      style={{
        position: "absolute", inset: 0,
        width: width, height: height,
      }}
    >
      <defs>
        {featherPx > 0 && (
          <filter id={blurId}>
            <feGaussianBlur stdDeviation={featherPx} />
          </filter>
        )}
        <mask id={maskId}>
          <rect x={0} y={0} width={width} height={height} fill="white" />
          <g filter={featherPx > 0 ? `url(#${blurId})` : undefined}>
            {a.shape === "ellipse" ? (
              <ellipse
                cx={rect.x + rect.w / 2}
                cy={rect.y + rect.h / 2}
                rx={rect.w / 2}
                ry={rect.h / 2}
                fill="black"
              />
            ) : (
              <rect
                x={rect.x} y={rect.y} width={rect.w} height={rect.h}
                rx={radiusPx} fill="black"
              />
            )}
          </g>
        </mask>
      </defs>
      <rect
        x={0} y={0} width={width} height={height}
        fill="black" fillOpacity={dim} mask={`url(#${maskId})`}
      />
    </svg>
  );
};
