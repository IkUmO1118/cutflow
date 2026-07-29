// src/engine/describeFrame.ts グループ3(テロップ: 位置/スタイル/anim/karaoke)
// の翻訳を固定する。CaptionLayer.tsx/captionAnim.ts の実式とクロスチェックする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCaptionLayer } from "../src/engine/describeFrame.ts";
import { alignKaraoke, animStateAt, karaokeActiveAt, karaokeFillProgress } from "../src/lib/captionAnim.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { Caption, RenderProps } from "../src/lib/renderPropsTypes.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  caption: { fontSizePx: 44 },
};

test("describeCaptionLayer: 表示中のテロップが無ければ空配列", () => {
  const props: RenderProps = { ...base, captions: [{ start: 10, end: 20, text: "後で", track: 1 }] };
  assert.deepEqual(describeCaptionLayer(props, 5), []);
});

test("describeCaptionLayer: hideCaption 区間は全トラック非表示", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "こんにちは", track: 1 }];
  const props: RenderProps = { ...base, captions, hideCaption: [{ start: 0, end: 10 }] };
  assert.deepEqual(describeCaptionLayer(props, 5), []);
});

test("describeCaptionLayer: pos 無しは下部中央フォールバック(カメラ無し=予約ゼロ)", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "こんにちは", track: 1 }];
  const props: RenderProps = { ...base, captions, wipe: { widthPx: 480, marginPx: 32 } };
  const items = describeCaptionLayer(props, 5);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "rendered" || item.placement.mode !== "anchor") throw new Error("unreachable");
  assert.equal(item.placement.anchor, "bottomCenter");
  assert.deepEqual(item.placement.point, { x: 1920 / 2, y: 1080 - 32 });
  assert.equal(item.placement.maxWidthPx, 1920 * 0.9);
});

test("describeCaptionLayer: pos 無し・カメラ有りは wipe ぶん右側を予約する", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "こんにちは", track: 1 }];
  const props: RenderProps = {
    ...base,
    captions,
    cameraRegion: { x: 1920, y: 0, w: 480, h: 270 },
    wipe: { widthPx: 480, marginPx: 32 },
  };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].placement.mode !== "anchor") throw new Error("unreachable");
  const reserve = 480 + 32 * 2;
  const bandWidth = 1920 - reserve;
  assert.deepEqual(items[0].placement.point, { x: bandWidth / 2, y: 1080 - 32 });
  assert.equal(items[0].placement.maxWidthPx, bandWidth * 0.9);
});

test("describeCaptionLayer: pos 指定は center アンカー(既定)", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "タイトル", track: 1, pos: { x: 500, y: 300 } }];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].placement.mode !== "anchor") throw new Error("unreachable");
  assert.equal(items[0].placement.anchor, "center");
  assert.deepEqual(items[0].placement.point, { x: 500, y: 300 });
  assert.equal(items[0].placement.maxWidthPx, undefined); // 位置指定は自動折り返みしない
});

test("describeCaptionLayer: pos + anchor:topLeft はそのまま topLeft", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "章タイトル", track: 1, pos: { x: 100, y: 100 }, anchor: "topLeft" },
  ];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].placement.mode !== "anchor") throw new Error("unreachable");
  assert.equal(items[0].placement.anchor, "topLeft");
});

test("describeCaptionLayer: スタイルは segment→config既定の優先順で解決される", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "x", track: 1, style: { fontSizePx: 60, color: "#ff0000" } },
  ];
  const props: RenderProps = {
    ...base,
    captions,
    caption: { fontSizePx: 44, color: "#00ff00", outlineColor: "#0000ff" },
  };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered") throw new Error("unreachable");
  const content = items[0].content;
  if (content.kind !== "caption") throw new Error("unreachable");
  assert.equal(content.fontSizePx, 60); // segment 優先
  assert.equal(content.color, "#ff0000"); // segment 優先
  assert.equal(content.outlineColor, "#0000ff"); // config 既定へフォールバック
  assert.equal(content.outlineWidthPx, Math.round(60 * 0.25)); // fontSizePx の0.25倍(既定)
});

test("describeCaptionLayer: outlineColor:'none' は打ち消しをそのまま保持する(hash対象)", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "x", track: 1, style: { outlineColor: "none" } }];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  assert.equal(items[0].content.outlineColor, "none");
});

