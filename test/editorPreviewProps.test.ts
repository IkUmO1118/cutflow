import { test } from "node:test";
import assert from "node:assert/strict";
import { videoFileForPreview } from "../editor/client/model.ts";
import type { Manifest } from "../src/types.ts";

const manifest = (layout: Manifest["layout"]): Manifest => ({
  dir: "/tmp/project",
  source: "raw.wav",
  durationSec: 10,
  layout,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  },
  audio: {
    micStream: 0,
    systemStream: null,
    micWav: "mic.wav",
  },
  createdAt: "2026-08-02T00:00:00.000Z",
});

test("videoFileForPreview: stills のプレビュー props は videoFile を空にする", () => {
  assert.equal(videoFileForPreview(manifest("stills")), "");
});

test("videoFileForPreview: 動画レイアウトは従来どおり proxy.mp4 を使う", () => {
  assert.equal(videoFileForPreview(manifest("plain")), "media/proxy.mp4");
});
