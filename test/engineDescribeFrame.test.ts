// src/engine/describeFrame.ts グループ1(ベース映像+zoom+colorFilter+design背景)
// の翻訳を固定する。Main.tsx の該当式(zoomTransformAt/cropFitStyle/
// cssFilterOf 相当)と数値が一致することをクロスチェックする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBaseLayer, describeFrame, describeLayerOrderStack } from "../src/engine/describeFrame.ts";
import { resolveDesign } from "../src/lib/design.ts";
import { zoomTransformAt } from "../src/lib/zoom.ts";
import type { ZoomSpan } from "../src/lib/zoom.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { RenderProps } from "../src/lib/renderPropsTypes.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  durationSec: 30,
};

test("describeBaseLayer: design 無し・zoom 無しはベース映像1件、sourceRect=screenRegion・quad=全画面", () => {
  const items = describeBaseLayer(base, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kind, "external");
  if (item.kind !== "external") throw new Error("unreachable");
  assert.equal(item.sourceId, "cut.mp4");
  assert.equal(item.sourceTimeSec, 5); // videoStart=0 の連続再生
  assert.equal(item.placement.mode, "resolved");
  if (item.placement.mode !== "resolved") throw new Error("unreachable");
  assert.deepEqual(item.placement.sourceRect, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(item.placement.quad, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(item.effects, undefined); // colorFilter 未指定
  assert.equal(item.radiusPx, undefined); // design 無し
});

test("describeBaseLayer: videoFile 空はプレースホルダー扱いで空配列", () => {
  assert.deepEqual(describeBaseLayer({ ...base, videoFile: "" }, 5), []);
});

test("describeBaseLayer: props.layout があるショート経路は空配列(グループ6の担当)", () => {
  const withLayout: RenderProps = {
    ...base,
    layout: { panels: [{ source: "screen", fit: "cover" }] },
  };
  assert.deepEqual(describeBaseLayer(withLayout, 5), []);
});

test("describeBaseLayer: baseSegments のギャップ(挿入クリップ中)はベース映像を出さない", () => {
  const withInsert: RenderProps = {
    ...base,
    baseSegments: [
      { start: 0, videoStart: 0, durationSec: 5 },
      { start: 8, videoStart: 5, durationSec: 10 }, // 5-8 は挿入クリップの穴
    ],
  };
  assert.deepEqual(describeBaseLayer(withInsert, 6), []); // 穴の中
  const after = describeBaseLayer(withInsert, 9);
  assert.equal(after.length, 1);
  if (after[0].kind !== "external") throw new Error("unreachable");
  assert.equal(after[0].sourceTimeSec, 6); // videoStart(5) + (9-8)*1
});

test("describeBaseLayer: playbackRate はソース側の進みを速める", () => {
  const sped: RenderProps = {
    ...base,
    baseSegments: [{ start: 0, videoStart: 100, durationSec: 10, playbackRate: 2 }],
  };
  const items = describeBaseLayer(sped, 3);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceTimeSec, 106); // 100 + 3*2
});

test("describeBaseLayer: colorFilter は全既定(1,1,1)なら effects 無し", () => {
  const items = describeBaseLayer({ ...base, colorFilter: { brightness: 1, contrast: 1, saturate: 1 } }, 1);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].effects, undefined);
});

test("describeBaseLayer: colorFilter 非既定は colorFilter effect を1件持つ", () => {
  const items = describeBaseLayer({ ...base, colorFilter: { brightness: 1.2, saturate: 0.8 } }, 1);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.deepEqual(items[0].effects, [
    { kind: "colorFilter", brightness: 1.2, contrast: 1, saturate: 0.8 },
  ]);
});

test("describeBaseLayer: zoom 中は quad が zoomTransformAt とビット等価(cover=全画面なので transform 直結)", () => {
  const zooms: ZoomSpan[] = [
    { start: 0, end: 10, rect: { x: 400, y: 200, w: 800, h: 450 }, easeSec: 1, chainGapSec: 1.5 },
  ];
  const props: RenderProps = { ...base, zooms };
  const tOut = 5; // 区間の中盤(イーズ完了・フルズーム)
  const items = describeBaseLayer(props, tOut);
  if (items[0].kind !== "external") throw new Error("unreachable");
  const zt = zoomTransformAt(tOut, zooms, props.width, props.height);
  // design 無し = panel は全画面 {0,0,W,H}、cover fit の quad はローカルで
  // 既に box 全体なので、期待値は「全画面 rect に zoom を適用」した値と一致する
  const expectedQuad = {
    x: zt.translateX,
    y: zt.translateY,
    w: zt.scale * props.width,
    h: zt.scale * props.height,
  };
  if (items[0].placement.mode !== "resolved") throw new Error("unreachable");
  assert.deepEqual(items[0].placement.quad, expectedQuad);
  assert.ok(zt.scale > 1, "zoom 中はスケールが1より大きいはず(テスト自体の前提確認)");
});

