import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
} from "../../src/types.ts";
import type { CaptionPos } from "../../src/types.ts";

/** プレビューに表示中のテロップ1つ分(座標はコンポジションのpx)。
 * pos は実効表示位置(個別指定 → トラック標準 → 下部中央の近似)で、
 * anchor がその解釈(center=テキスト中心 / topLeft=左上)を決める */
export interface OverlayCaption {
  /** transcript.segments の添字 */
  index: number;
  text: string;
  /** 実効表示位置 */
  pos: CaptionPos;
  /** 座標の解釈(トラック標準の anchor。既定 center) */
  anchor: "center" | "topLeft";
  /** 実効フォントサイズ(コンポジションpx)。style 解決済みで渡す */
  fontSizePx: number;
  /** 実効フォント種(style 解決済み)。当たり判定を本編の字幕に合わせる */
  fontFamily?: string;
  /** 実効の太さ(style 解決済み) */
  fontWeight?: number;
}

/**
 * プレビュー(@remotion/player)の上に重ねる透明レイヤー。表示中のテロップと
 * 同じ位置・寸法の掴めるボックスを出し、PowerPoint のテキストのように
 * ドラッグで移動できるようにする。座標変換(コンポジション⇔画面)だけを持ち、
 * ドキュメントの更新は onMove(コンポジションpx)に委ねる。
 */
export const CaptionOverlay = ({
  width,
  height,
  captions,
  selection,
  onSelect,
  onMove,
  onCommitText,
  onEditStart,
}: {
  /** コンポジションの解像度 */
  width: number;
  height: number;
  captions: OverlayCaption[];
  /** 選択中のテロップ(transcript.segments の添字) */
  selection: number | null;
  onSelect: (index: number) => void;
  onMove: (index: number, pos: CaptionPos) => void;
  /** ダブルクリックのインライン編集を確定(transcript.json の text に保存)。
   * 省略時はインライン編集を出さない(移動だけ) */
  onCommitText?: (index: number, text: string) => void;
  /** インライン編集に入る直前(プレビュー再生を止めてボックスを固定するため) */
  onEditStart?: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  // インライン編集中のテロップ添字と下書き(null=非編集)
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // ドラッグ中の一時的な位置(pointerup で 1 回だけ onMove に確定させる。
  // move の間はこれだけを更新する。テキスト編集用の draft/setDraft とは別物
  // (名前衝突を避けるため posDraft と呼ぶ)
  const [posDraft, setPosDraft] = useState<{ index: number; pos: CaptionPos } | null>(
    null,
  );
  // アクティブなドラッグの listener 解除処理(外部変更ガードから使う)
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

  // 外部変更ガード: ドラッグ中に captions(props)の参照が変わったら(undo /
  // hot-reload / 外部編集などドラッグ外の要因でしか起きない)ドラッグを強制
  // キャンセルする(listener 除去 + posDraft 破棄。stale な posDraft を残さない)
  useEffect(() => {
    if (dragCleanupRef.current) {
      dragCleanupRef.current();
      dragCleanupRef.current = null;
      setPosDraft(null);
      setDragging(false);
    }
  }, [captions]);

  // Player は親いっぱいに広がり、コンポジションはレターボックスで内接する
  const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / width, box.h / height) : 0;
  const dx = (box.w - width * scale) / 2;
  const dy = (box.h - height * scale) / 2;

  const startEdit = (c: OverlayCaption) => {
    if (!onCommitText) return;
    onEditStart?.();
    onSelect(c.index);
    setDragging(false);
    setDraft(c.text);
    setEditing(c.index);
  };
  const commitEdit = () => {
    if (editing !== null) onCommitText?.(editing, draft);
    setEditing(null);
  };
  const cancelEdit = () => setEditing(null);

  const onDown = (e: ReactPointerEvent, c: OverlayCaption) => {
    if (e.button !== 0 || scale === 0 || editing === c.index) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(c.index);
    setDragging(true);
    const x0 = e.clientX;
    const y0 = e.clientY;
    // ドラッグは掴んだ時点の実効位置に Δ を足すだけ(anchor は変えないので
    // 中心基準・左上基準どちらのトラックでも同じ計算でよい)
    const p0 = c.pos;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    // move ごとの最新候補をローカル変数にも持つ(pointerup の commit は React
    // state ではなくこちらを読む=直近の setPosDraft がまだコミットされて
    // いなくても最新値を確実に読める)
    let current: { index: number; pos: CaptionPos } | null = null;
    const move = (ev: PointerEvent) => {
      current = {
        index: c.index,
        pos: {
          x: clamp(Math.round(p0.x + (ev.clientX - x0) / scale), 0, width),
          y: clamp(Math.round(p0.y + (ev.clientY - y0) / scale), 0, height),
        },
      };
      setPosDraft(current);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanupRef.current = null;
    };
    const up = () => {
      cleanup();
      if (current !== null) onMove(current.index, current.pos);
      setPosDraft(null);
      setDragging(false);
    };
    const cancel = () => {
      cleanup();
      setPosDraft(null);
      setDragging(false);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  return (
    <div className={`capOverlay${dragging ? " dragging" : ""}`} ref={ref}>
      {scale > 0 &&
        captions.map((c) => {
          // ドラッグ中の対象だけ posDraft(一時値)を使う。他は props(確定値)のまま
          const pos = posDraft?.index === c.index ? posDraft.pos : c.pos;
          const common = {
            left: dx + pos.x * scale,
            top: dy + pos.y * scale,
            // CSS(.capBox)は中心基準の translate を持つので左上基準では外す
            ...(c.anchor === "topLeft" ? { transform: "none" } : {}),
            // 本編の字幕(OutlinedText)と同じフォント計量で当たり判定を合わせる
            fontFamily: c.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
            fontSize: c.fontSizePx * scale,
            fontWeight: c.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
            lineHeight: 1.4,
          };
          if (editing === c.index) {
            return (
              <textarea
                key={c.index}
                className="capBox editing sel"
                autoFocus
                value={draft}
                style={{ ...common, whiteSpace: "pre-line" }}
                // 編集中はドラッグ・グローバルショートカットを止める
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
            );
          }
          return (
            <div
              key={c.index}
              className={`capBox${selection === c.index ? " sel" : ""}`}
              style={{
                ...common,
                whiteSpace: "pre-line",
                width: "max-content",
              }}
              title={
                onCommitText
                  ? "ドラッグで移動 / ダブルクリックで文言を編集(transcript.json に保存)"
                  : "ドラッグでテロップを移動(位置は transcript.json の pos に保存)"
              }
              onPointerDown={(e) => onDown(e, c)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                startEdit(c);
              }}
            >
              {c.text}
            </div>
          );
        })}
    </div>
  );
};
