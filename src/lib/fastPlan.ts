// lib/fastPlan.ts — render 高速パスの適格性プランナー(純関数)。
// RenderProps を frame-integer の FAST/SLOW スパン列へ分類する。FAST =
// ベース映像+静的テロップ PNG だけで合成できる区間、SLOW = Remotion を
// 通す必要がある区間(§4 適格表)。P1 はこのプランナーとその出力の型だけを
// 定義する(CLI・render.ts への配線は P3)。
import type { RenderProps } from "../../remotion/props.ts";

/** frame-integer・半開区間 [fromFrame, toFrame) の分類済みスパン */
export interface FastSpan {
  kind: "fast" | "slow";
  /** inclusive */
  fromFrame: number;
  /** exclusive (> fromFrame) */
  toFrame: number;
}

export interface FastPlan {
  eligible: boolean;
  wholeFallback: string[];
  audioFastEligible: boolean;
  audioFallback: string[];
  spans: FastSpan[];
  coverageRatio: number;
  totalFrames: number;
  fps: number;
}

/** これより短い FAST の隙間は SLOW へ吸収する(Remotion 起動コストが
 * ペイしない短い FAST 区間を作らないため) */
export const MIN_FAST_SPAN_SEC = 3;

interface SecInterval {
  start: number;
  end: number;
}

interface FrameInterval {
  fromFrame: number;
  toFrame: number;
}

/** 音声の高速パス適格性(常に計算する。動画側の eligible とは独立)。
 * BGM・音声付き素材・挿入クリップのいずれかがあれば音声は SLOW(Remotion)
 * 経由が必要 */
function audioGate(props: RenderProps): { audioFastEligible: boolean; audioFallback: string[] } {
  const reasons: string[] = [];
  if (props.bgm.length > 0) reasons.push(`BGM ${props.bgm.length} 区間`);
  const audibleMat = props.overlays.filter((o) => (o.volume ?? 0) > 0);
  if (audibleMat.length > 0) reasons.push(`素材音声 ${audibleMat.length} 件`);
  const ins = props.inserts ?? [];
  if (ins.length > 0) reasons.push(`挿入 ${ins.length} 件`);
  return { audioFastEligible: reasons.length === 0, audioFallback: reasons };
}

/** 秒区間を frame-integer の半開区間へ、外側へ広げて変換する
 * (start は切り下げ、end は切り上げ)。totalFrames にクランプし、
 * 0 長になるものは捨てる */
function toFrameInterval(iv: SecInterval, fps: number, totalFrames: number): FrameInterval | null {
  const fromFrame = Math.max(0, Math.floor(iv.start * fps));
  const toFrame = Math.min(totalFrames, Math.ceil(iv.end * fps));
  if (toFrame <= fromFrame) return null;
  return { fromFrame, toFrame };
}

