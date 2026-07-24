// lib/zoom.ts — ズーム演出(overlays.json の zooms)の背景レイヤー transform を
// 求める純関数。区間外の恒等・区間中央での rect→全画面一致・イーズ中間値・
// 短い区間での遷移縮小を固定する(remotion/Main.tsx が使う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomContiguous, zoomEase, zoomProgressAt, zoomTransformAt } from "../src/lib/zoom.ts";
import type { ZoomSpan } from "../src/lib/zoom.ts";

const WIDTH = 1920;
const HEIGHT = 1080;

// ---- zoomEase(OpenScreen 移植 D3・D1a): cubic-bezier(0.16,1,0.3,1) ----

test("zoomEase: 端点は0/1、範囲外はクランプする", () => {
  assert.equal(zoomEase(0), 0);
  assert.equal(zoomEase(1), 1);
  assert.equal(zoomEase(-1), 0);
  assert.equal(zoomEase(2), 1);
});

test("zoomEase: 単調増加", () => {
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const y = zoomEase(Math.min(1, x));
    assert.ok(y >= prev - 1e-9, `x=${x}: y=${y} < prev=${prev}`);
    prev = y;
  }
});

test("zoomEase: screen-studio bezier(0.16,1,0.3,1) の既知点に一致(制御点が両方 y=1 なので早期にほぼ寄り切る)", () => {
  assert.ok(Math.abs(zoomEase(0.5) - 0.9717791052647868) < 1e-9);
  assert.ok(Math.abs(zoomEase(0.25) - 0.8256223011584941) < 1e-9);
});

test("zoomEase: dir 引数は現状 in/out で同じ曲線(将来の差し替えの余地)", () => {
  for (const x of [0, 0.2, 0.5, 0.8, 1]) {
    assert.equal(zoomEase(x, "in"), zoomEase(x, "out"));
  }
});

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
  // 区間の頭から 0.2 秒(easeSec の半分。raw=0.5)
  const t = zoomTransformAt(10.2, zooms, WIDTH, HEIGHT);
  const full = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  assert.ok(t.scale > 1 && t.scale < full.scale);
});

test("回帰固定(意図的な破壊。docs/decisions.md 参照): 孤立区間の中間値は旧 smoothstep(0.5)=0.5 とはもう一致しない", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4 }];
  const half = zoomTransformAt(10.2, zooms, WIDTH, HEIGHT); // raw=0.5
  const full = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  const oldSmoothstepScale = 1 + (full.scale - 1) * 0.5;
  assert.notEqual(half.scale, oldSmoothstepScale);
  const newCurveScale = 1 + (full.scale - 1) * zoomEase(0.5, "in");
  assert.ok(Math.abs(half.scale - newCurveScale) < 1e-9);
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

// ---- 連鎖(隣接ズームのパン遷移) ----
// end === 次の start で隙間なく接する2区間は、境界で等倍へ戻らず、次の区間の
// 頭 easeSec で前の rect から次の rect へ直接パンする。値が厳密比較できるよう
// scale=2・平行移動が整数になる rect を選ぶ

const CHAIN_A = { x: 192, y: 108, w: 960, h: 540 }; // full: scale=2, tx=-384, ty=-216
const CHAIN_B = { x: 768, y: 432, w: 960, h: 540 }; // full: scale=2, tx=-1536, ty=-864
const CHAIN: ZoomSpan[] = [
  { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4 },
  { start: 20, end: 30, rect: CHAIN_B, easeSec: 0.4 },
];

test("連鎖: 前の区間は末尾で等倍へ戻らない(イーズアウトせずフルズームを保つ)", () => {
  const fullA = zoomTransformAt(15, CHAIN, WIDTH, HEIGHT);
  assert.equal(fullA.scale, 2);
  // 従来なら 19.8 は easeOut 窓内で scale が 1 へ向かうが、連鎖では保つ
  assert.deepEqual(zoomTransformAt(19.8, CHAIN, WIDTH, HEIGHT), fullA);
});

