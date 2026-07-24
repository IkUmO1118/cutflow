// src/lib/cursorAnchors.ts(D2: カーソル dwell 検出 + focus→rect 変換)を固定する。
// §docs/plans/2026-07-24-openscreen-d2-dwell-suggestion-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cursorFocusToLocalPoint,
  cursorFocusToRect,
  detectDwellCandidates,
  resampleCursorTrack,
  resolveDwellWindowMs,
} from "../src/lib/cursorAnchors.ts";
import type { CursorDwellSample, DwellDetectionCfg } from "../src/lib/cursorAnchors.ts";

const BASE_CFG: DwellDetectionCfg = {
  minDwellMs: 450,
  maxDwellMs: 2600,
  moveThreshold: 0.02,
  spacingMs: 1800,
  clickBoost: 1.5,
  windowMs: 1000,
};

function sample(recTimeMs: number, cx: number, cy: number, opts: Partial<CursorDwellSample> = {}): CursorDwellSample {
  return { recTimeMs, cx, cy, inBounds: true, leftButtonPressed: false, ...opts };
}

/* ---------------- resolveDwellWindowMs ---------------- */

test("resolveDwellWindowMs: 総尺5%が1000ms超ならその値", () => {
  assert.equal(resolveDwellWindowMs(60_000), 3000);
});

test("resolveDwellWindowMs: 総尺5%が1000ms未満なら1000msの下限", () => {
  assert.equal(resolveDwellWindowMs(10_000), 1000);
});

/* ---------------- detectDwellCandidates: run 検出 ---------------- */

test("detectDwellCandidates: 大きな移動に挟まれた静止区間だけを候補にする", () => {
  const samples = [
    sample(0, 0, 0),
    sample(50, 0.9, 0.9), // 大移動→直前の run(1点)を打ち切り
    // 静止区間: t=100..1100(1000ms)、cx/cy はほぼ一定
    sample(100, 0.5, 0.5),
    sample(300, 0.5, 0.5),
    sample(500, 0.5, 0.5),
    sample(700, 0.5, 0.5),
    sample(900, 0.5, 0.5),
    sample(1100, 0.5, 0.5),
    sample(1150, 0.1, 0.9), // 大移動→静止 run を打ち切り
    sample(1200, 0.1, 0.9), // 短い run(50ms)は minDwellMs 未満
  ];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].startMs === undefined, false);
  assert.equal(candidates[0].centerMs, 600); // (100+1100)/2
  assert.ok(Math.abs(candidates[0].focus.cx - 0.5) < 1e-9);
  assert.ok(Math.abs(candidates[0].focus.cy - 0.5) < 1e-9);
  assert.equal(candidates[0].strength, 1000);
  assert.equal(candidates[0].clickBoosted, false);
});

test("detectDwellCandidates: minDwellMs 未満の run は候補にしない", () => {
  const samples = [sample(0, 0.5, 0.5), sample(300, 0.5, 0.5)]; // 300ms < 450ms
  assert.deepEqual(detectDwellCandidates(samples, BASE_CFG), []);
});

test("detectDwellCandidates: maxDwellMs 超の run は候補にしない(長時間の作業と区別)", () => {
  const samples = [sample(0, 0.5, 0.5), sample(3000, 0.5, 0.5)]; // 3000ms > 2600ms
  assert.deepEqual(detectDwellCandidates(samples, BASE_CFG), []);
});

test("detectDwellCandidates: moveThreshold 未満の微小な移動では run を切らない", () => {
  const samples = [
    sample(0, 0.5, 0.5),
    sample(500, 0.505, 0.5), // 距離0.005 < moveThreshold(0.02)
    sample(1000, 0.505, 0.5),
  ];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].centerMs, 500);
});

test("detectDwellCandidates: inBounds:false のサンプルは除外する", () => {
  const samples = [
    sample(0, 0.5, 0.5),
    sample(300, 0.99, 0.99, { inBounds: false }), // 除外されるので run を切らない
    sample(600, 0.5, 0.5),
  ];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].centerMs, 300); // (0+600)/2、除外後の2点間
});

