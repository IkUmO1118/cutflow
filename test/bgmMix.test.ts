import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RenderProps } from "../remotion/props.ts";
import {
  bgmMixSampleCount,
  buildBgmAmixArgs,
  frameSampleRange,
  mixBgmPcm,
  writeF32lePcm,
} from "../src/lib/bgmMix.ts";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";

type BgmTrack = RenderProps["bgm"][number];

function propsWith(bgm: BgmTrack[], durationSec = 1, fps = 2): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm,
    durationSec,
    fps,
    width: 1920,
    height: 1080,
    canvas: { w: 1920, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
  };
}

function track(overrides: Partial<BgmTrack> = {}): BgmTrack {
  return { file: "bgm.wav", volumeDb: 0, start: 0, end: 1, ...overrides };
}

test("bgmMixSampleCount は composition のフレーム尺に一致する", () => {
  const fps = 30;
  const sampleRate = 48000;
  const totalFrames = compositionDurationInFrames(1.04, fps);
  assert.equal(totalFrames, 31);
  assert.equal(bgmMixSampleCount(totalFrames, sampleRate, fps), 49600);
});

test("frameSampleRange は各 video frame の丸め済み sample 窓を返す", () => {
  assert.deepEqual(frameSampleRange(0, 10, 3), { fromSample: 0, toSample: 3 });
  assert.deepEqual(frameSampleRange(1, 10, 3), { fromSample: 3, toSample: 7 });
  assert.deepEqual(frameSampleRange(2, 10, 3), { fromSample: 7, toSample: 10 });
});

test("track の start/end は frame 丸めされ interleaved stereo の窓へ配置される", () => {
  const bgm = track({ start: 0.26, end: 0.76 });
  const props = propsWith([bgm], 1, 2);
  const pcm = new Float32Array([1, 10, 2, 20, 3, 30, 4, 40]);

  assert.deepEqual(
    Array.from(mixBgmPcm({ props, decodedTracks: [{ track: bgm, pcm }], sampleRate: 4 })),
    [0, 0, 0, 0, 1, 10, 2, 20],
  );
});

test("各 frame の sample 窓へ同じ frame の volume envelope を掛ける", () => {
  const bgm = track({ end: 2, fadeInSec: 1 });
  const props = propsWith([bgm], 2, 2);
  const pcm = new Float32Array(16).fill(1);

  assert.deepEqual(
    Array.from(mixBgmPcm({ props, decodedTracks: [{ track: bgm, pcm }], sampleRate: 4 })),
    [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1],
  );
});

test("startFrom 以降だけを素材末尾まで loop する", () => {
  const bgm = track({ end: 2, startFrom: 0.5 });
  const props = propsWith([bgm], 2, 2);
  const pcm = new Float32Array([
    1, 10,
    2, 20,
    3, 30,
    4, 40,
  ]);

  assert.deepEqual(
    Array.from(mixBgmPcm({ props, decodedTracks: [{ track: bgm, pcm }], sampleRate: 4 })),
    [3, 30, 4, 40, 3, 30, 4, 40, 3, 30, 4, 40, 3, 30, 4, 40],
  );
});

test("startFrom が素材末尾以降なら track を無視する", () => {
  const bgm = track({ startFrom: 2 });
  const props = propsWith([bgm]);
  const mixed = mixBgmPcm({
    props,
    sampleRate: 2,
    decodedTracks: [{ track: bgm, pcm: new Float32Array([1, 10, 2, 20]) }],
  });
  assert.deepEqual(Array.from(mixed), [0, 0, 0, 0]);
});

test("重なった BGM は normalize せず channel ごとに加算する", () => {
  const first = track();
  const second = track({ file: "second.wav" });
  const props = propsWith([first, second]);
  const mixed = mixBgmPcm({
    props,
    sampleRate: 2,
    decodedTracks: [
      { track: first, pcm: new Float32Array([0.75, 1, 0.75, 1]) },
      { track: second, pcm: new Float32Array([0.75, 2, 0.75, 2]) },
    ],
  });
  assert.deepEqual(Array.from(mixed), [1.5, 3, 1.5, 3]);
});

test("buildBgmAmixArgs は raw stereo f32le と非 normalize amix を AAC 192k へ出す", () => {
  const args = buildBgmAmixArgs({
    cutPath: "/rec/cut.mp4",
    bgmPcmPath: "/rec/render.fast/bgm.f32le",
    outM4a: "/rec/render.fast/audio.m4a",
    durationSec: 31 / 30,
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  assert.deepEqual(args.slice(0, 13), [
    "-y", "-v", "error",
    "-i", "/rec/cut.mp4",
    "-f", "f32le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "/rec/render.fast/bgm.f32le",
  ]);
  assert.match(filter, /atrim=duration=1\.0333333333333334/);
  assert.match(filter, /\[0:a\].*apad,atrim=duration=1\.0333333333333334,asetpts=N\/SR\/TB\[base\]/);
  assert.match(filter, /\[1:a\].*atrim=duration=1\.0333333333333334,asetpts=N\/SR\/TB\[bgm\]/);
  assert.match(filter, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0/);
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("192k"));
  assert.equal(args.at(-1), "/rec/render.fast/audio.m4a");
});

test("writeF32lePcm は Float32Array を little-endian で書く", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-bgm-mix-"));
  try {
    const path = join(dir, "pcm.f32le");
    writeF32lePcm(path, new Float32Array([1, -0.5, 0.25]));
    const bytes = readFileSync(path);
    assert.equal(bytes.readFloatLE(0), 1);
    assert.equal(bytes.readFloatLE(4), -0.5);
    assert.equal(bytes.readFloatLE(8), 0.25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
