import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previewBaseVideoMountKey,
  previewBaseVideoOf,
} from "../editor/client/previewCut.ts";
import { previewCutKeepSignature } from "../src/lib/previewCutSignature.ts";
import { buildRenderProps } from "../src/lib/renderProps.ts";
import type { Config } from "../src/lib/config.ts";
import type { CutPlan, Manifest, Overlays, Transcript } from "../src/types.ts";

const PLAN: CutPlan = {
  approved: false,
  segments: [
    { start: 0, end: 10, action: "keep", reason: "first", speed: 2 },
    { start: 10, end: 20, action: "cut", reason: "gap" },
    { start: 20, end: 30, action: "keep", reason: "second" },
  ],
};

const SOURCE_VIDEO = { videoFile: "media/proxy.mp4", videoIsSource: true };
const BAKED_VIDEO = { videoFile: "media/preview-cut.mp4", videoIsSource: false };

test("previewBaseVideoOf: 本編のready署名が現在keepと一致するときだけ連続ベイクを選ぶ", () => {
  const ready = { ready: true, keepSignature: previewCutKeepSignature(PLAN) };
  assert.deepEqual(
    previewBaseVideoOf({ cutplan: PLAN, previewCut: ready, shortMode: false, proxyStale: false }),
    BAKED_VIDEO,
  );

  assert.deepEqual(
    previewBaseVideoOf({
      cutplan: PLAN,
      previewCut: { ready: false, keepSignature: "" },
      shortMode: false,
      proxyStale: false,
    }),
    SOURCE_VIDEO,
    "preview-cut 欠落時",
  );
  assert.deepEqual(
    previewBaseVideoOf({ cutplan: PLAN, previewCut: ready, shortMode: false, proxyStale: true }),
    SOURCE_VIDEO,
    "proxy/preview-cut 陳腐化時",
  );

  const changed: CutPlan = {
    ...PLAN,
    segments: PLAN.segments.map((segment, index) =>
      index === 0 ? { ...segment, end: 9 } : segment
    ),
  };
  assert.deepEqual(
    previewBaseVideoOf({ cutplan: changed, previewCut: ready, shortMode: false, proxyStale: false }),
    SOURCE_VIDEO,
    "keep 変更直後",
  );
  assert.deepEqual(
    previewBaseVideoOf({ cutplan: PLAN, previewCut: ready, shortMode: true, proxyStale: false }),
    SOURCE_VIDEO,
    "short mode",
  );
  assert.notEqual(
    previewBaseVideoMountKey(SOURCE_VIDEO),
    previewBaseVideoMountKey(BAKED_VIDEO),
    "ready 状態の採用で Player remount key が変わる",
  );
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
  createdAt: "2026-07-22T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  captionColor: "#f5f5f5",
  captionOutlineColor: "#111111",
  captionBackground: { color: "rgba(0, 0, 0, 0.7)", paddingPx: 12 },
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
  zoom: { easeSec: 0.4 },
};

const transcript: Transcript = {
  segments: [
    {
      start: 2,
      end: 5,
      text: "first caption",
      style: { color: "#ff66cc", fontWeight: 900 },
      words: [
        { start: 2, end: 3, text: "first" },
        { start: 3, end: 5, text: "caption" },
      ],
    },
    {
      start: 22,
      end: 25,
      text: "second caption",
      track: 2,
      pos: { x: 1440, y: 180 },
      style: { background: "none" },
    },
  ],
};

const overlays: Overlays = {
  overlays: [
    {
      start: 21,
      end: 27,
      file: "materials/card.png",
      rect: { x: 100, y: 80, w: 640, h: 360 },
    },
  ],
  wipeFull: [{ start: 3, end: 8, transitionInSec: 0.2, transitionOutSec: 0.45 }],
  captionTracks: [
    {
      track: 1,
      x: 960,
      y: 900,
      style: {
        fontSizePx: 68,
        color: "#44ddff",
        karaoke: {
          activeColor: "#ffe14d",
          inactiveOpacity: 0.45,
          mode: "fill",
        },
      },
    },
    {
      track: 2,
      x: 960,
      y: 160,
      anchor: "topLeft",
      style: { fontSizePx: 44, background: { color: "#223344" } },
    },
  ],
  zooms: [
    {
      start: 22,
      end: 25,
      rect: { x: 480, y: 270, w: 960, h: 540 },
    },
    {
      start: 25,
      end: 28,
      rect: { x: 800, y: 360, w: 960, h: 540 },
      easeSec: 0.25,
      easeOutSec: 0.6,
    },
  ],
  colorFilter: { brightness: 1.05, contrast: 1.12, saturate: 0.9 },
  blurs: [
    {
      start: 21,
      end: 27,
      rect: { x: 40, y: 50, w: 320, h: 120 },
      strength: 0.8,
    },
  ],
  annotations: [
    {
      type: "box",
      start: 23,
      end: 27,
      rect: { x: 760, y: 300, w: 360, h: 220 },
      color: "#ff3344",
      widthPx: 8,
      radiusPx: 18,
    },
  ],
  layerOrder: ["ov1", "wipe", "caption", "cap2"],
};

const build = (baseVideo: typeof SOURCE_VIDEO | typeof BAKED_VIDEO) =>
  buildRenderProps({
    manifest,
    keeps: PLAN.segments.filter((segment) => segment.action === "keep"),
    transcript,
    overlays,
    renderCfg,
    width: 1920,
    height: 1080,
    ...baseVideo,
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

test("preview base video: bakedはbaseSegmentsを連続化し、演出propsはsourceとdeep-equal", () => {
  const source = build(SOURCE_VIDEO);
  const baked = build(BAKED_VIDEO);

  assert.deepEqual(source.baseSegments, [
    { start: 0, videoStart: 0, durationSec: 5, playbackRate: 2 },
    { start: 5, videoStart: 20, durationSec: 10 },
  ]);
  assert.deepEqual(baked.baseSegments, [
    { start: 0, videoStart: 0, durationSec: 15 },
  ]);

  const { videoFile: sourceFile, baseSegments: sourceBase, ...sourcePresentation } = source;
  const { videoFile: bakedFile, baseSegments: bakedBase, ...bakedPresentation } = baked;
  assert.equal(sourceFile, "media/proxy.mp4");
  assert.equal(bakedFile, "media/preview-cut.mp4");
  assert.ok(sourceBase.length > bakedBase.length);
  assert.deepEqual(bakedPresentation, sourcePresentation);

  // 3-level caption inheritance: config defaults remain on caption, track style
  // fills missing fields, and the segment wins for color/fontWeight. Karaoke words
  // survive the same source→output remap in both base-video modes.
  assert.deepEqual(source.caption, {
    fontSizePx: 52,
    color: "#f5f5f5",
    outlineColor: "#111111",
    background: { color: "rgba(0, 0, 0, 0.7)", paddingPx: 12 },
  });
  assert.deepEqual(source.captions[0].style, {
    fontSizePx: 68,
    color: "#ff66cc",
    karaoke: { activeColor: "#ffe14d", inactiveOpacity: 0.45, mode: "fill" },
    fontWeight: 900,
  });
  assert.deepEqual(source.captions[0].words, [
    { text: "first", start: 1, end: 1.5 },
    { text: "caption", start: 1.5, end: 2.5 },
  ]);
  assert.equal(source.zooms?.length, 2, "adjacent zoom chain");
  assert.equal(source.zooms?.[0].end, source.zooms?.[1].start);
  assert.equal(source.blurs?.length, 1, "base映像側のlower-layer blur");
  assert.equal(source.annotations?.length, 1, "常に最前面のannotation");
  assert.deepEqual(source.colorFilter, overlays.colorFilter);
  assert.deepEqual(source.layerOrder, ["ov1", "wipe", "caption", "cap2"]);
  assert.deepEqual(baked.captions, source.captions);
  assert.deepEqual(baked.overlays, source.overlays);
  assert.deepEqual(baked.zooms, source.zooms);
  assert.deepEqual(baked.wipeFull, source.wipeFull);
  assert.deepEqual(baked.blurs, source.blurs);
  assert.deepEqual(baked.annotations, source.annotations);
});
