// test/zoomRuntimeTrack.test.ts — 忠実性の担保(P2)。
// `src/lib/zoomRuntimeTrack.ts`(OpenScreen frameRenderer.ts:updateAnimationState の逐語
// ミラー・決定論 precompute)を、同じ vendored 関数を使った独立の参照実装(このファイル内で
// 別途書き下ろしたループ)と突き合わせて軌跡が一致することを固定する(golden トレース =
// 合成順序の忠実性の担保)。加えて決定論・静止/移動カーソルの追従・manual 区間への spring・
// dt>80 リセットを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildZoomRuntimeTrack, type ZoomRuntimeFrame } from "../src/lib/zoomRuntimeTrack.ts";
import type { CursorTelemetryPoint, ZoomFocus, ZoomRegion } from "../src/lib/vendor/openscreen/types.ts";
import { getZoomScale } from "../src/lib/vendor/openscreen/types.ts";
import { findDominantRegion } from "../src/lib/vendor/openscreen/zoomRegionUtils.ts";
import { AUTO_FOLLOW_PARAMS, DEFAULT_FOCUS } from "../src/lib/vendor/openscreen/constants.ts";
import { advanceFollowFocus } from "../src/lib/vendor/openscreen/cursorFollowUtils.ts";
import { clampFocusToScale } from "../src/lib/vendor/openscreen/focusUtils.ts";
import { computeFocusFromTransform, computeZoomTransform } from "../src/lib/vendor/openscreen/zoomTransform.ts";
import {
  createZoomSpringState,
  resetZoomSpring,
  stepZoomSpring,
} from "../src/lib/vendor/openscreen/zoomSpring.ts";

const STAGE = { width: 1920, height: 1080 };
const MASK = { x: 0, y: 0, width: 1920, height: 1080 };
const FPS = 30;

// ---- 独立の参照実装(frameRenderer.ts:785-932 の別途書き下ろし) ----
// buildZoomRuntimeTrack を呼ばず、同じ vendored プリミティブだけを使って独自にループを
// 組み立てる。これが golden トレースの基準になる。
function referenceUpdateAnimationState(
  regions: ZoomRegion[],
  cursorTelemetry: CursorTelemetryPoint[] | undefined,
  fps: number,
  startFrame: number,
  endFrame: number,
): ZoomRuntimeFrame[] {
  let smoothedAutoFocus: ZoomFocus | null = null;
  let prevTargetProgress = 0;
  let prevAnimationTimeMs: number | null = null;
  const spring = createZoomSpringState();
  const out: ZoomRuntimeFrame[] = [];

  for (let f = startFrame; f <= endFrame; f += 1) {
    const timeMs = (f / fps) * 1000;
    const { region, strength, blendedScale, transition } = findDominantRegion(regions, timeMs, {
      connectZooms: true,
      cursorTelemetry,
    });

    let targetScale = 1;
    let targetFocus: ZoomFocus = { ...DEFAULT_FOCUS };
    let targetProgress = 0;

    if (region && strength > 0) {
      const zoomScale = blendedScale ?? getZoomScale(region);
      targetFocus = clampFocusToScale(region.focus, zoomScale);
      targetScale = zoomScale;
      targetProgress = strength;

      if (region.focusMode === "auto" && !transition) {
        const raw = targetFocus;
        const dtMs = prevAnimationTimeMs != null ? timeMs - prevAnimationTimeMs : 0;
        const isZoomingIn = targetProgress < 0.999 && targetProgress >= prevTargetProgress;
        if (targetProgress >= 0.999) {
          const prev = smoothedAutoFocus ?? raw;
          smoothedAutoFocus = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
          targetFocus = smoothedAutoFocus;
        } else if (isZoomingIn) {
          smoothedAutoFocus = raw;
        } else {
          const prev = smoothedAutoFocus ?? raw;
          smoothedAutoFocus = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
          targetFocus = smoothedAutoFocus;
        }
      } else if (region.focusMode !== "auto") {
        smoothedAutoFocus = null;
      }

      prevTargetProgress = targetProgress;

      if (transition) {
        const startT = computeZoomTransform({
          stageSize: STAGE,
          baseMask: MASK,
          zoomScale: transition.startScale,
          zoomProgress: 1,
          focusX: transition.startFocus.cx,
          focusY: transition.startFocus.cy,
        });
        const endT = computeZoomTransform({
          stageSize: STAGE,
          baseMask: MASK,
          zoomScale: transition.endScale,
          zoomProgress: 1,
          focusX: transition.endFocus.cx,
          focusY: transition.endFocus.cy,
        });
        const interp = {
          scale: startT.scale + (endT.scale - startT.scale) * transition.progress,
          x: startT.x + (endT.x - startT.x) * transition.progress,
          y: startT.y + (endT.y - startT.y) * transition.progress,
        };
        targetScale = interp.scale;
        targetFocus = computeFocusFromTransform({
          stageSize: STAGE,
          baseMask: MASK,
          zoomScale: interp.scale,
          x: interp.x,
          y: interp.y,
        });
        targetProgress = 1;
      }
    }

    const projected = computeZoomTransform({
      stageSize: STAGE,
      baseMask: MASK,
      zoomScale: targetScale,
      zoomProgress: targetProgress,
      focusX: targetFocus.cx,
      focusY: targetFocus.cy,
    });

    const dtMs = prevAnimationTimeMs != null ? timeMs - prevAnimationTimeMs : 0;
    let applied: { scale: number; x: number; y: number };
    if (prevAnimationTimeMs == null || dtMs <= 0 || dtMs > 80) {
      resetZoomSpring(spring, projected);
      applied = { scale: projected.scale, x: projected.x, y: projected.y };
    } else {
      applied = stepZoomSpring(spring, projected, dtMs);
    }

    prevAnimationTimeMs = timeMs;
    out.push({ f, scale: applied.scale, x: applied.x, y: applied.y });
  }

  return out;
}

