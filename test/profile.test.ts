import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLayout,
  CANVAS_SIZES,
  isCanvasPreset,
  outputSize,
  resolveBaseLayoutKind,
  resolveCanvas,
  screenContentRect,
} from "../src/lib/profile.ts";
import type { Manifest } from "../src/types.ts";

const manifest = (canvas?: string, baseLayout?: string, camera = false): Manifest => ({
  dir: "/tmp", source: "raw.mp4", durationSec: 10, layout: camera ? "obs-canvas" : "plain",
  ...(canvas ? { canvas } : {}),
  ...(baseLayout ? { baseLayout } : {}),
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    ...(camera ? { cameraRegion: { x: 1920, y: 0, w: 960, h: 540 } } : {}),
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-08-02T00:00:00Z",
});

test("resolveCanvas: canvas 省略は screenRegion 寸法で layout 無し", () => {
  assert.deepEqual(resolveCanvas(manifest()), { width: 1920, height: 1080 });
});

test("resolveCanvas: portrait + camera は 1080x1920 + camera/screen パネル", () => {
  const profile = resolveCanvas(manifest("portrait", undefined, true));
  assert.equal(profile.width, 1080);
  assert.equal(profile.height, 1920);
  assert.deepEqual(profile.layout?.panels.map((p) => p.source), ["camera", "screen"]);
});

test("resolveCanvas: 未知の canvas は throw", () => {
  assert.throws(() => resolveCanvas(manifest("not-a-canvas")), /未知の canvas/);
  assert.throws(() => resolveCanvas(manifest("toString")), /未知の canvas/);
  assert.throws(() => resolveCanvas(manifest("portrait", "not-a-layout")), /未知の baseLayout/);
});

test("outputSize は resolveCanvas の width/height と一致", () => {
  for (const name of Object.keys(CANVAS_SIZES)) {
    const profile = resolveCanvas(manifest(name));
    assert.deepEqual(outputSize(manifest(name)), { w: profile.width, h: profile.height });
  }
});

test("square / portrait-4x5 は screen contain + 下部テロップ帯", () => {
  assert.deepEqual(outputSize(manifest("square")), { w: 1080, h: 1080 });
  assert.deepEqual(outputSize(manifest("portrait-4x5")), { w: 1080, h: 1350 });
  assert.equal(resolveCanvas(manifest("square")).layout?.panels[0].fit, "contain");
  assert.equal(resolveCanvas(manifest("portrait-4x5")).layout?.panels[0].fit, "contain");
});

test("screenContentRect: portrait-screen 旧キーは screen contain 座標を実映像矩形へ写像", () => {
  assert.deepEqual(screenContentRect(manifest("portrait-screen")), {
    x: 0, y: 440.25, w: 1080, h: 607.5,
  });
});

test("buildLayout: panels はキャンバス内に収まり、stack は隙間なく上下分割する", () => {
  for (const kind of ["screen", "camera", "stack"] as const) {
    const layout = buildLayout(kind, { width: 1080, height: 1921 });
    for (const panel of layout.panels) {
      const r = panel.rect!;
      assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0);
      assert.ok(r.x + r.w <= 1080);
      assert.ok(r.y + r.h <= 1921);
    }
  }
  const stack = buildLayout("stack", { width: 1080, height: 1921 });
  const a = stack.panels[0].rect!;
  const b = stack.panels[1].rect!;
  assert.equal(a.y + a.h, b.y);
  assert.equal(b.y + b.h, stack.caption!.y * 2 - 1921);
});

test("buildLayout: 同じ kind は寸法違いでも主要比率が一致し、fontScale は幅比例", () => {
  const square = buildLayout("screen", { width: 1080, height: 1080 });
  const fourByFive = buildLayout("screen", { width: 1080, height: 1350 });
  assert.equal(square.panels[0].rect!.h / 1080, fourByFive.panels[0].rect!.h / 1350);
  assert.equal(square.caption!.y / 1080, fourByFive.caption!.y / 1350);
  assert.equal(resolveCanvas(manifest("portrait")).layout!.caption!.fontScale! * 2, resolveCanvas(manifest("portrait-4k")).layout!.caption!.fontScale);
});

test("旧 canvas キーは新しい canvas/baseLayout として解決される", () => {
  assert.equal(isCanvasPreset("portrait-cover"), true);
  assert.deepEqual(resolveCanvas(manifest("portrait-cover")).layout?.panels.map((p) => p.source), ["camera"]);
  assert.deepEqual(resolveCanvas(manifest("portrait-screen")).layout?.panels.map((p) => p.source), ["screen"]);
  assert.deepEqual(resolveCanvas(manifest("portrait", undefined, true)).layout?.panels.map((p) => p.source), ["camera", "screen"]);
});

test("resolveBaseLayoutKind: auto は横長 layout 無し、縦はカメラ有無で stack/screen", () => {
  assert.equal(resolveBaseLayoutKind(manifest("landscape")), null);
  assert.equal(resolveBaseLayoutKind(manifest("portrait", undefined, true)), "stack");
  assert.equal(resolveBaseLayoutKind(manifest("portrait")), "screen");
  assert.equal(resolveBaseLayoutKind(manifest("landscape", "camera")), "camera");
});
