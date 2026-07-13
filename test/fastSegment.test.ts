// lib/fastSegment.ts の純関数テスト(node --test)。ffmpeg は一切実行しない。
// resolveFastCaptions(フレーム換算・z-order・hideCaption 分割・anim/karaoke
// ガード)と buildFastSegmentFilter/buildFastSegmentArgs(filtergraph 文字列・
// argv。B6 は 2-caption の worked example を全argv deepStrictEqual で固定)を
// 検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFastSegmentArgs,
  buildFastSegmentFilter,
  resolveFastCaptions,
} from "../src/lib/fastSegment.ts";
import type { FastSpan } from "../src/lib/fastPlan.ts";
import type { Caption, RenderProps } from "../remotion/props.ts";
import type { FastSegmentSpec } from "../src/lib/fastSegment.ts";

function mkProps(partial: Partial<RenderProps> = {}): RenderProps {
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
    durationSec: 300,
    ...partial,
  };
}

function mkCap(track: number, start: number, end: number, extra: Partial<Caption> = {}): Caption {
  return { start, end, text: `t${track}-${start}`, track, ...extra };
}

function span(fromFrame: number, toFrame: number): FastSpan {
  return { kind: "fast", fromFrame, toFrame };
}

// ---- resolveFastCaptions ----

test("R1: 空captions → []", () => {
  const props = mkProps({ captions: [] });
  assert.deepEqual(resolveFastCaptions(props, span(0, 300)), []);
});

test("R2: caption abs[30,120) span[0,300) → enableWindows [[30,119]]", () => {
  const cap = mkCap(1, 1, 4);
  const props = mkProps({ captions: [cap] });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 1);
  assert.equal(result[0].caption, cap);
  assert.deepEqual(result[0].enableWindows, [[30, 119]]);
});

test("R3: 左クランプ caption abs[10,120) span[30,300) → local [[0,89]]", () => {
  const cap = mkCap(1, 10 / 30, 120 / 30); // start frame 10, end frame 120
  const props = mkProps({ captions: [cap] });
  const result = resolveFastCaptions(props, span(30, 300));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[0, 89]]);
});

test("R4: 右クランプ caption abs[250,400) span[0,300) → local [[250,299]]", () => {
  const cap = mkCap(1, 250 / 30, 400 / 30);
  const props = mkProps({ captions: [cap] });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[250, 299]]);
});

test("R5: 範囲外 caption abs[400,500) span[0,300) → []", () => {
  const cap = mkCap(1, 400 / 30, 500 / 30);
  const props = mkProps({ captions: [cap] });
  assert.deepEqual(resolveFastCaptions(props, span(0, 300)), []);
});

test("R6: z-order + トラック未登場は捨てる", () => {
  const capA = mkCap(1, 1, 4); // track 1
  const capB = mkCap(2, 1, 4); // track 2
  const capC = mkCap(3, 1, 4); // track 3 (layerOrder に無い)
  const props = mkProps({
    captions: [capA, capB, capC],
    layerOrder: ["ov1", "wipe", "caption", "cap2"],
  });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 2);
  assert.equal(result[0].caption.track, 1);
  assert.equal(result[1].caption.track, 2);
});

test("R7: hideCaption による分割", () => {
  const cap = mkCap(1, 1, 4); // abs [30,120)
  const props = mkProps({
    captions: [cap],
    hideCaption: [{ start: 2, end: 3 }], // abs [60,90)
  });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [
    [30, 59],
    [90, 119],
  ]);
});

test("R8: anim/karaoke ガード", () => {
  const propsAnim = mkProps({
    captions: [mkCap(1, 1, 4, { style: { anim: { in: "fade" } } })],
  });
  assert.throws(() => resolveFastCaptions(propsAnim, span(0, 300)));

  const propsKaraoke = mkProps({
    captions: [mkCap(1, 1, 4, { style: { karaoke: {} } })],
  });
  assert.throws(() => resolveFastCaptions(propsKaraoke, span(0, 300)));
});

test("R9: フレーム境界(start=1.0,end=3.0,fps30) → [[30,89]]", () => {
  const cap = mkCap(1, 1.0, 3.0);
  const props = mkProps({ captions: [cap] });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[30, 89]]);
});

// ---- buildFastSegmentFilter / buildFastSegmentArgs ----

function mkSpec(overrides: Partial<FastSegmentSpec> = {}): FastSegmentSpec {
  return {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/render.fast/segments/seg000.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    captions: [],
    ...overrides,
  };
}

