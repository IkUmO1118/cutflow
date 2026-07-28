// src/engine/describeFrame.ts グループ5(blurs/annotations/layerOrder)の
// 翻訳を固定する。blur.ts の実式・normalizeLayerOrder の並びとクロスチェック。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeAnnotationItems,
  describeBlurItems,
  describeFrame,
  describeLayerOrderStack,
} from "../src/engine/describeFrame.ts";
import { blurRadiusPx } from "../src/lib/blur.ts";
import { defaultProps } from "../remotion/props.ts";
import type { RenderProps } from "../remotion/props.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
};

test("describeBlurItems: 区間外は空", () => {
  const props: RenderProps = { ...base, blurs: [{ start: 10, end: 20, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 }] };
  assert.deepEqual(describeBlurItems(props, 5), []);
});

test("describeBlurItems: strength<=0 は効果なしで出さない", () => {
  const props: RenderProps = { ...base, blurs: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0 }] };
  assert.deepEqual(describeBlurItems(props, 5), []);
});

test("describeBlurItems: radiusPx は blurRadiusPx(strength) と一致", () => {
  const props: RenderProps = { ...base, blurs: [{ start: 0, end: 10, rect: { x: 10, y: 20, w: 300, h: 200 }, strength: 0.5 }] };
  const items = describeBlurItems(props, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "rendered" || item.content.kind !== "blurRegion") throw new Error("unreachable");
  assert.deepEqual(item.content.rect, { x: 10, y: 20, w: 300, h: 200 });
  assert.equal(item.content.radiusPx, blurRadiusPx(0.5));
});

test("describeBlurItems: props.layout(ショート)は空(本編のみ)", () => {
  const props: RenderProps = {
    ...base,
    layout: { panels: [] },
    blurs: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 0.5 }],
  };
  assert.deepEqual(describeBlurItems(props, 5), []);
});

test("describeAnnotationItems: arrow は from/to/color/widthPx/headPx をそのまま content に持つ", () => {
  const props: RenderProps = {
    ...base,
    annotations: [
      { type: "arrow", start: 0, end: 10, from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, color: "#fff", widthPx: 4, headPx: 12 },
    ],
  };
  const items = describeAnnotationItems(props, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "rendered" || item.content.kind !== "annotationArrow") throw new Error("unreachable");
  assert.deepEqual(item.content.from, { x: 0, y: 0 });
  assert.deepEqual(item.content.to, { x: 100, y: 50 });
  assert.equal(item.content.widthPx, 4);
});

test("describeAnnotationItems: box は fill 省略可、指定時はそのまま持つ", () => {
  const props: RenderProps = {
    ...base,
    annotations: [
      {
        type: "box",
        start: 0,
        end: 10,
        rect: { x: 0, y: 0, w: 200, h: 100 },
        color: "#f00",
        widthPx: 3,
        radiusPx: 8,
        fill: "#00000033",
      },
    ],
  };
  const items = describeAnnotationItems(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "annotationBox") throw new Error("unreachable");
  assert.equal(items[0].content.fill, "#00000033");
});

test("describeAnnotationItems: spotlight は shape/dim/featherPx/radiusPx を持つ", () => {
  const props: RenderProps = {
    ...base,
    annotations: [
      {
        type: "spotlight",
        start: 0,
        end: 10,
        rect: { x: 0, y: 0, w: 400, h: 300 },
        shape: "ellipse",
        dim: 0.7,
        featherPx: 20,
        radiusPx: 0,
      },
    ],
  };
  const items = describeAnnotationItems(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "annotationSpotlight") throw new Error("unreachable");
  assert.equal(items[0].content.shape, "ellipse");
  assert.equal(items[0].content.dim, 0.7);
});

test("describeAnnotationItems: 区間外は硬いON/OFF(遷移無し)で出さない", () => {
  const props: RenderProps = {
    ...base,
    annotations: [
      { type: "box", start: 5, end: 10, rect: { x: 0, y: 0, w: 10, h: 10 }, color: "#fff", widthPx: 1, radiusPx: 0 },
    ],
  };
  assert.deepEqual(describeAnnotationItems(props, 4.999), []);
  assert.deepEqual(describeAnnotationItems(props, 10), []); // end は含まない
});

test("describeLayerOrderStack: 既定順(ov2..N, wipe, cap2..N, caption)は wipe→captionの並びを保つ", () => {
  const props: RenderProps = {
    ...base,
    cameraRegion: { x: 1920, y: 0, w: 480, h: 270 },
    wipe: { widthPx: 480, marginPx: 32 },
    captions: [{ start: 0, end: 10, text: "テロップ", track: 1 }],
  };
  const items = describeLayerOrderStack(props, 5);
  // 既定 layerOrder=["wipe","caption"](ov無し)。wipe が先、caption が後
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "external"); // camera(wipe)
  assert.equal(items[1].kind, "rendered"); // caption
});

test("describeLayerOrderStack: 明示 layerOrder で caption が wipe より下に来る", () => {
  const props: RenderProps = {
    ...base,
    cameraRegion: { x: 1920, y: 0, w: 480, h: 270 },
    wipe: { widthPx: 480, marginPx: 32 },
    captions: [{ start: 0, end: 10, text: "テロップ", track: 1 }],
    layerOrder: ["caption", "wipe"],
  };
  const items = describeLayerOrderStack(props, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "rendered"); // caption が先(下)
  assert.equal(items[1].kind, "external"); // wipe が後(上)
});

test("describeLayerOrderStack: ov<N> はそのトラックの現在表示中の素材を積む", () => {
  const props: RenderProps = {
    ...base,
    overlays: [{ start: 0, end: 10, file: "b.png", track: 2, fit: "cover" }],
    layerOrder: ["ov2"],
  };
  const items = describeLayerOrderStack(props, 5);
  assert.equal(items.length, 1);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceId, "b.png");
});

test("describeFrame: グループ5まで統合した最終順序(base→insert→blur→layerOrderスタック→annotation)", () => {
  const props: RenderProps = {
    ...base,
    captions: [{ start: 0, end: 10, text: "x", track: 1 }],
    blurs: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 50, h: 50 }, strength: 0.5 }],
    annotations: [
      { type: "box", start: 0, end: 10, rect: { x: 0, y: 0, w: 10, h: 10 }, color: "#fff", widthPx: 1, radiusPx: 0 },
    ],
  };
  const descriptor = describeFrame(props, 5);
  const kinds = descriptor.items.map((it) =>
    it.kind === "rendered" ? it.content.kind : "external",
  );
  // base(external) → blur(blurRegion) → caption(caption) → annotation(annotationBox)
  assert.deepEqual(kinds, ["external", "blurRegion", "caption", "annotationBox"]);
});
