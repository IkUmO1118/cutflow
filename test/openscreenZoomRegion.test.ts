// test/openscreenZoomRegion.test.ts — 忠実性の担保(P1)。OpenScreen v1.7.0
// `videoPlayback/zoomRegionUtils.test.ts` の期待値をそのまま移植して
// findDominantRegion(cursor 追従・連鎖)の逐語移植を数値一致で固定する。
// 追加で cursorFollowUtils/focusUtils の純関数(interpolateCursorAt/
// adaptiveSmoothFactor/timeCorrectedFollowFactor/clampFocusToScale)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CursorTelemetryPoint, ZoomRegion } from "../src/lib/vendor/openscreen/types.ts";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES } from "../src/lib/vendor/openscreen/types.ts";
import { findDominantRegion } from "../src/lib/vendor/openscreen/zoomRegionUtils.ts";
import {
  adaptiveSmoothFactor,
  interpolateCursorAt,
  timeCorrectedFollowFactor,
} from "../src/lib/vendor/openscreen/cursorFollowUtils.ts";
import { clampFocusToScale } from "../src/lib/vendor/openscreen/focusUtils.ts";

// vitest .toBeCloseTo(v, n) 相当(小数点以下 n 桁が一致 = |diff| < 0.5 * 10^-n)
function closeTo(actual: number, expected: number, digits: number) {
  return Math.abs(actual - expected) < 0.5 * 10 ** -digits;
}

// ---- OpenScreen zoomRegionUtils.test.ts の移植(issue #72 回帰) ----

const baseRegion: ZoomRegion = {
  id: "zoom-1",
  startMs: 0,
  endMs: 4000,
  depth: DEFAULT_ZOOM_DEPTH,
  customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
  // The static focus captured at suggestion time (e.g. the dwell centroid) — should
  // be ignored in favor of the live cursor position once focusMode is "auto". Kept
  // within the depth-3 focus bounds (~0.28-0.72) so clamping doesn't distort assertions.
  focus: { cx: 0.35, cy: 0.5 },
  focusMode: "auto",
  source: "auto",
};

// Cursor sweeps steadily from the left edge to the right edge across the region.
const movingTelemetry: CursorTelemetryPoint[] = [
  { timeMs: 0, cx: 0.1, cy: 0.5 },
  { timeMs: 2000, cx: 0.5, cy: 0.5 },
  { timeMs: 4000, cx: 0.9, cy: 0.5 },
];

test("findDominantRegion — auto-zoom: tracks the cursor across the region instead of freezing at the initial focus", () => {
  const early = findDominantRegion([baseRegion], 200, { cursorTelemetry: movingTelemetry });
  const mid = findDominantRegion([baseRegion], 2000, { cursorTelemetry: movingTelemetry });
  const late = findDominantRegion([baseRegion], 3800, { cursorTelemetry: movingTelemetry });

  assert.notEqual(early.region, null);
  assert.notEqual(mid.region, null);
  assert.notEqual(late.region, null);

  // The focus must move meaningfully between samples (cursor-following), not stay pinned.
  assert.ok((mid.region?.focus.cx ?? 0) > (early.region?.focus.cx ?? 0));
  assert.ok((late.region?.focus.cx ?? 0) > (mid.region?.focus.cx ?? 0));

  // And it must not equal the static creation-time focus baked into the region.
  assert.ok(!closeTo(mid.region?.focus.cx ?? 0, baseRegion.focus.cx, 2));
});

test("findDominantRegion — manual regions stay frozen at the static focus (unaffected by cursor)", () => {
  const manualRegion: ZoomRegion = { ...baseRegion, focusMode: "manual", source: "manual" };

  const early = findDominantRegion([manualRegion], 200, { cursorTelemetry: movingTelemetry });
  const late = findDominantRegion([manualRegion], 3800, { cursorTelemetry: movingTelemetry });

  assert.ok(closeTo(early.region?.focus.cx ?? 0, manualRegion.focus.cx, 5));
  assert.ok(closeTo(late.region?.focus.cx ?? 0, manualRegion.focus.cx, 5));
});

// ---- 追加: interpolateCursorAt(二分探索+lerp・端クランプ) ----

test("interpolateCursorAt: 空配列は null", () => {
  assert.equal(interpolateCursorAt([], 1000), null);
});

