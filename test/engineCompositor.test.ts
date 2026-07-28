// src/engine/runtime/compositor.ts の純関数(OffscreenCanvas を使わない部分)を固定する。
// EngineCompositor 本体(opencut-wasm/OffscreenCanvas が要る)は実 movie で
// M3a Phase5 の開発ページ+画素 parity で検証する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { quadToTransform, splitLayersForBlur } from "../src/engine/runtime/compositor.ts";
import type { ExternalItem, FrameItem, RenderedItem } from "../src/engine/descriptor.ts";

test("quadToTransform: 中心/幅高さ/回転無しへ変換する", () => {
  const t = quadToTransform({ x: 100, y: 50, w: 200, h: 80 });
  assert.deepEqual(t, {
    centerX: 200,
    centerY: 90,
    width: 200,
    height: 80,
    rotationDegrees: 0,
    flipX: false,
    flipY: false,
  });
});

function externalItem(sourceId: string): ExternalItem {
  return {
    kind: "external",
    sourceId,
    sourceTimeSec: 0,
    sourceKind: "video",
    placement: { mode: "resolved", quad: { x: 0, y: 0, w: 1920, h: 1080 } },
    opacity: 1,
  };
}

function fillItem(): RenderedItem {
  return {
    kind: "rendered",
    content: { kind: "fill", color: "#000" },
    contentHash: "hash-fill",
    placement: { mode: "quad", quad: { x: 0, y: 0, w: 1920, h: 1080 } },
    opacity: 1,
  };
}

function captionItem(): RenderedItem {
  return {
    kind: "rendered",
    content: {
      kind: "caption",
      text: "hello",
      fontSizePx: 40,
      color: "#fff",
      outlineColor: "none",
      outlineWidthPx: 0,
      fontFamily: "sans-serif",
      fontWeight: 700,
    },
    contentHash: "hash-caption",
    placement: { mode: "anchor", point: { x: 960, y: 1000 }, anchor: "bottomCenter" },
    opacity: 1,
  };
}

function blurItem(rect = { x: 10, y: 10, w: 100, h: 100 }): RenderedItem {
  return {
    kind: "rendered",
    content: { kind: "blurRegion", rect, radiusPx: 20 },
    contentHash: "hash-blur",
    opacity: 1,
  };
}

test("splitLayersForBlur: blurRegionが無ければbelow=全item・above/blurs=空", () => {
  const items: FrameItem[] = [externalItem("proxy.mp4"), captionItem()];
  const { below, blurs, above } = splitLayersForBlur(items);
  assert.equal(below.length, 2);
  assert.equal(blurs.length, 0);
  assert.equal(above.length, 0);
});

test("splitLayersForBlur: blurRegionの前をbelow・後をaboveへ分ける", () => {
  const base = externalItem("proxy.mp4");
  const insert = externalItem("materials/insert.mp4");
  const blur = blurItem();
  const caption = captionItem();
  const fill = fillItem();
  const items: FrameItem[] = [base, insert, blur, caption, fill];
  const { below, blurs, above } = splitLayersForBlur(items);
  assert.deepEqual(below, [base, insert]);
  assert.deepEqual(blurs, [blur]);
  assert.deepEqual(above, [caption, fill]);
});

test("splitLayersForBlur: 複数blurRegionは連続ブロックとしてまとめて扱う", () => {
  const base = externalItem("proxy.mp4");
  const blurA = blurItem({ x: 0, y: 0, w: 50, h: 50 });
  const blurB = blurItem({ x: 100, y: 100, w: 50, h: 50 });
  const caption = captionItem();
  const items: FrameItem[] = [base, blurA, blurB, caption];
  const { below, blurs, above } = splitLayersForBlur(items);
  assert.deepEqual(below, [base]);
  assert.deepEqual(blurs, [blurA, blurB]);
  assert.deepEqual(above, [caption]);
});
