import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineModel } from "../src/lib/timeline.ts";
import { sliceKeepsByOutputRange } from "../src/stages/av.ts";

test("sliceKeepsByOutputRange: 挿入込みの出力秒で keep を切り出す", () => {
  const built = buildTimelineModel(
    [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    [{ at: 10, durationSec: 2 }],
  );
  assert.deepEqual(
    sliceKeepsByOutputRange(built.entries, { startSec: 9, endSec: 13 }),
    [
      { start: 9, end: 10 },
      { start: 20, end: 21 },
    ],
  );
});