test("describeBaseLayer: zoomTransformTrack(baked)がある場合はフレーム lookup を使う(zoomTransformAt は無視)", () => {
  const props: RenderProps = {
    ...base,
    fps: 30,
    zooms: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 }, easeSec: 1 }],
    zoomTransformTrack: {
      startFrame: 0,
      frames: Array.from({ length: 300 }, (_, i) => ({ scale: 1 + i * 0.001, x: 10, y: 20 })),
    },
  };
  const tOut = 2; // frame = round(2*30) = 60
  const items = describeBaseLayer(props, tOut);
  if (items[0].kind !== "external" || items[0].placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  const expectedScale = 1 + 60 * 0.001;
  assert.equal(items[0].placement.quad.w, expectedScale * props.width);
  assert.equal(items[0].placement.quad.x, 10);
});

test("describeBaseLayer: design 有効時は背景画像item + パネル位置quad + 角丸(zoom追従)", () => {
  const design = resolveDesign(
    {
      enabled: true,
      backgroundFile: "bg.png",
      screen: { marginXPx: 100, marginBottomPx: 90, radiusPx: 24, shadow: true },
    },
    1920,
    1080,
    true,
  );
  const props: RenderProps = { ...base, design, cameraRegion: { x: 0, y: 0, w: 400, h: 400 } };
  const items = describeBaseLayer(props, 0);
  assert.equal(items.length, 2); // 背景 + 画面パネル
  assert.equal(items[0].kind, "external");
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceId, "bg.png");
  assert.equal(items[0].placement.mode, "fit");
  if (items[0].placement.mode !== "fit") throw new Error("unreachable");
  assert.deepEqual(items[0].placement.box, { x: 0, y: 0, w: 1920, h: 1080 }); // zoom無し=恒等

  const screenItem = items[1];
  if (screenItem.kind !== "external" || screenItem.placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  assert.deepEqual(screenItem.placement.quad, design!.screen.rect); // zoom無し=パネルそのまま
  assert.equal(screenItem.radiusPx, design!.screen.radiusPx); // zoom無し(scale=1)なので不変
});

test("describeFrame: size/backgroundColor を持ち、items にベース映像を含む", () => {
  const d = describeFrame(base, 5);
  assert.deepEqual(d.tOut, 5);
  assert.deepEqual(d.size, { w: 1920, h: 1080 });
  assert.equal(d.backgroundColor, "black"); // design 無しの既定
  assert.equal(d.items.length, 1);
});

test("describeLayerOrderStack: hiddenLayers 未指定のとき items が従来と同一", () => {
  const props: RenderProps = {
    ...base,
    cameraRegion: { x: 0, y: 0, w: 400, h: 400 },
    captions: [{ track: 1, start: 0, end: 10, text: "hello" }],
    layerOrder: ["wipe", "cap1"],
  };
  const items1 = describeLayerOrderStack({ ...props, hiddenLayers: undefined }, 5);
  const items2 = describeLayerOrderStack({ ...props }, 5);
  assert.deepEqual(items1, items2);
});

test("describeLayerOrderStack: hiddenLayers: ['wipe'] でワイプ item が消える", () => {
  const props: RenderProps = {
    ...base,
    cameraRegion: { x: 0, y: 0, w: 400, h: 400 },
    captions: [{ track: 1, start: 0, end: 10, text: "hello" }],
    layerOrder: ["wipe", "cap1"],
  };
  const withHidden = describeLayerOrderStack({ ...props, hiddenLayers: ["wipe"] }, 5);
  const withoutHidden = describeLayerOrderStack(props, 5);
  // wipe は hidden でも cap1 は残る
  assert.ok(withHidden.length < withoutHidden.length);
  // wipe 由来の external item が除去されている
  const wipeItem = withHidden.find((i) => i.kind === "external" && !("content" in i));
  assert.equal(wipeItem, undefined);
});

test("describeLayerOrderStack: hiddenLayers: ['cap1'] でキャプション item が消える", () => {
  const props: RenderProps = {
    ...base,
    cameraRegion: { x: 0, y: 0, w: 400, h: 400 },
    captions: [{ track: 1, start: 0, end: 10, text: "hello" }],
    layerOrder: ["wipe", "cap1"],
  };
  const withHidden = describeLayerOrderStack({ ...props, hiddenLayers: ["cap1"] }, 5);
  const withoutHidden = describeLayerOrderStack(props, 5);
  assert.ok(withHidden.length < withoutHidden.length);
  // caption 由来の rendered item が除去されている
  const capItem = withHidden.find((i) => i.kind === "rendered");
  assert.equal(capItem, undefined);
});
