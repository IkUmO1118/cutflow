// lib/fastSegment.ts の純関数テスト(node --test)。ffmpeg は一切実行しない。
// resolveFastLayers(フレーム換算・z-order・hideCaption 分割・anim/karaoke
// ガード・overlay の Sequence 区間・不変条件の throw)、mergeFastLayers
// (畳み込み)、countFastPngInputs、buildFastSegmentFilter/buildFastSegmentArgs
// (filtergraph 文字列・argv。B6 は 2-caption の worked example を全argv
// deepStrictEqual で固定)を検証する。P5-1(静止画 overlay の FAST 化)で
// resolveFastCaptions → resolveFastLayers へ一般化された(design-T1.md §6・
// 補遺4: fade 一致テストはストリーム先頭基準の式で書く)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_COLOR_FILTER,
  FAST_FPS_ROUND,
  buildFastSegmentArgs,
  buildFastSegmentFilter,
  countFastPngInputs,
  fastLayerMergeKey,
  mergeFastLayers,
  renderFastSegment,
  resolveFastLayers,
} from "../src/lib/fastSegment.ts";
import { fadeFactor } from "../src/lib/overlayFade.ts";
import type { FastSpan } from "../src/lib/fastPlan.ts";
import type { Caption, OverlayItem, RenderProps, ResolvedAnnotation } from "../remotion/props.ts";
import type { FastLayerItem, FastSegmentSpec } from "../src/lib/fastSegment.ts";
import type { WarmAssets } from "../src/stages/frames.ts";

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

function mkOverlay(partial: Partial<OverlayItem> & { start: number; end: number }): OverlayItem {
  return { file: "m.png", track: 1, fit: "contain", ...partial };
}

function mkAnnotation(partial: Partial<ResolvedAnnotation> & { start: number; end: number }): ResolvedAnnotation {
  return {
    type: "box",
    rect: { x: 0, y: 0, w: 100, h: 100 },
    color: "#fff",
    widthPx: 4,
    radiusPx: 0,
    ...partial,
  } as ResolvedAnnotation;
}

function span(fromFrame: number, toFrame: number): FastSpan {
  return { kind: "fast", fromFrame, toFrame };
}

function captionsOf(items: FastLayerItem[]): Extract<FastLayerItem, { kind: "caption" }>[] {
  return items.filter((it): it is Extract<FastLayerItem, { kind: "caption" }> => it.kind === "caption");
}

// ---- resolveFastLayers: caption 経路(旧 resolveFastCaptions と同じ挙動) ----

test("R1: 空captions/overlays → []", () => {
  const props = mkProps({ captions: [] });
  assert.deepEqual(resolveFastLayers(props, span(0, 300)), []);
});

test("R2: caption abs[30,120) span[0,300) → enableWindows [[30,119]]", () => {
  const cap = mkCap(1, 1, 4);
  const props = mkProps({ captions: [cap] });
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
  assert.equal(result.length, 1);
  assert.equal(result[0].caption, cap);
  assert.deepEqual(result[0].enableWindows, [[30, 119]]);
});

test("R3: 左クランプ caption abs[10,120) span[30,300) → local [[0,89]]", () => {
  const cap = mkCap(1, 10 / 30, 120 / 30);
  const props = mkProps({ captions: [cap] });
  const result = captionsOf(resolveFastLayers(props, span(30, 300)));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[0, 89]]);
});

test("R4: 右クランプ caption abs[250,400) span[0,300) → local [[250,299]]", () => {
  const cap = mkCap(1, 250 / 30, 400 / 30);
  const props = mkProps({ captions: [cap] });
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[250, 299]]);
});

test("R5: 範囲外 caption abs[400,500) span[0,300) → []", () => {
  const cap = mkCap(1, 400 / 30, 500 / 30);
  const props = mkProps({ captions: [cap] });
  assert.deepEqual(resolveFastLayers(props, span(0, 300)), []);
});

