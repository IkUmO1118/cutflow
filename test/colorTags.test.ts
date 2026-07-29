import { test } from "node:test";
import assert from "node:assert/strict";
import { colorTagArgs, colorTagsOfProbe, resolveColorTags } from "../src/lib/colorTags.ts";
import type { ProbeResult } from "../src/lib/ffmpeg.ts";

test("resolveColorTags: 入力に 709 タグがあれば継承する", () => {
  assert.deepEqual(
    resolveColorTags({ colorSpace: "bt709", colorRange: "tv", height: 540 }),
    { matrix: "bt709", range: "tv" },
  );
});

test("resolveColorTags: 未指定 540p は smpte170m/tv", () => {
  assert.deepEqual(
    resolveColorTags({ colorSpace: "unknown", colorRange: "unknown", height: 540 }),
    { matrix: "smpte170m", range: "tv" },
  );
});

test("resolveColorTags: 未指定 1080p は bt709/tv", () => {
  assert.deepEqual(
    resolveColorTags({ height: 1080 }),
    { matrix: "bt709", range: "tv" },
  );
});

test("resolveColorTags: pc range は継承する", () => {
  assert.deepEqual(
    resolveColorTags({ colorSpace: "smpte170m", colorRange: "pc", height: 540 }),
    { matrix: "smpte170m", range: "pc" },
  );
});

test("resolveColorTags: 高さ未取得なら bt709/tv", () => {
  assert.deepEqual(
    resolveColorTags({ colorSpace: "reserved", colorRange: "reserved" }),
    { matrix: "bt709", range: "tv" },
  );
});

test("colorTagArgs: matrix と range だけをこの順で返す", () => {
  assert.deepEqual(colorTagArgs({ matrix: "smpte170m", range: "tv" }), [
    "-colorspace", "smpte170m", "-color_range", "tv",
  ]);
});

test("colorTagsOfProbe: 先頭 video stream から色タグを解決する", () => {
  const result: ProbeResult = {
    streams: [
      { index: 0, codec_type: "audio" },
      { index: 1, codec_type: "video", color_space: "unknown", color_range: "unknown", height: 540 },
    ],
    format: { duration: "1" },
  };
  assert.deepEqual(colorTagsOfProbe(result), { matrix: "smpte170m", range: "tv" });
});
