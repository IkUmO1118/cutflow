// editor/client/enginePreviewTimeline.ts の純関数を固定する(M3b T2-2)。
// EnginePreview.tsx 本体(React/DOM/GPU が要る)は engineDev 相当の headless
// 確認と Phase3 の CDP 実測で検証する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProps } from "../remotion/props.ts";
import { audioSignatureOf, timelineFromBaseSegments } from "../editor/client/enginePreviewTimeline.ts";

test("timelineFromBaseSegments: baseSegments 省略時は durationSec 全編の1区間", () => {
  const entries = timelineFromBaseSegments({ ...defaultProps, durationSec: 12 });
  assert.deepEqual(entries, [
    { outputStart: 0, outputEnd: 12, sourceStart: 0, sourceEnd: 12, speed: 1 },
  ]);
});

test("timelineFromBaseSegments: playbackRate 無指定の区間は speed:1・sourceEnd=videoStart+durationSec", () => {
  const entries = timelineFromBaseSegments({
    ...defaultProps,
    baseSegments: [
      { start: 0, videoStart: 5, durationSec: 3 },
      { start: 3, videoStart: 20, durationSec: 4 },
    ],
  });
  assert.deepEqual(entries, [
    { outputStart: 0, outputEnd: 3, sourceStart: 5, sourceEnd: 8, speed: 1 },
    { outputStart: 3, outputEnd: 7, sourceStart: 20, sourceEnd: 24, speed: 1 },
  ]);
});

test("timelineFromBaseSegments: playbackRate 指定区間は sourceEnd が durationSec*rate 分だけ進む", () => {
  const entries = timelineFromBaseSegments({
    ...defaultProps,
    baseSegments: [{ start: 0, videoStart: 10, durationSec: 5, playbackRate: 2 }],
  });
  assert.deepEqual(entries, [
    { outputStart: 0, outputEnd: 5, sourceStart: 10, sourceEnd: 20, speed: 2 },
  ]);
});

test("audioSignatureOf: videoFile/baseSegments/bgm/fps のいずれかが変われば署名が変わる", () => {
  const base = { ...defaultProps, baseSegments: [{ start: 0, videoStart: 0, durationSec: 5 }] };
  const sig0 = audioSignatureOf(base);
  assert.equal(sig0, audioSignatureOf({ ...base }), "同内容なら同じ署名");
  assert.notEqual(
    sig0,
    audioSignatureOf({ ...base, baseSegments: [{ start: 0, videoStart: 0, durationSec: 6 }] }),
  );
  assert.notEqual(sig0, audioSignatureOf({ ...base, fps: 60 }));
});

test("audioSignatureOf: caption/overlay だけの違いは署名に影響しない(見た目だけの変更で再構築しない)", () => {
  const base = { ...defaultProps, baseSegments: [{ start: 0, videoStart: 0, durationSec: 5 }] };
  const sigA = audioSignatureOf({ ...base, captions: [] });
  const sigB = audioSignatureOf({
    ...base,
    captions: [{ start: 0, end: 1, text: "x", track: 1 }],
  });
  assert.equal(sigA, sigB);
});