test("detectDwellCandidates: 未ソートの入力でも時刻順に扱う", () => {
  const samples = [sample(600, 0.5, 0.5), sample(0, 0.5, 0.5)];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].centerMs, 300);
});

/* ---------------- detectDwellCandidates: 貪欲採用(spacing/window) ---------------- */

test("detectDwellCandidates: spacingMs 未満の候補は strength の低い方を間引く", () => {
  const samples = [
    // run A: t=0..1000(1000ms) → strength=1000
    sample(0, 0.2, 0.2),
    sample(1000, 0.2, 0.2),
    sample(1050, 0.9, 0.9), // 大移動
    // run B: t=1100..1900(800ms) → strength=800。中心1500msはAの中心500msから
    // 1000ms しか離れておらずspacingMs(1800)未満→間引かれる
    sample(1100, 0.6, 0.6),
    sample(1900, 0.6, 0.6),
  ];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].centerMs, 500); // strength の強い run A が残る
});

test("detectDwellCandidates: spacingMs 以上離れていれば両方採用する", () => {
  const samples = [
    sample(0, 0.2, 0.2),
    sample(1000, 0.2, 0.2), // run A center=500
    sample(1050, 0.9, 0.9),
    sample(3000, 0.6, 0.6),
    sample(3600, 0.6, 0.6), // run B center=3300、Aから2800ms以上離れている
  ];
  const candidates = detectDwellCandidates(samples, BASE_CFG);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.centerMs), [500, 3300]);
});

test("detectDwellCandidates: クリック起点ボーナスで採用順位が逆転する", () => {
  const withoutClick = {
    ...BASE_CFG,
    clickBoost: 1, // 無効化
  };
  const samples = [
    // run A(クリック無し): t=0..1000(1000ms)、center=500
    sample(0, 0.2, 0.2),
    sample(1000, 0.2, 0.2),
    sample(1050, 0.9, 0.9),
    // run B(クリック起点。run 先頭サンプルが leftButtonPressed): t=1100..1900(800ms)、
    // center=1500。Aとspacing競合(差1000<1800)
    sample(1100, 0.6, 0.6, { leftButtonPressed: true }),
    sample(1900, 0.6, 0.6),
  ];
  const withoutBoost = detectDwellCandidates(samples, withoutClick);
  assert.equal(withoutBoost.length, 1);
  assert.equal(withoutBoost[0].centerMs, 500); // strength(A)=1000 > strength(B)=800

  const withBoost = detectDwellCandidates(samples, BASE_CFG); // clickBoost=1.5
  assert.equal(withBoost.length, 1);
  assert.equal(withBoost[0].centerMs, 1500); // strength(B)=800*1.5=1200 > strength(A)=1000
  assert.equal(withBoost[0].clickBoosted, true);
});

test("detectDwellCandidates: 候補の startMs/endMs は windowMs 幅で中心に張る", () => {
  const samples = [sample(0, 0.5, 0.5), sample(1000, 0.5, 0.5)];
  const candidates = detectDwellCandidates(samples, { ...BASE_CFG, windowMs: 2000 });
  assert.equal(candidates[0].startMs, -500); // 500 - 2000/2
  assert.equal(candidates[0].endMs, 1500);
});

/* ---------------- cursorFocusToLocalPoint / cursorFocusToRect ---------------- */

test("cursorFocusToLocalPoint: obs-canvas はキャンバス上の screenRegion オフセットを差し引く", () => {
  const point = cursorFocusToLocalPoint(
    { cx: 0.5, cy: 0.5 },
    {
      layout: "obs-canvas",
      screenRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
      recordingWidth: 3840,
      recordingHeight: 1080,
      defaultScale: 2.5,
    },
  );
  // キャンバス絶対座標は 1920+960=2880 だが、screenRegion ローカルでは 960
  assert.deepEqual(point, { x: 960, y: 540 });
});

test("cursorFocusToLocalPoint: obs-canvas でオフセット0のときは cx*w と一致する", () => {
  const point = cursorFocusToLocalPoint(
    { cx: 0.25, cy: 0.75 },
    {
      layout: "obs-canvas",
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      recordingWidth: 3840,
      recordingHeight: 1080,
      defaultScale: 2.5,
    },
  );
  assert.deepEqual(point, { x: 480, y: 810 });
});