test("B1: captionsゼロ件の filter/args", () => {
  const spec = mkSpec();
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.endsWith("format=yuvj420p[vout]"));
  assert.ok(!filter.includes(";"));
  assert.ok(!filter.includes("overlay"));

  const args = buildFastSegmentArgs(spec);
  assert.ok(args.includes("-an"));
  const pairs: [string, string][] = [];
  for (let i = 0; i < args.length - 1; i++) pairs.push([args[i], args[i + 1]]);
  const has = (flag: string, value: string) => pairs.some(([f, v]) => f === flag && v === value);
  assert.ok(has("-c:v", "h264_videotoolbox"));
  assert.ok(has("-profile:v", "high"));
  assert.ok(has("-video_track_timescale", "90000"));
  assert.ok(has("-color_range", "pc"));
  assert.ok(has("-colorspace", "smpte170m"));
  assert.ok(has("-forced-idr", "1"));
  assert.ok(has("-force_key_frames", "expr:eq(n,0)"));
  assert.ok(args.includes("-g"));
  assert.ok(has("-map", "[vout]"));
  assert.equal(args.at(-1), spec.outPath);
});

test("B2: trim はフレーム指定(秒指定でない)", () => {
  const spec = mkSpec({ fromFrame: 0, toFrame: 300 });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("trim=start_frame=0:end_frame=300"));
  assert.ok(!filter.includes("trim=start="));
});

test("B3: caption 1件", () => {
  const spec = mkSpec({
    captions: [{ pngPath: "/rec/render.fast/captions/aaa.png", enableWindows: [[30, 119]] }],
  });
  const args = buildFastSegmentArgs(spec);
  const iIndices = args.reduce<number[]>((acc, a, i) => {
    if (a === "-i") acc.push(i);
    return acc;
  }, []);
  assert.equal(iIndices.length, 2); // cut + 1 png
  assert.equal(args[iIndices[1] + 1], "/rec/render.fast/captions/aaa.png");

  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("[0:v]trim=start_frame=0:end_frame=300,setpts=PTS-STARTPTS,"));
  assert.ok(filter.endsWith("[b0];[b0][1:v]overlay=x=0:y=0:format=auto:enable='between(n,30,119)'[vout]"));
});

test("B4: caption 2件のラベル遷移", () => {
  const spec = mkSpec({
    captions: [
      { pngPath: "/rec/a.png", enableWindows: [[30, 119]] },
      { pngPath: "/rec/b.png", enableWindows: [[60, 149]] },
    ],
  });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("[1:v]"));
  assert.ok(filter.includes("[2:v]"));
  assert.ok(filter.includes("[b0]"));
  assert.ok(filter.includes("[o0]"));
  assert.ok(filter.includes("[vout]"));
  assert.ok(!filter.includes("[o1]")); // 最後は vout に直行
});

test("B5: 複合 enable ウィンドウ", () => {
  const spec = mkSpec({
    captions: [
      {
        pngPath: "/rec/a.png",
        enableWindows: [
          [30, 59],
          [90, 119],
        ],
      },
    ],
  });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("enable='between(n,30,59)+between(n,90,119)'"));
});

test("B6: 2-caption worked example の全argv・filter を固定", () => {
  const spec: FastSegmentSpec = {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/seg003.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    captions: [
      { pngPath: "/rec/aaa.png", enableWindows: [[30, 119]] },
      { pngPath: "/rec/bbb.png", enableWindows: [[60, 149]] },
    ],
  };

  const filter = buildFastSegmentFilter(spec);
  assert.equal(
    filter,
    "[0:v]trim=start_frame=0:end_frame=300,setpts=PTS-STARTPTS,scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p[b0];" +
      "[b0][1:v]overlay=x=0:y=0:format=auto:enable='between(n,30,119)'[o0];" +
      "[o0][2:v]overlay=x=0:y=0:format=auto:enable='between(n,60,149)'[vout]",
  );

  const args = buildFastSegmentArgs(spec);
  assert.deepStrictEqual(args, [
    "-y",
    "-v",
    "error",
    "-i",
    "/rec/cut.mp4",
    "-i",
    "/rec/aaa.png",
    "-i",
    "/rec/bbb.png",
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-an",
    "-c:v",
    "h264_videotoolbox",
    "-profile:v",
    "high",
    "-b:v",
    "8000k",
    "-video_track_timescale",
    "90000",
    "-color_range",
    "pc",
    "-colorspace",
    "smpte170m",
    "-g",
    "60",
    "-forced-idr",
    "1",
    "-force_key_frames",
    "expr:eq(n,0)",
    "/rec/seg003.mp4",
  ]);
});

// ---- worked example resolveFastCaptions cross-check ----

test("worked example: resolveFastCaptions が B6 の入力と一致する", () => {
  const capA = mkCap(1, 1, 4); // abs [30,120)
  const capB = mkCap(2, 2, 5); // abs [60,150)
  const props = mkProps({
    captions: [capA, capB],
    layerOrder: ["ov1", "wipe", "caption", "cap2"],
  });
  const result = resolveFastCaptions(props, span(0, 300));
  assert.equal(result.length, 2);
  assert.equal(result[0].caption, capA);
  assert.deepEqual(result[0].enableWindows, [[30, 119]]);
  assert.equal(result[1].caption, capB);
  assert.deepEqual(result[1].enableWindows, [[60, 149]]);
});
