// test/webcamReactive.test.ts — 忠実性の担保。OpenScreen v1.7.0
// `lib/compositeLayout.ts` の reactiveWebcamScale(反応的ウェブカムワイプ縮小)を
// 逐語移植した src/lib/vendor/openscreen/webcamReactive.ts を数値一致で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEBCAM_REACTIVE_ZOOM_MIN_SCALE,
  reactiveWebcamScale,
} from "../src/lib/vendor/openscreen/webcamReactive.ts";

test("WEBCAM_REACTIVE_ZOOM_MIN_SCALE is 0.35", () => {
  assert.equal(WEBCAM_REACTIVE_ZOOM_MIN_SCALE, 0.35);
});

test("reactiveWebcamScale: identity at scale 1", () => {
  assert.equal(reactiveWebcamScale(1), 1);
});

test("reactiveWebcamScale: inverse below the floor", () => {
  assert.equal(reactiveWebcamScale(2), 0.5);
  assert.equal(reactiveWebcamScale(2.5), 0.4);
});

test("reactiveWebcamScale: clamped at the 0.35 floor once 1/scale would go lower", () => {
  // 1/4 = 0.25 < 0.35 → floor
  assert.equal(reactiveWebcamScale(4), 0.35);
  // 1/5 = 0.2 < 0.35 → floor
  assert.equal(reactiveWebcamScale(5), 0.35);
});

test("reactiveWebcamScale: clamped at 1 for scale < 1 (min(1, 1/scale))", () => {
  assert.equal(reactiveWebcamScale(0.5), 1);
});

test("reactiveWebcamScale: invalid input falls back to safe=1 → identity", () => {
  assert.equal(reactiveWebcamScale(0), 1);
  assert.equal(reactiveWebcamScale(NaN), 1);
  assert.equal(reactiveWebcamScale(-2), 1);
});
