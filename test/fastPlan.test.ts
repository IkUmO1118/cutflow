// lib/fastPlan.ts の純関数テスト。render 高速パスの適格性判定
// (FAST/SLOW frame-integer スパン列・全編フォールバック・音声ゲート)を
// 2026-07-12 の実測形状(旧: coverage 0.708 の SLOW 素材オーバーレイ。
// P5-1 で静止画 overlay が FAST 化されたので、その回帰ケースは overlay を
// 動画素材へ差し替えて残す)を含めて固定する。P5-1(静止画 overlay の
// FAST 化)の適格判定・不動点(またぎ降格)・入力数ガード(分割/SLOW化)の
// ケースを P-1〜P-14 として追加する(design-T1.md §6)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fastPlan, MAX_FAST_PNG_INPUTS, MIN_FAST_SPAN_SEC } from "../src/lib/fastPlan.ts";
import { countFastPngInputs } from "../src/lib/fastSegment.ts";
import { baseLayoutOf, baseSegOf } from "../src/lib/fastBase.ts";
import type { OverlayItem, RenderProps } from "../remotion/props.ts";

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

function mkOverlay(partial: Partial<OverlayItem> & { start: number; end: number }): OverlayItem {
  return { file: "m.png", track: 1, fit: "contain", ...partial };
}

test("MIN_FAST_SPAN_SEC は 3", () => {
  assert.equal(MIN_FAST_SPAN_SEC, 3);
});

test("2026-07-12 の実測形状を再現する(coverage 0.708・一塊の SLOW 素材オーバーレイ。P5-1 で静止画は FAST 化されたので動画素材へ差し替えた不適格 overlay の回帰)", () => {
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
  assert.equal(plan.audioMode, "bgm-mix");
  assert.equal(plan.audioFastEligible, true);
  assert.deepEqual(plan.audioFallback, []);
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
  assert.equal(plan.audioMode, "copy");
  assert.equal(plan.audioFastEligible, true);
  assert.deepEqual(plan.audioFallback, []);
});

// ---- P5-4: inserts の span 化(design-T4.md §6)。挿入区間だけ SLOW・
// 前後のベースは FAST(全編フォールバックしない)。PR1(映像)時点では
// audioGate はまだ inserts を理由に残しているので、audioFastEligible は
// 引き続き false(PR2 で "insert-mix" に変わる。P4-7〜P4-9 は fastPlan.ts の
// audioGate 改修後のテストなのでそちらに置く) ----

