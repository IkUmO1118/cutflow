// src/engine/describeFrame.ts グループ4(素材オーバーレイ/挿入クリップ)の
// 翻訳を固定する。OverlayItemView/InsertView(Main.tsx)の実式とクロスチェック。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInsertItems, describeOverlayItems } from "../src/engine/describeFrame.ts";
import { valuesAt } from "../src/lib/keyframes.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { RenderProps } from "../src/lib/renderPropsTypes.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
};

test("describeOverlayItems: 区間外は何も出さない", () => {
  const props: RenderProps = {
    ...base,
    overlays: [{ start: 10, end: 20, file: "b.png", track: 1, fit: "contain" }],
  };
  assert.deepEqual(describeOverlayItems(props, 5), []);
});

test("describeOverlayItems: rect 無しは全画面+黒レターボックス", () => {
  const props: RenderProps = {
    ...base,
    overlays: [{ start: 0, end: 10, file: "b.png", track: 1, fit: "contain" }],
  };
  const items = describeOverlayItems(props, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "external" || item.placement.mode !== "fit") throw new Error("unreachable");
  assert.equal(item.sourceKind, "image");
  assert.deepEqual(item.placement.box, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(item.placement.letterboxColor, "black");
});

test("describeOverlayItems: rect 指定は透過(letterboxColor 無し)+ その矩形", () => {
  const props: RenderProps = {
    ...base,
    overlays: [
      { start: 0, end: 10, file: "b.mp4", track: 1, fit: "cover", rect: { x: 100, y: 100, w: 400, h: 300 } },
    ],
  };
  const items = describeOverlayItems(props, 5);
  const item = items[0];
  if (item.kind !== "external" || item.placement.mode !== "fit") throw new Error("unreachable");
  assert.equal(item.sourceKind, "video");
  assert.deepEqual(item.placement.box, { x: 100, y: 100, w: 400, h: 300 });
  assert.equal(item.placement.letterboxColor, undefined);
});

test("describeOverlayItems: startFrom + 経過秒でソース時刻が進む", () => {
  const props: RenderProps = {
    ...base,
    overlays: [{ start: 5, end: 15, file: "b.mp4", track: 1, fit: "cover", startFrom: 3 }],
  };
  const items = describeOverlayItems(props, 8); // 区間開始から3秒経過
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceTimeSec, 3 + 3);
});

test("describeOverlayItems: フェードイン/アウトは連続時間版 fadeFactor と一致", () => {
  const props: RenderProps = {
    ...base,
    overlays: [{ start: 0, end: 10, file: "b.mp4", track: 1, fit: "cover", fadeInSec: 2, fadeOutSec: 2 }],
  };
  const atStart = describeOverlayItems(props, 1); // フェードイン中(1/2)
  if (atStart[0].kind !== "external") throw new Error("unreachable");
  assert.equal(atStart[0].opacity, 0.5);
  const atEnd = describeOverlayItems(props, 9); // フェードアウト中(1/2)
  if (atEnd[0].kind !== "external") throw new Error("unreachable");
  assert.equal(atEnd[0].opacity, 0.5);
  const middle = describeOverlayItems(props, 5);
  if (middle[0].kind !== "external") throw new Error("unreachable");
  assert.equal(middle[0].opacity, 1);
});

test("describeOverlayItems: keyframes は valuesAt の解決値と一致(rect+opacity)", () => {
  const keyframes = [
    { at: 0, easing: "linear" as const, values: { x: 0, y: 0, w: 100, h: 100, opacity: 1 } },
    { at: 10, easing: "linear" as const, values: { x: 200, y: 0, w: 100, h: 100, opacity: 0.5 } },
  ];
  const props: RenderProps = {
    ...base,
    overlays: [
      {
        start: 0,
        end: 10,
        file: "b.mp4",
        track: 1,
        fit: "cover",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        keyframes,
      },
    ],
  };
  const tOut = 5;
  const items = describeOverlayItems(props, tOut);
  if (items[0].kind !== "external" || items[0].placement.mode !== "fit") throw new Error("unreachable");
  const expected = valuesAt({ x: 0, y: 0, w: 100, h: 100, opacity: 1 }, keyframes, tOut);
  assert.deepEqual(items[0].placement.box, { x: expected.x, y: expected.y, w: expected.w, h: expected.h });
  assert.equal(items[0].opacity, expected.opacity);
});

test("describeInsertItems: 区間内は全画面+黒背景+フェード", () => {
  const props: RenderProps = {
    ...base,
    inserts: [{ start: 0, end: 5, file: "intro.mp4", fit: "cover", fadeInSec: 1 }],
  };
  const items = describeInsertItems(props, 0.5); // フェードイン中(50%)
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "external" || item.placement.mode !== "fit") throw new Error("unreachable");
  assert.deepEqual(item.placement.box, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(item.placement.letterboxColor, "black");
  assert.equal(item.opacity, 0.5);
});

test("describeInsertItems: startFrom + 経過秒でソース時刻が進む", () => {
  const props: RenderProps = { ...base, inserts: [{ start: 2, end: 8, file: "intro.mp4", fit: "cover", startFrom: 1 }] };
  const items = describeInsertItems(props, 4);
  if (items[0].kind !== "external") throw new Error("unreachable");
  assert.equal(items[0].sourceTimeSec, 1 + 2);
});

test("describeInsertItems: 区間外は空", () => {
  const props: RenderProps = { ...base, inserts: [{ start: 2, end: 8, file: "intro.mp4", fit: "cover" }] };
  assert.deepEqual(describeInsertItems(props, 10), []);
});
