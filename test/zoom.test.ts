// lib/zoom.ts — ズーム演出(overlays.json の zooms)の背景レイヤー transform を
// 求める純関数。区間外の恒等・区間中央での rect→全画面一致・イーズ中間値・
// 短い区間での遷移縮小を固定する(remotion/Main.tsx が使う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveZoomRange,
  zoomContiguous,
  zoomEase,
  zoomProgressAt,
  zoomTransformAt,
} from "../src/lib/zoom.ts";
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
  // leadSec: 0(pre-roll 無効)にして easeIn 自体の挙動だけを見る
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4, leadSec: 0 }];
  // 区間の頭から 0.2 秒(easeSec の半分。raw=0.5)
  const t = zoomTransformAt(10.2, zooms, WIDTH, HEIGHT);
  const full = zoomTransformAt(15, zooms, WIDTH, HEIGHT);
  assert.ok(t.scale > 1 && t.scale < full.scale);
});

test("回帰固定(意図的な破壊。docs/decisions.md 参照): 孤立区間の中間値は旧 smoothstep(0.5)=0.5 とはもう一致しない", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 0.4, leadSec: 0 }];
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

test("zoomProgressAt: leadSec: 0(pre-roll 無効)なら区間頭で0", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4, leadSec: 0 },
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

// ---- OpenScreen 移植 D3(#2・D2a): 連鎖を「gap <= chainGapSec」へ緩める ----
// 既定 chainGapSec は DEFAULT_ZOOM_CHAIN_GAP_SEC(1.5秒)。gap を明示しない
// ZoomSpan はこの既定を使う(zoom.ts の contiguousPrev/Next のフォールバック)

test("gap が既定 chainGapSec(1.5秒)以内なら連鎖する(区間の端が連鎖扱いになる)", () => {
  const gap: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4 },
    { start: 20.5, end: 30, rect: CHAIN_B, easeSec: 0.4 }, // gap=0.5 <= 1.5
  ];
  const fullA = zoomTransformAt(15, gap, WIDTH, HEIGHT);
  // A は末尾でイーズアウトせずフルズームを保つ(連鎖)
  assert.deepEqual(zoomTransformAt(19.99, gap, WIDTH, HEIGHT), fullA);
  assert.equal(zoomProgressAt(19.99, gap), 1);
  // B の頭(イーズ前)は前 rect(fullA)からのパン開始点になる
  assert.deepEqual(zoomTransformAt(20.5, gap, WIDTH, HEIGHT), fullA);
  // gap 区間 [20, 20.5) 自体も前 rect(fullA)のまま保持される(D2b・P4)
  assert.deepEqual(zoomTransformAt(20.2, gap, WIDTH, HEIGHT), fullA);
  assert.equal(zoomProgressAt(20.2, gap), 1);
});

test("gap が chainGapSec を超えると連鎖しない(従来どおり間で等倍へ戻る)", () => {
  const gap: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4, chainGapSec: 1.5 },
    { start: 22, end: 30, rect: CHAIN_B, easeSec: 0.4, chainGapSec: 1.5 }, // gap=2 > 1.5
  ];
  const nearEndA = zoomTransformAt(19.8, gap, WIDTH, HEIGHT);
  assert.ok(nearEndA.scale > 1 && nearEndA.scale < 2); // イーズアウト中
  assert.deepEqual(zoomTransformAt(20.2, gap, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  assert.equal(zoomProgressAt(20.2, gap), 0);
});

test("chainGapSec: 0 を明示すると gap があれば連鎖しない(完全隣接のみ連鎖する旧仕様と等価)", () => {
  // leadSec: 0(pre-roll 無効)で D1c との相互作用を排除し、chainGapSec だけを見る
  const gap: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4, chainGapSec: 0, leadSec: 0 },
    { start: 20.5, end: 30, rect: CHAIN_B, easeSec: 0.4, chainGapSec: 0, leadSec: 0 },
  ];
  const nearEndA = zoomTransformAt(19.8, gap, WIDTH, HEIGHT);
  assert.ok(nearEndA.scale > 1 && nearEndA.scale < 2); // イーズアウト中
  assert.deepEqual(zoomTransformAt(20.2, gap, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  assert.equal(zoomProgressAt(20.2, gap), 0);
});

// ---- OpenScreen 移植 D3(#2・D2b): gap のある連鎖のパン窓を chainPanSec に ----

test("D2b: gap のある連鎖は chainPanSec でパンする(easeSec より長くても短くてもそちらに従う)", () => {
  const gap: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4, leadSec: 0 },
    { start: 20.5, end: 30, rect: CHAIN_B, easeSec: 0.4, leadSec: 0, chainPanSec: 2.0 },
  ];
  const fullB = zoomTransformAt(25, gap, WIDTH, HEIGHT);
  // 旧 easeSec(0.4)の完了点(20.9)ではまだパンが完了していない
  // (chainPanSec=2.0 の方が長いため)
  assert.notDeepEqual(zoomTransformAt(20.9, gap, WIDTH, HEIGHT), fullB);
  // chainPanSec(2.0秒)経過後(22.5)ならパン完了
  assert.deepEqual(zoomTransformAt(22.5, gap, WIDTH, HEIGHT), fullB);
});

test("D2b: effectiveZoomRange は gap のある連鎖の尾を次区間の頭まで延長する", () => {
  const zooms: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4, leadSec: 0 },
    { start: 20.5, end: 30, rect: CHAIN_B, easeSec: 0.4, leadSec: 0 },
  ];
  const rangeA = effectiveZoomRange(zooms[0], zooms);
  assert.equal(rangeA.start, 10);
  assert.equal(rangeA.end, 20.5); // gap 区間ぶん延長(次の start まで)
  const rangeB = effectiveZoomRange(zooms[1], zooms);
  assert.equal(rangeB.start, 20.5); // 連鎖側は pre-roll しない
  assert.equal(rangeB.end, 30); // 次が無いので延長なし
});

