import test from "node:test";
import assert from "node:assert/strict";
import { splitSpanAt } from "../editor/client/model.ts";

test("splitSpanAt splits inside and rounds to 2dp", () => {
  assert.deepEqual(splitSpanAt(5, 25, 12, 0.01), { left: { start: 5, end: 12 }, right: { start: 12, end: 25 } });
  assert.deepEqual(splitSpanAt(0, 10, 3.334, 0.01), { left: { start: 0, end: 3.33 }, right: { start: 3.33, end: 10 } });
});
test("splitSpanAt refuses when at is at/near either edge (no-op)", () => {
  assert.equal(splitSpanAt(5, 25, 5, 0.01), null);
  assert.equal(splitSpanAt(5, 25, 25, 0.01), null);
  assert.equal(splitSpanAt(5, 25, 5.005, 0.01), null);
  assert.equal(splitSpanAt(5, 25, 24.995, 0.01), null);
});
test("splitSpanAt halves touch at the split point (zoom-chain safe)", () => {
  const r = splitSpanAt(0, 10, 4, 0.01)!;
  assert.equal(r.left.end, r.right.start);
});
