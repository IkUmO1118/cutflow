// lib/panelStyle.ts — region+rect(width/height)+fit から CroppedVideo の
// スケール後スタイルを求める純関数。既存の全画面呼び出し(region と箱の
// アスペクト比が一致)で現行の `scale = width / region.w` 直結の式と
// 完全に一致することを固定する(remotion/Main.tsx の CroppedVideo が使う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cropFitStyle } from "../src/lib/panelStyle.ts";

const canvas = { w: 3840, h: 1080 };

test("cropFitStyle: 全画面呼び出し(screenRegion)は旧来の scale=width/region.w 直結の式と一致", () => {
  const region = { x: 0, y: 0, w: 1920, h: 1080 };
  const width = 1920;
  const height = 1080;
  const scale = width / region.w;
  const expected = {
    width: canvas.w * scale,
    height: canvas.h * scale,
    left: -region.x * scale + (width - region.w * scale) / 2,
    top: -region.y * scale + (height - region.h * scale) / 2,
  };
  assert.deepEqual(cropFitStyle({ canvas, region, width, height, fit: "cover" }), expected);
  assert.deepEqual(cropFitStyle({ canvas, region, width, height, fit: "contain" }), expected);
});

test("cropFitStyle: ワイプ呼び出し(cameraRegion・region.x > 0)も旧来の式と一致", () => {
  const region = { x: 1920, y: 0, w: 1920, h: 1080 };
  const width = 480;
  const height = 270;
  const scale = width / region.w;
  const expected = {
    width: canvas.w * scale,
    height: canvas.h * scale,
    left: -region.x * scale + (width - region.w * scale) / 2,
    top: -region.y * scale + (height - region.h * scale) / 2,
  };
  assert.deepEqual(cropFitStyle({ canvas, region, width, height, fit: "cover" }), expected);
});

test("cropFitStyle: cover はアスペクト差があるとき大きい方のスケールで中央寄せ", () => {
  // region は 16:9(1920x1080)、箱は正方形寄りの 1080x1920 の一部(1080x607)
  const region = { x: 0, y: 0, w: 1920, h: 1080 };
  const width = 1080;
  const height = 607;
  const style = cropFitStyle({ canvas, region, width, height, fit: "cover" });
  const scaleX = width / region.w; // 0.5625
  const scaleY = height / region.h; // 0.5620...
  const expectedScale = Math.max(scaleX, scaleY);
  assert.equal(style.width, canvas.w * expectedScale);
  assert.equal(style.height, canvas.h * expectedScale);
  // cover ではみ出た分だけ中央寄せに負のオフセットが乗る
  assert.equal(style.left, -region.x * expectedScale + (width - region.w * expectedScale) / 2);
  assert.equal(style.top, -region.y * expectedScale + (height - region.h * expectedScale) / 2);
});

test("cropFitStyle: contain は小さい方のスケールで余白ができる(はみ出さない)", () => {
  const region = { x: 0, y: 0, w: 1920, h: 1080 };
  const width = 1080;
  const height = 1920;
  const style = cropFitStyle({ canvas, region, width, height, fit: "contain" });
  const scaleX = width / region.w;
  const scaleY = height / region.h;
  const expectedScale = Math.min(scaleX, scaleY);
  assert.equal(style.width, canvas.w * expectedScale);
  assert.equal(style.height, canvas.h * expectedScale);
});

test("cropFitStyle: vertical-cover プロファイルの camera 全画面パネルと同じ引数で cover が計算できる", () => {
  const cameraRegion = { x: 1920, y: 0, w: 1920, h: 1080 };
  const style = cropFitStyle({
    canvas,
    region: cameraRegion,
    width: 1080,
    height: 1920,
    fit: "cover",
  });
  // cover なので縦方向を優先したスケール(横がはみ出す)になる
  const scaleY = 1920 / 1080;
  assert.equal(style.height, canvas.h * scaleY);
  assert.ok(style.width > 1080); // 横がはみ出て中央寄せされる
});
