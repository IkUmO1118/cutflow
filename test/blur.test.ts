// lib/blur.ts — 領域ぼかしの強度(0〜1)→px 換算を固定する。
// remotion/Main.tsx の blur レイヤーが使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { blurRadiusPx } from "../src/lib/blur.ts";

test("blurRadiusPx: strength 0/0.5/1 の固定値", () => {
  assert.equal(blurRadiusPx(0), 4);
  assert.equal(blurRadiusPx(0.5), 22);
  assert.equal(blurRadiusPx(1), 40);
});

test("blurRadiusPx: 範囲外は 0〜1 にクランプされる", () => {
  assert.equal(blurRadiusPx(-1), 4);
  assert.equal(blurRadiusPx(2), 40);
});