test("P4-1: 挿入1件(中間)→ eligible:true・wholeFallback 空・挿入区間だけ SLOW・前後は FAST", () => {
  const props = mkProps({
    durationSec: 30,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.wholeFallback, []);
  assert.deepEqual(plan.spans, [
    { kind: "fast", fromFrame: 0, toFrame: 600 },
    { kind: "slow", fromFrame: 600, toFrame: 750 },
    { kind: "fast", fromFrame: 750, toFrame: 900 },
  ]);
});

test("P4-2: FAST スパンは必ず単一 baseSegment に収まる(baseSegOf !== null)", () => {
  const props = mkProps({
    durationSec: 30,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
  });
  const plan = fastPlan(props);
  const layout = baseLayoutOf(props);
  assert.equal(layout.ok, true);
  if (layout.ok) {
    for (const s of plan.spans) {
      if (s.kind !== "fast") continue;
      assert.ok(baseSegOf(layout, s) !== null, `FAST span[${s.fromFrame},${s.toFrame}) が baseSegment に収まらない`);
    }
  }
});

test("P4-3: 挿入と挿入の間のベースが3秒未満 → absorbMinFastGaps が SLOW に吸収(SLOW 1本)", () => {
  const props = mkProps({
    durationSec: 10, // insert[0,3) + base[3,5)(2秒<3秒) + insert[5,10)
    baseSegments: [{ start: 3, videoStart: 0, durationSec: 2 }],
    inserts: [
      { start: 0, end: 3, file: "a.mp4", fit: "cover" },
      { start: 5, end: 10, file: "b.mp4", fit: "cover" },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 0, toFrame: plan.totalFrames });
});

test("P4-4: 冒頭の挿入→先頭 FAST が生まれない・末尾の挿入→末尾 FAST が生まれない", () => {
  const props = mkProps({
    durationSec: 13, // insert[0,2) + base[2,10) + insert[10,13)
    baseSegments: [{ start: 2, videoStart: 0, durationSec: 8 }],
    inserts: [
      { start: 0, end: 2, file: "a.mp4", fit: "cover" },
      { start: 10, end: 13, file: "b.mp4", fit: "cover" },
    ],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [
    { kind: "slow", fromFrame: 0, toFrame: 60 },
    { kind: "fast", fromFrame: 60, toFrame: 300 },
    { kind: "slow", fromFrame: 300, toFrame: 390 },
  ]);
});

test("P4-5: playbackRate:1 でない baseSegment → wholeFallback に baseSegments(playbackRate)", () => {
  const props = mkProps({
    durationSec: 10,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 10, playbackRate: 2 }],
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.wholeFallback, ["baseSegments(playbackRate)"]);
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 0);
});

test("P4-6: 挿入区間に重なる不適格 overlay があっても FAST スパンが base をまたがない", () => {
  const props = mkProps({
    durationSec: 30,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
    // 静止画でない overlay(動画素材)は不適格 → SLOW。挿入区間[20,25)と重なる
    // 区間を指定しても(renderProps は実際には挿入で断片化するので起きないが)
    // FAST スパンは base の境界内に収まったままであること
    overlays: [{ start: 18, end: 22, file: "m.mp4", track: 1, fit: "contain" }],
  });
  const plan = fastPlan(props);
  const layout = baseLayoutOf(props);
  assert.equal(layout.ok, true);
  if (layout.ok) {
    for (const s of plan.spans) {
      if (s.kind !== "fast") continue;
      assert.ok(baseSegOf(layout, s) !== null);
    }
  }
});

// ---- P5-4 PR2: audioGate(insert-mix)。design-T4.md §5 P4-7〜P4-9 ----

test("P4-7: audioMode: 挿入あり→insert-mix / 挿入あり+BGM→insert-mix / 挿入無し+BGM→bgm-mix / 何も無し→copy", () => {
  const withInsert = mkProps({
    durationSec: 20,
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
  });
  assert.equal(fastPlan(withInsert).audioMode, "insert-mix");

  const withInsertAndBgm = mkProps({
    durationSec: 20,
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
    bgm: [{ file: "a.mp3", volumeDb: -18, start: 0, end: 20 }],
  });
  assert.equal(fastPlan(withInsertAndBgm).audioMode, "insert-mix");

  const withBgmOnly = mkProps({
    durationSec: 20,
    bgm: [{ file: "a.mp3", volumeDb: -18, start: 0, end: 20 }],
  });
  assert.equal(fastPlan(withBgmOnly).audioMode, "bgm-mix");

  const bare = mkProps({ durationSec: 20 });
  assert.equal(fastPlan(bare).audioMode, "copy");
});

test("P4-8: 挿入あり + overlays[].volume>0 → audioFastEligible:false(素材音声は据え置き)", () => {
  const props = mkProps({
    durationSec: 20,
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
    overlays: [{ start: 6, end: 8, file: "material.mp4", track: 1, fit: "contain", volume: 1 }],
  });
  const plan = fastPlan(props);
  assert.equal(plan.audioMode, "insert-mix");
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((r) => r.includes("素材音声")));
});

test("P4-9: coverage が挿入ぶんだけ下がる(数値固定)", () => {
  const props = mkProps({
    durationSec: 20, // insert[0,5) + base[5,20)
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 15 }],
    inserts: [{ start: 0, end: 5, file: "i.mp4", fit: "cover" }],
  });
  const plan = fastPlan(props);
  // SLOW = insert 分(5秒/20秒) → coverage = 15/20 = 0.75
  assert.equal(plan.coverageRatio, 0.75);
});

