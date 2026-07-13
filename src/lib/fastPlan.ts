// lib/fastPlan.ts — render 高速パスの適格性プランナー(純関数)。
// RenderProps を frame-integer の FAST/SLOW スパン列へ分類する。FAST =
// ベース映像+静的テロップ PNG+適格な静止画 overlay だけで合成できる区間、
// SLOW = Remotion を通す必要がある区間(§4 適格表)。
//
// P5-1(静止画 overlay の FAST 化): 従来は props.overlays を無条件に SLOW へ
// 送っていたが、静止画(画像ファイル)・keyframes 無し・音声無し・フェード
// 窓が重ならないものは FAST 化できる(overlayFastReason)。適格 overlay が
// SLOW 境界をまたぐ場合だけ、その overlay 区間ごと SLOW へ降格する(fade の
// frame 写像=ffmpeg fade フィルタの start_frame>=0 前提を壊さないため)。
// min-FAST-span 吸収が新たなまたぎを生みうるので不動点反復で解く(§3.3)。
import { compositionDurationInFrames } from "./renderFrameMath.ts";
import { overlayFastReason, overlaySeqRange } from "./overlayFade.ts";
import { countFastPngInputs } from "./fastSegment.ts";
import { DEFAULT_LAYER_ORDER, ovId } from "../types.ts";
import type { OverlayItem, RenderProps } from "../../remotion/props.ts";

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
  audioMode: "copy" | "bgm-mix";
  audioFastEligible: boolean;
  audioFallback: string[];
  spans: FastSpan[];
  coverageRatio: number;
  totalFrames: number;
  fps: number;
  /** 降格・分割などの診断メモ(発動可否には影響しない。空配列可) */
  notes: string[];
}

/** これより短い FAST の隙間は SLOW へ吸収する(Remotion 起動コストが
 * ペイしない短い FAST 区間を作らないため) */
export const MIN_FAST_SPAN_SEC = 3;

/** 1 FAST セグメントに渡す PNG 入力の上限(畳み込み後)。simple 入力は
 * デコード後 RGBA 1フレーム(1920x1080 で約 8.3MB)を ffmpeg が抱え、
 * alpha 入力(fade あり/opacity<1)は overlay 自身の尺ぶんの短いループ
 * (補遺1 の「必要窓だけループ」)なのでさらに軽い。120 本で概ね 1GB 前後が
 * 目安。超える FAST スパンは安全な境界で複数の FAST セグメントへ分割する
 * (splitOversizedFastSpans)。 */
export const MAX_FAST_PNG_INPUTS = 120;

/** 不動点反復の上限(理論上は「適格 overlay 数 + 1」で必ず収束する。
 * 超えたら全編フォールバック=バグの安全弁) */
export const FIXPOINT_MAX_ITER_MARGIN = 2;

interface SecInterval {
  start: number;
  end: number;
}

interface FrameInterval {
  fromFrame: number;
  toFrame: number;
}

/** 音声の高速パス適格性と生成方式(常に計算する。動画側の eligible とは独立)。
 * 音声付き素材・挿入クリップは音声を Remotion 経由にする必要がある。 */