test("連鎖: 境界直後は前の rect のフルズームから始まる(等倍への落ち込みが無い)", () => {
  const fullA = zoomTransformAt(15, CHAIN, WIDTH, HEIGHT);
  assert.deepEqual(zoomTransformAt(20, CHAIN, WIDTH, HEIGHT), fullA);
});

test("連鎖: 次の区間の頭 easeSec で前の rect から次の rect へパン(中点は zoomEase(0.5) の進行度で補間)", () => {
  // 20.2 = easeSec 0.4 の半分 → raw=0.5。旧 smoothstep(0.5)=0.5 の対称性は
  // cubic-bezier 差し替え(OpenScreen 移植 D3・D1a)で意図的に崩れる
  // (docs/decisions.md 参照)。実際の進行度は zoomEase(0.5) から求める
  const p = zoomEase(0.5, "in");
  const mid = zoomTransformAt(20.2, CHAIN, WIDTH, HEIGHT);
  assert.equal(mid.scale, 2); // 同じ幅の rect どうしのパンでは scale は動かない
  const expectedTx = -384 + (-1536 - -384) * p;
  const expectedTy = -216 + (-864 - -216) * p;
  assert.ok(Math.abs(mid.translateX - expectedTx) < 1e-6, `translateX=${mid.translateX}`);
  assert.ok(Math.abs(mid.translateY - expectedTy) < 1e-6, `translateY=${mid.translateY}`);
  // イーズ完了後は次の rect のフルズーム
  const fullB = zoomTransformAt(25, CHAIN, WIDTH, HEIGHT);
  assert.deepEqual(zoomTransformAt(20.4, CHAIN, WIDTH, HEIGHT), fullB);
});

test("連鎖: 進行度は境界をまたいで 1 のまま(ワイプ縮小が境界で戻らない)", () => {
  assert.equal(zoomProgressAt(19.9, CHAIN), 1);
  assert.equal(zoomProgressAt(20, CHAIN), 1);
  assert.equal(zoomProgressAt(20.1, CHAIN), 1);
});

test("連鎖: 最後の区間は従来どおり末尾で等倍へ戻る", () => {
  const nearEnd = zoomTransformAt(29.8, CHAIN, WIDTH, HEIGHT);
  assert.ok(nearEnd.scale > 1 && nearEnd.scale < 2);
  assert.deepEqual(zoomTransformAt(30, CHAIN, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
});

test("連鎖: 3区間の連鎖も各境界でパンする", () => {
  const rectC = { x: 480, y: 270, w: 960, h: 540 };
  const chain3: ZoomSpan[] = [...CHAIN, { start: 30, end: 40, rect: rectC, easeSec: 0.4 }];
  const fullB = zoomTransformAt(25, chain3, WIDTH, HEIGHT);
  assert.deepEqual(zoomTransformAt(30, chain3, WIDTH, HEIGHT), fullB); // 2つ目→3つ目の境界も落ちない
  const fullC = zoomTransformAt(35, chain3, WIDTH, HEIGHT);
  assert.deepEqual(zoomTransformAt(30.4, chain3, WIDTH, HEIGHT), fullC);
});

test("隙間のある2区間は連鎖しない(従来どおり間で等倍へ戻る)", () => {
  const gap: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4 },
    { start: 20.5, end: 30, rect: CHAIN_B, easeSec: 0.4 },
  ];
  const nearEndA = zoomTransformAt(19.8, gap, WIDTH, HEIGHT);
  assert.ok(nearEndA.scale > 1 && nearEndA.scale < 2); // イーズアウト中
  assert.deepEqual(zoomTransformAt(20.2, gap, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  assert.equal(zoomProgressAt(20.2, gap), 0);
});

test("zoomContiguous: 浮動小数の合成誤差(1µs 以内)だけを連鎖とみなす", () => {
  assert.equal(zoomContiguous(20, 20), true);
  assert.equal(zoomContiguous(20, 20 + 1e-9), true);
  assert.equal(zoomContiguous(20, 20.01), false);
  assert.equal(zoomContiguous(20, 19.99), false);
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