test("interpolateCursorAt: 先頭より前は先頭へクランプ", () => {
  const t = movingTelemetry;
  const r = interpolateCursorAt(t, -500);
  assert.deepEqual(r, { cx: t[0].cx, cy: t[0].cy });
});

test("interpolateCursorAt: 末尾より後は末尾へクランプ", () => {
  const t = movingTelemetry;
  const r = interpolateCursorAt(t, 999999);
  assert.deepEqual(r, { cx: t[t.length - 1].cx, cy: t[t.length - 1].cy });
});

test("interpolateCursorAt: 中間点は線形補間", () => {
  // 0ms:0.1, 2000ms:0.5 の中間 1000ms は0.3のはず
  const r = interpolateCursorAt(movingTelemetry, 1000);
  assert.ok(r !== null);
  assert.ok(closeTo(r!.cx, 0.3, 9));
  assert.ok(closeTo(r!.cy, 0.5, 9));
});

// ---- 追加: adaptiveSmoothFactor(距離ランプ) ----

test("adaptiveSmoothFactor: 距離0はminFactor", () => {
  const f = adaptiveSmoothFactor({ cx: 0.5, cy: 0.5 }, { cx: 0.5, cy: 0.5 }, 0.1, 0.25, 0.15);
  assert.ok(closeTo(f, 0.1, 9));
});

test("adaptiveSmoothFactor: 距離>=rampDistanceはmaxFactor", () => {
  const f = adaptiveSmoothFactor({ cx: 1, cy: 0.5 }, { cx: 0, cy: 0.5 }, 0.1, 0.25, 0.15);
  assert.ok(closeTo(f, 0.25, 9));
});

test("adaptiveSmoothFactor: 中間距離は線形補間", () => {
  // dx=0.075(=rampDistance/2), dy=0 -> distance=0.075 -> t=0.5
  const f = adaptiveSmoothFactor({ cx: 0.575, cy: 0.5 }, { cx: 0.5, cy: 0.5 }, 0.1, 0.25, 0.15);
  assert.ok(closeTo(f, 0.175, 9));
});

// ---- 追加: timeCorrectedFollowFactor(fps 非依存の指数収束) ----

test("timeCorrectedFollowFactor: dt==referenceMsはbaseFactorそのまま", () => {
  const f = timeCorrectedFollowFactor(0.2, 100, 100);
  assert.ok(closeTo(f, 0.2, 9));
});

test("timeCorrectedFollowFactor: dtが大きいほどfactorが大きい(単調)", () => {
  const ref = 1000 / 40;
  const small = timeCorrectedFollowFactor(0.1, ref, ref);
  const large = timeCorrectedFollowFactor(0.1, ref * 4, ref);
  assert.ok(large > small);
  assert.ok(large <= 1);
});

test("timeCorrectedFollowFactor: dt<=0 または referenceMs<=0 は0", () => {
  assert.equal(timeCorrectedFollowFactor(0.2, 0, 100), 0);
  assert.equal(timeCorrectedFollowFactor(0.2, -5, 100), 0);
  assert.equal(timeCorrectedFollowFactor(0.2, 100, 0), 0);
});

// ---- 追加: clampFocusToScale(margin = min(0.5, 1/(2*scale))) ----

test("clampFocusToScale: 範囲内のfocusはそのまま", () => {
  const r = clampFocusToScale({ cx: 0.5, cy: 0.5 }, 2);
  assert.ok(closeTo(r.cx, 0.5, 9));
  assert.ok(closeTo(r.cy, 0.5, 9));
});

test("clampFocusToScale: 範囲外のfocusはmarginへクランプされる", () => {
  const scale = 2; // margin = min(0.5, 1/(2*2)) = 0.25
  const r = clampFocusToScale({ cx: -1, cy: 2 }, scale);
  assert.ok(closeTo(r.cx, 0.25, 9));
  assert.ok(closeTo(r.cy, 0.75, 9));
});

test("clampFocusToScale: scale<=1 はmargin 0.5(中央固定)", () => {
  const r = clampFocusToScale({ cx: 0, cy: 1 }, 1);
  assert.ok(closeTo(r.cx, 0.5, 9));
  assert.ok(closeTo(r.cy, 0.5, 9));
});
