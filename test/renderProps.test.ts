// lib/renderProps.ts — 編集ファイル群からカット後の RenderProps を組む純関数。
// render とエディタのプレビューが同じ絵になることの土台。レイヤー順の正規化と
// テロップのカット後写像を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderProps,
  capCountOf,
  normalizeLayerOrder,
  ovCountOf,
} from "../src/lib/renderProps.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest, Overlays, Transcript } from "../src/types.ts";

test("normalizeLayerOrder: 省略時は素材2トラックの既定順", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1), ["ov1", "wipe", "ov2", "caption"]);
});

test("normalizeLayerOrder: 旧形式(ovUnder/chapter)を読み替え・破棄", () => {
  // ovUnder→ov1、chapter は黙って捨てる。欠けた wipe/caption/ov2 は補完される
  const order = normalizeLayerOrder(["ovUnder", "chapter", "wipe"], 1, 1);
  assert.ok(order.includes("ov1"));
  assert.ok(!order.includes("chapter" as never));
  assert.ok(order.includes("wipe"));
  assert.ok(order.includes("caption"));
});

test("capCountOf / ovCountOf: 参照される最大トラック番号(最低1)", () => {
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a", track: 3 }] } as Transcript), 3);
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a" }] } as Transcript), 1);
  assert.equal(ovCountOf({ overlays: [{ start: 0, end: 1, file: "x.png", track: 2 }] } as Overlays), 2);
  assert.equal(ovCountOf({} as Overlays), 1);
});

const manifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
};

test("buildRenderProps: カット内のテロップは落ち、尺は keep の合計", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  const transcript: Transcript = {
    segments: [
      { start: 2, end: 5, text: "残る" },
      { start: 12, end: 14, text: "カット内で消える" },
    ],
  };
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    overlayExists: () => true,
    warn: () => {},
  });

  assert.equal(props.durationSec, 20); // 10 + 10
  assert.equal(props.captions.length, 1);
  assert.equal(props.captions[0].text, "残る");
  assert.deepEqual(
    { start: props.captions[0].start, end: props.captions[0].end },
    { start: 2, end: 5 },
  );
  assert.deepEqual(props.layerOrder, ["ov1", "wipe", "ov2", "caption"]);
});
