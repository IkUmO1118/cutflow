// editor/client/metrics.ts の純関数。PresentationClock の累積カウンタから
// 増分を出す部分だけを固定する(remount でカウンタが 0 に戻るケースが本番)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffCounters } from "../editor/client/metrics.ts";

test("diffCounters: 初回は baselineOnly で増分を計上しない", () => {
  assert.deepEqual(
    diffCounters(null, { presentedFrames: 60, droppedFrames: 1, forcedResets: 2 }),
    { presented: 0, dropped: 0, forcedResets: 0, baselineOnly: true },
  );
});

test("diffCounters: 通常の前進は累積カウンタ差分を返す", () => {
  assert.deepEqual(
    diffCounters(
      { presentedFrames: 60, droppedFrames: 0, forcedResets: 0 },
      { presentedFrames: 120, droppedFrames: 2, forcedResets: 0 },
    ),
    { presented: 60, dropped: 2, forcedResets: 0, baselineOnly: false },
  );
});

test("diffCounters: presentedFrames が減ったら clock 再生成として baseline だけ張り替える", () => {
  assert.deepEqual(
    diffCounters(
      { presentedFrames: 120, droppedFrames: 5, forcedResets: 1 },
      { presentedFrames: 3, droppedFrames: 0, forcedResets: 0 },
    ),
    { presented: 0, dropped: 0, forcedResets: 0, baselineOnly: true },
  );
});

test("diffCounters: presentedFrames が同じで dropped だけ増えた窓も差分を返す", () => {
  assert.deepEqual(
    diffCounters(
      { presentedFrames: 120, droppedFrames: 2, forcedResets: 0 },
      { presentedFrames: 120, droppedFrames: 7, forcedResets: 0 },
    ),
    { presented: 0, dropped: 5, forcedResets: 0, baselineOnly: false },
  );
});

test("diffCounters: droppedFrames が減ったら 0 に丸める", () => {
  assert.deepEqual(
    diffCounters(
      { presentedFrames: 120, droppedFrames: 7, forcedResets: 0 },
      { presentedFrames: 180, droppedFrames: 2, forcedResets: 0 },
    ),
    { presented: 60, dropped: 0, forcedResets: 0, baselineOnly: false },
  );
});
