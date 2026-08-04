import { test } from "node:test";
import assert from "node:assert/strict";
import { renderedTextureId } from "../src/engine/runtime/textureCache.ts";
import type { RenderedItem } from "../src/engine/descriptor.ts";

function item(overrides: Partial<RenderedItem> = {}): RenderedItem {
  return {
    kind: "rendered",
    contentHash: "abc123",
    content: {
      kind: "caption",
      text: "同じ内容",
      fontSizePx: 48,
      color: "#fff",
      outlineColor: "#000",
      outlineWidthPx: 8,
      fontFamily: "sans-serif",
      fontWeight: 700,
    },
    placement: { mode: "anchor", point: { x: 100, y: 200 }, anchor: "center" },
    opacity: 1,
    ...overrides,
  };
}

test("renderedTextureId: content が同じでも placement が違えば ID が変わる", () => {
  // drawCaption は refPainter.ts で opacity と transform をテクスチャへ焼き込む。
  // compositor はそのテクスチャを opacity:1 + 恒等 quad で貼るだけなので、
  // placement/opacity/transform は cache key に必ず必要。
  assert.notEqual(
    renderedTextureId(item()),
    renderedTextureId(item({ placement: { mode: "anchor", point: { x: 300, y: 200 }, anchor: "center" } })),
  );
});

test("renderedTextureId: opacity が違えば ID が変わる", () => {
  assert.notEqual(renderedTextureId(item()), renderedTextureId(item({ opacity: 0.5 })));
});

test("renderedTextureId: transform が違えば ID が変わる", () => {
  assert.notEqual(
    renderedTextureId(item()),
    renderedTextureId(item({ transform: { translateX: 10, translateY: 0, scale: 1 } })),
  );
});

test("renderedTextureId: すべて同じなら ID も同じ", () => {
  assert.equal(renderedTextureId(item()), renderedTextureId(item()));
});

test("renderedTextureId: contentHash が ID の先頭に残る", () => {
  assert.match(renderedTextureId(item()), /^rnd:abc123:/);
});
