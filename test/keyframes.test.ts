import { test } from "node:test";
import assert from "node:assert/strict";
import { easingProgress, remapKeyframesForPiece, valueAt, valuesAt } from "../src/lib/keyframes.ts";

test("easingProgress: 5種類の easing を評価する", () => {
  assert.equal(easingProgress("linear", 0.5), 0.5);
  assert.equal(easingProgress("ease-in", 0.5), 0.25);
  assert.equal(easingProgress("ease-out", 0.5), 0.75);
  assert.equal(easingProgress("ease-in-out", 0.5), 0.5);
  assert.equal(easingProgress("hold", 0.5), 0);
});

test("valueAt/valuesAt: sparse channel・先頭末尾 hold・exact key time", () => {
  const keyframes = [
    { at: 10, easing: "linear" as const, values: { x: 0, opacity: 0 } },
    { at: 11, easing: "linear" as const, values: { opacity: 1 } },
    { at: 12, easing: "linear" as const, values: { x: 100 } },
  ];
  assert.equal(valueAt("x", 50, keyframes, 9), 0);
  assert.equal(valueAt("x", 50, keyframes, 11), 50);
  assert.equal(valueAt("x", 50, keyframes, 13), 100);
  assert.equal(valueAt("opacity", 1, keyframes, 10.5), 0.5);
  assert.deepEqual(valuesAt({ x: 50, opacity: 1 }, keyframes, 11), { x: 50, opacity: 1 });
});

test("remapKeyframesForPiece: cut 境界で補間せず boundary key を打つ", () => {
  const remapped = remapKeyframesForPiece(
    [
      { at: 4, easing: "linear", values: { x: 100 } },
      { at: 11, easing: "linear", values: { x: 500 } },
    ],
    { sourceStart: 10, sourceEnd: 15, outputStart: 5, outputEnd: 10 },
    { x: 0 },
  );
  assert.deepEqual(remapped, [
    { at: 5, easing: "linear", values: { x: 442.85714285714283 } },
    { at: 6, easing: "linear", values: { x: 500 } },
    { at: 10, easing: "linear", values: { x: 500 } },
  ]);
});
