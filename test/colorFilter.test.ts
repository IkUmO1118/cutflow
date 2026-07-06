// lib/colorFilter.ts — 簡易カラー調整(overlays.json の colorFilter)を CSS
// filter 文字列に変換する純関数。未指定・全既定(1.0)は無補正(undefined)を
// 固定する(remotion/Main.tsx が使う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cssFilterOf } from "../src/lib/colorFilter.ts";

test("cssFilterOf: 未指定はフィルタなし(undefined)", () => {
  assert.equal(cssFilterOf(undefined), undefined);
});

test("cssFilterOf: 空オブジェクト(全既定 1.0)もフィルタなし", () => {
  assert.equal(cssFilterOf({}), undefined);
});

test("cssFilterOf: 一部指定(残りは既定 1 を補う)", () => {
  assert.equal(cssFilterOf({ brightness: 1.2 }), "brightness(1.2) contrast(1) saturate(1)");
});

test("cssFilterOf: 全指定", () => {
  assert.equal(
    cssFilterOf({ brightness: 1.05, contrast: 1.1, saturate: 0.9 }),
    "brightness(1.05) contrast(1.1) saturate(0.9)",
  );
});
