// lib/chunkPlan.ts — チャンク差分レンダー(render.chunks/)のキャッシュキーを
// 固定する。設計文書 docs/render-chunk-cache.md §3-3 の不変条件:
// - テロップ1件の text/pos/style を変えると、それが乗るチャンクの
//   chunkVideoKey だけが変わり、他チャンクと audioKey は不変。
// - BGM/volume/ducking/cut.mp4 を変えると audioKey が変わる。
// - 全域 props(layerOrder 等)を変えると全チャンクの chunkVideoKey が変わる。
// - 境界 [from,to) ちょうどに end が来る要素が ±1フレームで取りこぼれない。
// - carveBoundaries が疎な keyframe でも単調増加・被りなし。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioKey,
  carveBoundaries,
  chunkVideoKey,
  globalVideoKey,
  overlapsChunk,
} from "../src/lib/chunkPlan.ts";
import type { RenderProps } from "../remotion/props.ts";

const FPS = 30;
// 2チャンク: [0,150) と [150,300)(5秒ずつ)
const CUT_STAT = { mtimeMs: 1000, size: 2000 };

const PROPS: RenderProps = {
  videoFile: "cut.mp4",
  bgm: [{ file: "bgm.mp3", volumeDb: -22, start: 0, end: 10 }],
  durationSec: 10,
  fps: FPS,
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 0, y: 0, w: 0, h: 0 },
  wipe: { widthPx: 480, marginPx: 32 },
  caption: { fontSizePx: 44 },
  captions: [
    { start: 1, end: 2, text: "chunk0のテロップ", track: 1 },
    { start: 6, end: 7, text: "chunk1のテロップ", track: 1 },
  ],
  overlays: [],
  wipeFull: [],
  hideCaption: [],
};

function keysOf(props: RenderProps) {
  return {
    chunk0: chunkVideoKey(props, 0, 150, CUT_STAT, FPS),
    chunk1: chunkVideoKey(props, 150, 300, CUT_STAT, FPS),
    audio: audioKey(props, CUT_STAT, []),
  };
}

test("chunkVideoKey: テロップ1件の text 変更は乗っているチャンクのキーだけを変える", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    captions: [
      { ...PROPS.captions[0], text: "編集後のテロップ" },
      PROPS.captions[1],
    ],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("chunkVideoKey: テロップの pos 変更は乗っているチャンクのキーだけを変える", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    captions: [
      { ...PROPS.captions[0], pos: { x: 100, y: 200 } },
      PROPS.captions[1],
    ],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("chunkVideoKey: テロップの style 変更は乗っているチャンクのキーだけを変える", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    captions: [
      { ...PROPS.captions[0], style: { color: "#ff0000" } },
      PROPS.captions[1],
    ],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("audioKey: BGM の区間変更で audioKey が変わる(映像キーは不変)", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    bgm: [{ file: "bgm.mp3", volumeDb: -22, start: 0, end: 8 }],
  });
  assert.notEqual(before.audio, after.audio);
  assert.equal(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
});

test("audioKey: BGM の volumeDb 変更で audioKey が変わる", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    bgm: [{ file: "bgm.mp3", volumeDb: -10, start: 0, end: 10 }],
  });
  assert.notEqual(before.audio, after.audio);
});

test("audioKey: ducking(BGM区間のduck)変更で audioKey が変わる", () => {
  const before = keysOf(PROPS);
  const after = keysOf({
    ...PROPS,
    bgm: [
      {
        ...PROPS.bgm[0],
        duck: { spans: [{ start: 1, end: 2 }], duckDb: -8, fadeSec: 0.4 },
      },
    ],
  });
  assert.notEqual(before.audio, after.audio);
});

test("audioKey: cut.mp4 の mtime/size 変更で audioKey が変わる", () => {
  const a = audioKey(PROPS, CUT_STAT, []);
  const b = audioKey(PROPS, { mtimeMs: 1001, size: 2000 }, []);
  assert.notEqual(a, b);
});

