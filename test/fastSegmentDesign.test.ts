import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_COLOR_FILTER,
  MAX_FAST_DESIGN_PNG_INPUTS,
  buildFastDesignBaseSpec,
  buildFastSegmentArgs,
  buildFastSegmentFilter,
  centerCoverCrop,
  countFastPngInputs,
  mergeFastLayers,
  resolveFastDesignLayers,
  resolveFastLayers,
} from "../src/lib/fastSegment.ts";
import type { FastDesignBaseSpec, FastSegmentSpec } from "../src/lib/fastSegment.ts";
import type { RenderProps } from "../remotion/props.ts";

const DESIGN: FastDesignBaseSpec & { camera: NonNullable<FastDesignBaseSpec["camera"]> } = {
  mode: "design",
  backdropPath: "/rec/render.fast/design/key.backdrop.png",
  screen: {
    sourceRect: { x: 0, y: 0, w: 1920, h: 1080 },
    targetRect: { x: 100, y: 22, w: 1720, h: 968 },
    maskPath: "/rec/render.fast/design/key.screen-mask.png",
  },
  camera: {
    sourceRect: { x: 1920, y: 0, w: 1920, h: 1080 },
    targetRect: { x: 1517, y: 677, w: 375, h: 375 },
    shadowPath: "/rec/render.fast/design/key.camera-shadow.png",
    maskPath: "/rec/render.fast/design/key.camera-mask.png",
  },
  cameraLayerIndex: 1,
};

const PLAIN_PORTRAIT: FastDesignBaseSpec = {
  mode: "design",
  backdropPath: "/rec/render.fast/design/plain.backdrop.png",
  screen: {
    sourceRect: { x: 0, y: 0, w: 1080, h: 1920 },
    targetRect: { x: 100, y: 266, w: 880, h: 1564 },
    maskPath: "/rec/render.fast/design/plain.screen-mask.png",
  },
};

function spec(overrides: Partial<FastSegmentSpec> = {}): FastSegmentSpec {
  return {
    cutPath: "/rec/cut.mp4",
    outPath: "/rec/render.fast/segments/seg000.mp4",
    fromFrame: 0,
    toFrame: 300,
    fps: 30,
    layers: [
      { pngPath: "/rec/below.png", enableWindows: [[0, 299]] },
      { pngPath: "/rec/above.png", enableWindows: [[30, 119]] },
    ],
    base: DESIGN,
    ...overrides,
  };
}

test("centerCoverCrop: 横長cameraを正方形へ中央cropし整数丸めする", () => {
  assert.deepEqual(
    centerCoverCrop(
      { x: 1920, y: 0, w: 1920, h: 1080 },
      { x: 1517, y: 677, w: 375, h: 375 },
    ),
    { x: 2340, y: 0, w: 1080, h: 1080 },
  );
  assert.deepEqual(
    centerCoverCrop(
      { x: 10, y: 20, w: 101, h: 201 },
      { x: 0, y: 0, w: 160, h: 90 },
    ),
    { x: 10, y: 92, w: 101, h: 57 },
  );
});

test("design graph: BASE補正後splitし、crop→scale→user color→rgba→maskの順", () => {
  const filter = buildFastSegmentFilter(spec({
    colorFilters: ["lutrgb=r='f':g='f':b='f'"],
  }));
  const baseAt = filter.indexOf(BASE_COLOR_FILTER);
  const splitAt = filter.indexOf("split=2[design-screen-src][design-camera-src]");
  const screenCropAt = filter.indexOf("[design-screen-src]crop=w=1920:h=1080:x=0:y=0");
  const screenScaleAt = filter.indexOf("scale=w=1720:h=968", screenCropAt);
  const userAt = filter.indexOf("format=rgb24,lutrgb=r='f':g='f':b='f',format=rgba", screenScaleAt);
  const screenMergeAt = filter.indexOf("[design-screen-rgb][design-screen-mask]alphamerge");
  assert.ok(baseAt < splitAt);
  assert.ok(splitAt < screenCropAt && screenCropAt < screenScaleAt);
  assert.ok(screenScaleAt < userAt && userAt < screenMergeAt);

  const cameraCropAt = filter.indexOf("[design-camera-src]crop=w=1080:h=1080:x=2340:y=0");
  const cameraScaleAt = filter.indexOf("scale=w=375:h=375", cameraCropAt);
  const cameraUserAt = filter.indexOf("format=rgb24,lutrgb=r='f':g='f':b='f',format=rgba", cameraScaleAt);
  const cameraMergeAt = filter.indexOf("[design-camera-rgb][design-camera-mask]alphamerge");
  assert.ok(splitAt < cameraCropAt && cameraCropAt < cameraScaleAt);
  assert.ok(cameraScaleAt < cameraUserAt && cameraUserAt < cameraMergeAt);
});

