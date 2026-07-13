// lib/fastBase.ts — ベース映像区間 ⇄ cut.mp4 の frame 写像(純関数)。design-T4.md §1.1。
// Main.tsx の <Sequence from/durationInFrames> + <OffthreadVideo startFrom> と
// **同一式**でなければならないので、丸め規則を二重実装せず frameSpans(renderProps.ts。
// Main.tsx が既に import しているブラウザ安全なモジュール)を再利用する。
import { frameSpans } from "./renderProps.ts";
import { compositionDurationInFrames } from "./renderFrameMath.ts";
import type { RenderProps } from "../../remotion/props.ts";

/** ベース映像 1 区間の frame 表現。[fromFrame, toFrame) は出力フレーム、
 *  videoStartFrame は cut.mp4 の CFR 格子上の開始フレーム
 *  (= Main.tsx の startFromFrames={Math.round(seg.videoStart * fps)}) */
export interface BaseFrameSeg {
  fromFrame: number;
  toFrame: number;
  videoStartFrame: number;
  playbackRate?: number;
}

/** 挿入 1 件の出力 frame 区間(index = props.inserts の添字) */
export interface InsertFrameSeg {
  index: number;
  fromFrame: number;
  toFrame: number;
}

export type BaseLayout =
  | { ok: true; base: BaseFrameSeg[]; inserts: InsertFrameSeg[]; totalFrames: number }
  | { ok: false; reason: string };

/**
 * props から base/insert の frame レイアウトを組み立て、FAST が依存する
 * 不変条件(単調・非重複・[0,totalFrames) を隙間なく被覆・playbackRate 無し)を
 * 検査する。render 経路では baseSegments[].playbackRate は絶対に立たない
 * (videoIsSource 専用。design-T4.md §0)が、保守的に検査だけはしておく。
 */
export function baseLayoutOf(props: RenderProps): BaseLayout {
  const fps = props.fps;
  const totalFrames = compositionDurationInFrames(props.durationSec, fps);
  const baseSegsIn = props.baseSegments ?? [
    { start: 0, videoStart: 0, durationSec: props.durationSec },
  ];
  const insertsIn = props.inserts ?? [];

  for (const seg of baseSegsIn) {
    if (seg.playbackRate !== undefined && seg.playbackRate !== 1) {
      return { ok: false, reason: "playbackRate" };
    }
  }

  const spans = frameSpans({
    baseSegments: baseSegsIn,
    inserts: insertsIn,
    fps,
    durationInFrames: totalFrames,
  });

  const base: BaseFrameSeg[] = baseSegsIn.map((seg, i) => {
    const fs = spans.base[i];
    return {
      fromFrame: fs.from,
      toFrame: fs.from + fs.durationInFrames,
      videoStartFrame: Math.round(seg.videoStart * fps),
      ...(seg.playbackRate !== undefined ? { playbackRate: seg.playbackRate } : {}),
    };
  });
  const inserts: InsertFrameSeg[] = insertsIn.map((_ins, i) => {
    const fs = spans.inserts[i];
    return { index: i, fromFrame: fs.from, toFrame: fs.from + fs.durationInFrames };
  });

  // 不変条件の検査。frameSpans の Math.max(1, …) 退化(0長区間が1frameへ
  // 膨張する)は、ここでの重なり検出で ok:false になる(B5 の安全弁)
  for (const b of base) {
    if (b.toFrame <= b.fromFrame) return { ok: false, reason: "0長のbase区間" };
    if (b.videoStartFrame < 0) return { ok: false, reason: "videoStartFrameが負" };
  }
  for (const ins of inserts) {
    if (ins.toFrame <= ins.fromFrame) return { ok: false, reason: "0長のinsert区間" };
  }

  const all = [
    ...base.map((b) => ({ fromFrame: b.fromFrame, toFrame: b.toFrame })),
    ...inserts.map((i) => ({ fromFrame: i.fromFrame, toFrame: i.toFrame })),
  ].sort((a, b) => a.fromFrame - b.fromFrame);
  let cursor = 0;
  for (const seg of all) {
    if (seg.fromFrame !== cursor) {
      return { ok: false, reason: `frameレイアウトに穴/重なり(cursor=${cursor}, from=${seg.fromFrame})` };
    }
    cursor = seg.toFrame;
  }
  if (cursor !== totalFrames) {
    return { ok: false, reason: `frameレイアウトが末尾を覆っていない(cursor=${cursor}, total=${totalFrames})` };
  }

  return { ok: true, base, inserts, totalFrames };
}

/** 出力 frame 区間 [fromFrame, toFrame) を完全に含む単一の base 区間。無ければ null */
export function baseSegOf(
  layout: Extract<BaseLayout, { ok: true }>,
  span: { fromFrame: number; toFrame: number },
): BaseFrameSeg | null {
  return (
    layout.base.find((b) => b.fromFrame <= span.fromFrame && span.toFrame <= b.toFrame) ?? null
  );
}

/** 出力 frame → cut.mp4 の CFR 格子 frame(seg 内でのみ有効) */
export function cutFrameOf(seg: BaseFrameSeg, outFrame: number): number {
  return seg.videoStartFrame + (outFrame - seg.fromFrame);
}
