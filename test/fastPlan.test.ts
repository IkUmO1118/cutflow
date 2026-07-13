// lib/fastPlan.ts の純関数テスト。render 高速パスの適格性判定
// (FAST/SLOW frame-integer スパン列・全編フォールバック・音声ゲート)を
// 2026-07-12 の実測形状(coverage 0.708, 一塊の SLOW 素材オーバーレイ)を
// 含めて固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fastPlan, MIN_FAST_SPAN_SEC } from "../src/lib/fastPlan.ts";
import type { RenderProps } from "../remotion/props.ts";

function mkProps(partial: Partial<RenderProps> & { durationSec: number }): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm: [],
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    ...partial,
  };
}

test("MIN_FAST_SPAN_SEC は 3", () => {
  assert.equal(MIN_FAST_SPAN_SEC, 3);
});

test("2026-07-12 の実測形状を再現する(coverage 0.708・一塊の SLOW 素材オーバーレイ)", () => {
  const props = mkProps({
    durationSec: 210.0,
    overlays: [{ start: 55.9, end: 117.2, file: "m.mp4", track: 1, fit: "contain" }],
    bgm: [
      { file: "a.mp3", volumeDb: -18, start: 0, end: 60 },
      { file: "b.mp3", volumeDb: -18, start: 60, end: 140 },
      { file: "c.mp3", volumeDb: -18, start: 140, end: 210 },
    ],
  });
  const plan = fastPlan(props);
  assert.equal(plan.totalFrames, 6300);
  assert.deepEqual(plan.spans, [
    { kind: "fast", fromFrame: 0, toFrame: 1677 },
    { kind: "slow", fromFrame: 1677, toFrame: 3516 },
    { kind: "fast", fromFrame: 3516, toFrame: 6300 },
  ]);
  assert.equal(Math.round(plan.coverageRatio * 1000), 708);
  assert.equal(plan.eligible, true);
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((r) => r.includes("BGM")));
});

test("静的テロップだけ・BGM なし → 全編1本の FAST スパン", () => {
  const props = mkProps({
    durationSec: 20,
    captions: [{ start: 1, end: 3, text: "静的", track: 1 }],
    bgm: [],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
  assert.equal(plan.eligible, true);
  assert.equal(plan.audioFastEligible, true);
});

test("inserts があれば全編フォールバック(SLOW 一本・coverage 0)", () => {
  const props = mkProps({
    durationSec: 20,
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, false);
  assert.ok(plan.wholeFallback.includes("inserts"));
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 0);
});

test("colorFilter があれば全編フォールバック(SLOW 一本・coverage 0)", () => {
  const props = mkProps({
    durationSec: 20,
    colorFilter: { brightness: 1.1 },
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, false);
  assert.ok(plan.wholeFallback.includes("colorFilter"));
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 0);
});

test("zoom 区間は SLOW(前後は FAST)", () => {
  const props = mkProps({
    durationSec: 30,
    zooms: [{ start: 10, end: 20, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.3 }],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [
    { kind: "fast", fromFrame: 0, toFrame: 300 },
    { kind: "slow", fromFrame: 300, toFrame: 600 },
    { kind: "fast", fromFrame: 600, toFrame: 900 },
  ]);
});

test("anim テロップは SLOW、他の静的テロップは FAST のまま", () => {
  const props = mkProps({
    durationSec: 30,
    captions: [
      { start: 10, end: 15, text: "アニメ", track: 1, style: { fontSizePx: 44, anim: { in: "fade" } } },
      { start: 20, end: 25, text: "静的", track: 1 },
    ],
  });
  const plan = fastPlan(props);
  assert.ok(
    plan.spans.some((s) => s.kind === "slow" && s.fromFrame === 300 && s.toFrame === 450),
    `spans=${JSON.stringify(plan.spans)}`,
  );
  const slowFrames = plan.spans.filter((s) => s.kind === "slow").reduce((n, s) => n + (s.toFrame - s.fromFrame), 0);
  assert.equal(slowFrames, 150); // 5秒ぶんだけ(静的テロップは寄与しない)
});

test("karaoke テロップは SLOW", () => {
  const props = mkProps({
    durationSec: 30,
    captions: [
      {
        start: 10,
        end: 15,
        text: "カラオケ",
        track: 1,
        style: { fontSizePx: 44, karaoke: {} },
        words: [{ text: "カラオケ", start: 10, end: 15 }],
      },
    ],
  });
  const plan = fastPlan(props);
  assert.ok(
    plan.spans.some((s) => s.kind === "slow" && s.fromFrame === 300 && s.toFrame === 450),
    `spans=${JSON.stringify(plan.spans)}`,
  );
});

test("blur と annotation はそれぞれ SLOW(非重複なら2本)", () => {
  const props = mkProps({
    durationSec: 60,
    blurs: [
      { start: 5, end: 8, rect: { x: 0, y: 0, w: 100, h: 100 }, type: "blur", strength: 0.5 },
    ],
    annotations: [
      {
        type: "box",
        start: 30,
        end: 33,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: "#fff",
        widthPx: 4,
        radiusPx: 0,
      },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 2);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 });
  assert.deepEqual(slow[1], { kind: "slow", fromFrame: 900, toFrame: 990 });
});

test("dip-to-black のカット境界窓は SLOW", () => {
  const props = mkProps({
    durationSec: 60,
    cutTransition: { sec: 0.4 },
    cutBoundarySecs: [30],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  // floor((30-0.2)*30)=894, ceil((30+0.2)*30)=ceil(906)=906 (design spec's
  // worked example states 907, but 30.2*30 is exactly 906 in both real and
  // double-precision arithmetic — see final report deviation note).
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 894, toFrame: 906 });
});

test("min-FAST 吸収: 3秒未満の FAST 隙間は SLOW へ吸収してマージされる", () => {
  const props = mkProps({
    durationSec: 10,
    zooms: [
      { start: 0, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 },
      { start: 4, end: 6, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 0, toFrame: 180 });
});

test("min-FAST 吸収: 3秒以上の FAST 隙間は吸収されず2本のまま", () => {
  const props = mkProps({
    durationSec: 10,
    zooms: [
      { start: 0, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 },
      { start: 5, end: 7, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 2);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 0, toFrame: 60 });
  assert.deepEqual(slow[1], { kind: "slow", fromFrame: 150, toFrame: 210 });
});

test("min-FAST 吸収: 先頭の短い FAST は吸収されフレーム0から SLOW になる", () => {
  const props = mkProps({
    durationSec: 15,
    zooms: [{ start: 1, end: 10, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0 }],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [
    { kind: "slow", fromFrame: 0, toFrame: 300 },
    { kind: "fast", fromFrame: 300, toFrame: 450 },
  ]);
});

test("素材音声は音声ゲートを塞ぐが映像カバレッジには影響しない", () => {
  const props = mkProps({
    durationSec: 210.0,
    overlays: [{ start: 55.9, end: 117.2, file: "m.mp4", track: 1, fit: "contain", volume: 1 }],
  });
  const plan = fastPlan(props);
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((r) => r.includes("素材音声")));
  assert.equal(Math.round(plan.coverageRatio * 1000), 708);
});