test("design graph: backdrop→screenの後、wipe位置へshadow→cameraを挿入する", () => {
  const filter = buildFastSegmentFilter(spec());
  const screenAt = filter.indexOf(
    "[design-backdrop][design-screen-alpha]overlay=x=100:y=22:format=auto[design-base]",
  );
  const belowAt = filter.indexOf("[design-base][5:v]overlay=x=0:y=0");
  const shadowAt = filter.indexOf("[design-op0][design-camera-shadow]overlay=x=0:y=0");
  const cameraAt = filter.indexOf("[design-op1][design-camera-alpha]overlay=x=1517:y=677");
  const aboveAt = filter.indexOf("[design-op2][6:v]overlay=x=0:y=0");
  assert.ok(screenAt < belowAt && belowAt < shadowAt && shadowAt < cameraAt && cameraAt < aboveAt);
  assert.ok(filter.endsWith("[design-op3]format=yuvj420p[vout]"));
});

test("design argv: 固定4 PNGの後に時間レイヤーを並べ、入力indexと上限を固定する", () => {
  assert.equal(MAX_FAST_DESIGN_PNG_INPUTS, 4);
  const s = spec();
  const args = buildFastSegmentArgs(s);
  const inputs = args.flatMap((arg, i) => arg === "-i" ? [args[i + 1]] : []);
  assert.deepEqual(inputs, [
    s.cutPath,
    DESIGN.backdropPath,
    DESIGN.screen.maskPath,
    DESIGN.camera.shadowPath,
    DESIGN.camera.maskPath,
    "/rec/below.png",
    "/rec/above.png",
  ]);
  assert.equal(args.filter((arg) => arg === "-loop").length, 4);
  assert.equal(args.filter((arg) => arg === "-framerate").length, 4);
  const filter = buildFastSegmentFilter(s);
  assert.match(filter, /\[2:v\]alphaextract\[design-screen-mask\]/);
  assert.match(filter, /\[3:v\]format=rgba\[design-camera-shadow\]/);
  assert.match(filter, /\[4:v\]alphaextract\[design-camera-mask\]/);
  assert.match(filter, /\[5:v\]overlay/);
  assert.match(filter, /\[6:v\]overlay/);
});

test("plain portrait design graph: screen branchだけをcrop/scaleしcamera入力を作らない", () => {
  const s = spec({ base: PLAIN_PORTRAIT });
  const args = buildFastSegmentArgs(s);
  const inputs = args.flatMap((arg, i) => arg === "-i" ? [args[i + 1]] : []);
  assert.deepEqual(inputs, [
    s.cutPath,
    PLAIN_PORTRAIT.backdropPath,
    PLAIN_PORTRAIT.screen.maskPath,
    "/rec/below.png",
    "/rec/above.png",
  ]);
  assert.equal(args.filter((arg) => arg === "-loop").length, 2);
  const filter = buildFastSegmentFilter(s);
  assert.match(filter, /crop=w=1080:h=1920:x=0:y=0,scale=w=880:h=1564/);
  assert.match(filter, /\[3:v\]overlay/);
  assert.match(filter, /\[4:v\]overlay/);
  assert.doesNotMatch(filter, /design-camera|camera-shadow/);
});

test("design graph: wipeが非表示ならcamera graphを作らずscreen基底だけ使う", () => {
  const filter = buildFastSegmentFilter(spec({ base: { ...DESIGN, cameraLayerIndex: undefined } }));
  assert.doesNotMatch(filter, /design-camera-src|design-camera-alpha|design-camera-shadow/);
  assert.match(filter, /format=yuvj420p\[vout\]$/);
});

test("base未指定/undefinedは既存composite filter/argvと1バイトも変わらない", () => {
  const legacy = { ...spec(), base: undefined };
  const omitted = { ...legacy };
  delete omitted.base;
  assert.equal(buildFastSegmentFilter(legacy), buildFastSegmentFilter(omitted));
  assert.deepEqual(buildFastSegmentArgs(legacy), buildFastSegmentArgs(omitted));
});

test("plain identityはbaseを指定せず既存composite filter/argvをそのまま再利用する", () => {
  const identity = spec({ base: undefined });
  const composite = { ...identity };
  delete composite.base;
  assert.equal(buildFastSegmentFilter(identity), buildFastSegmentFilter(composite));
  assert.deepEqual(buildFastSegmentArgs(identity), buildFastSegmentArgs(composite));
  assert.deepEqual(
    buildFastSegmentArgs(identity).flatMap((arg, i, args) => arg === "-i" ? [args[i + 1]] : []),
    [identity.cutPath, "/rec/below.png", "/rec/above.png"],
  );
});

