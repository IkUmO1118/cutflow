import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CaptionPos } from "../../src/types.ts";
import type { AnnotationPatch } from "./model.ts";

/** プレビューに表示中の矢印注釈1つ分(座標はコンポジションのpx) */
export interface OverlayArrow {
  /** overlays.annotations の添字 */
  index: number;
  from: CaptionPos;
  to: CaptionPos;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 退化(2点が重なる)防止の最小距離(コンポジションpx)。これ未満になる
 * ドラッグ結果は適用しない(直前の値をそのまま維持) */
const MIN_DIST = 4;

/**
 * プレビュー(@remotion/player)の上に重ねる透明レイヤー。矢印注釈の
 * from/to を掴めるハンドル2つ + 破線の参考線 + 参考矢尻を SVG で描く。
 * 実際の矢印描画は Player(remotion/Main.tsx)側が済んでいるので、ここは
 * 編集用の透明な当たり判定だけ(二重掛けしない)。座標変換
 * (コンポジション⇔画面)は MaterialOverlay と同じ、点ドラッグの仕組みは
 * CaptionOverlay と同じ。
 */
export const ArrowOverlay = ({
  width,
  height,
  arrows,
  selection,
  onSelect,
  onChange,
}: {
  /** コンポジションの解像度 */
  width: number;
  height: number;
  arrows: OverlayArrow[];
  /** 選択中の注釈(overlays.annotations の添字) */
  selection: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: AnnotationPatch, coalesceKey?: string) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setBox({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Player は親いっぱいに広がり、コンポジションはレターボックスで内接する
  const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / width, box.h / height) : 0;
  const dx = (box.w - width * scale) / 2;
  const dy = (box.h - height * scale) / 2;

  const toScreen = (p: CaptionPos) => ({ x: dx + p.x * scale, y: dy + p.y * scale });

  const onDown = (
    e: ReactPointerEvent,
    a: OverlayArrow,
    part: "from" | "to" | "line",
  ) => {
    if (e.button !== 0 || scale === 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(a.index);
    setDragging(true);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const from0 = a.from;
    const to0 = a.to;
    const coalesceKey = `annotation:${a.index}:drag`;
    const move = (ev: PointerEvent) => {
      const ddx = (ev.clientX - x0) / scale;
      const ddy = (ev.clientY - y0) / scale;
      if (part === "line") {
        const from = {
          x: clamp(Math.round(from0.x + ddx), 0, width),
          y: clamp(Math.round(from0.y + ddy), 0, height),
        };
        const to = {
          x: clamp(Math.round(to0.x + ddx), 0, width),
          y: clamp(Math.round(to0.y + ddy), 0, height),
        };
        if (Math.hypot(to.x - from.x, to.y - from.y) < MIN_DIST) return;
        onChange(a.index, { from, to }, coalesceKey);
      } else if (part === "from") {
        const from = {
          x: clamp(Math.round(from0.x + ddx), 0, width),
          y: clamp(Math.round(from0.y + ddy), 0, height),
        };
        if (Math.hypot(to0.x - from.x, to0.y - from.y) < MIN_DIST) return;
        onChange(a.index, { from }, coalesceKey);
      } else {
        const to = {
          x: clamp(Math.round(to0.x + ddx), 0, width),
          y: clamp(Math.round(to0.y + ddy), 0, height),
        };
        if (Math.hypot(to.x - from0.x, to.y - from0.y) < MIN_DIST) return;
        onChange(a.index, { to }, coalesceKey);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className={`arrowOverlay${dragging ? " dragging" : ""}`} ref={ref}>
      {scale > 0 && (
        <svg>
          {arrows.map((a) => {
            const sel = selection === a.index;
            const from = toScreen(a.from);
            const to = toScreen(a.to);
            // 参考矢尻(装飾。to 側に小三角。線の向きに沿わせる)
            const ang = Math.atan2(to.y - from.y, to.x - from.x);
            const headLen = 10;
            const headWide = 6;
            const bx = to.x - headLen * Math.cos(ang);
            const by = to.y - headLen * Math.sin(ang);
            const p1 = `${bx - headWide * Math.sin(ang)},${by + headWide * Math.cos(ang)}`;
            const p2 = `${bx + headWide * Math.sin(ang)},${by - headWide * Math.cos(ang)}`;
            return (
              <g key={a.index}>
                <line
                  className="arrowLine"
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  onPointerDown={(e) => onDown(e, a, "line")}
                />
                <polygon
                  className="arrowHead"
                  points={`${to.x},${to.y} ${p1} ${p2}`}
                  style={{ pointerEvents: "none" }}
                />
                {sel && (
                  <>
                    <circle
                      className="arrowHandle"
                      cx={from.x}
                      cy={from.y}
                      r={7}
                      onPointerDown={(e) => onDown(e, a, "from")}
                    />
                    <circle
                      className="arrowHandle"
                      cx={to.x}
                      cy={to.y}
                      r={7}
                      onPointerDown={(e) => onDown(e, a, "to")}
                    />
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
};
