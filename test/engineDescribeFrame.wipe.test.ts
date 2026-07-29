// src/engine/describeFrame.ts グループ2(カメラ/ワイプ+wipeFull+zoom連動縮小)
// の翻訳を固定する。wipe.ts/design.ts の実式とクロスチェックする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBaseLayer, describeWipeLayer } from "../src/engine/describeFrame.ts";
import { resolveDesign, shrinkRectBottomRight, wipeRectAt } from "../src/lib/design.ts";
import { wipeProgressAt } from "../src/lib/wipe.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { RenderProps } from "../src/lib/renderPropsTypes.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 1920, y: 0, w: 960, h: 1080 }, // 拡張キャンバスの右側にカメラ
  wipe: { widthPx: 480, marginPx: 32 },
  durationSec: 30,
};

test("describeWipeLayer: cameraRegion が無ければ空配列", () => {
  assert.deepEqual(describeWipeLayer({ ...base, cameraRegion: undefined }, 5), []);
});

test("describeWipeLayer: wipeBurnedIn は空配列(render高速パスで焼き込み済み)", () => {
  assert.deepEqual(describeWipeLayer({ ...base, wipeBurnedIn: true }, 5), []);
});

test("describeWipeLayer: layout(ショート)は空配列", () => {
  const withLayout: RenderProps = { ...base, layout: { panels: [] } };
  assert.deepEqual(describeWipeLayer(withLayout, 5), []);
});

test("describeWipeLayer: 挿入クリップの穴(baseSourceTimeAt null)は空配列", () => {
  const withInsert: RenderProps = {
    ...base,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 5 }],
  };
  assert.deepEqual(describeWipeLayer(withInsert, 6), []);
});

test("describeWipeLayer: colorFilter が既定値なら effects は出ない", () => {
  const items = describeWipeLayer({ ...base, colorFilter: { saturate: 1 } }, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "external") throw new Error("unreachable");
  assert.equal(item.effects, undefined);
});

test("describeWipeLayer: camera item に base と同じ colorFilter effects を載せる", () => {
  const props: RenderProps = { ...base, colorFilter: { saturate: 1.8 } };
  const wipeItems = describeWipeLayer(props, 5);
  const baseItems = describeBaseLayer(props, 5);
  const wipeItem = wipeItems[0];
  const screenItem = baseItems.find((item) => item.kind === "external" && item.sourceKind === "video");
  if (wipeItem.kind !== "external" || screenItem?.kind !== "external") throw new Error("unreachable");
  assert.deepEqual(wipeItem.effects, [
    { kind: "colorFilter", brightness: 1, contrast: 1, saturate: 1.8 },
  ]);
  assert.deepEqual(wipeItem.effects, screenItem.effects);
});

test("describeWipeLayer: design無し・wipeFull無し・zoom無しは右下 flush の素の矩形", () => {
  const items = describeWipeLayer(base, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "external" || item.placement.mode !== "resolved") throw new Error("unreachable");
  assert.equal(item.sourceId, "cut.mp4");
  assert.equal(item.sourceTimeSec, 5);
  const wipeH = Math.round((base.wipe.widthPx * base.cameraRegion!.h) / base.cameraRegion!.w);
  assert.deepEqual(item.placement.quad, {
    x: base.width - base.wipe.widthPx,
    y: base.height - wipeH,
    w: base.wipe.widthPx,
    h: wipeH,
  });
  assert.equal(item.radiusPx, undefined); // design 無し=角丸無し
});