test("design追加でもresolve/merge/countの既存結果とspan分類用入力数は不変", () => {
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: DESIGN.screen.sourceRect,
    cameraRegion: DESIGN.camera.sourceRect,
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [{ start: 1, end: 2, text: "caption", track: 1 }],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
  };
  const span = { kind: "fast" as const, fromFrame: 0, toFrame: 300 };
  const resolved = resolveFastLayers(props, span);
  assert.equal(mergeFastLayers(props, resolved).length, 1);
  assert.equal(countFastPngInputs(props, span), 1);
});

test("design activation: asset refsとgeometryから絶対pathのbase specを組み立てる", () => {
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: DESIGN.screen.sourceRect,
    cameraRegion: DESIGN.camera.sourceRect,
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    design: {
      backgroundColor: "#001122",
      screen: { rect: DESIGN.screen.targetRect, radiusPx: 24, shadow: true },
      camera: { rect: DESIGN.camera.targetRect, radiusPx: 96, shadow: true },
    },
  };
  const refs = {
    key: "key",
    backdropFile: "render.fast/design/key.backdrop.png",
    screenMaskFile: "render.fast/design/key.screen-mask.png",
    cameraShadowFile: "render.fast/design/key.camera-shadow.png",
    cameraMaskFile: "render.fast/design/key.camera-mask.png",
  };
  assert.deepEqual(buildFastDesignBaseSpec({ dir: "/rec", props, refs, cameraLayerIndex: 2 }), {
    ...DESIGN,
    cameraLayerIndex: 2,
  });
});

test("design activation: camera無しplainは2-role base specを組み立てる", () => {
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 10,
    fps: 30,
    width: 1080,
    height: 1920,
    canvas: { w: 1080, h: 1920 },
    screenRegion: PLAIN_PORTRAIT.screen.sourceRect,
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    design: {
      backgroundColor: "#001122",
      screen: { rect: PLAIN_PORTRAIT.screen.targetRect, radiusPx: 24, shadow: true },
    },
  };
  const refs = {
    key: "plain",
    backdropFile: "render.fast/design/plain.backdrop.png",
    screenMaskFile: "render.fast/design/plain.screen-mask.png",
  };
  assert.deepEqual(buildFastDesignBaseSpec({ dir: "/rec", props, refs }), PLAIN_PORTRAIT);
});

test("design activation: wipe位置をまたいで同一PNGをmergeせずcamera indexを保つ", () => {
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: DESIGN.screen.sourceRect,
    cameraRegion: DESIGN.camera.sourceRect,
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [
      { start: 0, end: 2, file: "same.png", track: 1, fit: "contain" },
      { start: 3, end: 5, file: "same.png", track: 2, fit: "contain" },
    ],
    layerOrder: ["ov1", "wipe", "ov2"],
    wipeFull: [],
    hideCaption: [],
  };
  const span = { kind: "fast" as const, fromFrame: 0, toFrame: 300 };
  assert.equal(mergeFastLayers(props, resolveFastLayers(props, span)).length, 1);
  const design = resolveFastDesignLayers(props, span);
  assert.equal(design.items.length, 2);
  assert.equal(design.cameraLayerIndex, 1);
  assert.deepEqual(design.items.map((item) => item.kind), ["overlay", "overlay"]);
});

test("design activation: lower/upperの後にannotationを置き、hidden wipeではcameraを省く", () => {
  const props: RenderProps = {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: DESIGN.screen.sourceRect,
    cameraRegion: DESIGN.camera.sourceRect,
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [
      { start: 0, end: 2, text: "lower", track: 1 },
      { start: 0, end: 2, text: "upper", track: 2 },
    ],
    overlays: [],
    annotations: [{ type: "rect", start: 0, end: 2, rect: { x: 1, y: 2, w: 3, h: 4 } }],
    layerOrder: ["cap1", "wipe", "cap2"],
    wipeFull: [],
    hideCaption: [],
  };
  const span = { kind: "fast" as const, fromFrame: 0, toFrame: 300 };
  const visible = resolveFastDesignLayers(props, span);
  assert.equal(visible.cameraLayerIndex, 1);
  assert.deepEqual(visible.items.map((item) => item.kind), ["caption", "caption", "annotation"]);

  const hidden = resolveFastDesignLayers({ ...props, hiddenLayers: ["wipe"] }, span);
  assert.equal(hidden.cameraLayerIndex, undefined);
  assert.deepEqual(hidden.items.map((item) => item.kind), ["caption", "caption", "annotation"]);
});
