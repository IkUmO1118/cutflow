// lib/annotation.ts — 注釈グラフィック(overlays.json の annotations)の
// 既定値解決(resolveAnnotation)と矢尻ポリゴンの算出(arrowHeadPoints)、
// render 高速パスの FAST 適格性(annotationFastReason)・レイヤー画の正規形
// (annotationStillItem)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationFastReason,
  annotationStillItem,
  arrowHeadPoints,
  resolveAnnotation,
} from "../src/lib/annotation.ts";
import type { ArrowAnnotation, BoxAnnotation, SpotlightAnnotation } from "../src/types.ts";
import type { ResolvedAnnotation } from "../remotion/props.ts";

const closeTo = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be close to ${expected}`,
  );

/* ---------------- resolveAnnotation ---------------- */

test("resolveAnnotation: arrow は既定色・既定太さ・既定矢尻サイズを埋める", () => {
  const a: ArrowAnnotation = {
    type: "arrow",
    start: 1,
    end: 2,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
  };
  const r = resolveAnnotation(a, 10, 20);
  assert.deepEqual(r, {
    type: "arrow",
    start: 10,
    end: 20,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "#ff3b30",
    widthPx: 8,
    headPx: 28,
  });
});

test("resolveAnnotation: arrow の per-item 上書きは既定より優先", () => {
  const a: ArrowAnnotation = {
    type: "arrow",
    start: 1,
    end: 2,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "#00ff00",
    widthPx: 3,
    headPx: 12,
  };
  const r = resolveAnnotation(a, 5, 6);
  assert.deepEqual(r, {
    type: "arrow",
    start: 5,
    end: 6,
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "#00ff00",
    widthPx: 3,
    headPx: 12,
  });
});

test("resolveAnnotation: box は既定色・既定枠幅・既定角丸を埋め、fill 省略時はキー自体が無い", () => {
  const a: BoxAnnotation = {
    type: "box",
    start: 1,
    end: 2,
    rect: { x: 10, y: 20, w: 100, h: 50 },
  };
  const r = resolveAnnotation(a, 3, 4);
  assert.deepEqual(r, {
    type: "box",
    start: 3,
    end: 4,
    rect: { x: 10, y: 20, w: 100, h: 50 },
    color: "#ff3b30",
    widthPx: 6,
    radiusPx: 8,
  });
  assert.equal("fill" in r, false);
});

test("resolveAnnotation: box の per-item 上書き(fill 込み)は既定より優先", () => {
  const a: BoxAnnotation = {
    type: "box",
    start: 1,
    end: 2,
    rect: { x: 10, y: 20, w: 100, h: 50 },
    color: "#123456",
    widthPx: 2,
    radiusPx: 0,
    fill: "rgba(0,0,0,0.4)",
  };
  const r = resolveAnnotation(a, 3, 4);
  assert.deepEqual(r, {
    type: "box",
    start: 3,
    end: 4,
    rect: { x: 10, y: 20, w: 100, h: 50 },
    color: "#123456",
    widthPx: 2,
    radiusPx: 0,
    fill: "rgba(0,0,0,0.4)",
  });
});

test("resolveAnnotation: spotlight は既定 shape/dim/featherPx/radiusPx(0)を埋める", () => {
  const a: SpotlightAnnotation = {
    type: "spotlight",
    start: 1,
    end: 2,
    rect: { x: 0, y: 0, w: 500, h: 300 },
  };
  const r = resolveAnnotation(a, 7, 8);
  assert.deepEqual(r, {
    type: "spotlight",
    start: 7,
    end: 8,
    rect: { x: 0, y: 0, w: 500, h: 300 },
    shape: "rect",
    dim: 0.6,
    featherPx: 24,
    radiusPx: 0,
  });
});

test("resolveAnnotation: spotlight の per-item 上書き(ellipse)は既定より優先", () => {
  const a: SpotlightAnnotation = {
    type: "spotlight",
    start: 1,
    end: 2,
    rect: { x: 0, y: 0, w: 500, h: 300 },
    shape: "ellipse",
    dim: 0.9,
    featherPx: 10,
    radiusPx: 20,
  };
  const r = resolveAnnotation(a, 7, 8);
  assert.deepEqual(r, {
    type: "spotlight",
    start: 7,
    end: 8,
    rect: { x: 0, y: 0, w: 500, h: 300 },
    shape: "ellipse",
    dim: 0.9,
    featherPx: 10,
    radiusPx: 20,
  });
});

/* ---------------- arrowHeadPoints ---------------- */

test("arrowHeadPoints: 水平線(左→右)の矢尻頂点", () => {
  const { p1, p2 } = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
  closeTo(p1.x, 82.67949192431123);
  closeTo(p1.y, 10);
  closeTo(p2.x, 82.67949192431123);
  closeTo(p2.y, -10);
});

test("arrowHeadPoints: 垂直線(上→下)の矢尻頂点", () => {
  const { p1, p2 } = arrowHeadPoints({ x: 0, y: 0 }, { x: 0, y: 100 }, 20);
  closeTo(p1.x, -10);
  closeTo(p1.y, 82.67949192431123);
  closeTo(p2.x, 10);
  closeTo(p2.y, 82.67949192431123);
});

test("arrowHeadPoints: 斜め45°線の矢尻頂点", () => {
  const { p1, p2 } = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 100 }, 20);
  closeTo(p1.x, 80.68148347421863);
  closeTo(p1.y, 94.82361909794959);
  closeTo(p2.x, 94.82361909794959);
  closeTo(p2.y, 80.68148347421863);
});

test("arrowHeadPoints: from と to が同一点なら退化(to をそのまま返す)", () => {
  const { p1, p2 } = arrowHeadPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 20);
  assert.deepEqual(p1, { x: 5, y: 5 });
  assert.deepEqual(p2, { x: 5, y: 5 });
});

/* ---------------- annotationFastReason (A-1〜A-3) ---------------- */

test("A-1: annotationFastReason: keyframes 無しの arrow/box/spotlight は null(3種別すべて適格)", () => {
  const arrow: ResolvedAnnotation = {
    type: "arrow", start: 0, end: 1,
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    color: "#ff3b30", widthPx: 8, headPx: 28,
  };
  const box: ResolvedAnnotation = {
    type: "box", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: "#ff3b30", widthPx: 6, radiusPx: 8,
  };
  const spotlight: ResolvedAnnotation = {
    type: "spotlight", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    shape: "rect", dim: 0.6, featherPx: 24, radiusPx: 0,
  };
  assert.equal(annotationFastReason(arrow), null);
  assert.equal(annotationFastReason(box), null);
  assert.equal(annotationFastReason(spotlight), null);
});

test("A-2: annotationFastReason: keyframes: [](空配列)は静的扱い(null)", () => {
  const a: ResolvedAnnotation = {
    type: "box", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: "#ff3b30", widthPx: 6, radiusPx: 8,
    keyframes: [],
  };
  assert.equal(annotationFastReason(a), null);
});

test("A-3: annotationFastReason: keyframes 付きは 'keyframes' 理由で不適格", () => {
  const a: ResolvedAnnotation = {
    type: "box", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: "#ff3b30", widthPx: 6, radiusPx: 8,
    keyframes: [{ at: 0, easing: "linear", values: { x: 1 } }],
  };
  assert.equal(annotationFastReason(a), "keyframes");
});

/* ---------------- annotationStillItem (A-4〜A-5) ---------------- */

test("A-4: annotationStillItem: start/end を 0/1 に正規化し keyframes を落とす。他フィールドは保存", () => {
  const arrow: ResolvedAnnotation = {
    type: "arrow", start: 4.0, end: 6.4,
    from: { x: 1400, y: 600 }, to: { x: 900, y: 1000 },
    color: "#ff3b30", widthPx: 10, headPx: 36,
    keyframes: [{ at: 4.0, easing: "linear", values: { fromX: 1 } }],
  };
  const arrowItem = annotationStillItem(arrow);
  assert.deepEqual(arrowItem, {
    type: "arrow", start: 0, end: 1,
    from: { x: 1400, y: 600 }, to: { x: 900, y: 1000 },
    color: "#ff3b30", widthPx: 10, headPx: 36,
  });
  assert.equal("keyframes" in arrowItem, false);

  const box: ResolvedAnnotation = {
    type: "box", start: 8.0, end: 10.2,
    rect: { x: 120, y: 120, w: 760, h: 420 },
    color: "#00c853", widthPx: 8, radiusPx: 16,
    fill: "rgba(0,200,83,0.18)",
  };
  const boxItem = annotationStillItem(box);
  assert.deepEqual(boxItem, {
    type: "box", start: 0, end: 1,
    rect: { x: 120, y: 120, w: 760, h: 420 },
    color: "#00c853", widthPx: 8, radiusPx: 16,
    fill: "rgba(0,200,83,0.18)",
  });

  const spotlight: ResolvedAnnotation = {
    type: "spotlight", start: 11.0, end: 12.8,
    rect: { x: 560, y: 260, w: 800, h: 500 },
    shape: "ellipse", dim: 0.65, featherPx: 32, radiusPx: 0,
  };
  const spotlightItem = annotationStillItem(spotlight);
  assert.deepEqual(spotlightItem, {
    type: "spotlight", start: 0, end: 1,
    rect: { x: 560, y: 260, w: 800, h: 500 },
    shape: "ellipse", dim: 0.65, featherPx: 32, radiusPx: 0,
  });
});

test("A-5: annotationStillItem: box の fill 未指定なら出力に fill キー自体が無い(キャッシュキー安定性)", () => {
  const box: ResolvedAnnotation = {
    type: "box", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: "#ff3b30", widthPx: 6, radiusPx: 8,
  };
  const item = annotationStillItem(box);
  assert.equal("fill" in item, false);
});