test("audioKey: overlay の volume 変更で audioKey は変わるが chunkVideoKey は不変", () => {
  const withOverlay: RenderProps = {
    ...PROPS,
    overlays: [
      { start: 1, end: 2, file: "materials/a.mp4", track: 1, fit: "contain", volume: 0 },
    ],
  };
  const before = keysOf(withOverlay);
  const after = keysOf({
    ...withOverlay,
    overlays: [{ ...withOverlay.overlays[0], volume: 1 }],
  });
  assert.notEqual(before.audio, after.audio);
  assert.equal(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
});

test("chunkVideoKey: cutBoundarySecs の追加は境界を含むチャンクのキーだけを変える", () => {
  const before = keysOf(PROPS);
  // 境界は chunk0 側([0,5s))の 2.5s
  const after = keysOf({
    ...PROPS,
    cutTransition: { sec: 0.4 },
    cutBoundarySecs: [2.5],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
  assert.equal(globalVideoKey(PROPS, CUT_STAT), globalVideoKey({ ...PROPS, cutTransition: { sec: 0.4 }, cutBoundarySecs: [2.5] }, CUT_STAT));
});

test("chunkVideoKey: cutTransition.sec の変更は境界を含まないチャンクのキーを変えない", () => {
  const withBoundary: RenderProps = {
    ...PROPS,
    cutTransition: { sec: 0.4 },
    cutBoundarySecs: [2.5], // chunk0 側のみ
  };
  const before = keysOf(withBoundary);
  const after = keysOf({ ...withBoundary, cutTransition: { sec: 1.0 } });
  assert.notEqual(before.chunk0, after.chunk0); // 境界を含むチャンクは変わる
  assert.equal(before.chunk1, after.chunk1); // 境界を含まないチャンクは不変
  assert.equal(before.audio, after.audio); // 音声には影響しない
});

test("chunkVideoKey: sec を広げて境界の影響範囲が隣のチャンクに及ぶと、そのチャンクのキーも変わる", () => {
  // 境界 5.2s はチャンク1側([5,10s))。sec が狭いと chunk1 だけに重なるが、
  // 広げると安全マージンが chunk0([0,5s))側にも届く
  const narrow: RenderProps = { ...PROPS, cutTransition: { sec: 0.2 }, cutBoundarySecs: [5.2] };
  const wide: RenderProps = { ...PROPS, cutTransition: { sec: 2.6 }, cutBoundarySecs: [5.2] };
  const n = keysOf(narrow);
  const w = keysOf(wide);
  assert.equal(n.chunk0, keysOf(PROPS).chunk0); // 狭い sec では chunk0 に影響なし
  assert.notEqual(n.chunk0, w.chunk0); // 広い sec では chunk0 も境界を拾う
  assert.notEqual(n.chunk1, w.chunk1); // chunk1 は両方で境界を含むが sec 自体が変わる
});

test("chunkVideoKey/audioKey: cutTransition が無いとき(既存挙動)はキーに影響しない", () => {
  const withNull: RenderProps = { ...PROPS, cutTransition: undefined, cutBoundarySecs: undefined };
  const before = keysOf(PROPS);
  const after = keysOf(withNull);
  assert.equal(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("chunkVideoKey: zooms は wipeFull と同じくチャンク限定(重なるチャンクだけキーが変わる・全域キー不変)", () => {
  const before = keysOf(PROPS);
  const withZoom: RenderProps = {
    ...PROPS,
    zooms: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.4 }],
  };
  const after = keysOf(withZoom);
  assert.notEqual(before.chunk0, after.chunk0); // 1-2s は chunk0([0,5s))に重なる
  assert.equal(before.chunk1, after.chunk1); // chunk1([5,10s))には重ならない
  assert.equal(before.audio, after.audio); // 音声には影響しない
  assert.equal(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(withZoom, CUT_STAT));
});

test("chunkVideoKey: zoom の rect 変更は乗っているチャンクのキーだけを変える", () => {
  const withZoom: RenderProps = {
    ...PROPS,
    zooms: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.4 }],
  };
  const before = keysOf(withZoom);
  const after = keysOf({
    ...withZoom,
    zooms: [{ ...withZoom.zooms![0], rect: { x: 100, y: 100, w: 800, h: 900 } }],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("chunkVideoKey: blurs は zooms/wipeFull と同じくチャンク限定(重なるチャンクだけキーが変わる・全域キー不変)", () => {
  const before = keysOf(PROPS);
  const withBlur: RenderProps = {
    ...PROPS,
    blurs: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 500, h: 200 }, type: "blur", strength: 0.5 }],
  };
  const after = keysOf(withBlur);
  assert.notEqual(before.chunk0, after.chunk0); // 1-2s は chunk0([0,5s))に重なる
  assert.equal(before.chunk1, after.chunk1); // chunk1([5,10s))には重ならない
  assert.equal(before.audio, after.audio); // 音声には影響しない
  assert.equal(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(withBlur, CUT_STAT));
});

test("chunkVideoKey: blur の rect 変更は乗っているチャンクのキーだけを変える", () => {
  const withBlur: RenderProps = {
    ...PROPS,
    blurs: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 500, h: 200 }, type: "blur", strength: 0.5 }],
  };
  const before = keysOf(withBlur);
  const after = keysOf({
    ...withBlur,
    blurs: [{ ...withBlur.blurs![0], rect: { x: 100, y: 100, w: 400, h: 300 } }],
  });
  assert.notEqual(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("chunkVideoKey: blurs 無しは現行のキーと一致する(キャッシュ総無効化を起こさない)", () => {
  const before = keysOf(PROPS);
  const after = keysOf({ ...PROPS, blurs: undefined });
  assert.equal(before.chunk0, after.chunk0);
  assert.equal(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio);
});

test("globalVideoKey / chunkVideoKey: layerOrder 変更で全チャンクのキーが変わる", () => {
  const before = keysOf(PROPS);
  const changed: RenderProps = { ...PROPS, layerOrder: ["wipe", "caption"] };
  const after = keysOf(changed);
  assert.notEqual(before.chunk0, after.chunk0);
  assert.notEqual(before.chunk1, after.chunk1);
  assert.notEqual(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(changed, CUT_STAT));
});

test("globalVideoKey/chunkVideoKey: colorFilter 変更は全チャンクのキーを変える(グローバルキー扱い)", () => {
  const before = keysOf(PROPS);
  const changed: RenderProps = { ...PROPS, colorFilter: { brightness: 1.2 } };
  const after = keysOf(changed);
  assert.notEqual(before.chunk0, after.chunk0);
  assert.notEqual(before.chunk1, after.chunk1);
  assert.equal(before.audio, after.audio); // 音声には影響しない
  assert.notEqual(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(changed, CUT_STAT));
});

test("globalVideoKey: wipe 幾何変更で全域キーが変わる", () => {
  const changed: RenderProps = { ...PROPS, wipe: { ...PROPS.wipe, widthPx: 600 } };
  assert.notEqual(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(changed, CUT_STAT));
});

test("globalVideoKey: baseSegments 変更で全域キーが変わる(inserts の尺変更等を包含)", () => {
  const changed: RenderProps = {
    ...PROPS,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 10 }],
  };
  assert.notEqual(globalVideoKey(PROPS, CUT_STAT), globalVideoKey(changed, CUT_STAT));
});

test("overlapsChunk: 通常の重なり判定", () => {
  assert.ok(overlapsChunk(1, 2, 0, 150, FPS)); // 完全に内側
  assert.ok(!overlapsChunk(6, 7, 0, 150, FPS)); // 完全に外側(次チャンク)
});

test("overlapsChunk: 境界ちょうどに end が来る要素は ±1フレームで両チャンクから拾える", () => {
  // end = 150フレーム目(ちょうどチャンク境界)の要素
  const elemStart = 140 / FPS;
  const elemEnd = 150 / FPS;
  assert.ok(overlapsChunk(elemStart, elemEnd, 0, 150, FPS), "前チャンクに含まれる");
  assert.ok(overlapsChunk(elemStart, elemEnd, 150, 300, FPS), "安全マージンで次チャンクにも含まれる");
});

test("overlapsChunk: 境界ちょうどに start が来る要素は ±1フレームで両チャンクから拾える", () => {
  const elemStart = 150 / FPS;
  const elemEnd = 160 / FPS;
  assert.ok(overlapsChunk(elemStart, elemEnd, 0, 150, FPS), "安全マージンで前チャンクにも含まれる");
  assert.ok(overlapsChunk(elemStart, elemEnd, 150, 300, FPS), "次チャンクに含まれる");
});

test("carveBoundaries: 単調増加・被りなし(密な keyframe)", () => {
  const keyframes = Array.from({ length: 30 }, (_, i) => i * 30); // 1秒毎
  const boundaries = carveBoundaries(keyframes, 900, 5, 30); // 5秒チャンク狙い、30秒動画
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries[boundaries.length - 1], 900);
  for (let i = 1; i < boundaries.length; i++) {
    assert.ok(boundaries[i] > boundaries[i - 1], "単調増加");
  }
});