/** 昇順に並んでいない/重なる区間をマージする(隣接=next.from <= cur.to も結合) */
function mergeFrameIntervals(intervals: FrameInterval[]): FrameInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.fromFrame - b.fromFrame);
  const out: FrameInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.fromFrame <= last.toFrame) {
      last.toFrame = Math.max(last.toFrame, cur.toFrame);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export function fastPlan(props: RenderProps): FastPlan {
  const fps = props.fps;
  const totalFrames = Math.max(1, Math.round(props.durationSec * fps));

  // ---- 全編ビデオフォールバック(inserts / colorFilter) ----
  const wholeFallback: string[] = [];
  if ((props.inserts?.length ?? 0) > 0) wholeFallback.push("inserts");
  if (props.colorFilter) wholeFallback.push("colorFilter");
  if (wholeFallback.length > 0) {
    return {
      eligible: false,
      wholeFallback,
      ...audioGate(props),
      spans: [{ kind: "slow", fromFrame: 0, toFrame: totalFrames }],
      coverageRatio: 0,
      totalFrames,
      fps,
    };
  }

  // ---- SLOW 区間の収集(秒) ----
  const slowSec: SecInterval[] = [];
  for (const z of props.zooms ?? []) slowSec.push({ start: z.start, end: z.end });
  for (const w of props.wipeFull) slowSec.push({ start: w.start, end: w.end });
  for (const o of props.overlays) slowSec.push({ start: o.start, end: o.end });
  for (const b of props.blurs ?? []) slowSec.push({ start: b.start, end: b.end });
  for (const a of props.annotations ?? []) slowSec.push({ start: a.start, end: a.end });
  for (const c of props.captions) {
    if (c.style?.anim) slowSec.push({ start: c.start, end: c.end });
    if (c.style?.karaoke) slowSec.push({ start: c.start, end: c.end });
  }
  // 静的テロップ(anim も karaoke も無い)と hideCaption は何も追加しない
  // (FAST のまま)。
  if (props.cutTransition) {
    const half = props.cutTransition.sec / 2;
    for (const tb of props.cutBoundarySecs ?? []) {
      slowSec.push({ start: tb - half, end: tb + half });
    }
  }

  // ---- frame-integer へ変換・マージ ----
  const rawFrameIntervals = slowSec
    .map((iv) => toFrameInterval(iv, fps, totalFrames))
    .filter((iv): iv is FrameInterval => iv !== null);
  let slowFrames = mergeFrameIntervals(rawFrameIntervals);

  // ---- min-FAST-span 吸収 ----
  // slowSec が空(=SLOW 区間なし)のときは全編1本の FAST スパンのまま
  // (吸収するものが無い)。
  if (slowFrames.length > 0) {
    const MIN_FAST_FRAMES = Math.round(MIN_FAST_SPAN_SEC * fps);
    const absorbed: FrameInterval[] = [...slowFrames];
    // 先頭 FAST gap(0 〜 最初の SLOW)
    if (absorbed[0].fromFrame > 0 && absorbed[0].fromFrame < MIN_FAST_FRAMES) {
      absorbed[0] = { fromFrame: 0, toFrame: absorbed[0].toFrame };
    }
    // SLOW 同士の間の FAST gap
    for (let i = 1; i < absorbed.length; i++) {
      const gap = absorbed[i].fromFrame - absorbed[i - 1].toFrame;
      if (gap > 0 && gap < MIN_FAST_FRAMES) {
        absorbed[i] = { fromFrame: absorbed[i - 1].toFrame, toFrame: absorbed[i].toFrame };
      }
    }
    // 末尾 FAST gap(最後の SLOW 〜 totalFrames)
    const lastIdx = absorbed.length - 1;
    const tailGap = totalFrames - absorbed[lastIdx].toFrame;
    if (tailGap > 0 && tailGap < MIN_FAST_FRAMES) {
      absorbed[lastIdx] = { fromFrame: absorbed[lastIdx].fromFrame, toFrame: totalFrames };
    }
    slowFrames = mergeFrameIntervals(absorbed);
  }

  // ---- 連続する交互スパン列を [0, totalFrames) 全体に対して出力 ----
  const spans: FastSpan[] = [];
  let cursor = 0;
  for (const s of slowFrames) {
    if (s.fromFrame > cursor) {
      spans.push({ kind: "fast", fromFrame: cursor, toFrame: s.fromFrame });
    }
    spans.push({ kind: "slow", fromFrame: s.fromFrame, toFrame: s.toFrame });
    cursor = s.toFrame;
  }
  if (cursor < totalFrames) {
    spans.push({ kind: "fast", fromFrame: cursor, toFrame: totalFrames });
  }
  if (spans.length === 0) {
    spans.push({ kind: "fast", fromFrame: 0, toFrame: totalFrames });
  }

  const fastFrames = spans
    .filter((s) => s.kind === "fast")
    .reduce((sum, s) => sum + (s.toFrame - s.fromFrame), 0);
  const coverageRatio = fastFrames / totalFrames;

  return {
    eligible: true,
    wholeFallback,
    ...audioGate(props),
    spans,
    coverageRatio,
    totalFrames,
    fps,
  };
}
