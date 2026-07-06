// lib/captionAnim.ts — テロップの登場/退場アニメとカラオケ表示の純関数。
// remotion/Main.tsx(描画)から使う。ブラウザ(エディタのプレビュー相当)にも
// 入りうるため node 依存(node:fs 等)は禁止。
//
// - animStateAt: t(カット後秒)における登場/退場アニメの状態(opacity/transform)。
//   ズームの zoomTransformAt と同じ発想(Sequence の相対フレームではなく
//   グローバル t と caption.start/end から進行度を出す)。
// - alignKaraoke / karaokeActiveAt: caption.text を語 span 列(KaraokePiece[])へ
//   分解し、時刻 t における各ピースの発話済み(active)状態を返す。
import { KARAOKE_DEFAULT_ACTIVE, DEFAULT_CAPTION_ANIM_SEC } from "../types.ts";
import type { CaptionAnim, CaptionAnimKind, CaptionKaraoke } from "../types.ts";

export interface AnimState {
  opacity: number;
  translateX: number;
  translateY: number;
  scale: number;
}

const IDENTITY: AnimState = { opacity: 1, translateX: 0, translateY: 0, scale: 1 };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
/** smoothstep(zoomTransformAt / wipeEase と同じイーズカーブ) */
const smooth = (p: number): number => p * p * (3 - 2 * p);

/** t(カット後秒)における登場/退場アニメの状態。anim 未指定なら恒等
 * (opacity=1・transform 無し)を返す=呼び出し側で「未指定なら器を包まない」
 * 分岐と合わせて 1px 不変を担保する。fontSizePx はスライド量の基準。 */
export function animStateAt(
  anim: CaptionAnim | undefined,
  start: number,
  end: number,
  t: number,
  fontSizePx: number,
): AnimState {
  if (!anim) return IDENTITY;
  const dur = anim.durationSec ?? DEFAULT_CAPTION_ANIM_SEC;
  // in+out が尺を超える短い区間では各遷移を尺の半分へ縮める(fadeFactor と同一規則)
  const half = Math.min(dur, (end - start) / 2);
  const pIn = anim.in && half > 0 ? clamp01((t - start) / half) : 1;
  const pOut = anim.out && half > 0 ? clamp01((end - t) / half) : 1;
  const eIn = smooth(pIn);
  const eOut = smooth(pOut);
  // 登場は eIn を、退場は eOut を使う。両方とも動くのは短区間で重なるときだけで、
  // その場合は「より進んでいない方」を採る(min)= 出入りが喧嘩しない
  const p = Math.min(eIn, eOut);
  const off = fontSizePx * 0.7; // スライド量(フォントサイズ比。M では固定)
  const dir = (kind?: CaptionAnimKind): { x: number; y: number } => {
    switch (kind) {
      case "slide-up":
        return { x: 0, y: off };
      case "slide-down":
        return { x: 0, y: -off };
      case "slide-left":
        return { x: off, y: 0 };
      case "slide-right":
        return { x: -off, y: 0 };
      default:
        return { x: 0, y: 0 };
    }
  };
  // 登場側の未完了分(1-eIn)だけ入りのオフセットを、退場側は出のオフセットを足す
  const din = dir(anim.in);
  const dout = dir(anim.out);
  const translateX = din.x * (1 - eIn) + dout.x * (1 - eOut);
  const translateY = din.y * (1 - eIn) + dout.y * (1 - eOut);
  const popIn = anim.in === "pop";
  const popOut = anim.out === "pop";
  const scale = popIn || popOut ? 0.6 + 0.4 * p : 1;
  // 全種別で opacity も動かす(スライド/ポップも淡く入る)
  const opacity = p;
  return { opacity, translateX, translateY, scale };
}

export interface KaraokePiece {
  text: string;
  /** この文字列に対応する語の時刻(カット後秒)。text 内の gap(句読点・
   * 手編集で語に対応しない文字)は null。null は直前の語の active を引き継ぐ */
  start: number | null;
  end: number | null;
}

/** caption.text を語 span 列へ分解する。連結は必ず text と一致する
 * (gap も含めて全文字を覆う)ので、描画側で色だけ差し替えれば layout 不変。 */
export function alignKaraoke(
  text: string,
  words: { text: string; start: number; end: number }[],
): KaraokePiece[] {
  const pieces: KaraokePiece[] = [];
  let cursor = 0;
  for (const w of words) {
    if (w.text === "") continue;
    const idx = text.indexOf(w.text, cursor);
    if (idx < 0) continue; // 手編集で語が見つからない → 飛ばす(stale words)
    if (idx > cursor) pieces.push({ text: text.slice(cursor, idx), start: null, end: null });
    pieces.push({ text: w.text, start: w.start, end: w.end });
    cursor = idx + w.text.length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), start: null, end: null });
  return pieces;
}

/** ピース i が t 時点で active(発話済み=色替え済み)か。語は t>=start で active に
 * なり以降 active のまま(左→右に進む)。gap は直前の語の active を引き継ぐ。 */
export function karaokeActiveAt(pieces: KaraokePiece[], t: number): boolean[] {
  const out: boolean[] = [];
  let prev = false;
  for (const p of pieces) {
    const active: boolean = p.start === null ? prev : t >= p.start;
    out.push(active);
    prev = active;
  }
  return out;
}

/** "fill" モードで、いま発話中の語ピースの塗り進み割合(0〜1)。
 * 発話中でない(t が [start,end) 外)ときは 0/1 の端に丸まる。
 * gap ピース(start===null)は呼び出し側で対象外にする。 */
export function karaokeFillProgress(start: number, end: number, t: number): number {
  if (end <= start) return 1;
  return clamp01((t - start) / (end - start));
}

/** KaraokePiece からトラック標準の既定値を解決した色を返す小さなヘルパー。
 * inactiveColor 省略時は呼び出し側が渡す本文色(baseColor)を使う。 */
export function karaokeColorOf(
  active: boolean,
  karaoke: CaptionKaraoke | undefined,
  baseColor: string,
): string {
  if (active) return karaoke?.activeColor ?? KARAOKE_DEFAULT_ACTIVE;
  return karaoke?.inactiveColor ?? baseColor;
}