// ---- 固定入力(golden トレース用) ----
// region A: auto(カーソル追従)0-4000ms、region B: manual 5000-8000ms。
// gap = 5000-4000 = 1000ms <= CHAINED_ZOOM_PAN_GAP_MS(1500) なので連鎖する。
const regionA: ZoomRegion = {
  id: "regionA",
  startMs: 0,
  endMs: 4000,
  depth: 3,
  customScale: 1.8,
  focus: { cx: 0.4, cy: 0.5 },
  focusMode: "auto",
};
const regionB: ZoomRegion = {
  id: "regionB",
  startMs: 5000,
  endMs: 8000,
  depth: 3,
  customScale: 1.8,
  focus: { cx: 0.6, cy: 0.5 },
  focusMode: "manual",
};
const CHAIN_REGIONS: ZoomRegion[] = [regionA, regionB];

// カーソルは cx 0.2→0.8 を 0..8000ms で線形に横切る(cy は固定)。
function sweepTelemetry(fromMs: number, toMs: number, stepMs: number): CursorTelemetryPoint[] {
  const points: CursorTelemetryPoint[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const ratio = (t - 0) / 8000;
    const cx = 0.2 + 0.6 * Math.min(1, Math.max(0, ratio));
    points.push({ timeMs: t, cx, cy: 0.5 });
  }
  return points;
}
const MOVING_TELEMETRY = sweepTelemetry(0, 9500, 50);

// 全区間(leadIn/leadOut/連鎖 transition 込み)をカバー。
const START_FRAME = 0;
const END_FRAME = Math.ceil((9500 / 1000) * FPS);

test("golden trace: buildZoomRuntimeTrack matches an independent transcription of the same loop (composition order)", () => {
  const actual = buildZoomRuntimeTrack({
    regions: CHAIN_REGIONS,
    cursorTelemetry: MOVING_TELEMETRY,
    fps: FPS,
    stageSize: STAGE,
    baseMask: MASK,
    startFrame: START_FRAME,
    endFrame: END_FRAME,
  });
  const expected = referenceUpdateAnimationState(
    CHAIN_REGIONS,
    MOVING_TELEMETRY,
    FPS,
    START_FRAME,
    END_FRAME,
  );

  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    assert.equal(actual[i].f, expected[i].f, `frame index mismatch at ${i}`);
    assert.equal(actual[i].scale, expected[i].scale, `scale mismatch at frame ${actual[i].f}`);
    assert.equal(actual[i].x, expected[i].x, `x mismatch at frame ${actual[i].f}`);
    assert.equal(actual[i].y, expected[i].y, `y mismatch at frame ${actual[i].f}`);
  }
});

test("determinism: identical input produces a byte-identical (deep-equal) track across calls", () => {
  const build = () =>
    buildZoomRuntimeTrack({
      regions: CHAIN_REGIONS,
      cursorTelemetry: MOVING_TELEMETRY,
      fps: FPS,
      stageSize: STAGE,
      baseMask: MASK,
      startFrame: START_FRAME,
      endFrame: END_FRAME,
    });

  const first = build();
  const second = build();
  assert.deepEqual(first, second);
});

