// src/engine/runtime/clock.ts の純関数部分を固定する(M3b T1-1: playbackRate対応)。
// PresentationClock 本体(AudioContext/requestAnimationFrame が要る)は実 movie で
// editor 統合後に実測する(audioScheduler.test.ts と同じ方針)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { outputSecFromMapping, shouldForceReset } from "../src/engine/runtime/clock.ts";

test("outputSecFromMapping: rate省略時は等速(従来どおり)", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100 };
  assert.equal(outputSecFromMapping(mapping, 100), 10);
  assert.equal(outputSecFromMapping(mapping, 102.5), 12.5);
  assert.equal(outputSecFromMapping(mapping, 95), 5);
});

test("outputSecFromMapping: rate:1は等速と同じ", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100, rate: 1 };
  assert.equal(outputSecFromMapping(mapping, 105), 15);
});

test("outputSecFromMapping: rate:2は倍速で進む", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100, rate: 2 };
  assert.equal(outputSecFromMapping(mapping, 105), 20);
});

test("outputSecFromMapping: rate:0.5は半速で進む", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100, rate: 0.5 };
  assert.equal(outputSecFromMapping(mapping, 110), 15);
});

// R4 Phase5: 描画の詰まりから復帰するかを決める純関数
test("shouldForceReset: 経過時間がstallMs以下ならfalse", () => {
  assert.equal(shouldForceReset(1000, 1500, 1000), false);
});

test("shouldForceReset: 経過時間がstallMsちょうどならfalse(境界は含まない)", () => {
  assert.equal(shouldForceReset(1000, 2000, 1000), false);
});

test("shouldForceReset: 経過時間がstallMsを超えたらtrue", () => {
  assert.equal(shouldForceReset(1000, 2001, 1000), true);
});

test("shouldForceReset: stallMsが小さいほど早く強制復帰と判定する", () => {
  assert.equal(shouldForceReset(0, 100, 50), true);
  assert.equal(shouldForceReset(0, 100, 200), false);
});
