// lib/zoom.ts — ズーム演出(overlays.json の zooms)の背景レイヤー transform を
// 求める純関数。区間外の恒等・区間中央での rect→全画面一致・イーズ中間値・
// 短い区間での遷移縮小を固定する(remotion/Main.tsx が使う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomProgressAt, zoomTransformAt } from "../src/lib/zoom.ts";
import type { ZoomSpan } from "../src/lib/zoom.ts";

const WIDTH = 1920;
const HEIGHT = 1080;

test("zoomTransformAt: 区間外は恒等(scale=1, translate=0)", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 },
  ];
  assert.deepEqual(zoomTransformAt(5, zooms, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  assert.deepEqual(zoomTransformAt(20, zooms, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  assert.deepEqual(zoomTransformAt(25, zooms, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
});

test("zoomTransformAt: 区間中央(イーズ完了後)は rect がちょうど全画面になる scale・translate", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  const t = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  const expectedScale = WIDTH / rect.w; // 2
  assert.equal(t.scale, expectedScale);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  assert.equal(t.translateX, WIDTH / 2 - expectedScale * cx);
  assert.equal(t.translateY, HEIGHT / 2 - expectedScale * cy);
  // rect の中心が出力の中心に来ていることの検算
  assert.equal(expectedScale * cx + t.translateX, WIDTH / 2);
  assert.equal(expectedScale * cy + t.translateY, HEIGHT / 2);
});

test("zoomTransformAt: イーズ中間値は 0(恒等)と完了後の間", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  // 区間の頭から 0.2 秒(easeSec の半分)= smoothstep(0.5) = 0.5
  const t = zoomTransformAt(10.2, zooms, WIDTH, HEIGHT);
  const full = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  assert.ok(t.scale > 1 && t.scale < full.scale);
});

test("zoomTransformAt: 区間が遷移2回分より短いと遷移を区間の半分へ縮める", () => {
  // easeSec=0.4 だが区間長 0.5 秒(遷移2回分=0.8 を超える半分=0.25 に縮む)
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 10.5, rect, easeSec: 0.4 }];
  // 縮んだ ease(0.25秒)の終端である 10.25 秒でイーズ完了(scale = full)のはず
  const atShrunkEnd = zoomTransformAt(10.25, zooms, WIDTH, HEIGHT);
  const expectedScale = WIDTH / rect.w;
  assert.equal(atShrunkEnd.scale, expectedScale);
});

test("zoomTransformAt: easeOutSec でズームアウトだけ別の速さにできる", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const base: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  const slowOut: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4, easeOutSec: 2 }];
  const normal = zoomTransformAt(19, base, WIDTH, HEIGHT);
  const slow = zoomTransformAt(19, slowOut, WIDTH, HEIGHT);
  assert.ok(slow.scale < normal.scale);
  assert.ok(slow.scale > 1);
});

test("zoomTransformAt: 重ならない複数区間から正しく該当区間を選ぶ", () => {
  const rectA = { x: 0, y: 0, w: 960, h: 1080 };
  const rectB = { x: 960, y: 0, w: 960, h: 1080 };
  const zooms: ZoomSpan[] = [
    { start: 0, end: 5, rect: rectA, easeSec: 0 },
    { start: 5, end: 10, rect: rectB, easeSec: 0 },
  ];
  assert.equal(zoomTransformAt(2, zooms, WIDTH, HEIGHT).translateX, WIDTH / 2 - (WIDTH / rectA.w) * (rectA.x + rectA.w / 2));
  assert.equal(zoomTransformAt(7, zooms, WIDTH, HEIGHT).translateX, WIDTH / 2 - (WIDTH / rectB.w) * (rectB.x + rectB.w / 2));
});

test("zoomProgressAt: 区間外は0", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 },
  ];
  assert.equal(zoomProgressAt(5, zooms), 0);
  assert.equal(zoomProgressAt(20, zooms), 0);
  assert.equal(zoomProgressAt(25, zooms), 0);
});

test("zoomProgressAt: 区間頭で0", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 },
  ];
  assert.equal(zoomProgressAt(10, zooms), 0);
});

test("zoomProgressAt: ease完了後は1", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 },
  ];
  assert.equal(zoomProgressAt(15, zooms), 1);
  assert.equal(zoomProgressAt(10.4, zooms), 1);
});

test("zoomProgressAt: 区間が短いとease を区間の半分へ縮める", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 10.5, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 },
  ];
  // 縮んだease(0.25秒)の終端である10.25秒で完了(=1)のはず
  assert.equal(zoomProgressAt(10.25, zooms), 1);
});

test("zoomProgressAt: easeOutSec 個別指定でズームアウトだけ別の速さになる", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const base: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  const slowOut: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4, easeOutSec: 2 }];
  const normal = zoomProgressAt(19, base);
  const slow = zoomProgressAt(19, slowOut);
  assert.ok(slow < normal);
  assert.ok(slow > 0);
});

test("zoomProgressAt: smoothstep 値が zoomTransformAt の scale から逆算した進行度と一致する", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  for (const t of [10.1, 10.2, 10.3, 15, 19.7, 19.8, 19.9]) {
    const transform = zoomTransformAt(t, zooms, WIDTH, HEIGHT);
    const targetScale = WIDTH / rect.w;
    const pFromScale = (transform.scale - 1) / (targetScale - 1);
    const p = zoomProgressAt(t, zooms);
    assert.ok(Math.abs(pFromScale - p) < 1e-9, `t=${t}: ${pFromScale} !== ${p}`);
  }
});

test("zoomTransformAt: リファクタ後も既存の期待値が1つも変わらない(回帰の要)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  assert.deepEqual(zoomTransformAt(5, zooms, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  const full = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  const expectedScale = WIDTH / rect.w;
  assert.equal(full.scale, expectedScale);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  assert.equal(full.translateX, WIDTH / 2 - expectedScale * cx);
  assert.equal(full.translateY, HEIGHT / 2 - expectedScale * cy);
});