test("describeCaptionLayer: background 未指定(config含め全て無し)は content.background 無し", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "x", track: 1 }];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  assert.equal(items[0].content.background, undefined);
});

test("describeCaptionLayer: background 指定はpadding/radius既定を解決して持つ", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "x", track: 1, style: { fontSizePx: 40, background: { color: "#000000cc" } } },
  ];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  assert.deepEqual(items[0].content.background, {
    color: "#000000cc",
    paddingPx: Math.round(40 * 0.35),
    radiusPx: 8,
  });
});

test("describeCaptionLayer: 複数トラックはトラック番号昇順で複数 item", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "2番目", track: 2 },
    { start: 0, end: 10, text: "1番目", track: 1 },
  ];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  assert.equal(items.length, 2);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  if (items[1].kind !== "rendered" || items[1].content.kind !== "caption") throw new Error("unreachable");
  assert.equal(items[0].content.text, "1番目");
  assert.equal(items[1].content.text, "2番目");
});

test("describeCaptionLayer: 同トラック重なりは配列先頭が優先(.find と同じ)", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "先", track: 1 },
    { start: 0, end: 10, text: "後", track: 1 },
  ];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  assert.equal(items[0].content.text, "先");
});

test("describeCaptionLayer: anim 未指定は transform 無し・opacity=1(1px不変の契約)", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "x", track: 1 }];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered") throw new Error("unreachable");
  assert.equal(items[0].transform, undefined);
  assert.equal(items[0].opacity, 1);
});

test("describeCaptionLayer: anim ありは animStateAt と一致する opacity/transform", () => {
  const captions: Caption[] = [
    { start: 0, end: 10, text: "x", track: 1, style: { fontSizePx: 50, anim: { in: "slide-up", durationSec: 1 } } },
  ];
  const props: RenderProps = { ...base, captions };
  const tOut = 0.5; // 登場アニメの途中
  const items = describeCaptionLayer(props, tOut);
  if (items[0].kind !== "rendered") throw new Error("unreachable");
  const expected = animStateAt({ in: "slide-up", durationSec: 1 }, 0, 10, tOut, 50);
  assert.equal(items[0].opacity, expected.opacity);
  assert.deepEqual(items[0].transform, {
    translateX: expected.translateX,
    translateY: expected.translateY,
    scale: expected.scale,
  });
});

test("describeCaptionLayer: karaoke word モードは karaokeActiveAt と同じ active 集合", () => {
  const words = [
    { text: "こんにちは", start: 0, end: 2 },
    { text: "世界", start: 2, end: 4 },
  ];
  const captions: Caption[] = [
    { start: 0, end: 10, text: "こんにちは世界", track: 1, words, style: { karaoke: {} } },
  ];
  const props: RenderProps = { ...base, captions };
  const tOut = 3; // 1語目発話済み・2語目発話中
  const items = describeCaptionLayer(props, tOut);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  const pieces = alignKaraoke("こんにちは世界", words);
  const expectedActive = karaokeActiveAt(pieces, tOut);
  assert.deepEqual(
    items[0].content.words?.map((w) => w.active),
    expectedActive,
  );
  assert.equal(items[0].content.karaokeMode, "word");
});

test("describeCaptionLayer: karaoke fill モードは発話中の語だけ fillProgress を持つ", () => {
  const words = [{ text: "こんにちは", start: 0, end: 2 }];
  const captions: Caption[] = [
    { start: 0, end: 10, text: "こんにちは", track: 1, words, style: { karaoke: { mode: "fill" } } },
  ];
  const props: RenderProps = { ...base, captions };
  const tOut = 1; // 発話中(進捗50%)
  const items = describeCaptionLayer(props, tOut);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  const expectedProgress = karaokeFillProgress(0, 2, tOut);
  assert.equal(items[0].content.words?.[0].fillProgress, expectedProgress);
});

test("describeCaptionLayer: karaoke 指定でも words[] が無ければ通常表示(content.words 無し)", () => {
  const captions: Caption[] = [{ start: 0, end: 10, text: "x", track: 1, style: { karaoke: {} } }];
  const props: RenderProps = { ...base, captions };
  const items = describeCaptionLayer(props, 5);
  if (items[0].kind !== "rendered" || items[0].content.kind !== "caption") throw new Error("unreachable");
  assert.equal(items[0].content.words, undefined);
});
