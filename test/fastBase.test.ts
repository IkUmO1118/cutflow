// lib/fastBase.ts の純関数テスト(node --test)。design-T4.md §5「test/fastBase.test.ts」。
// baseLayoutOf/baseSegOf/cutFrameOf が Main.tsx の <Sequence>/<OffthreadVideo startFrom>
// と同一式(frameSpans 経由)であること・不変条件の検査(playbackRate・穴・重なり・
// 0長の膨張)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseLayoutOf, baseSegOf, cutFrameOf } from "../src/lib/fastBase.ts";
import { frameSpans } from "../src/lib/renderProps.ts";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";
import type { BaseLayout } from "../src/lib/fastBase.ts";
import type { RenderProps } from "../remotion/props.ts";

function mkProps(partial: Partial<RenderProps> & { durationSec: number }): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm: [],
    fps: 30,
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
    ...partial,
  };
}

function ok(layout: BaseLayout): Extract<BaseLayout, { ok: true }> {
  assert.equal(layout.ok, true, `expected ok:true, got ${JSON.stringify(layout)}`);
  return layout as Extract<BaseLayout, { ok: true }>;
}

// ---- B1: 挿入無し(恒等写像の退化) ----

test("B1: 挿入無し → base 1本 {0,totalFrames,videoStartFrame:0}・inserts 空・cutFrameOf(seg,n)===n", () => {
  const props = mkProps({ durationSec: 10 });
  const layout = ok(baseLayoutOf(props));
  const totalFrames = compositionDurationInFrames(10, 30);
  assert.deepEqual(layout.base, [{ fromFrame: 0, toFrame: totalFrames, videoStartFrame: 0 }]);
  assert.deepEqual(layout.inserts, []);
  assert.equal(layout.totalFrames, totalFrames);
  for (const n of [0, 1, 100, totalFrames - 1]) {
    assert.equal(cutFrameOf(layout.base[0], n), n);
  }
});

// ---- B2: 挿入1件(中間) ----

test("B2: 挿入1件(中間)→ base 2本。2本目の videoStartFrame が挿入尺ぶん前へ戻る", () => {
  const props = mkProps({
    durationSec: 30, // base[0,20) + insert[20,25) + base[25,30)
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
  });
  const layout = ok(baseLayoutOf(props));
  assert.equal(layout.base.length, 2);
  assert.deepEqual(layout.base[0], { fromFrame: 0, toFrame: 600, videoStartFrame: 0 });
  assert.deepEqual(layout.base[1], { fromFrame: 750, toFrame: 900, videoStartFrame: 600 });
  assert.deepEqual(layout.inserts, [{ index: 0, fromFrame: 600, toFrame: 750 }]);
  // videoStartFrame(600) = fromFrame(750) - 挿入尺(150 frame = 5秒*30fps)
  assert.equal(layout.base[1].videoStartFrame, layout.base[1].fromFrame - 150);
});

// ---- B3: frameSpans と同じ丸めであることを直接突き合わせる ----

test("B3: baseLayoutOf の from/toFrame は frameSpans の出力と一致する(丸めの二重実装が無いことの確認)", () => {
  const baseSegments = [
    { start: 0, videoStart: 0, durationSec: 12.34 },
    { start: 15.5, videoStart: 12.34, durationSec: 8.2 },
  ];
  const inserts: NonNullable<RenderProps["inserts"]> = [
    { start: 12.34, end: 15.5, file: "i.mp4", fit: "contain", fadeInSec: 0.5 },
  ];
  const durationSec = 23.7;
  const props = mkProps({ durationSec, baseSegments, inserts });
  const fps = props.fps;
  const totalFrames = compositionDurationInFrames(durationSec, fps);
  const expected = frameSpans({ baseSegments, inserts, fps, durationInFrames: totalFrames });
  const layout = ok(baseLayoutOf(props));
  layout.base.forEach((b, i) => {
    assert.equal(b.fromFrame, expected.base[i].from);
    assert.equal(b.toFrame, expected.base[i].from + expected.base[i].durationInFrames);
  });
  layout.inserts.forEach((ins, i) => {
    assert.equal(ins.fromFrame, expected.inserts[i].from);
    assert.equal(ins.toFrame, expected.inserts[i].from + expected.inserts[i].durationInFrames);
  });
});

