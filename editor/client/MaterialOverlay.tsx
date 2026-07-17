import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Region } from "../../src/types.ts";

/** プレビューに表示中の素材(部分配置=rect あり)1つ分。座標はコンポジションのpx */
export interface OverlayRect {
  /** overlays.overlays の添字 */
  index: number;
  rect: Region;
}

/** リサイズハンドルの位置(8方向)。文字は縦横のどの辺を掴んでいるかを表す */
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** 素材ボックスの最小サイズ(コンポジションpx)。小さすぎて掴めなくならないよう */
const MIN_RECT = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * プレビュー(@remotion/player)の上に重ねる透明レイヤー。表示中の「部分配置」
 * 素材と同じ位置・寸法の掴めるボックスを出し、PowerPoint の図のように本体
 * ドラッグで移動・端(8ハンドル)ドラッグでリサイズできるようにする。座標変換
 * (コンポジション⇔画面)だけを持ち、ドキュメントの更新は onRectChange
 * (コンポジションpx の rect)に委ねる。全画面(rect なし)の素材はここには
 * 出ない(インスペクタのプリセットで rect を作ってから微調整する)。
 */
export const MaterialOverlay = ({
  width,
  height,
  overlays,
  selection,
  onSelect,
  onRectChange,
}: {
  /** コンポジションの解像度 */
  width: number;
  height: number;
  overlays: OverlayRect[];
  /** 選択中の素材(overlays.overlays の添字) */
  selection: number | null;
  onSelect: (index: number) => void;
  onRectChange: (index: number, rect: Region) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  // ドラッグ中の一時的な rect(pointerup で 1 回だけ onRectChange に確定させる。
  // move の間はこれだけを更新し、ドキュメント(overlays.json)には触れない)
  const [draft, setDraft] = useState<{ index: number; rect: Region } | null>(null);
  // アクティブなドラッグの listener 解除処理(アンマウント時のクリーンアップと
  // onDown の直前ドラッグ畳みから使う)
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setBox({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // アンマウント時に進行中ドラッグの window リスナを確実に外す
  // (mid-drag でツリーが外れても listener が孤児化して stale commit しないように)
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Player は親いっぱいに広がり、コンポジションはレターボックスで内接する
  const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / width, box.h / height) : 0;
  const dx = (box.w - width * scale) / 2;
  const dy = (box.h - height * scale) / 2;

  /** 掴んだ時点の rect に、画面移動量(Δcomp)を反映して新しい rect を作る。
   *  handle=null は本体ドラッグ(移動)、それ以外は対応する辺のリサイズ */
  const applyDrag = (
    r0: Region,
    handle: HandleId | null,
    ddx: number,
    ddy: number,
  ): Region => {
    if (handle === null) {
      // 移動。可動域は [0, フレーム-素材] を基本に、素材がフレームより
      // 大きい cover 配置(端が画面外)ではパン、元位置が画面外のときは
      // それを含むよう広げる(掴んだだけ=Δ0 では動かさない)。
      const xlo = Math.min(0, width - r0.w, r0.x);
      const xhi = Math.max(0, width - r0.w, r0.x);
      const ylo = Math.min(0, height - r0.h, r0.y);
      const yhi = Math.max(0, height - r0.h, r0.y);
      return {
        x: Math.round(clamp(r0.x + ddx, xlo, xhi)),
        y: Math.round(clamp(r0.y + ddy, ylo, yhi)),
        w: r0.w,
        h: r0.h,
      };
    }
    // リサイズ: 掴んだ辺の反対側を固定して、辺を動かす。可動域はフレーム内が
    // 基本だが、元の辺が画面外(cover 配置)ならそこまで含める(掴んだだけでは
    // 動かさない・その辺を外へも内へも伸ばせる)
    let { x, y, w, h } = r0;
    if (handle.includes("w")) {
      const right = r0.x + r0.w; // 右辺を固定
      x = clamp(r0.x + ddx, Math.min(0, r0.x), right - MIN_RECT);
      w = right - x;
    } else if (handle.includes("e")) {
      const right = clamp(r0.x + r0.w + ddx, r0.x + MIN_RECT, Math.max(width, r0.x + r0.w));
      w = right - r0.x;
    }
    if (handle.includes("n")) {
      const bottom = r0.y + r0.h; // 下辺を固定
      y = clamp(r0.y + ddy, Math.min(0, r0.y), bottom - MIN_RECT);
      h = bottom - y;
    } else if (handle.includes("s")) {
      const bottom = clamp(r0.y + r0.h + ddy, r0.y + MIN_RECT, Math.max(height, r0.y + r0.h));
      h = bottom - r0.y;
    }
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  };

  const onDown = (
    e: ReactPointerEvent,
    ov: OverlayRect,
    handle: HandleId | null,
  ) => {
    if (e.button !== 0 || scale === 0) return;
    dragCleanupRef.current?.(); // 直前のドラッグが残っていれば先に畳む(単一ドラッグ前提)
    e.preventDefault();
    e.stopPropagation();
    onSelect(ov.index);
    setDragging(true);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = ov.rect;
    // move ごとの最新候補をローカル変数にも持つ(pointerup の commit は React
    // state の draft ではなくこちらを読む=直近の setDraft がまだコミットされて
    // いなくても最新値を確実に読める)
    let current: { index: number; rect: Region } | null = null;
    const move = (ev: PointerEvent) => {
      current = {
        index: ov.index,
        rect: applyDrag(r0, handle, (ev.clientX - x0) / scale, (ev.clientY - y0) / scale),
      };
      setDraft(current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanupRef.current = null;
    };
    const up = () => {
      cleanup();
      if (current !== null) onRectChange(current.index, current.rect);
      setDraft(null);
      setDragging(false);
    };
    const cancel = () => {
      cleanup();
      setDraft(null);
      setDragging(false);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  return (
    <div className={`matOverlay${dragging ? " dragging" : ""}`} ref={ref}>
      {scale > 0 &&
        overlays.map((ov) => {
          const sel = selection === ov.index;
          // ドラッグ中の対象だけ draft(一時値)を使う。他は props(確定値)のまま
          const r = draft?.index === ov.index ? draft.rect : ov.rect;
          return (
            <div
              key={ov.index}
              className={`matBox${sel ? " sel" : ""}`}
              style={{
                left: dx + r.x * scale,
                top: dy + r.y * scale,
                width: r.w * scale,
                height: r.h * scale,
              }}
              title="ドラッグで移動・端をドラッグでリサイズ(overlays.json の rect に保存)"
              onPointerDown={(e) => onDown(e, ov, null)}
            >
              {/* リサイズハンドルは選択中の素材だけに出す(複数枠のときの雑音を抑える) */}
              {sel &&
                HANDLES.map((h) => (
                  <div
                    key={h}
                    className={`matHandle ${h}`}
                    onPointerDown={(e) => onDown(e, ov, h)}
                  />
                ))}
            </div>
          );
        })}
    </div>
  );
};