test("R6: z-order + トラック未登場は捨てる", () => {
  const capA = mkCap(1, 1, 4);
  const capB = mkCap(2, 1, 4);
  const capC = mkCap(3, 1, 4); // track 3 (layerOrder に無い)
  const props = mkProps({
    captions: [capA, capB, capC],
    layerOrder: ["ov1", "wipe", "caption", "cap2"],
  });
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
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
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
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
  assert.throws(() => resolveFastLayers(propsAnim, span(0, 300)));

  const propsKaraoke = mkProps({
    captions: [mkCap(1, 1, 4, { style: { karaoke: {} } })],
  });
  assert.throws(() => resolveFastLayers(propsKaraoke, span(0, 300)));
});

test("R9: フレーム境界(start=1.0,end=3.0,fps30) → [[30,89]]", () => {
  const cap = mkCap(1, 1.0, 3.0);
  const props = mkProps({ captions: [cap] });
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[30, 89]]);
});

test("R10: 同一trackのoverlapは配列順先勝ちで後続は重なり後から表示", () => {
  const first = mkCap(1, 1, 4, { text: "first" });
  const second = mkCap(1, 3, 5, { text: "second" });
  const props = mkProps({ captions: [first, second] });
  const result = captionsOf(resolveFastLayers(props, span(0, 180)));
  assert.equal(result.length, 2);
  assert.equal(result[0].caption, first);
  assert.deepEqual(result[0].enableWindows, [[30, 119]]);
  assert.equal(result[1].caption, second);
  assert.deepEqual(result[1].enableWindows, [[120, 149]]);
});

// ---- S: resolveFastLayers / mergeFastLayers(overlay 経路。design §6) ----

test("S-1: layerOrder [wipe, ov1, caption, cap2] で overlay → caption の順に並ぶ", () => {
  const ov = mkOverlay({ start: 1, end: 4 }); // abs frame [30,120)
  const cap = mkCap(1, 1, 4); // abs frame [30,120)
  const props = mkProps({
    overlays: [ov],
    captions: [cap],
    layerOrder: ["wipe", "ov1", "caption", "cap2"],
  });
  const result = resolveFastLayers(props, span(0, 300));
  assert.equal(result.length, 2);
  assert.equal(result[0].kind, "overlay");
  assert.equal(result[1].kind, "caption");
});

test("S-2: 1トラック内の overlay は配列順(後勝ちで上)", () => {
  const ov1 = mkOverlay({ start: 1, end: 2, file: "a.png" });
  const ov2 = mkOverlay({ start: 1, end: 2, file: "b.png" });
  const props = mkProps({ overlays: [ov1, ov2] });
  const result = resolveFastLayers(props, span(0, 300));
  assert.equal(result.length, 2);
  assert.equal(result[0].kind, "overlay");
  assert.equal((result[0] as Extract<FastLayerItem, { kind: "overlay" }>).item.file, "a.png");
  assert.equal((result[1] as Extract<FastLayerItem, { kind: "overlay" }>).item.file, "b.png");
});

test("S-3: overlay の enable 窓は overlaySeqRange(round(end*fps) ではない)", () => {
  // overlay#21 相当: start 93.57/end 93.65 → from=round(93.57*30)=2807,
  // dur=max(1,round((93.65-93.57)*30))=max(1,round(2.4))=2 → to=2809
  const ov = mkOverlay({ start: 93.57, end: 93.65 });
  const props = mkProps({ overlays: [ov], durationSec: 200 });
  const result = resolveFastLayers(props, span(2700, 2900));
  assert.equal(result.length, 1);
  const item = result[0] as Extract<FastLayerItem, { kind: "overlay" }>;
  const local0 = 2807 - 2700;
  assert.deepEqual(item.enableWindows, [[local0, local0 + 1]]); // [2807,2808] local
  assert.notEqual(Math.round(93.65 * 30), 2809); // round(end*fps)=2810 と一致しないことの確認
});

test("S-4: 畳み込み: 同一画像・fade 無し・連続3スライス → 1入力・1窓(coalesce)", () => {
  const items: FastLayerItem[] = [
    { kind: "overlay", item: mkOverlay({ start: 0, end: 1, file: "a.png" }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] },
    { kind: "overlay", item: mkOverlay({ start: 1, end: 2, file: "a.png" }), startFrame: 30, durFrames: 30, enableWindows: [[30, 59]] },
    { kind: "overlay", item: mkOverlay({ start: 2, end: 3, file: "a.png" }), startFrame: 60, durFrames: 30, enableWindows: [[60, 89]] },
  ];
  const props = mkProps();
  const merged = mergeFastLayers(props, items);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].enableWindows, [[0, 89]]);
});