// ---- B4: 先頭の挿入・末尾の挿入 ----

test("B4: 先頭(start===0)・末尾(end===durationSec)の挿入 → base は挿入の間だけに1本", () => {
  const durationSec = 13; // insert[0,2) + base[2,10) + insert[10,13)
  const props = mkProps({
    durationSec,
    baseSegments: [{ start: 2, videoStart: 0, durationSec: 8 }],
    inserts: [
      { start: 0, end: 2, file: "a.mp4", fit: "cover" },
      { start: 10, end: 13, file: "b.mp4", fit: "cover" },
    ],
  });
  const layout = ok(baseLayoutOf(props));
  assert.equal(layout.base.length, 1);
  assert.equal(layout.base[0].fromFrame, 60); // 2秒*30fps
  assert.equal(layout.base[0].toFrame, 300); // 10秒*30fps
  assert.equal(layout.inserts.length, 2);
  assert.equal(layout.inserts[0].fromFrame, 0);
  assert.equal(layout.inserts[1].toFrame, layout.totalFrames);
});

// ---- B5: 連続2件の挿入(間にベース無し)/ 退化0長baseの弾き ----

test("B5a: 連続する2件の挿入(間にベース無し)→ その間に base 区間が生まれない", () => {
  const durationSec = 10; // insert[0,3) + insert[3,6) + base[6,10)
  const props = mkProps({
    durationSec,
    baseSegments: [{ start: 6, videoStart: 0, durationSec: 4 }],
    inserts: [
      { start: 0, end: 3, file: "a.mp4", fit: "cover" },
      { start: 3, end: 6, file: "b.mp4", fit: "cover" },
    ],
  });
  const layout = ok(baseLayoutOf(props));
  assert.equal(layout.base.length, 1);
  assert.equal(layout.inserts.length, 2);
  // 挿入どうしが隙間なく接続している(base が挟まっていない)
  assert.equal(layout.inserts[0].toFrame, layout.inserts[1].fromFrame);
});

test("B5b: 退化した0長base(frameSpans の Math.max(1,…) 膨張)→ ok:false", () => {
  // base[5,5)(durationSec:0)が insert1[5,8) と同じ frame 位置に膨張し重なる
  const props = mkProps({
    durationSec: 8,
    baseSegments: [{ start: 5, videoStart: 0, durationSec: 0 }],
    inserts: [
      { start: 0, end: 5, file: "a.mp4", fit: "cover" },
      { start: 5, end: 8, file: "b.mp4", fit: "cover" },
    ],
  });
  const layout = baseLayoutOf(props);
  assert.equal(layout.ok, false);
});

// ---- B6: playbackRate ----

test("B6: playbackRate: 0.5 の baseSegment → {ok:false, reason:'playbackRate'}", () => {
  const props = mkProps({
    durationSec: 10,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 10, playbackRate: 0.5 }],
  });
  const layout = baseLayoutOf(props);
  assert.deepEqual(layout, { ok: false, reason: "playbackRate" });
});

// ---- B7: 人為的に重なる baseSegments ----

test("B7: 人為的に重なる baseSegments → ok:false", () => {
  const props = mkProps({
    durationSec: 15,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 10 },
      { start: 5, videoStart: 5, durationSec: 10 },
    ],
  });
  const layout = baseLayoutOf(props);
  assert.equal(layout.ok, false);
});

// ---- B8: baseSegOf ----

test("B8: baseSegOf: スパンが2つの base をまたぐ → null", () => {
  const props = mkProps({
    durationSec: 30,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
  });
  const layout = ok(baseLayoutOf(props));
  // span[0,750) は base[0](0-600)を超えて base[1]の頭(750)まで到達するが
  // base[0]の終端(600)を越えるので単一baseに収まらない
  assert.equal(baseSegOf(layout, { fromFrame: 0, toFrame: 750 }), null);
  // 単一baseに完全収容される場合は非null
  assert.equal(baseSegOf(layout, { fromFrame: 0, toFrame: 600 }), layout.base[0]);
  assert.equal(baseSegOf(layout, { fromFrame: 750, toFrame: 900 }), layout.base[1]);
});