test("colorFilter(表現可能)は FAST 適格(P5-3。時間軸に影響しない)", () => {
  const withCf = mkProps({
    durationSec: 20,
    colorFilter: { brightness: 1.1 },
  });
  const without = mkProps({ durationSec: 20 });
  const plan = fastPlan(withCf);
  const planWithout = fastPlan(without);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.wholeFallback, []);
  // colorFilter は全編一律(時間軸に関与しない)。span/coverage は
  // colorFilter 無しの同一 props と完全一致する
  assert.deepEqual(plan.spans, planWithout.spans);
  assert.equal(plan.coverageRatio, planWithout.coverageRatio);
});

test("colorFilter(表現不能: saturate>2.0776)は全編フォールバック(SLOW 一本・coverage 0)", () => {
  const props = mkProps({
    durationSec: 20,
    colorFilter: { saturate: 2.5 },
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, false);
  assert.equal(plan.wholeFallback.length, 1);
  assert.ok(plan.wholeFallback[0].startsWith("colorFilter("));
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 0);
});

test("colorFilter 全キー 1.0(無補正)は wholeFallback に影響しない", () => {
  const props = mkProps({
    durationSec: 20,
    colorFilter: { brightness: 1, contrast: 1, saturate: 1 },
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.wholeFallback, []);
});

test("zoom 区間は SLOW(前後は FAST)", () => {
  const props = mkProps({
    durationSec: 30,
    zooms: [{ start: 10, end: 20, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.3, wipeScale: 0.8 }],
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

test("blur は SLOW・静的 annotation(keyframes 無し)は SLOW を作らない(P5-2 回帰。旧: 2本 → 新: 1本)", () => {
  const props = mkProps({
    durationSec: 60,
    blurs: [
      { start: 5, end: 8, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 },
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
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 }); // blur ぶんのみ(annotation は寄与しない)
});

// ---- P5-2: 静的 annotation の FAST 化(design-T2.md §6) ----

test("P2-1: 静的 annotation(arrow/box/spotlight 各1件)だけ → SLOW スパン無し・全編 FAST", () => {
  const props = mkProps({
    durationSec: 30,
    annotations: [
      {
        type: "arrow", start: 2, end: 4,
        from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
        color: "#ff3b30", widthPx: 8, headPx: 28,
      },
      {
        type: "box", start: 10, end: 12,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: "#fff", widthPx: 4, radiusPx: 0,
      },
      {
        type: "spotlight", start: 20, end: 22,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        shape: "rect", dim: 0.6, featherPx: 24, radiusPx: 0,
      },
    ],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
  assert.equal(plan.eligible, true);
});

test("P2-2: keyframes 付き annotation 1件 → その区間だけ SLOW", () => {
  const props = mkProps({
    durationSec: 30,
    annotations: [
      {
        type: "box", start: 10, end: 12,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: "#fff", widthPx: 4, radiusPx: 0,
        keyframes: [{ at: 10, easing: "linear", values: { x: 0 } }],
      },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  // floor(10*30)=300, ceil(12*30)=360
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 300, toFrame: 360 });
  assert.ok(plan.notes.some((n) => n.includes("keyframes") && n.includes("box")));
});

test("P2-3: keyframes: [] の annotation は FAST のまま(A-2 のプランナー側回帰)", () => {
  const props = mkProps({
    durationSec: 30,
    annotations: [
      {
        type: "box", start: 10, end: 12,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: "#fff", widthPx: 4, radiusPx: 0,
        keyframes: [],
      },
    ],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
});

test("P2-4: blur は依然 SLOW(判断Bの回帰)", () => {
  const props = mkProps({
    durationSec: 30,
    blurs: [
      { start: 5, end: 7, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 },
      { start: 15, end: 17, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 },
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 2);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 210 });
  assert.deepEqual(slow[1], { kind: "slow", fromFrame: 450, toFrame: 510 });
});

test("P2-5: 静的 annotation は SLOW 境界(blur 由来)をまたいでも降格しない", () => {
  const withoutAnnotation = mkProps({
    durationSec: 30,
    blurs: [{ start: 10, end: 12, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 }],
  });
  const withAnnotation = mkProps({
    durationSec: 30,
    blurs: [{ start: 10, end: 12, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 }],
    annotations: [
      {
        // 11.0-13.0 は blur の SLOW 窓 [10,12) をまたぐ
        type: "box", start: 11, end: 13,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        color: "#fff", widthPx: 4, radiusPx: 0,
      },
    ],
  });
  const planWithout = fastPlan(withoutAnnotation);
  const planWith = fastPlan(withAnnotation);
  // spans(SLOW 区間)は annotation の有無で変わらない = 追加の SLOW が発生しない
  assert.deepEqual(planWith.spans, planWithout.spans);
});

test("P2-6: 静的 annotation は countFastPngInputs を +1 する(同一内容2件は畳み込まれ+1・異なる内容2件は+2)", () => {
  const base = mkProps({ durationSec: 30 });
  const baseline = countFastPngInputs(base, { kind: "fast", fromFrame: 0, toFrame: 900 });

  const sameTwice = mkProps({
    durationSec: 30,
    annotations: [
      { type: "box", start: 2, end: 3, rect: { x: 0, y: 0, w: 100, h: 100 }, color: "#fff", widthPx: 4, radiusPx: 0 },
      { type: "box", start: 20, end: 21, rect: { x: 0, y: 0, w: 100, h: 100 }, color: "#fff", widthPx: 4, radiusPx: 0 },
    ],
  });
  assert.equal(
    countFastPngInputs(sameTwice, { kind: "fast", fromFrame: 0, toFrame: 900 }),
    baseline + 1,
  );

  const differentTwice = mkProps({
    durationSec: 30,
    annotations: [
      { type: "box", start: 2, end: 3, rect: { x: 0, y: 0, w: 100, h: 100 }, color: "#fff", widthPx: 4, radiusPx: 0 },
      { type: "box", start: 20, end: 21, rect: { x: 0, y: 0, w: 100, h: 100 }, color: "#000", widthPx: 4, radiusPx: 0 },
    ],
  });
  assert.equal(
    countFastPngInputs(differentTwice, { kind: "fast", fromFrame: 0, toFrame: 900 }),
    baseline + 2,
  );
});

test("P2-7: props.layout があると eligible: false / wholeFallback に layout(ショート経路)が含まれる", () => {
  const props = mkProps({
    durationSec: 20,
    layout: { panels: [{ source: "screen", fit: "cover" }] },
  });
  const plan = fastPlan(props);
  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.wholeFallback, ["layout(ショート経路)"]);
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
});

test("P2-8: 静的 annotation が MAX_FAST_PNG_INPUTS 超過に寄与するとき splitOversizedFastSpans が働く(落ちない)", () => {
  const annotations = Array.from({ length: 130 }, (_, i) => ({
    type: "box" as const,
    start: 1 + i * 2,
    end: 1.5 + i * 2,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: `#${(i % 999).toString().padStart(3, "0")}`, // 全件異なる内容(畳み込み不可)
    widthPx: 4,
    radiusPx: 0,
  }));
  const props = mkProps({ durationSec: 320, annotations });
  const plan = fastPlan(props);
  for (const s of plan.spans) {
    if (s.kind === "fast") {
      assert.ok(countFastPngInputs(props, s) <= MAX_FAST_PNG_INPUTS);
    }
  }
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
      { start: 0, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 },
      { start: 4, end: 6, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 },
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
      { start: 0, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 },
      { start: 5, end: 7, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 },
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
    zooms: [{ start: 1, end: 10, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
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
  assert.equal(plan.audioMode, "copy");
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((r) => r.includes("素材音声")));
  assert.equal(Math.round(plan.coverageRatio * 1000), 708);
});

// ---- P5-1: 静止画 overlay の FAST 化(design-T1.md §6) ----

test("P-1: 静止画 overlay(fade 無し・rect 無し)だけ → 全編 FAST", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 8 })],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.notes, []);
});

test("P-2: 静止画 overlay + フェード(fin+fout <= dur) → 全編 FAST", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 8, fadeInSec: 0.5, fadeOutSec: 0.5 })],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
});

test("P-3: fin + fout > durFrames は不適格 → その区間だけ SLOW", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 6, fadeInSec: 0.6, fadeOutSec: 0.6 })], // dur=30f, fin=18,fout=18
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 180 });
});

