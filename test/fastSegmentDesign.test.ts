import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_COLOR_FILTER,
  MAX_FAST_DESIGN_PNG_INPUTS,
  buildFastSegmentArgs,
  buildFastSegmentFilter,
  centerCoverCrop,
  countFastPngInputs,
  mergeFastLayers,
  resolveFastLayers,
} from "../src/lib/fastSegment.ts";
import type { FastDesignBaseSpec, FastSegmentSpec } from "../src/lib/fastSegment.ts";
import type { RenderProps } from "../remotion/props.ts";

const DESIGN: FastDesignBaseSpec = {
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