function audioGate(props: RenderProps): {
  audioMode: "copy" | "bgm-mix";
  audioFastEligible: boolean;
  audioFallback: string[];
} {
  const reasons: string[] = [];
  const audibleMat = props.overlays.filter((o) => (o.volume ?? 0) > 0);
  if (audibleMat.length > 0) reasons.push(`素材音声 ${audibleMat.length} 件`);
  const ins = props.inserts ?? [];
  if (ins.length > 0) reasons.push(`挿入 ${ins.length} 件`);
  return {
    audioMode: props.bgm.length > 0 ? "bgm-mix" : "copy",
    audioFastEligible: reasons.length === 0,
    audioFallback: reasons,
  };
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

/** min-FAST-span(3秒)未満の FAST 隙間を隣接 SLOW へ吸収する。
 * slowFrames が空(SLOW 区間なし)なら何もしない */
function absorbMinFastGaps(slowFrames: FrameInterval[], totalFrames: number, fps: number): FrameInterval[] {
  if (slowFrames.length === 0) return slowFrames;
  const MIN_FAST_FRAMES = Math.round(MIN_FAST_SPAN_SEC * fps);
  const absorbed: FrameInterval[] = [...slowFrames];
  if (absorbed[0].fromFrame > 0 && absorbed[0].fromFrame < MIN_FAST_FRAMES) {
    absorbed[0] = { fromFrame: 0, toFrame: absorbed[0].toFrame };
  }
  for (let i = 1; i < absorbed.length; i++) {
    const gap = absorbed[i].fromFrame - absorbed[i - 1].toFrame;
    if (gap > 0 && gap < MIN_FAST_FRAMES) {
      absorbed[i] = { fromFrame: absorbed[i - 1].toFrame, toFrame: absorbed[i].toFrame };
    }
  }
  const lastIdx = absorbed.length - 1;
  const tailGap = totalFrames - absorbed[lastIdx].toFrame;
  if (tailGap > 0 && tailGap < MIN_FAST_FRAMES) {
    absorbed[lastIdx] = { fromFrame: absorbed[lastIdx].fromFrame, toFrame: totalFrames };
  }
  return mergeFrameIntervals(absorbed);
}

/** [a,b) が slow のいずれかの区間と交差するか(半開区間) */
function intersects(r: FrameInterval, slow: FrameInterval[]): boolean {
  return slow.some((s) => r.fromFrame < s.toFrame && s.fromFrame < r.toFrame);
}

/** r が slow の単一区間に完全に収まるか(slow はマージ済み前提) */
function containedIn(r: FrameInterval, slow: FrameInterval[]): boolean {
  return slow.some((s) => s.fromFrame <= r.fromFrame && r.toFrame <= s.toFrame);
}

/** span 内で有効な(layerOrder に載っている)適格 overlay の frame 区間一覧。
 * splitOversizedFastSpans の安全な分割境界の計算に使う */
function eligibleOverlayRangesInSpan(props: RenderProps, span: FrameInterval): FrameInterval[] {
  const fps = props.fps;
  const order = props.layerOrder ?? DEFAULT_LAYER_ORDER;
  const out: FrameInterval[] = [];
  for (const o of props.overlays) {
    if (!order.includes(ovId(o.track))) continue;
    if (overlayFastReason(o, fps) !== null) continue;
    const r = overlaySeqRange(o, fps);
    if (r.toFrame <= span.fromFrame || r.fromFrame >= span.toFrame) continue;
    out.push({ fromFrame: r.fromFrame, toFrame: r.toFrame });
  }
  return out;
}

/** 1つの巨大すぎる FAST スパンを、適格 overlay の内部を切らない安全な境界
 * (caption の from/to ∪ 適格 overlay の from/to)で貪欲に分割する。
 * どの候補でも上限を満たせなければスパン丸ごと SLOW へ落とす */
function splitFastSpan(props: RenderProps, span: FastSpan, notes: string[]): FastSpan[] {
  const fps = props.fps;
  const overlayRanges = eligibleOverlayRangesInSpan(props, span);

  const candidateSet = new Set<number>();
  for (const c of props.captions) {
    const f0 = Math.round(c.start * fps);
    const f1 = Math.round(c.end * fps);
    if (f0 > span.fromFrame && f0 < span.toFrame) candidateSet.add(f0);
    if (f1 > span.fromFrame && f1 < span.toFrame) candidateSet.add(f1);
  }
  for (const r of overlayRanges) {
    if (r.fromFrame > span.fromFrame && r.fromFrame < span.toFrame) candidateSet.add(r.fromFrame);
    if (r.toFrame > span.fromFrame && r.toFrame < span.toFrame) candidateSet.add(r.toFrame);
  }
  const safe = [...candidateSet]
    .filter((f) => overlayRanges.every((r) => !(r.fromFrame < f && f < r.toFrame)))
    .sort((a, b) => a - b);

  const result: FastSpan[] = [];
  let cur = span.fromFrame;
  for (;;) {
    const remaining = countFastPngInputs(props, { kind: "fast", fromFrame: cur, toFrame: span.toFrame });
    if (remaining <= MAX_FAST_PNG_INPUTS) {
      result.push({ kind: "fast", fromFrame: cur, toFrame: span.toFrame });
      break;
    }
    let best: number | null = null;
    for (const c of safe) {
      if (c <= cur) continue;
      const cnt = countFastPngInputs(props, { kind: "fast", fromFrame: cur, toFrame: c });
      if (cnt <= MAX_FAST_PNG_INPUTS) best = c;
      else break; // 入力数は c の増加に対して単調非減少
    }
    if (best === null) {
      notes.push(`FAST スパン[${span.fromFrame},${span.toFrame}) の PNG 入力が上限超過のため SLOW へ`);
      return [{ kind: "slow", fromFrame: span.fromFrame, toFrame: span.toFrame }];
    }
    result.push({ kind: "fast", fromFrame: cur, toFrame: best });
    cur = best;
  }
  return result;
}

function splitOversizedFastSpans(props: RenderProps, spans: FastSpan[], notes: string[]): FastSpan[] {
  const out: FastSpan[] = [];
  for (const s of spans) {
    if (s.kind !== "fast") {
      out.push(s);
      continue;
    }
    const count = countFastPngInputs(props, s);
    if (count <= MAX_FAST_PNG_INPUTS) {
      out.push(s);
      continue;
    }
    out.push(...splitFastSpan(props, s, notes));
  }
  return out;
}

export function fastPlan(props: RenderProps): FastPlan {
  const fps = props.fps;
  const totalFrames = compositionDurationInFrames(props.durationSec, fps);
  const notes: string[] = [];

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
      notes,
    };
  }

  // ---- SLOW 区間の収集(秒。不適格 overlay だけ含む) ----
  const slowSec: SecInterval[] = [];
  for (const z of props.zooms ?? []) slowSec.push({ start: z.start, end: z.end });
  for (const w of props.wipeFull) slowSec.push({ start: w.start, end: w.end });
  const order = props.layerOrder ?? DEFAULT_LAYER_ORDER;
  const eligibleOv: OverlayItem[] = [];
  for (const o of props.overlays) {
    const reason = order.includes(ovId(o.track)) ? overlayFastReason(o, fps) : "layerOrder 外";
    if (reason === null) eligibleOv.push(o);
    else slowSec.push({ start: o.start, end: o.end }); // 不適格 overlay だけ SLOW
  }
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

  const baseSlow = mergeFrameIntervals(
    slowSec.map((iv) => toFrameInterval(iv, fps, totalFrames)).filter((iv): iv is FrameInterval => iv !== null),
  );

  const eligibleRanges: FrameInterval[] = eligibleOv.map((o) => {
    const r = overlaySeqRange(o, fps);
    return { fromFrame: r.fromFrame, toFrame: Math.min(totalFrames, r.toFrame) };
  });

  // ---- 不動点反復(吸収 ⇄ またぎ降格) ----
  const demoted = new Set<number>();
  const maxIter = eligibleOv.length + FIXPOINT_MAX_ITER_MARGIN;
  let slowFrames: FrameInterval[] = absorbMinFastGaps(mergeFrameIntervals(baseSlow), totalFrames, fps);
  let converged = false;
  for (let iter = 0; iter < maxIter; iter++) {
    const newly: number[] = [];
    eligibleRanges.forEach((r, i) => {
      if (demoted.has(i)) return;
      if (intersects(r, slowFrames) && !containedIn(r, slowFrames)) newly.push(i);
    });
    if (newly.length === 0) {
      converged = true;
      break;
    }
    for (const i of newly) demoted.add(i);
    const demotedIntervals = [...demoted].map((i) => eligibleRanges[i]);
    slowFrames = absorbMinFastGaps(mergeFrameIntervals([...baseSlow, ...demotedIntervals]), totalFrames, fps);
  }
  if (!converged) {
    return {
      eligible: false,
      wholeFallback: ["fastPlan 不動点非収束"],
      ...audioGate(props),
      spans: [{ kind: "slow", fromFrame: 0, toFrame: totalFrames }],
      coverageRatio: 0,
      totalFrames,
      fps,
      notes: ["fastPlan 不動点非収束(バグの可能性)"],
    };
  }
  for (const i of demoted) {
    notes.push(`overlay#${i}(${eligibleOv[i].file})が SLOW 境界をまたぐため SLOW へ降格`);
  }

  // ---- 連続する交互スパン列を [0, totalFrames) 全体に対して出力 ----
  let spans: FastSpan[] = [];
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

  // ---- 入力数ガード: 巨大すぎる FAST スパンを安全な境界で分割する ----
  spans = splitOversizedFastSpans(props, spans, notes);

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
    notes,
  };
}
