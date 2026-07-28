// src/engine/refPainter.ts の描画呼び出しを固定する。Node には Canvas2D が
// 無いため、CanvasRenderingContext2D の使用箇所だけを実装した記録用モックで
// 検証する(実ブラウザでの見た目は scripts/engine-parity.mjs が担当)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { paintDescriptor } from "../src/engine/refPainter.ts";
import type { FrameDescriptor } from "../src/engine/descriptor.ts";

type Call = [string, ...unknown[]];

/** CanvasRenderingContext2D の使用箇所だけを実装した記録用モック */
function createMockCtx(width: number, height: number) {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {};
  const proxyMethods = [
    "save", "restore", "fillRect", "drawImage", "beginPath", "moveTo", "lineTo",
    "closePath", "rect", "ellipse", "arcTo", "clip", "fill", "stroke",
    "translate", "scale", "fillText", "strokeText",
  ];
  const ctx: Record<string, unknown> = {
    canvas: { width, height },
    measureText: (text: string) => {
      calls.push(["measureText", text]);
      return { width: text.length * 10 }; // 決定論的な固定幅(1文字=10px)
    },
  };
  for (const m of proxyMethods) {
    ctx[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
    };
  }
  for (const p of ["fillStyle", "strokeStyle", "globalAlpha", "font", "textAlign", "textBaseline", "lineWidth", "lineCap", "filter"]) {
    Object.defineProperty(ctx, p, {
      get: () => props[p],
      set: (v) => {
        props[p] = v;
        calls.push([`set:${p}`, v]);
      },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const baseDescriptor: FrameDescriptor = {
  tOut: 5,
  size: { w: 1920, h: 1080 },
  backgroundColor: "black",
  items: [],
};

test("paintDescriptor: 背景色で fillRect する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  paintDescriptor(ctx, baseDescriptor, () => null);
  assert.deepEqual(
    calls.find((c) => c[0] === "set:fillStyle"),
    ["set:fillStyle", "black"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "fillRect"),
    ["fillRect", 0, 0, 1920, 1080],
  );
});

test("paintDescriptor: external(resolved) は quad へ clip して drawImage する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "external",
        sourceId: "cut.mp4",
        sourceTimeSec: 5,
        sourceKind: "video",
        placement: { mode: "resolved", sourceRect: { x: 0, y: 0, w: 1920, h: 1080 }, quad: { x: 0, y: 0, w: 1920, h: 1080 } },
        opacity: 1,
      },
    ],
  };
  const fakeVideo = { videoWidth: 1920, videoHeight: 1080 };
  paintDescriptor(ctx, descriptor, () => fakeVideo as unknown as CanvasImageSource);
  const drawImageCall = calls.find((c) => c[0] === "drawImage");
  assert.deepEqual(drawImageCall, ["drawImage", fakeVideo, 0, 0, 1920, 1080, 0, 0, 1920, 1080]);
});

test("paintDescriptor: external(fit=cover) は実寸(ダックタイピング)から source crop を解決する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "external",
        sourceId: "b.png",
        sourceTimeSec: 0,
        sourceKind: "image",
        placement: { mode: "fit", fit: "cover", box: { x: 0, y: 0, w: 200, h: 100 }, letterboxColor: "black" },
        opacity: 1,
      },
    ],
  };
  // 実寸 400x400 の正方形素材を 200x100(横長)の box へ cover
  const fakeImg = { naturalWidth: 400, naturalHeight: 400 };
  paintDescriptor(ctx, descriptor, () => fakeImg as unknown as CanvasImageSource);
  // レターボックス色の fillRect(box全体)が先に呼ばれる
  const letterboxFill = calls.filter((c) => c[0] === "fillRect");
  assert.deepEqual(letterboxFill[1], ["fillRect", 0, 0, 200, 100]); // [0]は背景、[1]がレターボックス
  const drawImageCall = calls.find((c) => c[0] === "drawImage");
  // scale = max(200/400, 100/400) = 0.5。visW=200/0.5=400(全幅使用=クロップ無し)、
  // visH=100/0.5=200(400のうち200だけ=上下100pxずつクロップ)
  assert.deepEqual(drawImageCall, ["drawImage", fakeImg, 0, 100, 400, 200, 0, 0, 200, 100]);
});

test("paintDescriptor: external(fit) はソース未解決(null)でもレターボックスだけは描く", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "external",
        sourceId: "missing.png",
        sourceTimeSec: 0,
        sourceKind: "image",
        placement: { mode: "fit", fit: "contain", box: { x: 0, y: 0, w: 100, h: 100 }, letterboxColor: "black" },
        opacity: 1,
      },
    ],
  };
  paintDescriptor(ctx, descriptor, () => null);
  assert.equal(calls.some((c) => c[0] === "drawImage"), false);
  assert.ok(calls.some((c) => c[0] === "fillRect" && c[3] === 100));
});

test("paintDescriptor: caption(anchor:center) は測定幅の半分だけ左へ寄せて fillText する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "rendered",
        content: {
          kind: "caption",
          text: "abcd", // モックの measureText は 1文字=10px → 幅40
          fontSizePx: 40,
          color: "#fff",
          outlineColor: "none",
          outlineWidthPx: 10,
          fontFamily: "sans-serif",
          fontWeight: 700,
        },
        contentHash: "x",
        placement: { mode: "anchor", point: { x: 500, y: 300 }, anchor: "center" },
        opacity: 1,
      },
    ],
  };
  paintDescriptor(ctx, descriptor, () => null);
  const fillTextCall = calls.find((c) => c[0] === "fillText");
  // boxX = 500 - 40/2 = 480。textY = boxY+textH/2 = (300-28)+28 = 300
  // (center アンカーでは常に point.y に一致する)。
  // outlineColor:"none" なので strokeText は呼ばれない
  assert.deepEqual(fillTextCall, ["fillText", "abcd", 480, 300]);
  assert.equal(calls.some((c) => c[0] === "strokeText"), false);
});

test("paintDescriptor: annotationBox は roundRectPath(移動+arcTo)+stroke する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "rendered",
        content: { kind: "annotationBox", rect: { x: 10, y: 20, w: 100, h: 50 }, color: "#f00", widthPx: 3, radiusPx: 8 },
        contentHash: "x",
        opacity: 1,
      },
    ],
  };
  paintDescriptor(ctx, descriptor, () => null);
  assert.ok(calls.some((c) => c[0] === "arcTo"));
  assert.ok(calls.some((c) => c[0] === "stroke"));
});

test("paintDescriptor: fill content は quad へ opacity 付きで fillRect する", () => {
  const { ctx, calls } = createMockCtx(1920, 1080);
  const descriptor: FrameDescriptor = {
    ...baseDescriptor,
    items: [
      {
        kind: "rendered",
        content: { kind: "fill", color: "black" },
        contentHash: "x",
        placement: { mode: "quad", quad: { x: 0, y: 0, w: 1920, h: 1080 } },
        opacity: 0.5,
      },
    ],
  };
  paintDescriptor(ctx, descriptor, () => null);
  const alphaSets = calls.filter((c) => c[0] === "set:globalAlpha");
  assert.ok(alphaSets.some((c) => c[1] === 0.5));
});
