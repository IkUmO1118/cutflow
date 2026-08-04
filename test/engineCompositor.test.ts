// src/engine/runtime/compositor.ts の純関数(OffscreenCanvas を使わない部分)を固定する。
// EngineCompositor 本体(webgpuBackend/OffscreenCanvas が要る)は実 movie で
// M3a Phase5 の開発ページ+画素 parity で検証する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { quadToTransform, splitLayersForBlur } from "../src/engine/runtime/compositor.ts";
import { externalTextureId, renderedTextureId } from "../src/engine/runtime/textureCache.ts";
import type { ExternalItem, FrameItem, RenderedItem } from "../src/engine/descriptor.ts";

test("quadToTransform: 中心/幅高さへ変換する", () => {
  const t = quadToTransform({ x: 100, y: 50, w: 200, h: 80 });
  assert.deepEqual(t, { centerX: 200, centerY: 90, width: 200, height: 80 });
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

// R4 Phase2: externalTextureId にクロップ(sourceRect/quad寸法/radiusPx)を
// 含めることで、同一sourceId+同一timestampでも配置が違えばIDが分かれる
// ことを固定する(§1.1: obs-canvas の画面パネル+カメラワイプが同じソース・
// 同じサンプル時刻から作られ、旧IDが完全一致していたことの再発防止)。
test("externalTextureId: 同一source+同一timestampでもsourceRectが違えばIDが異なる(§1.1再発防止)", () => {
  const screenPanelId = externalTextureId(
    "media/proxy.mp4", 160.09, undefined,
    { x: 0.5, y: 0, w: 1919, h: 1080 }, { w: 1920, h: 1080 }, undefined,
  );
  const wipeId = externalTextureId(
    "media/proxy.mp4", 160.09, undefined,
    { x: 2340, y: 0, w: 1080, h: 1080 }, { w: 375, h: 375 }, undefined,
  );
  assert.notEqual(screenPanelId, wipeId);
});

test("externalTextureId: sourceId・timestamp・colorFilter・sourceRect・quad・radiusPxが全て同一ならIDが一致する(キャッシュが効く)", () => {
  const rect = { x: 10, y: 20, w: 300, h: 200 };
  const cf = { kind: "colorFilter" as const, brightness: 1.1, contrast: 1, saturate: 1 };
  const a = externalTextureId("media/proxy.mp4", 5.5, cf, rect, { w: 300, h: 200 }, 12);
  const b = externalTextureId("media/proxy.mp4", 5.5, cf, { ...rect }, { w: 300, h: 200 }, 12);
  assert.equal(a, b);
});

test("externalTextureId: radiusPxの違いがIDに効く", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const a = externalTextureId("media/proxy.mp4", 0, undefined, rect, { w: 100, h: 100 }, 0);
  const b = externalTextureId("media/proxy.mp4", 0, undefined, rect, { w: 100, h: 100 }, 20);
  assert.notEqual(a, b);
});

test("externalTextureId: colorFilterの違いがIDに効く", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const a = externalTextureId("media/proxy.mp4", 0, undefined, rect, { w: 100, h: 100 }, undefined);
  const b = externalTextureId(
    "media/proxy.mp4", 0, { kind: "colorFilter", brightness: 1.2, contrast: 1, saturate: 1 },
    rect, { w: 100, h: 100 }, undefined,
  );
  assert.notEqual(a, b);
});

test("externalTextureId: quadの寸法の違いがIDに効く(同じsourceRectでも出力サイズが違えば別テクスチャ)", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const a = externalTextureId("media/proxy.mp4", 0, undefined, rect, { w: 100, h: 100 }, undefined);
  const b = externalTextureId("media/proxy.mp4", 0, undefined, rect, { w: 200, h: 200 }, undefined);
  assert.notEqual(a, b);
});

// rendered 側にも external(§1.1)と同じ罠がある: ensureRendered は item を
// フルフレームへ**絶対座標で**焼くのに、旧IDは contentHash(content+解像度)
// だけだった。文言を変えずに動かすとIDが一致し、古い座標のテクスチャが
// 再利用されて画が動かない(エディタでテロップ/テキストを D&D しても
// キャンバス上の文字が移動せず、リロードするまで直らない)。
// 既存の captionItem() を「動かす」ヘルパ(contentHash は据え置き=
// 文言・スタイルを変えずに配置だけ動かした状況を作る)
function movedCaption(overrides: Partial<RenderedItem>): RenderedItem {
  return { ...captionItem(), ...overrides };
}

test("renderedTextureId: 同一contentHashでも placement が違えばIDが異なる(D&Dでキャンバスが追従しない再発防止)", () => {
  const before = captionItem();
  const after = movedCaption({
    placement: { mode: "anchor", point: { x: 505, y: 1200 }, anchor: "center" },
  });
  assert.equal(before.contentHash, after.contentHash, "前提: 文言を変えずに動かすと contentHash は一致する");
  assert.notEqual(renderedTextureId(before), renderedTextureId(after));
});

test("renderedTextureId: anchor だけの違いもIDに効く(同じ点でも描かれる場所が変わる)", () => {
  // 点は据え置きで anchor だけ差し替える(anchor 単独の寄与を測る)
  const bottomCenter = captionItem();
  const topLeft = movedCaption({
    placement: { mode: "anchor", point: { x: 960, y: 1000 }, anchor: "topLeft" },
  });
  assert.notEqual(renderedTextureId(bottomCenter), renderedTextureId(topLeft));
});

test("renderedTextureId: opacity の違いがIDに効く(anim フェードが最初の1枚で凍らない)", () => {
  assert.notEqual(
    renderedTextureId(movedCaption({ opacity: 0.2 })),
    renderedTextureId(movedCaption({ opacity: 1 })),
  );
});

test("renderedTextureId: transform の違いがIDに効く(anim スライド/ポップが凍らない)", () => {
  const still = captionItem();
  const moved = movedCaption({ transform: { translateX: 0, translateY: -40, scale: 1 } });
  assert.notEqual(renderedTextureId(still), renderedTextureId(moved));
});

test("renderedTextureId: content・placement・opacity・transform が全て同一ならIDが一致する(キャッシュが効く)", () => {
  assert.equal(renderedTextureId(captionItem()), renderedTextureId(captionItem()));
});
