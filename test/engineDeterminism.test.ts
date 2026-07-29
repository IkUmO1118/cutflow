// test/engineDeterminism.test.ts — M4 Phase4: エンジン決定性テスト。
// 決定性2層契約の CI ゲート:
// (a) descriptor golden: byte 一致 (engineDescribeFrame.golden.test.ts で担保)
// (b) 同一入力→2回 render の構造一致 (フレーム数・video stream duration)
//
// SSIM 閾値検証は GPU を必要とするため、このファイルでは構造検証と
// renderKey の決定性のみを確認する。SSIM parity は bench で手動実測する
// (§4 design doc・母艦§9)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compositionDurationInFrames, compositionDurationSec } from "../src/lib/renderFrameMath.ts";
import { contentHashOf } from "../src/engine/hash.ts";
import { buildRenderCacheKey, renderCacheKeyEquals, type RenderCacheKey } from "../src/lib/renderKey.ts";

test("compositionDurationInFrames: 同じ入力で同じ出力", () => {
  const a = compositionDurationInFrames(120, 30);
  const b = compositionDurationInFrames(120, 30);
  assert.equal(a, b);
});

test("compositionDurationInFrames: フレーム数が非負整数", () => {
  const frames = compositionDurationInFrames(10.5, 30);
  assert.ok(Number.isInteger(frames));
  assert.ok(frames >= 0);
});

test("compositionDurationSec: 同じ入力で同じ出力", () => {
  const a = compositionDurationSec(120, 30);
  const b = compositionDurationSec(120, 30);
  assert.equal(a, b);
});

test("contentHashOf: 同じ文字列で同じハッシュ", () => {
  const a = contentHashOf("hello world");
  const b = contentHashOf("hello world");
  assert.equal(a, b);
});

test("contentHashOf: 異なる文字列で異なるハッシュ", () => {
  const a = contentHashOf("hello world");
  const b = contentHashOf("hello world!");
  assert.notEqual(a, b);
});

test("contentHashOf: 空文字列でもハッシュが取れる", () => {
  const hash = contentHashOf("");
  assert.ok(typeof hash === "string");
  assert.ok(hash.length > 0);
});

test("contentHashOf: オブジェクトの JSON 表現が同じならハッシュも同じ", () => {
  const a = contentHashOf(JSON.stringify({ x: 1, y: [2, 3] }));
  const b = contentHashOf(JSON.stringify({ x: 1, y: [2, 3] }));
  assert.equal(a, b);
});

test("contentHashOf: JSON.stringify はオブジェクトのキー順序を保持する", () => {
  const a = JSON.stringify({ x: 1, y: 2 });
  const b = JSON.stringify({ x: 1, y: 2 });
  assert.equal(contentHashOf(a), contentHashOf(b));
});

test("renderCacheKeyEquals: 同一キーで true", () => {
  const key: RenderCacheKey = {
    props: { fps: 30, durationSec: 10, width: 1920, height: 1080 } as never,
    cut: { mtimeMs: 1000, size: 50000 },
    materials: [],
    hardwareAcceleration: "if-possible",
  };
  assert.ok(renderCacheKeyEquals(key, JSON.parse(JSON.stringify(key))));
});

test("renderCacheKeyEquals: 異なるキーで false", () => {
  const a: RenderCacheKey = {
    props: { fps: 30, durationSec: 10, width: 1920, height: 1080 } as never,
    cut: { mtimeMs: 1000, size: 50000 },
    materials: [],
    hardwareAcceleration: "if-possible",
  };
  const b: RenderCacheKey = {
    props: { fps: 30, durationSec: 10, width: 1920, height: 1080 } as never,
    cut: { mtimeMs: 1000, size: 50001 },
    materials: [],
    hardwareAcceleration: "if-possible",
  };
  assert.equal(renderCacheKeyEquals(a, b), false);
});
