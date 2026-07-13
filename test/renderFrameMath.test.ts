import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compositionDurationInFrames,
  compositionDurationSec,
} from "../src/lib/renderFrameMath.ts";

test("compositionDurationInFrames は durationSec * fps を四捨五入する", () => {
  assert.equal(compositionDurationInFrames(210.0, 30), 6300);
  assert.equal(compositionDurationInFrames(210.033333, 30), 6301);
  assert.equal(compositionDurationInFrames(210.083333, 30), 6302);
});

test("compositionDurationInFrames は最小1フレームを返す", () => {
  assert.equal(compositionDurationInFrames(0, 30), 1);
  assert.equal(compositionDurationInFrames(0.01, 30), 1);
});

test("compositionDurationSec は丸めた総フレーム数から秒数を返す", () => {
  assert.equal(compositionDurationSec(210.033333, 30), 6301 / 30);
  assert.equal(compositionDurationSec(0, 30), 1 / 30);
});
