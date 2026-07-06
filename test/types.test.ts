// src/types.ts — manifest のレイアウト判定(plain/obs-canvas)の純関数を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasCamera, manifestLayout } from "../src/types.ts";
import type { Manifest } from "../src/types.ts";

const obsManifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 3840,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

test("manifestLayout: 未指定は obs-canvas(旧 manifest 互換)", () => {
  assert.equal(manifestLayout({}), "obs-canvas");
  assert.equal(manifestLayout({ layout: undefined }), "obs-canvas");
});

test("manifestLayout: plain 明示は plain", () => {
  assert.equal(manifestLayout({ layout: "plain" }), "plain");
});

test("manifestLayout: obs-canvas 明示は obs-canvas", () => {
  assert.equal(manifestLayout({ layout: "obs-canvas" }), "obs-canvas");
});

test("hasCamera: obs-canvas で cameraRegion があれば true", () => {
  assert.equal(hasCamera(obsManifest), true);
});

test("hasCamera: layout 無し(旧 manifest)でも cameraRegion があれば true", () => {
  const { layout: _layout, ...rest } = obsManifest;
  assert.equal(hasCamera(rest as Manifest), true);
});

test("hasCamera: plain(cameraRegion 無し)は false", () => {
  const plain: Manifest = {
    ...obsManifest,
    layout: "plain",
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    },
  };
  assert.equal(hasCamera(plain), false);
});

test("hasCamera: obs-canvas なのに cameraRegion 欠落(壊れたデータ)は false", () => {
  const broken: Manifest = {
    ...obsManifest,
    video: { width: 3840, height: 1080, fps: 30, screenRegion: obsManifest.video.screenRegion },
  };
  assert.equal(hasCamera(broken), false);
});
