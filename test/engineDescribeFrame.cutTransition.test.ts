// src/engine/describeFrame.ts の dip-to-black(cutTransition)翻訳を固定する。
// Main.tsx:157-165 の三角波と数値をクロスチェックする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCutTransition, describeFrame } from "../src/engine/describeFrame.ts";
import { defaultProps } from "../remotion/props.ts";
import type { RenderProps } from "../remotion/props.ts";

const base: RenderProps = {
  ...defaultProps,
  videoFile: "cut.mp4",
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  durationSec: 30,
};

test("describeCutTransition: cutTransition 未指定は空", () => {
  assert.deepEqual(describeCutTransition(base, 10), []);
});

test("describeCutTransition: 境界から離れていれば空(sec=0.5, half=0.25)", () => {
  const props: RenderProps = { ...base, cutTransition: { sec: 0.5 }, cutBoundarySecs: [10] };
  assert.deepEqual(describeCutTransition(props, 5), []);
});

test("describeCutTransition: 境界ちょうどで opacity=1(ピーク)", () => {
  const props: RenderProps = { ...base, cutTransition: { sec: 0.5 }, cutBoundarySecs: [10] };
  const items = describeCutTransition(props, 10);
  assert.equal(items.length, 1);
  const item = items[0];
  if (item.kind !== "rendered" || item.content.kind !== "fill") throw new Error("unreachable");
  assert.equal(item.content.color, "black");
  assert.equal(item.opacity, 1);
  assert.deepEqual(item.placement, { mode: "quad", quad: { x: 0, y: 0, w: 1920, h: 1080 } });
});

test("describeCutTransition: 境界前後で三角波(線形)に上下する", () => {
  const props: RenderProps = { ...base, cutTransition: { sec: 0.5 }, cutBoundarySecs: [10] };
  const half = 0.25;
  const before = describeCutTransition(props, 10 - half / 2);
  const after = describeCutTransition(props, 10 + half / 2);
  if (before[0].kind !== "rendered" || after[0].kind !== "rendered") throw new Error("unreachable");
  assert.equal(before[0].opacity, 0.5);
  assert.equal(after[0].opacity, 0.5);
});

test("describeCutTransition: 複数境界が重なる場合は最大値を採る", () => {
  const props: RenderProps = { ...base, cutTransition: { sec: 2 }, cutBoundarySecs: [10, 10.5] };
  // t=10.5 は境界10からは離れかけ、境界10.5ではピーク → max はピーク側
  const items = describeCutTransition(props, 10.5);
  if (items[0].kind !== "rendered") throw new Error("unreachable");
  assert.equal(items[0].opacity, 1);
});

test("describeFrame: cutTransition は items の最後(最前面)に来る", () => {
  const props: RenderProps = { ...base, cutTransition: { sec: 0.5 }, cutBoundarySecs: [5] };
  const d = describeFrame(props, 5);
  const last = d.items[d.items.length - 1];
  assert.equal(last.kind, "rendered");
  if (last.kind !== "rendered") throw new Error("unreachable");
  assert.equal(last.content.kind, "fill");
});
