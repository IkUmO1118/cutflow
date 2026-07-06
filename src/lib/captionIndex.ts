import type { Caption } from "../../remotion/props.ts";

/**
 * テロップの「今どれが表示中か」を毎フレーム引く索引。
 *
 * Main.tsx は再生中フレームごとにテロップトラック分だけ「t 時点で表示中の
 * テロップ」を引く。従来は props.captions 全件の線形走査(.find)で、テロップ
 * 数に比例して毎フレームのコストが増えていた。トラック別に start 昇順で
 * まとめ、時間的な重なりが無いトラックは二分探索で O(log n) に落とす。
 *
 * ただし同一トラックのテロップが時間的に重なる手編集データでは、.find の
 * 「配列順で最初の一致」と二分探索の「直前に始まった1件」が食い違う。
 * そこで重なりの無い"clean"なトラックだけ二分探索し、重なりのあるトラックは
 * 従来の .find に委ねて、プレビュー・最終レンダーの絵を一切変えない。
 */

/** トラック別の索引。clean なら二分探索可(start 昇順かつ [start,end) 非重複) */
export type CaptionGroup = { list: Caption[]; clean: boolean };

/** props.captions をトラック別にまとめ、各トラックが二分探索できるかを判定する。
 * buildRenderProps は transcript 順で captions を作るので通常は clean */
export function buildCaptionIndex(captions: Caption[]): Map<number, CaptionGroup> {
  const byTrack = new Map<number, Caption[]>();
  for (const c of captions) {
    const tr = c.track ?? 1;
    const arr = byTrack.get(tr);
    if (arr) arr.push(c);
    else byTrack.set(tr, [c]);
  }
  const index = new Map<number, CaptionGroup>();
  for (const [tr, list] of byTrack) {
    let clean = true;
    for (let i = 1; i < list.length; i++) {
      // 直前より前に始まる(順序崩れ)か、直前の終わりより前に始まる(重なり)
      // なら二分探索できない。end > start 前提なので start<prev.end が両方を含む
      if (list[i].start < list[i - 1].end) {
        clean = false;
        break;
      }
    }
    index.set(tr, { list, clean });
  }
  return index;
}

/** track に t 時点で表示中のテロップ。clean なら二分探索(直前に始まった
 * 1件を引いて end で確認)、そうでなければ元の .find と同じ厳密一致。
 * 返り値は必ず旧実装 captions.find((c)=>(c.track??1)===track && t>=c.start && t<c.end)
 * と一致する(test/captionIndex.test.ts で固定) */
export function lookupCaption(
  index: Map<number, CaptionGroup>,
  track: number,
  t: number,
): Caption | undefined {
  const g = index.get(track);
  if (!g) return undefined;
  if (!g.clean) return g.list.find((c) => t >= c.start && t < c.end);
  const arr = g.list;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start > t) hi = mid;
    else lo = mid + 1;
  }
  const c = arr[lo - 1];
  return c && t < c.end ? c : undefined;
}