test("S-5: 畳み込み: 間に時間の重なる別画像の op があるときは畳まない", () => {
  const items: FastLayerItem[] = [
    { kind: "overlay", item: mkOverlay({ start: 0, end: 1, file: "a.png" }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] },
    { kind: "overlay", item: mkOverlay({ start: 0, end: 3, file: "b.png", rect: { x: 0, y: 0, w: 10, h: 10 } }), startFrame: 0, durFrames: 90, enableWindows: [[0, 89]] },
    { kind: "overlay", item: mkOverlay({ start: 1, end: 2, file: "a.png" }), startFrame: 30, durFrames: 30, enableWindows: [[30, 59]] },
  ];
  const props = mkProps();
  const merged = mergeFastLayers(props, items);
  assert.equal(merged.length, 3); // a.png の2枚は間の b.png(重なる窓)に阻まれて畳めない
});

test("S-6: 畳み込み: fade 付き op は絶対に畳まれない", () => {
  const items: FastLayerItem[] = [
    { kind: "overlay", item: mkOverlay({ start: 0, end: 1, file: "a.png", fadeInSec: 0.1 }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] },
    { kind: "overlay", item: mkOverlay({ start: 1, end: 2, file: "a.png", fadeInSec: 0.1 }), startFrame: 30, durFrames: 30, enableWindows: [[30, 59]] },
  ];
  const props = mkProps();
  const merged = mergeFastLayers(props, items);
  assert.equal(merged.length, 2);
});

test("S-10: 不適格 overlay が FAST span に混入 → throw", () => {
  const props = mkProps({ overlays: [mkOverlay({ start: 1, end: 4, file: "m.mp4" })] });
  assert.throws(() => resolveFastLayers(props, span(0, 300)));
});

test("S-11: 適格 overlay が span をまたぐ → throw", () => {
  const props = mkProps({ overlays: [mkOverlay({ start: 1, end: 4 })] }); // abs[30,120)
  assert.throws(() => resolveFastLayers(props, span(0, 90))); // span が [30,120) を包含しない
});

test("S-12: countFastPngInputs は畳み込み後の入力数を返す", () => {
  const items: FastLayerItem[] = [
    { kind: "overlay", item: mkOverlay({ start: 0, end: 1, file: "a.png" }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] },
    { kind: "overlay", item: mkOverlay({ start: 1, end: 2, file: "a.png" }), startFrame: 30, durFrames: 30, enableWindows: [[30, 59]] },
  ];
  const props = mkProps({ overlays: items.map((it) => (it as Extract<FastLayerItem, { kind: "overlay" }>).item) });
  assert.equal(countFastPngInputs(props, span(0, 60)), 1);
});

test("fastLayerMergeKey: overlay は file|fit|rect で決まる(opacity/fade は含まない)", () => {
  const props = mkProps();
  const a: FastLayerItem = { kind: "overlay", item: mkOverlay({ start: 0, end: 1, file: "a.png", opacity: 0.3 }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] };
  const b: FastLayerItem = { kind: "overlay", item: mkOverlay({ start: 5, end: 6, file: "a.png", opacity: 0.9 }), startFrame: 150, durFrames: 30, enableWindows: [[150, 179]] };
  assert.equal(fastLayerMergeKey(props, a), fastLayerMergeKey(props, b));
});

// ---- G2: resolveFastLayers / annotation 経路(P5-2。design-T2.md §6) ----

function annotationsOf(items: FastLayerItem[]): Extract<FastLayerItem, { kind: "annotation" }>[] {
  return items.filter((it): it is Extract<FastLayerItem, { kind: "annotation" }> => it.kind === "annotation");
}

test("G2-1: resolveFastLayers: annotation は layerOrder の全レイヤーより後に並ぶ", () => {
  const ov = mkOverlay({ start: 1, end: 4 }); // abs frame [30,120)
  const cap = mkCap(1, 1, 4); // abs frame [30,120)
  const cap2 = mkCap(2, 1, 4);
  const ann = mkAnnotation({ start: 1, end: 4 }); // abs frame [30,120)
  const props = mkProps({
    overlays: [ov],
    captions: [cap, cap2],
    annotations: [ann],
    layerOrder: ["wipe", "ov1", "caption", "cap2"],
  });
  const result = resolveFastLayers(props, span(0, 300));
  assert.equal(result.at(-1)!.kind, "annotation");
  assert.ok(result.slice(0, -1).every((it) => it.kind !== "annotation"));
});