test("cursorFocusToLocalPoint: plain は screenRegion 全体(=収録実寸)へ直接写像", () => {
  const point = cursorFocusToLocalPoint(
    { cx: 0.5, cy: 0.5 },
    {
      layout: "plain",
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      recordingWidth: 1920,
      recordingHeight: 1080,
      defaultScale: 2.5,
    },
  );
  assert.deepEqual(point, { x: 960, y: 540 });
});

test("cursorFocusToRect: defaultScale で screenRegion を割ったサイズを focus 中心に置く", () => {
  const rect = cursorFocusToRect(
    { cx: 0.5, cy: 0.5 },
    {
      layout: "plain",
      screenRegion: { x: 0, y: 0, w: 1000, h: 500 },
      recordingWidth: 1000,
      recordingHeight: 500,
      defaultScale: 2,
    },
  );
  // point=(500,250), w=500, h=250 → x=500-250=250, y=250-125=125
  assert.deepEqual(rect, { x: 250, y: 125, w: 500, h: 250 });
});

test("cursorFocusToRect: 画面端の focus は矩形が画面外へはみ出しうる(clamp は呼び出し側の責務)", () => {
  const rect = cursorFocusToRect(
    { cx: 0, cy: 0 },
    {
      layout: "plain",
      screenRegion: { x: 0, y: 0, w: 1000, h: 500 },
      recordingWidth: 1000,
      recordingHeight: 500,
      defaultScale: 2,
    },
  );
  assert.ok(rect.x < 0);
  assert.ok(rect.y < 0);
});

/* ---------------- resampleCursorTrack(D7) ---------------- */

test("resampleCursorTrack: rateHz のバケット幅で平均し、小数3桁へ丸める", () => {
  const samples: CursorDwellSample[] = [
    sample(0, 0.111111, 0.222222),
    sample(30, 0.2, 0.3),
    sample(120, 0.5, 0.6), // 次のバケット(rateHz=10→100ms幅)へ
  ];
  const points = resampleCursorTrack(samples, 0, 200, { rateHz: 10 });
  assert.equal(points.length, 2);
  assert.equal(points[0].tMs, 50); // バケット[0,100)の中心
  assert.equal(points[0].cx, Math.round(((0.111111 + 0.2) / 2) * 1000) / 1000);
  assert.equal(points[1].tMs, 150); // バケット[100,200)の中心
  assert.equal(points[1].cx, 0.5);
});

test("resampleCursorTrack: サンプルが無いバケットは出力しない(補間しない)", () => {
  const samples: CursorDwellSample[] = [sample(0, 0.1, 0.1), sample(500, 0.9, 0.9)];
  const points = resampleCursorTrack(samples, 0, 500, { rateHz: 10 });
  // 先頭バケットと末尾直前のバケットにしかサンプルが無い(中間は空)
  assert.ok(points.length < 5);
  assert.ok(points.every((p) => p.cx === 0.1 || p.cx === 0.9));
});

test("resampleCursorTrack: inBounds:false のサンプルは無視する", () => {
  const samples: CursorDwellSample[] = [sample(0, 0.9, 0.9, { inBounds: false })];
  assert.deepEqual(resampleCursorTrack(samples, 0, 100, { rateHz: 10 }), []);
});

test("resampleCursorTrack: 範囲外のサンプルは無視する", () => {
  const samples: CursorDwellSample[] = [sample(-100, 0.9, 0.9), sample(1000, 0.9, 0.9)];
  assert.deepEqual(resampleCursorTrack(samples, 0, 500, { rateHz: 10 }), []);
});

test("resampleCursorTrack: 空区間・0以下の rateHz は空配列", () => {
  const samples: CursorDwellSample[] = [sample(0, 0.5, 0.5)];
  assert.deepEqual(resampleCursorTrack(samples, 100, 100, { rateHz: 10 }), []);
  assert.deepEqual(resampleCursorTrack(samples, 0, 100, { rateHz: 0 }), []);
});