test("describeWipeLayer: wipeFull 全画面到達(ease=1)時は quad が出力全面", () => {
  const props: RenderProps = { ...base, wipeFull: [{ start: 0, end: 10 }] };
  const items = describeWipeLayer(props, 5); // 区間中盤=遷移完了
  if (items[0].kind !== "external" || items[0].placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  assert.deepEqual(items[0].placement.quad, { x: 0, y: 0, w: 1920, h: 1080 });
});

test("describeWipeLayer: wipeFull 遷移中は wipeProgressAt の値と一致する幅で補間される", () => {
  const wipeFull = [{ start: 0, end: 10, transitionInSec: 2 }];
  const props: RenderProps = { ...base, wipeFull };
  const tOut = 1; // 遷移途中
  const ease = wipeProgressAt(tOut, wipeFull, 0);
  const wipeH = Math.round((props.wipe.widthPx * props.cameraRegion!.h) / props.cameraRegion!.w);
  const expectedW = Math.round(props.wipe.widthPx + (props.width - props.wipe.widthPx) * ease);
  const expectedH = Math.round(wipeH + (props.height - wipeH) * ease);
  const items = describeWipeLayer(props, tOut);
  if (items[0].kind !== "external" || items[0].placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  assert.deepEqual(items[0].placement.quad, {
    x: props.width - expectedW,
    y: props.height - expectedH,
    w: expectedW,
    h: expectedH,
  });
});

test("describeWipeLayer: design.camera 有効時は wipeRectAt+shrinkRectBottomRight と一致", () => {
  const design = resolveDesign(
    { enabled: true, camera: { sizePx: 300, marginPx: 28, radiusPx: 96, shadow: true } },
    1920,
    1080,
    true,
  );
  const props: RenderProps = { ...base, design };
  const items = describeWipeLayer(props, 5);
  if (items[0].kind !== "external" || items[0].placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  const designWipe = wipeRectAt(design!.camera, 1920, 1080, 0); // ease=0(wipeFull無し)
  const shrunk = shrinkRectBottomRight(designWipe.rect, designWipe.radiusPx, 1); // shrinkS=1(zoom無し)
  assert.deepEqual(items[0].placement.quad, shrunk.rect);
  assert.equal(items[0].radiusPx, shrunk.radiusPx);
});

test("describeWipeLayer: zoom 中の legacy 経路は wipeScale × zoomProgressAt で右下アンカーのまま縮む", () => {
  const props: RenderProps = {
    ...base,
    zooms: [
      {
        start: 0,
        end: 10,
        rect: { x: 0, y: 0, w: 960, h: 540 },
        easeSec: 0,
        easeOutSec: 0,
        wipeScale: 0.5,
      },
    ],
  };
  const tOut = 5; // イーズ完了(easeSec=0なので即フル)= zoomProgressAt=1
  const items = describeWipeLayer(props, tOut);
  if (items[0].kind !== "external" || items[0].placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  // shrinkS = 1-(1-0.5)*1*(1-0) = 0.5。右下アンカーを保ったまま w/h が半分
  const wipeH = Math.round((props.wipe.widthPx * props.cameraRegion!.h) / props.cameraRegion!.w);
  const expectedW = Math.round(props.wipe.widthPx * 0.5);
  const expectedH = Math.round(wipeH * 0.5);
  assert.deepEqual(items[0].placement.quad, {
    x: props.width - expectedW,
    y: props.height - expectedH,
    w: expectedW,
    h: expectedH,
  });
});

test("describeWipeLayer: zoom pre-roll 境界で legacy wipeScale が1フレームで跳ばない", () => {
  const props: RenderProps = {
    ...base,
    zooms: [
      {
        start: 10,
        end: 12,
        rect: { x: 0, y: 0, w: 960, h: 540 },
        easeSec: 1.5,
        easeOutSec: 1,
        wipeScale: 0.8,
      },
    ],
  };
  const before = wipeWidth(props, 10 - 1 / 30);
  const atStart = wipeWidth(props, 10);
  const perFrameDelta = Math.abs(before - atStart) / props.wipe.widthPx;
  assert.ok(perFrameDelta < 0.05, `pre-roll 境界の変化が大きすぎる: ${before} -> ${atStart}`);
});

test("describeWipeLayer: gap 連鎖中は legacy wipeScale が1に戻らない", () => {
  const props: RenderProps = {
    ...base,
    zooms: [
      {
        start: 10,
        end: 11,
        rect: { x: 0, y: 0, w: 960, h: 540 },
        easeSec: 0,
        easeOutSec: 0,
        wipeScale: 0.8,
      },
      {
        start: 12,
        end: 13,
        rect: { x: 240, y: 135, w: 960, h: 540 },
        easeSec: 0,
        easeOutSec: 0,
        wipeScale: 0.8,
      },
    ],
  };
  assert.equal(wipeWidth(props, 11.5), Math.round(props.wipe.widthPx * 0.8));
});

test("describeWipeLayer: legacy zoom の wipeScale 未指定は pre-roll 中も従来どおり1", () => {
  const props: RenderProps = {
    ...base,
    zooms: [
      {
        start: 10,
        end: 12,
        rect: { x: 0, y: 0, w: 960, h: 540 },
        easeSec: 1.5,
        easeOutSec: 1,
      },
    ],
  };
  assert.equal(wipeWidth(props, 10 - 1 / 30), props.wipe.widthPx);
  assert.equal(wipeWidth(props, 10), props.wipe.widthPx);
});

test("describeWipeLayer: baked zoomTransformTrack 経路は zoomT.scale から縮小し legacy wipeScale を見ない", () => {
  const props: RenderProps = {
    ...base,
    fps: 30,
    zooms: [
      {
        start: 10,
        end: 12,
        rect: { x: 0, y: 0, w: 960, h: 540 },
        easeSec: 1.5,
        easeOutSec: 1,
        wipeScale: 0.2,
      },
    ],
    zoomTransformTrack: {
      startFrame: 300,
      frames: [{ scale: 2, x: 0, y: 0 }],
    },
  };
  assert.equal(wipeWidth(props, 10), Math.round(props.wipe.widthPx * 0.5));
});

function wipeWidth(props: RenderProps, tOut: number): number {
  const items = describeWipeLayer(props, tOut);
  const item = items[0];
  if (item.kind !== "external" || item.placement.mode !== "resolved") {
    throw new Error("unreachable");
  }
  return item.placement.quad.w;
}