test("P-4: 動画素材 overlay(.mp4) → SLOW", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 8, file: "m.mp4" })],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 });
});

test("P-5: keyframes 付き画像 overlay → SLOW", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [
      mkOverlay({
        start: 5,
        end: 8,
        rect: { x: 0, y: 0, w: 100, h: 100 },
        keyframes: [{ at: 5, easing: "linear", values: { x: 0 } }],
      }),
    ],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 });
});

test("P-6: volume 付き画像 overlay → SLOW + audioFastEligible=false", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 8, volume: 1 })],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 });
  assert.equal(plan.audioFastEligible, false);
  assert.ok(plan.audioFallback.some((r) => r.includes("素材音声")));
});

test("P-7: opacity 0.5 の静止画 overlay(定数 alpha)→ 全編 FAST", () => {
  const props = mkProps({
    durationSec: 20,
    overlays: [mkOverlay({ start: 5, end: 8, opacity: 0.5 })],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
});

test("P-8: またぎ降格: zoom と部分的に重なる静止画 overlay は overlay 区間ごと SLOW へ降格", () => {
  const props = mkProps({
    durationSec: 30,
    zooms: [{ start: 10, end: 12, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
    overlays: [mkOverlay({ start: 11, end: 15 })],
  });
  const plan = fastPlan(props);
  // zoom frame[300,360) ∪ overlay frame[330,450) = [300,450)
  assert.deepEqual(plan.spans, [
    { kind: "fast", fromFrame: 0, toFrame: 300 },
    { kind: "slow", fromFrame: 300, toFrame: 450 },
    { kind: "fast", fromFrame: 450, toFrame: 900 },
  ]);
  assert.ok(plan.notes.some((n) => n.includes("SLOW 境界をまたぐ")));
});

test("P-9: 不動点2周: min-FAST 吸収が新たなまたぎを生み、2回目の反復で収束する", () => {
  const props = mkProps({
    durationSec: 30,
    zooms: [
      { start: 0, end: 1, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }, // frame[0,30)
      { start: 10, end: 11, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }, // frame[300,330)
    ],
    // overlay[2,11.5) = frame[60,345): B[300,330) と交差するが両方には収まらない
    overlays: [mkOverlay({ start: 2, end: 11.5 })],
  });
  const plan = fastPlan(props);
  // iter1 で demote → 吸収で [0,30)-[60,345) の1秒ギャップが閉じ [0,345) に統合される
  assert.deepEqual(plan.spans, [
    { kind: "slow", fromFrame: 0, toFrame: 345 },
    { kind: "fast", fromFrame: 345, toFrame: 900 },
  ]);
});

test("P-10: 完全に SLOW の内側にある静止画 overlay は降格しない(spans 不変)", () => {
  const withOverlay = mkProps({
    durationSec: 30,
    zooms: [{ start: 5, end: 15, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
    overlays: [mkOverlay({ start: 7, end: 9 })],
  });
  const withoutOverlay = mkProps({
    durationSec: 30,
    zooms: [{ start: 5, end: 15, rect: { x: 0, y: 0, w: 100, h: 100 }, easeSec: 0, wipeScale: 0.8 }],
  });
  const planWith = fastPlan(withOverlay);
  const planWithout = fastPlan(withoutOverlay);
  assert.deepEqual(planWith.spans, planWithout.spans);
  assert.deepEqual(planWith.notes, []);
});

test("P-11: layerOrder に ov1 が無い静止画 overlay → SLOW(保守)", () => {
  const props = mkProps({
    durationSec: 20,
    layerOrder: ["wipe", "caption"],
    overlays: [mkOverlay({ start: 5, end: 8 })],
  });
  const plan = fastPlan(props);
  const slow = plan.spans.filter((s) => s.kind === "slow");
  assert.equal(slow.length, 1);
  assert.deepEqual(slow[0], { kind: "slow", fromFrame: 150, toFrame: 240 });
});

test("P-12: 実収録形状に近い合成データ(多数の静止画 overlay・caption・BGM 複数)→ 全編 FAST", () => {
  // 実際の 2026-07-12(overlay 33件・caption 94件・BGM×3・durationSec 210.03)は
  // 完了条件4のスクリプトで実収録コピーを直接読んで検証する。ここでは形状
  // (多数の適格 overlay・caption・複数 BGM・SLOW 源なし)の代表例を固定する。
  const fps = 30;
  const overlays: OverlayItem[] = [];
  for (let i = 0; i < 15; i++) {
    const start = 3 + i * 8;
    overlays.push(mkOverlay({ start, end: start + 4, file: `m${i}.png`, fadeInSec: i % 3 === 0 ? 0.3 : undefined }));
  }
  const captions = Array.from({ length: 30 }, (_, i) => ({
    start: 0.5 + i * 4,
    end: 2 + i * 4,
    text: `字幕${i}`,
    track: 1,
  }));
  const props = mkProps({
    durationSec: 130,
    overlays,
    captions,
    bgm: [
      { file: "a.mp3", volumeDb: -18, start: 0, end: 40 },
      { file: "b.mp3", volumeDb: -18, start: 40, end: 90 },
      { file: "c.mp3", volumeDb: -18, start: 90, end: 130 },
    ],
  });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "fast", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.equal(plan.coverageRatio, 1);
  assert.equal(plan.eligible, true);
  assert.equal(plan.audioMode, "bgm-mix");
  assert.equal(plan.audioFastEligible, true);
  assert.ok(countFastPngInputs(props, plan.spans[0]) <= MAX_FAST_PNG_INPUTS);
});

test("P-13: 入力数ガード: caption が上限を超えると FAST スパンが複数に割れる", () => {
  const n = 150;
  const captions = Array.from({ length: n }, (_, i) => ({
    start: 1 + 2 * i,
    end: 1.5 + 2 * i,
    text: `c${i}`, // 全件テキストを変えて captionStillKey を別々にする(畳み込み不可)
    track: 1,
  }));
  const props = mkProps({ durationSec: 320, captions });
  const plan = fastPlan(props);
  const fastSpans = plan.spans.filter((s) => s.kind === "fast");
  assert.ok(fastSpans.length > 1, `分割されていない: ${JSON.stringify(plan.spans)}`);
  for (const s of fastSpans) {
    assert.ok(countFastPngInputs(props, s) <= MAX_FAST_PNG_INPUTS);
  }
  // caption 過多以外の SLOW 源が無いので分割だけで済み、SLOW 化はしない
  assert.equal(plan.coverageRatio, 1);
  assert.ok(!plan.notes.some((s) => s.includes("上限超過のため SLOW")));
});

test("P-14: 分割不能(1つの区間内に上限超の alpha overlay 入力)→ そのスパンが SLOW", () => {
  const overlays: OverlayItem[] = Array.from({ length: 130 }, (_, i) =>
    mkOverlay({ start: 0, end: 10, file: `m${i}.png`, opacity: 0.5 }),
  );
  const props = mkProps({ durationSec: 10, overlays });
  const plan = fastPlan(props);
  assert.deepEqual(plan.spans, [{ kind: "slow", fromFrame: 0, toFrame: plan.totalFrames }]);
  assert.ok(plan.notes.some((n) => n.includes("上限超過のため SLOW")));
});