test("G2-2: enable 窓は Main の start<=t<end と一致する(fps=30, start=1.0/end=2.0 → local [[30,59]]、境界フレーム60は含まない)", () => {
  const ann = mkAnnotation({ start: 1.0, end: 2.0 });
  const props = mkProps({ annotations: [ann] });
  const result = annotationsOf(resolveFastLayers(props, span(0, 90)));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].enableWindows, [[30, 59]]);
});

test("G2-3: span をまたぐ annotation の窓は span 内へクリップされる(throw しない)", () => {
  // abs frame [0,180): span[0,90) を完全に覆い、span[90,180) も完全に覆う
  // (両方とも throw せずクリップされた [0,89] になることを確認する)
  const ann = mkAnnotation({ start: 0.0, end: 6.0 });
  const props = mkProps({ annotations: [ann] });
  const first = annotationsOf(resolveFastLayers(props, span(0, 90)));
  const second = annotationsOf(resolveFastLayers(props, span(90, 180)));
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].enableWindows, [[0, 89]]);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].enableWindows, [[0, 89]]);
});

test("G2-4: annotation は simple レイヤー: buildFastSegmentArgs の入力が -i <png> のみ(-loop/-framerate/-t が付かない)", () => {
  const spec = mkSpec({
    layers: [{ pngPath: "/rec/render.fast/annotations/aaa.png", enableWindows: [[30, 119]] }],
  });
  const args = buildFastSegmentArgs(spec);
  assert.ok(!args.includes("-loop"));
  assert.ok(!args.includes("-framerate"));
  assert.ok(!args.includes("-t"));
  const iIndices = args.reduce<number[]>((acc, a, i) => {
    if (a === "-i") acc.push(i);
    return acc;
  }, []);
  assert.equal(iIndices.length, 2); // cut + 1 png
  assert.equal(args[iIndices[1] + 1], "/rec/render.fast/annotations/aaa.png");
});

test("G2-5: 同一内容の annotation 2件(離れた時刻・間に重なる操作なし)は mergeFastLayers で1入力に畳まれ、enable 窓が2つになる", () => {
  const items: FastLayerItem[] = [
    { kind: "annotation", annotation: mkAnnotation({ start: 0, end: 1 }), enableWindows: [[0, 29]] },
    { kind: "annotation", annotation: mkAnnotation({ start: 5, end: 6 }), enableWindows: [[150, 179]] },
  ];
  const props = mkProps();
  const merged = mergeFastLayers(props, items);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].enableWindows, [
    [0, 29],
    [150, 179],
  ]);
});

test("G2-6: z-order: annotation 配列順で後のものが後ろ(上)に並ぶ", () => {
  const first = mkAnnotation({ start: 1, end: 4, color: "#111" });
  const second = mkAnnotation({ start: 1, end: 4, color: "#222" });
  const props = mkProps({ annotations: [first, second] });
  const result = annotationsOf(resolveFastLayers(props, span(0, 300)));
  assert.equal(result.length, 2);
  assert.equal(result[0].annotation, first);
  assert.equal(result[1].annotation, second);
});

test("G2-7: keyframes 付き annotation が FAST span に混入 → throw(安全弁)", () => {
  const ann = mkAnnotation({
    start: 1,
    end: 4,
    keyframes: [{ at: 1, easing: "linear", values: { x: 0 } }],
  });
  const props = mkProps({ annotations: [ann] });
  assert.throws(() => resolveFastLayers(props, span(0, 300)));
});

