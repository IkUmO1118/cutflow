// lib/annotationStill.ts — render 高速パスが使う、注釈グラフィック1件を
// 「時間不変なレイヤー画」として焼くためのキャッシュキー・パスを固定する。
// annotationStillKey は overlayStillKey と違い外部ファイルを参照しない
// (annotation の内容 + 出力解像度だけで決まる)ので純関数として直接テストできる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  annotationStillItem as reexportedAnnotationStillItem,
  annotationStillKey,
  annotationStillPath,
} from "../src/lib/annotationStill.ts";
// annotationStillItem の定義はブラウザ安全な annotation.ts 側
// (remotion/AnnotationStill.tsx が import するため。annotationStill.ts は
// node 専用でブラウザバンドルに入れられない)
import { annotationStillItem } from "../src/lib/annotation.ts";
import type { ResolvedAnnotation } from "../remotion/props.ts";

const BOX: ResolvedAnnotation = {
  type: "box", start: 0, end: 1,
  rect: { x: 100, y: 100, w: 400, h: 300 },
  color: "#ff3b30", widthPx: 6, radiusPx: 8,
};

test("annotationStillItem: annotationStill.ts の re-export は annotation.ts の定義そのもの(二重定義しない)", () => {
  assert.equal(reexportedAnnotationStillItem, annotationStillItem);
});

test("S-1: annotationStillKey: start/end/keyframes だけ違う2件が同一キー", () => {
  const a: ResolvedAnnotation = { ...BOX, start: 8.0, end: 10.2 };
  const b: ResolvedAnnotation = {
    ...BOX, start: 100.0, end: 102.5,
    keyframes: [{ at: 100.0, easing: "linear", values: { x: 1 } }],
  };
  const keyA = annotationStillKey({ annotation: a, width: 1920, height: 1080 });
  const keyB = annotationStillKey({ annotation: b, width: 1920, height: 1080 });
  assert.equal(keyA, keyB);
});

test("S-2: annotationStillKey: rect/color/widthPx/dim/shape のどれか1つが違えば別キー", () => {
  const base = annotationStillKey({ annotation: BOX, width: 1920, height: 1080 });

  const rectDiff = annotationStillKey({
    annotation: { ...BOX, rect: { x: 0, y: 0, w: 10, h: 10 } },
    width: 1920, height: 1080,
  });
  assert.notEqual(base, rectDiff);

  const colorDiff = annotationStillKey({
    annotation: { ...BOX, color: "#00c853" },
    width: 1920, height: 1080,
  });
  assert.notEqual(base, colorDiff);

  const widthDiff = annotationStillKey({
    annotation: { ...BOX, widthPx: 2 },
    width: 1920, height: 1080,
  });
  assert.notEqual(base, widthDiff);

  const spotlightBase: ResolvedAnnotation = {
    type: "spotlight", start: 0, end: 1,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    shape: "rect", dim: 0.6, featherPx: 24, radiusPx: 0,
  };
  const spotlightKey = annotationStillKey({ annotation: spotlightBase, width: 1920, height: 1080 });

  const dimDiff = annotationStillKey({
    annotation: { ...spotlightBase, dim: 0.9 },
    width: 1920, height: 1080,
  });
  assert.notEqual(spotlightKey, dimDiff);

  const shapeDiff = annotationStillKey({
    annotation: { ...spotlightBase, shape: "ellipse" },
    width: 1920, height: 1080,
  });
  assert.notEqual(spotlightKey, shapeDiff);
});

test("S-3: annotationStillKey: width/height(出力解像度)が違えば別キー", () => {
  const keyA = annotationStillKey({ annotation: BOX, width: 1920, height: 1080 });
  const keyB = annotationStillKey({ annotation: BOX, width: 1280, height: 720 });
  assert.notEqual(keyA, keyB);
});

test("S-4: annotationStillKey は純関数(fs に触れない)=存在しない dir でも例外を投げない", () => {
  // annotationStillKey は dir を受け取らない(annotation 内容+解像度だけで決まる)。
  // annotationStillPath には存在しない dir を渡しても例外にならないことを確認する。
  assert.doesNotThrow(() => {
    annotationStillPath({
      dir: "/nonexistent/path/does/not/exist",
      annotation: BOX, width: 1920, height: 1080,
    });
  });
});

test("S-5: annotationStillPath: <dir>/render.fast/annotations/<key>.png を返す", () => {
  const dir = "/some/dir";
  const args = { dir, annotation: BOX, width: 1920, height: 1080 };
  const path = annotationStillPath(args);
  const key = annotationStillKey(args);
  assert.equal(path, join(dir, "render.fast", "annotations", `${key}.png`));
});