test("carveBoundaries: 疎な keyframe でも単調増加・被りなし(目標より長いチャンクになる)", () => {
  // keyframe が10秒毎しかない(静的シーン相当)。目標は3秒チャンク
  const keyframes = [0, 300, 600, 900];
  const boundaries = carveBoundaries(keyframes, 1200, 3, 30);
  assert.deepEqual(boundaries, [0, 300, 600, 900, 1200]);
  for (let i = 1; i < boundaries.length; i++) {
    assert.ok(boundaries[i] > boundaries[i - 1]);
  }
});

test("carveBoundaries: keyframe が無ければ全体で1チャンク", () => {
  const boundaries = carveBoundaries([], 300, 5, 30);
  assert.deepEqual(boundaries, [0, 300]);
});

test("carveBoundaries: totalFrames が目標長未満なら1チャンクのみ", () => {
  const boundaries = carveBoundaries([0, 30, 60], 100, 5, 30);
  assert.deepEqual(boundaries, [0, 100]);
});

test("chunkVideoKey/audioKey: 安定ソート済みなので要素の並び順に依存しない", () => {
  const a: RenderProps = {
    ...PROPS,
    captions: [PROPS.captions[0], PROPS.captions[1]],
  };
  const b: RenderProps = {
    ...PROPS,
    captions: [PROPS.captions[1], PROPS.captions[0]],
  };
  assert.equal(chunkVideoKey(a, 0, 150, CUT_STAT, FPS), chunkVideoKey(b, 0, 150, CUT_STAT, FPS));
});

// F4: plain(cameraRegion undefined)でもキーが決定的(stableHash が undefined
// キーを落とすだけで安定する。obs↔plain は width/height/screenRegion の
// どれかが必ず違うのでキーは自然に分かれる)
test("globalVideoKey/chunkVideoKey: cameraRegion 無し(plain props)でもキーが決定的で obs-canvas とは異なる", () => {
  const plainProps: RenderProps = {
    ...PROPS,
    width: 1080,
    height: 1920,
    canvas: { w: 1080, h: 1920 },
    screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    cameraRegion: undefined,
  };
  const k1 = globalVideoKey(plainProps, CUT_STAT);
  const k2 = globalVideoKey({ ...plainProps }, CUT_STAT);
  assert.equal(k1, k2);
  assert.notEqual(k1, globalVideoKey(PROPS, CUT_STAT));

  const c1 = keysOf(plainProps);
  const c2 = keysOf({ ...plainProps });
  assert.deepEqual(c1, c2);
});