test("G2-8: buildFastSegmentFilter の snapshot: caption 1 + annotation 1 で§5.2(f) の順序(annotation が最後に overlay される)になる", () => {
  const spec: FastSegmentSpec = {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/seg000.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    layers: [
      { pngPath: "/rec/render.fast/captions/cap.png", enableWindows: [[30, 119]] },
      { pngPath: "/rec/render.fast/annotations/ann.png", enableWindows: [[12, 71]] },
    ],
  };
  const filter = buildFastSegmentFilter(spec);
  assert.equal(
    filter,
    `[0:v]setpts=PTS-STARTPTS,fps=fps=30:round=${FAST_FPS_ROUND}:start_time=0,trim=start_frame=0:end_frame=300,setpts=N/30/TB,scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p[b0];` +
      "[b0][1:v]overlay=x=0:y=0:format=auto:enable='between(n,30,119)'[o0];" +
      "[o0][2:v]overlay=x=0:y=0:format=auto:enable='between(n,12,71)'[vout]",
  );
});

test("G2-9: fastLayerMergeKey: annotation のキーは ann: 前置で caption/overlay のキーと衝突しない", () => {
  const props = mkProps();
  const annItem: FastLayerItem = { kind: "annotation", annotation: mkAnnotation({ start: 0, end: 1 }), enableWindows: [[0, 29]] };
  const key = fastLayerMergeKey(props, annItem);
  assert.ok(key.startsWith("ann:"));
  const capItem: FastLayerItem = { kind: "caption", caption: mkCap(1, 0, 1), enableWindows: [[0, 29]] };
  const ovItem: FastLayerItem = { kind: "overlay", item: mkOverlay({ start: 0, end: 1 }), startFrame: 0, durFrames: 30, enableWindows: [[0, 29]] };
  assert.notEqual(key, fastLayerMergeKey(props, capItem));
  assert.notEqual(key, fastLayerMergeKey(props, ovItem));
});

// ---- buildFastSegmentFilter / buildFastSegmentArgs ----

function mkSpec(overrides: Partial<FastSegmentSpec> = {}): FastSegmentSpec {
  return {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/render.fast/segments/seg000.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    layers: [],
    ...overrides,
  };
}

test("B1: layersゼロ件の filter/args", () => {
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
  assert.ok(has("-frames:v", "300"));
  assert.ok(args.includes("-g"));
  assert.ok(has("-map", "[vout]"));
  assert.equal(args.at(-1), spec.outPath);
});

test("B2: trim はフレーム指定(秒指定でない)", () => {
  const spec = mkSpec({ fromFrame: 0, toFrame: 300 });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("trim=start_frame=0:end_frame=300"));
  assert.ok(!filter.includes("trim=start="));
  const fpsIndex = filter.indexOf(`fps=fps=30:round=${FAST_FPS_ROUND}:start_time=0`);
  const trimIndex = filter.indexOf("trim=start_frame=0:end_frame=300");
  const localPtsIndex = filter.indexOf("setpts=N/30/TB");
  assert.ok(fpsIndex >= 0);
  assert.ok(fpsIndex < trimIndex);
  assert.ok(trimIndex < localPtsIndex);
});

test("B2b: fpsRound を指定すると fps filter の round を上書きする", () => {
  const filter = buildFastSegmentFilter(mkSpec({ fpsRound: "down" }));
  assert.ok(filter.includes("fps=fps=30:round=down:start_time=0"));
});

test("B3: simple layer 1件(単一フレーム入力)", () => {
  const spec = mkSpec({
    layers: [{ pngPath: "/rec/render.fast/captions/aaa.png", enableWindows: [[30, 119]] }],
  });
  const args = buildFastSegmentArgs(spec);
  const iIndices = args.reduce<number[]>((acc, a, i) => {
    if (a === "-i") acc.push(i);
    return acc;
  }, []);
  assert.equal(iIndices.length, 2); // cut + 1 png
  assert.equal(args[iIndices[1] + 1], "/rec/render.fast/captions/aaa.png");
  assert.ok(!args.includes("-loop")); // simple は単一フレーム入力(ループしない)

  const filter = buildFastSegmentFilter(spec);
  assert.ok(
    filter.includes(
      `[0:v]setpts=PTS-STARTPTS,fps=fps=30:round=${FAST_FPS_ROUND}:start_time=0,trim=start_frame=0:end_frame=300,setpts=N/30/TB,`,
    ),
  );
  assert.ok(filter.endsWith("[b0];[b0][1:v]overlay=x=0:y=0:format=auto:enable='between(n,30,119)'[vout]"));
});

