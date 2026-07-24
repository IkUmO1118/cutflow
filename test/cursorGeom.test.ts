import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absolutePointToNormalized,
  cursorToOutputPoint,
  pickDisplayByTelemetry,
} from "../src/lib/cursorGeom.ts";

const SCREEN_REGION_LEFT_HALF = { x: 0, y: 0, w: 1920, h: 1080 };

test("cursorToOutputPoint: obs-canvas は撮影ディスプレイ全体を screenRegion(左半分)へ写像", () => {
  const p = cursorToOutputPoint({
    cx: 0.5,
    cy: 0.25,
    layout: "obs-canvas",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 3840,
    outputHeight: 1080,
  });
  assert.deepEqual(p, { x: 960, y: 270 });
});

test("cursorToOutputPoint: obs-canvas で screenRegion がキャンバス右半分でもオフセットが乗る", () => {
  const p = cursorToOutputPoint({
    cx: 0.5,
    cy: 0.5,
    layout: "obs-canvas",
    screenRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    outputWidth: 3840,
    outputHeight: 1080,
  });
  assert.deepEqual(p, { x: 1920 + 960, y: 540 });
});

test("cursorToOutputPoint: plain は出力実寸へ直接写像(screenRegion 無視)", () => {
  const p = cursorToOutputPoint({
    cx: 0.5,
    cy: 0.5,
    layout: "plain",
    screenRegion: { x: 999, y: 999, w: 1, h: 1 }, // plain では使われないはず
    outputWidth: 1920,
    outputHeight: 1080,
  });
  assert.deepEqual(p, { x: 960, y: 540 });
});

test("cursorToOutputPoint: 角(0,0)と(1,1)が screenRegion の角に一致する", () => {
  const topLeft = cursorToOutputPoint({
    cx: 0,
    cy: 0,
    layout: "obs-canvas",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 3840,
    outputHeight: 1080,
  });
  assert.deepEqual(topLeft, { x: 0, y: 0 });

  const bottomRight = cursorToOutputPoint({
    cx: 1,
    cy: 1,
    layout: "obs-canvas",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 3840,
    outputHeight: 1080,
  });
  assert.deepEqual(bottomRight, { x: 1920, y: 1080 });
});

test("cursorToOutputPoint: Y 反転が二重にかからない(cy が単調に outY へ写る)", () => {
  const near = cursorToOutputPoint({
    cx: 0,
    cy: 0.1,
    layout: "obs-canvas",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 3840,
    outputHeight: 1080,
  });
  const far = cursorToOutputPoint({
    cx: 0,
    cy: 0.9,
    layout: "obs-canvas",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 3840,
    outputHeight: 1080,
  });
  // cy が大きいほど outY も大きい(反転していれば逆になる)
  assert.ok(far.y > near.y, `far.y=${far.y} near.y=${near.y}`);
  assert.equal(near.y, 108);
  assert.equal(far.y, 972);
});

test("cursorToOutputPoint: plain でも Y 反転が二重にかからない", () => {
  const near = cursorToOutputPoint({
    cx: 0,
    cy: 0.2,
    layout: "plain",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 1920,
    outputHeight: 1080,
  });
  const far = cursorToOutputPoint({
    cx: 0,
    cy: 0.8,
    layout: "plain",
    screenRegion: SCREEN_REGION_LEFT_HALF,
    outputWidth: 1920,
    outputHeight: 1080,
  });
  assert.ok(far.y > near.y);
});

const PRIMARY = { id: 1, bounds: { x: 0, y: 0, w: 1470, h: 956 } };
const SECONDARY = { id: 3, bounds: { x: 1470, y: -56, w: 1920, h: 1080 } };

test("absolutePointToNormalized: 対象ディスプレイの角(0,0)/(1,1)に一致", () => {
  assert.deepEqual(
    absolutePointToNormalized({ ax: SECONDARY.bounds.x, ay: SECONDARY.bounds.y }, SECONDARY.bounds),
    { cx: 0, cy: 0, inBounds: true },
  );
  assert.deepEqual(
    absolutePointToNormalized(
      { ax: SECONDARY.bounds.x + SECONDARY.bounds.w, ay: SECONDARY.bounds.y + SECONDARY.bounds.h },
      SECONDARY.bounds,
    ),
    { cx: 1, cy: 1, inBounds: true },
  );
});

test("absolutePointToNormalized: 範囲外は inBounds:false かつ範囲外の値をそのまま返す", () => {
  const p = absolutePointToNormalized({ ax: 100, ay: 100 }, SECONDARY.bounds);
  assert.equal(p.inBounds, false);
  assert.ok(p.cx < 0);
});

test("pickDisplayByTelemetry: in-bounds 滞在最長のディスプレイを選ぶ", () => {
  const points = [
    { ax: 700, ay: 400 }, // primary 内
    { ax: 700, ay: 500 }, // primary 内
    { ax: 2000, ay: 500 }, // secondary 内
  ];
  const result = pickDisplayByTelemetry(points, [PRIMARY, SECONDARY]);
  assert.deepEqual(result, { id: 1, inBoundsCount: 2 });
});

test("pickDisplayByTelemetry: 候補・サンプルが無ければ null", () => {
  assert.equal(pickDisplayByTelemetry([], [PRIMARY]), null);
  assert.equal(pickDisplayByTelemetry([{ ax: 0, ay: 0 }], []), null);
});
