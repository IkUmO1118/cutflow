import { test } from "node:test";
import assert from "node:assert/strict";
import type { RenderProps } from "../remotion/props.ts";
import { bgmTrackTiming, bgmVolumeAtFrame } from "../src/lib/bgmEnvelope.ts";
import { duckFactorAt } from "../src/lib/duck.ts";

type BgmTrack = RenderProps["bgm"][number];

const baseTrack = (overrides: Partial<BgmTrack> = {}): BgmTrack => ({
  file: "bgm.mp3",
  volumeDb: 0,
  start: 0,
  end: 2,
  ...overrides,
});

const closeTo = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} !== ${expected}`);
};

test("bgmVolumeAtFrame: volumeDb を線形ゲインへ変換する", () => {
  const track = baseTrack({ volumeDb: -6 });
  closeTo(bgmVolumeAtFrame(track, 20, 30), Math.pow(10, -6 / 20));
});

test("bgmVolumeAtFrame: fadeIn/fadeOut は丸めない frame 基準で clamp する", () => {
  const track = baseTrack({ end: 1, fadeInSec: 0.25, fadeOutSec: 0.25 });
  const fps = 30;

  assert.equal(bgmVolumeAtFrame(track, -1, fps), 0);
  closeTo(bgmVolumeAtFrame(track, 3, fps), 3 / 7.5);
  assert.equal(bgmVolumeAtFrame(track, 8, fps), 1);
  closeTo(bgmVolumeAtFrame(track, 27, fps), 3 / 7.5);
  assert.equal(bgmVolumeAtFrame(track, 30, fps), 0);
  assert.equal(bgmVolumeAtFrame(track, 31, fps), 0);
});

test("bgmVolumeAtFrame: fadeIn/fadeOut が重なる短区間では両係数を積算する", () => {
  const track = baseTrack({ end: 1, fadeInSec: 0.8, fadeOutSec: 0.8 });
  const fadeFactor = 15 / 24;
  closeTo(bgmVolumeAtFrame(track, 15, 30), fadeFactor * fadeFactor);
});

test("bgmVolumeAtFrame: duckFactorAt と同じ絶対時刻と最小 fade でダッキングする", () => {
  const fps = 30;
  const track = baseTrack({
    start: 1.01,
    end: 4,
    duck: { spans: [{ start: 2, end: 2.5 }], duckDb: -12, fadeSec: 0 },
  });
  const localFrame = 29.5;
  const { fromFrame } = bgmTrackTiming(track, fps);
  const duckGain = Math.pow(10, track.duck!.duckDb / 20);
  const expected = duckFactorAt(
    track.duck!.spans,
    (fromFrame + localFrame) / fps,
    1 / fps,
    duckGain,
  );

  closeTo(bgmVolumeAtFrame(track, localFrame, fps), expected);
  assert.ok(expected > duckGain && expected < 1);
});

test("bgmTrackTiming: from/duration/startFrom を既存の規則で丸める", () => {
  const track = baseTrack({ start: 0.051, end: 0.152, startFrom: 0.049 });
  assert.deepEqual(bgmTrackTiming(track, 30), {
    fromFrame: 2,
    durationInFrames: 3,
    startFromFrame: 1,
  });
  assert.equal(bgmTrackTiming(baseTrack({ start: 1, end: 1 }), 30).durationInFrames, 1);
});