test("B4: layer 2件のラベル遷移", () => {
  const spec = mkSpec({
    layers: [
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
    layers: [
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

test("B6: 2-layer(caption相当)worked example の全argv・filter を固定", () => {
  const spec: FastSegmentSpec = {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/seg003.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    layers: [
      { pngPath: "/rec/aaa.png", enableWindows: [[30, 119]] },
      { pngPath: "/rec/bbb.png", enableWindows: [[60, 149]] },
    ],
  };

  const filter = buildFastSegmentFilter(spec);
  assert.equal(
    filter,
    `[0:v]setpts=PTS-STARTPTS,fps=fps=30:round=${FAST_FPS_ROUND}:start_time=0,trim=start_frame=0:end_frame=300,setpts=N/30/TB,scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p[b0];` +
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
    "-frames:v",
    "300",
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

test("B7: alpha layer(fade付き)の入力引数(補遺1: 必要窓だけループ)とfiltergraph", () => {
  const spec = mkSpec({
    fromFrame: 1677,
    toFrame: 3517,
    layers: [
      {
        pngPath: "/rec/render.fast/overlays/k0.png",
        fade: { startFrame: 0, durFrames: 41, fadeInFrames: 41, fadeOutFrames: 0 },
        enableWindows: [[0, 40]],
      },
    ],
  });
  const args = buildFastSegmentArgs(spec);
  const iArgIdx = args.indexOf("-loop");
  assert.ok(iArgIdx >= 0);
  assert.deepEqual(args.slice(iArgIdx, iArgIdx + 8), [
    "-loop",
    "1",
    "-framerate",
    "30",
    "-t",
    "1.400", // (41+1)/30
    "-i",
    "/rec/render.fast/overlays/k0.png",
  ]);

  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("[1:v]format=rgba,fade=t=in:alpha=1:start_frame=0:nb_frames=41,setpts=N/30/TB+0/30/TB[a0]"));
  assert.ok(filter.includes("[b0][a0]overlay=x=0:y=0:format=auto:enable='between(n,0,40)'[vout]"));
});

test("B8: alpha layer(fadeOut・opacity 併用)のfiltergraph(fade の start_frame はストリーム先頭基準)", () => {
  const spec = mkSpec({
    layers: [
      {
        pngPath: "/rec/render.fast/overlays/k32.png",
        opacity: 0.8,
        fade: { startFrame: 100, durFrames: 68, fadeInFrames: 0, fadeOutFrames: 30 },
        enableWindows: [[100, 167]],
      },
    ],
  });
  const filter = buildFastSegmentFilter(spec);
  // start_frame = d - fout = 68 - 30 = 38(ストリーム先頭基準。A=100 は使わない)
  assert.ok(
    filter.includes(
      "[1:v]format=rgba,colorchannelmixer=aa=0.8,fade=t=out:alpha=1:start_frame=38:nb_frames=30,setpts=N/30/TB+100/30/TB[a0]",
    ),
  );
});

test("B9: -frames:v は toFrame - fromFrame", () => {
  const spec = mkSpec({ fromFrame: 100, toFrame: 250 });
  const args = buildFastSegmentArgs(spec);
  const idx = args.indexOf("-frames:v");
  assert.equal(args[idx + 1], "150");
});

// ---- colorFilters (P5-3) ----

test("B10: colorFilters 未指定は現行と1文字も変わらない(BASE_COLOR_FILTER の直後が [b0])", () => {
  const spec = mkSpec();
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.endsWith(`${BASE_COLOR_FILTER}[vout]`));
  assert.ok(!filter.includes("format=rgb24"));
  assert.ok(!filter.includes("lutrgb"));
  assert.ok(!filter.includes("colorchannelmixer"));
});

test("B11: colorFilters を渡すと BASE_COLOR_FILTER の直後・最初の overlay の前に段が入る", () => {
  const spec = mkSpec({
    layers: [{ pngPath: "/rec/a.png", enableWindows: [[30, 119]] }],
    colorFilters: ["lutrgb=r='f1':g='f1':b='f1'", "colorchannelmixer=rr=1"],
  });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(
    filter.includes(
      `${BASE_COLOR_FILTER},format=rgb24,lutrgb=r='f1':g='f1':b='f1',colorchannelmixer=rr=1,format=yuvj420p[b0];`,
    ),
  );
  assert.ok(filter.includes("[b0][1:v]overlay=x=0:y=0:format=auto:enable='between(n,30,119)'[vout]"));
});

test("B12: layers:[] + colorFilters あり → ,format=yuvj420p[vout] で終わる", () => {
  const spec = mkSpec({ colorFilters: ["lutrgb=r='f':g='f':b='f'"] });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.endsWith(",format=rgb24,lutrgb=r='f':g='f':b='f',format=yuvj420p[vout]"));
});

test("B13: colorFilters:[](空配列)は未指定と同じ扱い(段を挿入しない)", () => {
  const withEmpty = buildFastSegmentFilter(mkSpec({ colorFilters: [] }));
  const withoutField = buildFastSegmentFilter(mkSpec());
  assert.equal(withEmpty, withoutField);
});

// ---- videoFromFrame(P5-4: baseSegment 由来の trim 写像。design-T4.md §2-C) ----

test("G4-1: videoFromFrame 省略 → 現行の filtergraph 文字列と1文字も変わらない(既存 snapshot を維持=バイト等価の証明)", () => {
  const spec = mkSpec({
    layers: [{ pngPath: "/rec/aaa.png", enableWindows: [[30, 119]] }],
  });
  const filterWithout = buildFastSegmentFilter(spec);
  const filterExplicitEqual = buildFastSegmentFilter({ ...spec, videoFromFrame: spec.fromFrame });
  assert.equal(filterWithout, filterExplicitEqual);
  assert.ok(filterWithout.includes(`trim=start_frame=${spec.fromFrame}:end_frame=${spec.toFrame}`));
});

test("G4-2: videoFromFrame:900・fromFrame:1200・toFrame:1500 → trim=start_frame=900:end_frame=1200(長さ300が保たれる)", () => {
  const spec = mkSpec({ fromFrame: 1200, toFrame: 1500, videoFromFrame: 900 });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("trim=start_frame=900:end_frame=1200"));
  assert.ok(!filter.includes("trim=start_frame=1200"));
});

test("G4-3: -frames:v はセグメント長(toFrame-fromFrame)のまま(videoFromFrame の影響を受けない)", () => {
  const spec = mkSpec({ fromFrame: 1200, toFrame: 1500, videoFromFrame: 900 });
  const args = buildFastSegmentArgs(spec);
  const idx = args.indexOf("-frames:v");
  assert.equal(args[idx + 1], "300");
});

test("G4-4: overlay の enable='between(n,...)'(セグメントローカル出力frame)は videoFromFrame の影響を受けない", () => {
  const spec = mkSpec({
    fromFrame: 1200,
    toFrame: 1500,
    videoFromFrame: 900,
    layers: [{ pngPath: "/rec/a.png", enableWindows: [[30, 119]] }],
  });
  const filter = buildFastSegmentFilter(spec);
  assert.ok(filter.includes("enable='between(n,30,119)'"));
});

test("G4-5: renderFastSegment に base をまたぐ span を渡す → throw(baseSegOf の null を先に見る。ffmpeg は起動しない)", async () => {
  const props = mkProps({
    durationSec: 30,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 20 },
      { start: 25, videoStart: 20, durationSec: 5 },
    ],
    inserts: [{ start: 20, end: 25, file: "i.mp4", fit: "cover" }],
  });
  // span[0,750) は base[0](フレーム0-600)を超えて挿入区間(600-750)にまで
  // またがる。fastPlan(clampFastSpansToBase)が本来これを許さないが、
  // 不変条件が破れたときの安全弁を直接検証する
  await assert.rejects(
    () =>
      renderFastSegment({
        dir: "/tmp/does-not-matter",
        props,
        span: { kind: "fast", fromFrame: 0, toFrame: 750 },
        index: 0,
        warm: {} as WarmAssets,
      }),
    /baseSegment/,
  );
});

// ---- S-9: fade 式が Remotion(fadeFactor)と全フレームで一致する(補遺4) ----

/** 補遺1/補遺4: ffmpeg 側の fade はストリーム先頭基準の n(= セグメントローカル
 * frame m そのもの)。§5.4 の一致証明をそのまま独立実装してテストする */
function ffmpegFadeAlpha(m: number, spec: { d: number; fin: number; fout: number }): number {
  const { d, fin, fout } = spec;
  const factorIn = fin > 0 ? Math.min(1, Math.max(0, m / fin)) : 1;
  const factorOut = fout > 0 ? Math.min(1, Math.max(0, (d - m) / fout)) : 1;
  return factorIn * factorOut;
}

test("S-9: fade 式が全 m で fadeFactor と一致する(fin=15,fout=10,d=90)", () => {
  const fps = 30;
  const d = 90;
  const fin = 15;
  const fout = 10;
  for (let m = 0; m <= d; m++) {
    const expected = fadeFactor(m, d, fps, fin / fps, fout / fps);
    const actual = ffmpegFadeAlpha(m, { d, fin, fout });
    assert.ok(Math.abs(expected - actual) < 1e-9, `m=${m}: expected=${expected} actual=${actual}`);
  }
});

test("S-9b: fade 式が全 m で fadeFactor と一致する(等号ケース fin+fout=d)", () => {
  const fps = 30;
  const d = 41;
  const fin = 41;
  const fout = 0;
  for (let m = 0; m <= d; m++) {
    const expected = fadeFactor(m, d, fps, fin / fps, fout / fps);
    const actual = ffmpegFadeAlpha(m, { d, fin, fout });
    assert.ok(Math.abs(expected - actual) < 1e-9, `m=${m}: expected=${expected} actual=${actual}`);
  }
});

// ---- worked example resolveFastLayers cross-check ----

test("worked example: resolveFastLayers(caption経路)が B6 の入力と一致する", () => {
  const capA = mkCap(1, 1, 4); // abs [30,120)
  const capB = mkCap(2, 2, 5); // abs [60,150)
  const props = mkProps({
    captions: [capA, capB],
    layerOrder: ["ov1", "wipe", "caption", "cap2"],
  });
  const result = captionsOf(resolveFastLayers(props, span(0, 300)));
  assert.equal(result.length, 2);
  assert.equal(result[0].caption, capA);
  assert.deepEqual(result[0].enableWindows, [[30, 119]]);
  assert.equal(result[1].caption, capB);
  assert.deepEqual(result[1].enableWindows, [[60, 149]]);
});

// ---- 実収録形状(design-T1.md §7): 1スパンでの入力本数(overlay 13 + caption 94) ----

test("S-12b: 実収録形状の1スパン(0-6301)→ layers.length === 107(caption 94 + overlay 13)", () => {
  const fps = 30;
  const overlays: OverlayItem[] = [];
  // 7クラスタ、各クラスタ: 先頭1件がfade付き(alpha・畳まれない) + 続く4件が
  // simple(同一ファイル・連続窓 → 1入力に畳み込まれる)= 7 * (1+1) = 14...
  // 実収録は「fade七つ(単独) + simple塊六つ」の 7+6=13 入力になるよう
  // 6クラスタ(各1 fade + 続くsimple群)+末尾1件のfadeOnlyクラスタで構成する
  let t = 10;
  for (let c = 0; c < 6; c++) {
    const file = `f${c}.png`;
    overlays.push(mkOverlay({ start: t, end: t + 1, file, fadeInSec: 0.2 }));
    t += 1;
    for (let s = 0; s < 4; s++) {
      overlays.push(mkOverlay({ start: t, end: t + 1, file }));
      t += 1;
    }
  }
  // 末尾: fadeOut のみの単独クラスタ
  overlays.push(mkOverlay({ start: t, end: t + 2, file: "last.png", fadeOutSec: 1 }));

  const captions = Array.from({ length: 94 }, (_, i) => ({
    start: 60 + i * 1.4,
    end: 60 + i * 1.4 + 1,
    text: `字幕${i}`,
    track: 1,
  }));

  const props = mkProps({ durationSec: 210.03, overlays, captions, fps });
  const total = 6301;
  const items = resolveFastLayers(props, span(0, total));
  const merged = mergeFastLayers(props, items);
  const overlayCount = merged.filter((it) => it.kind === "overlay").length;
  const captionCount = merged.filter((it) => it.kind === "caption").length;
  assert.equal(overlayCount, 13); // 6 fade + 6 simple塊 + 1 fade = 13
  assert.equal(captionCount, 94);
  assert.equal(merged.length, 107);
});
