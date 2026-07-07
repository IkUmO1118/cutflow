// lib/ffmpeg.ts の summarizeProbe(素材知覚の下地。docs/plans/
// 2026-07-07-material-introspection-design.md タスク1)を fixture の
// ffprobe JSON で固定する。実 ffprobe は一切呼ばない(外部依存をテストに
// 持ち込まない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProbe } from "../src/lib/ffmpeg.ts";
import type { ProbeResult } from "../src/lib/ffmpeg.ts";

test("summarizeProbe: 音声付き動画", () => {
  const result: ProbeResult = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "4.020000" },
  };
  assert.deepEqual(summarizeProbe(result), {
    durationSec: 4.02,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
  });
});

test("summarizeProbe: 無音動画(hasAudio:false・audioCodec 省略)", () => {
  const result: ProbeResult = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "25/1" },
    ],
    format: { duration: "10.500000" },
  };
  assert.deepEqual(summarizeProbe(result), {
    durationSec: 10.5,
    width: 1280,
    height: 720,
    fps: 25,
    hasAudio: false,
    videoCodec: "h264",
  });
});

test("summarizeProbe: 画像(duration/fps 無し。avg_frame_rate 0/0 は省略)", () => {
  const result: ProbeResult = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "png", width: 3840, height: 2160, avg_frame_rate: "0/0" },
    ],
    format: { duration: "N/A" },
  };
  assert.deepEqual(summarizeProbe(result), {
    width: 3840,
    height: 2160,
    hasAudio: false,
    videoCodec: "png",
  });
});

test("summarizeProbe: 音声のみ(mp3。width/height/fps/videoCodec 省略)", () => {
  const result: ProbeResult = {
    streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }],
    format: { duration: "180.000000" },
  };
  assert.deepEqual(summarizeProbe(result), {
    durationSec: 180,
    hasAudio: true,
    audioCodec: "mp3",
  });
});

test("summarizeProbe: video/audio ストリームが無い(壊れたファイル)場合は hasAudio:false のみ確定", () => {
  const result: ProbeResult = { streams: [], format: { duration: "0.000000" } };
  assert.deepEqual(summarizeProbe(result), { durationSec: 0, hasAudio: false });
});
