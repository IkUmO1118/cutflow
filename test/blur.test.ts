// lib/blur.ts — 領域ぼかし/モザイクの座標変換(出力px→canvas px)と
// 強度(0〜1)→px 換算を固定する。remotion/Main.tsx の blur レイヤーが使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blurRadiusPx,
  mosaicBlockPx,
  mosaicFallbackBlurPx,
  outputRectToCanvasRegion,
} from "../src/lib/blur.ts";

test("outputRectToCanvasRegion: screenRegion が全画面(オフセット無し・等倍)なら恒等", () => {
  const rect = { x: 700, y: 400, w: 520, h: 140 };
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(outputRectToCanvasRegion(rect, screenRegion, 1920, 1080), rect);
});

test("outputRectToCanvasRegion: screenRegion にオフセットがある場合(obs-canvas)は平行移動する", () => {
  const rect = { x: 0, y: 0, w: 960, h: 540 };
  // 出力 1920x1080、canvas 内の screenRegion は右半分(オフセット x=1920)
  const screenRegion = { x: 1920, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(outputRectToCanvasRegion(rect, screenRegion, 1920, 1080), {
    x: 1920,
    y: 0,
    w: 960,
    h: 540,
  });
});

test("outputRectToCanvasRegion: screenRegion に縮尺がある場合は rect も同じ比率で縮む", () => {
  const rect = { x: 960, y: 540, w: 960, h: 540 }; // 出力の右下1/4
  // canvas 側の screenRegion が出力の半分の解像度(960x540)
  const screenRegion = { x: 100, y: 50, w: 960, h: 540 };
  assert.deepEqual(outputRectToCanvasRegion(rect, screenRegion, 1920, 1080), {
    x: 100 + 480,
    y: 50 + 270,
    w: 480,
    h: 270,
  });
});

test("blurRadiusPx: strength 0/0.5/1 の固定値", () => {
  assert.equal(blurRadiusPx(0), 4);
  assert.equal(blurRadiusPx(0.5), 22);
  assert.equal(blurRadiusPx(1), 40);
});

test("blurRadiusPx: 範囲外は 0〜1 にクランプされる", () => {
  assert.equal(blurRadiusPx(-1), 4);
  assert.equal(blurRadiusPx(2), 40);
});

test("mosaicBlockPx: strength 0/0.5/1 の固定値", () => {
  assert.equal(mosaicBlockPx(0), 8);
  assert.equal(mosaicBlockPx(0.5), 36);
  assert.equal(mosaicBlockPx(1), 64);
});

test("mosaicBlockPx: 範囲外は 0〜1 にクランプされる", () => {
  assert.equal(mosaicBlockPx(-0.5), 8);
  assert.equal(mosaicBlockPx(1.5), 64);
});

test("mosaicFallbackBlurPx: mosaicBlockPx のおよそ半分", () => {
  assert.equal(mosaicFallbackBlurPx(0), 4); // round(8*0.5)
  assert.equal(mosaicFallbackBlurPx(0.5), 18); // round(36*0.5)
  assert.equal(mosaicFallbackBlurPx(1), 32); // round(64*0.5)
});
