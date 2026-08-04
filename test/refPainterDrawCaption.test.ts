import { test } from "node:test";
import assert from "node:assert/strict";
import { drawRendered } from "../src/engine/refPainter.ts";
import type { RenderedItem } from "../src/engine/descriptor.ts";

type TextCall = { text: string; x: number; y: number };

function stubCtx() {
  const calls: TextCall[] = [];
  const ctx = {
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "middle",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    fill: () => {},
    measureText: (text: string) => ({ width: [...text].length * 10 }),
    fillText: (text: string, x: number, y: number) => { calls.push({ text, x, y }); },
    strokeText: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function caption(text: string, placement: NonNullable<RenderedItem["placement"]>): RenderedItem {
  return {
    kind: "rendered",
    contentHash: "caption",
    content: {
      kind: "caption",
      text,
      fontSizePx: 10,
      color: "#fff",
      outlineColor: "none",
      outlineWidthPx: 0,
      fontFamily: "sans-serif",
      fontWeight: 700,
    },
    placement,
    opacity: 1,
  };
}

test("drawCaption: 1行 maxWidth なし center は導入前と同じ左端", () => {
  const { ctx, calls } = stubCtx();
  drawRendered(ctx, caption("abcd", { mode: "anchor", point: { x: 100, y: 50 }, anchor: "center" }));
  assert.equal(calls[0].x, 80);
});

test("drawCaption: 1行 maxWidth なし topLeft は point.x から描く", () => {
  const { ctx, calls } = stubCtx();
  drawRendered(ctx, caption("abcd", { mode: "anchor", point: { x: 100, y: 50 }, anchor: "topLeft" }));
  assert.equal(calls[0].x, 100);
});

test("drawCaption: maxWidth 超過 bottomCenter は真の中央揃え", () => {
  // この期待値は 2026-08-04 の意図的な変更。画素ゲートの golden は
  // Remotion オラクル由来で再撮影できないため、この経路はここで固定する。
  const { ctx, calls } = stubCtx();
  drawRendered(ctx, caption("abcdefghij", {
    mode: "anchor",
    point: { x: 100, y: 50 },
    anchor: "bottomCenter",
    maxWidthPx: 40,
  }));
  assert.equal(calls[0].x + 100 / 2, 100);
});

test("drawCaption: 2行 center は各行をボックス内で中央揃えし y が行高ずつ増える", () => {
  const { ctx, calls } = stubCtx();
  drawRendered(ctx, caption("abcd\nef", { mode: "anchor", point: { x: 100, y: 50 }, anchor: "center" }));
  assert.equal(calls[0].x, 80);
  assert.equal(calls[1].x, 90);
  assert.equal(calls[1].y - calls[0].y, 14);
});

test("drawCaption: 2行 topLeft は各行を左揃えする", () => {
  const { ctx, calls } = stubCtx();
  drawRendered(ctx, caption("abcd\nef", { mode: "anchor", point: { x: 100, y: 50 }, anchor: "topLeft" }));
  assert.deepEqual(calls.map((c) => c.x), [100, 100]);
});
