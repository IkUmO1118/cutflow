import { test } from "node:test";
import assert from "node:assert/strict";
import { CANVAS_PRESETS, outputSize, resolveCanvas, screenContentRect } from "../src/lib/profile.ts";
import type { Manifest } from "../src/types.ts";

const manifest = (canvas?: string): Manifest => ({
  dir: "/tmp", source: "raw.mp4", durationSec: 10, layout: "plain",
  ...(canvas ? { canvas } : {}),
  video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-08-02T00:00:00Z",
});

test("resolveCanvas: canvas 省略は screenRegion 寸法で layout 無し", () => {
  assert.deepEqual(resolveCanvas(manifest()), { width: 1920, height: 1080 });
});

test("resolveCanvas: portrait は 1080x1920 + camera/screen パネル", () => {
  const profile = resolveCanvas(manifest("portrait"));
  assert.equal(profile.width, 1080);
  assert.equal(profile.height, 1920);
  assert.deepEqual(profile.layout?.panels.map((p) => p.source), ["camera", "screen"]);
});

test("resolveCanvas: 未知の canvas は throw", () => {
  assert.throws(() => resolveCanvas(manifest("not-a-canvas")), /未知の canvas/);
  assert.throws(() => resolveCanvas(manifest("toString")), /未知の canvas/);
});

test("outputSize は resolveCanvas の width/height と一致", () => {
  for (const name of Object.keys(CANVAS_PRESETS)) {
    const profile = resolveCanvas(manifest(name));
    assert.deepEqual(outputSize(manifest(name)), { w: profile.width, h: profile.height });
  }
});

test("square / portrait-4x5 は screen contain + 下部テロップ帯", () => {
  assert.deepEqual(outputSize(manifest("square")), { w: 1080, h: 1080 });
  assert.deepEqual(outputSize(manifest("portrait-4x5")), { w: 1080, h: 1350 });
  assert.equal(CANVAS_PRESETS.square.layout?.panels[0].fit, "contain");
  assert.equal(CANVAS_PRESETS["portrait-4x5"].layout?.panels[0].fit, "contain");
});

test("screenContentRect: portrait-screen の contain 座標を実映像矩形へ写像", () => {
  assert.deepEqual(screenContentRect(manifest("portrait-screen")), {
    x: 0, y: 416.25, w: 1080, h: 607.5,
  });
});
