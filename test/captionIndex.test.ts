import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCaptionIndex, lookupCaption } from "../src/lib/captionIndex.ts";
import type { Caption } from "../remotion/props.ts";

// 索引化した captionAt が、旧実装の線形 .find と常に同一の結果を返すことを固定する。
// (プレビュー・最終レンダーの「同じ絵」保証。壊すとテロップの出方が変わる)

const cap = (start: number, end: number, track = 1, text = "x"): Caption => ({
  start, end, text, track,
});

/** 旧 Main.tsx の captionAt の実装(基準) */
const naive = (caps: Caption[], track: number, t: number) =>
  caps.find((c) => (c.track ?? 1) === track && t >= c.start && t < c.end);

/** caps と track 群にわたり、細かい t 刻みで索引と .find の一致を突き合わせる */
function assertEquivalent(caps: Caption[], tracks: number[]) {
  const index = buildCaptionIndex(caps);
  for (const track of tracks) {
    for (let t = -1; t <= 40; t += 0.1) {
      const tt = Math.round(t * 100) / 100;
      assert.deepEqual(
        lookupCaption(index, track, tt),
        naive(caps, track, tt),
        `track=${track} t=${tt}`,
      );
    }
  }
}

test("clean(非重複・昇順)トラックは二分探索が .find と一致する", () => {
  const caps = [cap(0, 3), cap(3, 5), cap(5.5, 8), cap(10, 12)];
  const idx = buildCaptionIndex(caps);
  assert.equal(idx.get(1)?.clean, true);
  assertEquivalent(caps, [1]);
});

test("隙間なく連続([start,end) が接する)も clean", () => {
  const caps = [cap(0, 2), cap(2, 4), cap(4, 6)];
  assert.equal(buildCaptionIndex(caps).get(1)?.clean, true);
  assertEquivalent(caps, [1]);
});

test("同一トラックの時間重なりは clean=false で .find に委ね厳密一致を保つ", () => {
  // A[0,10] と B[5,7] が重なる。t=6 で .find は最初の A を返す(索引もこれに合わせる)
  const caps = [cap(0, 10, 1, "A"), cap(5, 7, 1, "B")];
  const idx = buildCaptionIndex(caps);
  assert.equal(idx.get(1)?.clean, false);
  assert.equal(lookupCaption(idx, 1, 6)?.text, "A");
  assertEquivalent(caps, [1]);
});

test("順序が崩れたデータも clean=false で .find と一致", () => {
  const caps = [cap(10, 12, 1), cap(0, 3, 1), cap(5, 8, 1)];
  assert.equal(buildCaptionIndex(caps).get(1)?.clean, false);
  assertEquivalent(caps, [1]);
});

test("複数トラックが混在しても各トラックで一致(track 省略は 1 扱い)", () => {
  const caps = [
    cap(0, 3, 1), cap(1, 4, 2), cap(3, 6, 1), cap(4, 5, 2),
    { start: 6, end: 9, text: "notrack" } as Caption, // track 省略 → 1
  ];
  assertEquivalent(caps, [1, 2, 3]);
});

test("大量データ(ランダム非重複)でも全 t で一致", () => {
  // 疑似乱数(決定的)で 500 件の非重複テロップを2トラックに敷く
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const caps: Caption[] = [];
  const cursor = [0, 0];
  for (let i = 0; i < 500; i++) {
    const track = i % 2;
    const start = cursor[track] + rand() * 2;
    const end = start + 0.5 + rand() * 3;
    caps.push(cap(Math.round(start * 100) / 100, Math.round(end * 100) / 100, track + 1));
    cursor[track] = end;
  }
  const index = buildCaptionIndex(caps);
  assert.equal(index.get(1)?.clean, true);
  assert.equal(index.get(2)?.clean, true);
  for (let t = 0; t < 1000; t += 0.25) {
    for (const track of [1, 2]) {
      assert.deepEqual(lookupCaption(index, track, t), naive(caps, track, t));
    }
  }
});