test("static cursor: focus/transform stays constant during a full-zoom hold", () => {
  const staticTelemetry: CursorTelemetryPoint[] = [{ timeMs: 0, cx: 0.5, cy: 0.5 }];
  const region: ZoomRegion = {
    id: "static-hold",
    startMs: 0,
    endMs: 6000,
    depth: 3,
    customScale: 1.8,
    focus: { cx: 0.5, cy: 0.5 },
    focusMode: "auto",
  };
  const track = buildZoomRuntimeTrack({
    regions: [region],
    cursorTelemetry: staticTelemetry,
    fps: FPS,
    stageSize: STAGE,
    baseMask: MASK,
    startFrame: 0,
    endFrame: Math.ceil((6000 / 1000) * FPS),
  });

  // Sample deep into the hold (well past lead-in and spring settling, well before lead-out).
  const holdFrames = track.filter((frame) => {
    const t = (frame.f / FPS) * 1000;
    return t > 1500 && t < 5000;
  });
  assert.ok(holdFrames.length > 10, "expected multiple frames in the hold window");
  const first = holdFrames[0];
  for (const frame of holdFrames) {
    assert.ok(Math.abs(frame.scale - first.scale) < 1e-6, `scale drifted at f=${frame.f}`);
    assert.ok(Math.abs(frame.x - first.x) < 1e-6, `x drifted at f=${frame.f}`);
    assert.ok(Math.abs(frame.y - first.y) < 1e-6, `y drifted at f=${frame.f}`);
  }
});

test("moving cursor: transform follows the cursor across the hold (auto region)", () => {
  const track = buildZoomRuntimeTrack({
    regions: [regionA],
    cursorTelemetry: MOVING_TELEMETRY,
    fps: FPS,
    stageSize: STAGE,
    baseMask: MASK,
    startFrame: 0,
    endFrame: Math.ceil((4000 / 1000) * FPS),
  });

  const early = track.find((frame) => (frame.f / FPS) * 1000 >= 1000);
  const late = track.find((frame) => (frame.f / FPS) * 1000 >= 3500);
  assert.ok(early && late, "expected samples early and late in the hold");
  assert.notEqual(early!.x, late!.x, "x should change as the cursor sweeps across the region");
});

test("manual region also gets spring: zoom-in ramps in smoothly (first active frame's scale is strictly between 1 and target)", () => {
  const region: ZoomRegion = {
    id: "manual-only",
    startMs: 3000,
    endMs: 6000,
    depth: 3,
    customScale: 1.8,
    focus: { cx: 0.5, cy: 0.5 },
    // focusMode omitted = manual (back-compat default).
  };
  const track = buildZoomRuntimeTrack({
    regions: [region],
    cursorTelemetry: undefined,
    fps: FPS,
    stageSize: STAGE,
    baseMask: MASK,
    startFrame: 0,
    endFrame: Math.ceil((7000 / 1000) * FPS),
  });

  const firstActive = track.find((frame) => frame.scale > 1 + 1e-9);
  assert.ok(firstActive, "expected the zoom to become active at some frame");
  assert.ok(firstActive!.scale > 1, `expected scale > 1, got ${firstActive!.scale}`);
  assert.ok(firstActive!.scale < 1.8, `expected scale < target 1.8, got ${firstActive!.scale}`);
});

test("dt>80 resets the spring: at low fps every frame snaps straight to the projected transform", () => {
  const region: ZoomRegion = {
    id: "low-fps",
    startMs: 0,
    endMs: 3000,
    depth: 3,
    customScale: 1.8,
    focus: { cx: 0.5, cy: 0.5 },
    focusMode: "manual",
  };
  const lowFps = 10; // dt = 100ms > 80ms between every frame.
  const endFrame = Math.ceil((4000 / 1000) * lowFps);
  const track = buildZoomRuntimeTrack({
    regions: [region],
    cursorTelemetry: undefined,
    fps: lowFps,
    stageSize: STAGE,
    baseMask: MASK,
    startFrame: 0,
    endFrame,
  });

  for (const frame of track) {
    const timeMs = (frame.f / lowFps) * 1000;
    const { region: activeRegion, strength, blendedScale } = findDominantRegion([region], timeMs, {
      connectZooms: true,
      cursorTelemetry: undefined,
    });
    let scale = 1;
    let focus: ZoomFocus = { ...DEFAULT_FOCUS };
    let progress = 0;
    if (activeRegion && strength > 0) {
      const zoomScale = blendedScale ?? getZoomScale(activeRegion);
      focus = clampFocusToScale(activeRegion.focus, zoomScale);
      scale = zoomScale;
      progress = strength;
    }
    const direct = computeZoomTransform({
      stageSize: STAGE,
      baseMask: MASK,
      zoomScale: scale,
      zoomProgress: progress,
      focusX: focus.cx,
      focusY: focus.cy,
    });
    assert.ok(Math.abs(frame.scale - direct.scale) < 1e-9, `scale mismatch at f=${frame.f}`);
    assert.ok(Math.abs(frame.x - direct.x) < 1e-9, `x mismatch at f=${frame.f}`);
    assert.ok(Math.abs(frame.y - direct.y) < 1e-9, `y mismatch at f=${frame.f}`);
  }
});
