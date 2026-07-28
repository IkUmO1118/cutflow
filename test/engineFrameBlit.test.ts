// src/engine/runtime/frameBlit.ts の純関数(OffscreenCanvas を使わない部分)を固定する。
// blitVideoSample 自体(OffscreenCanvas/VideoSample.draw が要る)は実 movie で
// M3a Phase5 の開発ページ+画素 parity で検証する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  colorFilterCss,
  resolveFitFromNatural,
  scaleRectToPixelSpace,
} from "../src/engine/runtime/frameBlit.ts";

test("scaleRectToPixelSpace: canvas空間の矩形をproxyの実デコード解像度へ縮小する", () => {
  // canvas(manifest.video.canvas)が3840x2160、proxyが1920x1080(半分)の想定
  const rect = { x: 100, y: 200, w: 400, h: 300 };
  const out = scaleRectToPixelSpace(rect, { w: 3840, h: 2160 }, { w: 1920, h: 1080 });
  assert.deepEqual(out, { x: 50, y: 100, w: 200, h: 150 });
});

test("scaleRectToPixelSpace: canvasとproxyが同解像度なら恒等", () => {
  const rect = { x: 10, y: 20, w: 30, h: 40 };
  const out = scaleRectToPixelSpace(rect, { w: 1920, h: 1080 }, { w: 1920, h: 1080 });
  assert.deepEqual(out, rect);
});

test("resolveFitFromNatural: cover は箱を隙間なく埋める(quad=box、sourceRectは中央基準で狭める)", () => {
  // natural 200x100(横長) を 100x100(正方形)の箱へ cover
  const { sourceRect, quad } = resolveFitFromNatural({ w: 200, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }, "cover");
  assert.deepEqual(quad, { x: 0, y: 0, w: 100, h: 100 });
  // scale = max(100/200, 100/100) = 1 → visW=100, visH=100 → 横方向だけ中央基準で切り出す
  assert.deepEqual(sourceRect, { x: 50, y: 0, w: 100, h: 100 });
});

test("resolveFitFromNatural: contain は全体を収めレターボックスする(sourceRect=natural全体)", () => {
  const { sourceRect, quad } = resolveFitFromNatural({ w: 200, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }, "contain");
  assert.deepEqual(sourceRect, { x: 0, y: 0, w: 200, h: 100 });
  // scale = min(100/200, 100/100) = 0.5 → quadW=100, quadH=50 → 縦方向にレターボックス
  assert.deepEqual(quad, { x: 0, y: 25, w: 100, h: 50 });
});

test("colorFilterCss: brightness/contrast/saturateをCSS filter文字列へ", () => {
  assert.equal(
    colorFilterCss({ kind: "colorFilter", brightness: 1.1, contrast: 0.9, saturate: 1.2 }),
    "brightness(1.1) contrast(0.9) saturate(1.2)",
  );
});