test("D2b: 完全隣接(gap=0)は chainPanSec の影響を受けず easeSec のまま", () => {
  const chained: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4, leadSec: 0 },
    { start: 20, end: 30, rect: CHAIN_B, easeSec: 0.4, leadSec: 0, chainPanSec: 5.0 },
  ];
  // gap=0 なので chainPanSec(5.0)は無視され、easeSec(0.4)でパン完了する
  const fullB = zoomTransformAt(25, chained, WIDTH, HEIGHT);
  assert.deepEqual(zoomTransformAt(20.4, chained, WIDTH, HEIGHT), fullB);
});

test("zoomContiguous: 0 <= gap <= chainGapSec を連鎖とみなす(境界含む)", () => {
  assert.equal(zoomContiguous(20, 20, 1.5), true); // gap=0
  assert.equal(zoomContiguous(20, 21.5, 1.5), true); // gap=chainGapSec ちょうど(境界含む)
  assert.equal(zoomContiguous(20, 21.51, 1.5), false); // gap がわずかに超過
  assert.equal(zoomContiguous(20, 20 + 1e-9, 1.5), true); // 浮動小数の合成誤差
});

test("zoomContiguous: 負の gap(重なり)は chainGapSec に関わらず連鎖にしない", () => {
  assert.equal(zoomContiguous(20, 19.99, 1.5), false);
  assert.equal(zoomContiguous(20, 10, 1.5), false);
  assert.equal(zoomContiguous(20, 15, 100), false);
});

test("zoomContiguous: chainGapSec: 0 は完全隣接(1µs 以内)だけを連鎖とみなす旧仕様と等価", () => {
  assert.equal(zoomContiguous(20, 20, 0), true);
  assert.equal(zoomContiguous(20, 20 + 1e-9, 0), true);
  assert.equal(zoomContiguous(20, 20.01, 0), false);
  assert.equal(zoomContiguous(20, 19.99, 0), false);
});

// ---- OpenScreen 移植 D3(#1・D1c): 先読み(pre-roll) ----
// 既定 leadSec は DEFAULT_ZOOM_LEAD_SEC(0.5秒)。孤立ズームのみに効く
// (連鎖側は既に前 rect からのパンで入るため pre-roll しない)

test("pre-roll: 孤立ズームの effectiveZoomRange は leadSec ぶん前へ広がる", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 1.5, leadSec: 0.5 }];
  const range = effectiveZoomRange(zooms[0], zooms);
  assert.equal(range.start, 9.5);
  assert.equal(range.end, 20);
});

test("pre-roll: 連鎖側は effectiveZoomRange が z.start のまま(leadSec があっても)", () => {
  const chained: ZoomSpan[] = [
    { start: 10, end: 20, rect: CHAIN_A, easeSec: 0.4 },
    { start: 20, end: 30, rect: CHAIN_B, easeSec: 0.4, leadSec: 0.5 },
  ];
  const rangeB = effectiveZoomRange(chained[1], chained);
  assert.equal(rangeB.start, 20);
});

test("pre-roll: 区間頭で既に leadSec/easeIn まで寄っている(実効区間の頭は0、区間開始は正の進行度)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [{ start: 10, end: 20, rect, easeSec: 1.5, easeOutSec: 1.0, leadSec: 0.5 }];
  // 実効区間の頭(t = start - leadSec = 9.5)で p=0、直前は恒等
  assert.equal(zoomProgressAt(9.5, zooms), 0);
  assert.deepEqual(zoomTransformAt(9.49, zooms, WIDTH, HEIGHT), { scale: 1, translateX: 0, translateY: 0 });
  // 区間開始(t=10)では既に raw = leadSec/easeIn = 0.5/1.5 まで進んだ状態
  const atStart = zoomProgressAt(10, zooms);
  const expected = zoomEase(0.5 / 1.5, "in");
  assert.ok(Math.abs(atStart - expected) < 1e-9, `atStart=${atStart}`);
  assert.ok(atStart > 0);
});

test("pre-roll: leadSec がタイムライン先頭(0)より前へ出る場合は詰める", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  // start=0.2 しかないので leadSec=0.5 は 0.2 分しか使えない(0 へ詰まる)
  const zooms: ZoomSpan[] = [{ start: 0.2, end: 10, rect, easeSec: 1.5, leadSec: 0.5 }];
  assert.equal(effectiveZoomRange(zooms[0], zooms).start, 0);
  assert.equal(zoomProgressAt(0, zooms), 0); // タイムライン先頭(実効区間の頭)
  assert.ok(zoomProgressAt(0.1, zooms) > 0); // 詰まった pre-roll 内で進行している
});

test("pre-roll: 直前ズームの末尾より前へは出ない(隣接ズームとの間で leadSec を詰める)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const zooms: ZoomSpan[] = [
    { start: 0, end: 5, rect, easeSec: 0.4, chainGapSec: 0, leadSec: 0 },
    // gap=0.3。chainGapSec: 0 なので連鎖しない。leadSec=1.0 だが直前ズームの
    // 末尾(5)より前へは出せないので実効 lead は 0.3 に詰まる
    { start: 5.3, end: 10, rect, easeSec: 1.5, chainGapSec: 0, leadSec: 1.0 },
  ];
  assert.equal(effectiveZoomRange(zooms[1], zooms).start, 5);
  assert.equal(zoomProgressAt(5, zooms), 0); // 詰まった実効区間の頭
  assert.ok(zoomProgressAt(5.29, zooms) > 0); // 詰まった pre-roll 内で進行している
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
