import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
} from "../../src/types.ts";
import type { CaptionPos } from "../../src/types.ts";
import { captionBoxOffset } from "./model.ts";

/** プレビューに表示中のテロップ1つ分(座標はコンポジションのpx)。
 * pos は実効表示位置(個別指定 → トラック標準 → 下部中央のフォールバック)で、
 * anchor がその解釈(center=テキスト中心 / topLeft=テキストボックスの左上)を
 * 決める。どちらも実描画(src/engine/refPainter.ts drawCaption)と同じ規約で、
 * 座布団(background)の張り出しは pos ではなく padXPx/padYPx が表す */
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
  /** 縁取り/座布団の左右の張り出し(コンポジションpx)。枠をテキスト芯では
   * なく可視字幕まで広げるための padding。省略時 0 */
  padXPx?: number;
  /** 縁取り/座布団の上下の張り出し(コンポジションpx)。省略時 0 */
  padYPx?: number;
}

/**
 * プレビューの上に重ねる透明レイヤー。表示中のテロップと
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
  onEditingChange,
  storeFile,
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
  /** Player 側の字幕を編集中の下書きへ差し替えるための状態通知 */
  onEditingChange?: (index: number | null, text?: string) => void;
  /** ツールチップに出す保存先ファイル名。省略時 "transcript.json"(テロップ) */
  storeFile?: string;
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
  const store = storeFile ?? "transcript.json";

  const startEdit = (c: OverlayCaption) => {
    if (!onCommitText) return;
    onEditStart?.();
    onSelect(c.index);
    setDragging(false);
    setDraft(c.text);
    setEditing(c.index);
    onEditingChange?.(c.index, c.text);
  };
  const commitEdit = () => {
    if (editing !== null) onCommitText?.(editing, draft);
    setEditing(null);
    onEditingChange?.(null);
  };
  const cancelEdit = () => {
    setEditing(null);
    onEditingChange?.(null);
  };

  const onDown = (e: ReactPointerEvent, c: OverlayCaption) => {
    if (e.button !== 0 || scale === 0 || editing === c.index) return;
    dragCleanupRef.current?.(); // 直前のドラッグが残っていれば先に畳む(単一ドラッグ前提)
    e.preventDefault();
    e.stopPropagation();
    onSelect(c.index);
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
    // ドラッグ開始の閾値(画面px)。これを越えて初めて「移動」とみなす。
    // ダブルクリック中の微小な指の揺れで onMove が発火し、意図せず pos が
    // transcript.json に書き込まれる(位置がずれる)のを防ぐ
    const DRAG_THRESHOLD_PX = 3;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return;
        started = true;
        setDragging(true);
      }
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
          const padX = (c.padXPx ?? 0) * scale;
          const padY = (c.padYPx ?? 0) * scale;
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
            textAlign: (c.anchor === "topLeft" ? "left" : "center") as "left" | "center",
          };
          // center は padding 込みの中心、topLeft はテキスト左上が pos。
          // 通常枠と編集欄で必ず同じ補正を使い、編集切替時のジャンプを防ぐ。
          const off = captionBoxOffset(c.anchor, padX, padY);
          if (editing === c.index) {
            return (
              <textarea
                key={c.index}
                className="capBox editing sel"
                autoFocus
                value={draft}
                // Shift+Enter は下の onKeyDown で素通しし textarea 既定の改行になる。
                // 手動改行はそのまま複数行テロップとして描画される
                title="Shift+Enter で改行 / Enter で確定 / Esc で取消"
                style={{
                  ...common,
                  left: common.left + off.dx,
                  top: common.top + off.dy,
                  whiteSpace: "pre-line",
                  paddingLeft: padX,
                  paddingRight: padX,
                  paddingTop: padY,
                  paddingBottom: padY,
                }}
                // 編集中はドラッグ・グローバルショートカットを止める
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  setDraft(e.target.value);
                  onEditingChange?.(c.index, e.target.value);
                }}
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
          // 枠の左上を pos からずらす量(コンポジションpx→画面px は上で scale 済み)。
          // center は padding が対称なので不変、topLeft は pos が「テキストボックスの
          // 左上」で座布団はその外側へはみ出す=padding ぶん左上へ広げる
          return (
            <div
              key={c.index}
              className={`capBox${selection === c.index ? " sel" : ""}`}
              style={{
                ...common,
                left: common.left + off.dx,
                top: common.top + off.dy,
                whiteSpace: "pre-line",
                width: "max-content",
                // 縁取り/座布団の張り出しぶん枠を広げ、可視字幕を囲う
                boxSizing: "content-box",
                paddingLeft: padX,
                paddingRight: padX,
                paddingTop: padY,
                paddingBottom: padY,
              }}
              title={
                onCommitText
                  ? `ドラッグで移動 / ダブルクリックで文言を編集(${store} に保存)`
                  : `ドラッグで移動(位置は ${store} の pos に保存)`
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
