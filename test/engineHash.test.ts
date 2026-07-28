// src/engine/hash.ts — contentHash の決定性・近接値の差別化を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentHashOf, fnv1a64, stableStringify } from "../src/engine/hash.ts";

test("fnv1a64: 同じ入力は常に同じハッシュ(決定性)", () => {
  const a = fnv1a64("hello world");
  const b = fnv1a64("hello world");
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test("fnv1a64: 近接する値の差は別ハッシュになる(衝突しない)", () => {
  const hashes = new Set<string>();
  for (let i = 0; i < 50; i++) {
    hashes.add(fnv1a64(`x=${i}`));
  }
  assert.equal(hashes.size, 50);
});

test("fnv1a64: 1文字違うだけでも別ハッシュ", () => {
  assert.notEqual(fnv1a64("abc"), fnv1a64("abd"));
});

test("stableStringify: キー順序に依存しない(オブジェクトキーをソートする)", () => {
  const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = stableStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 });
  assert.equal(a, b);
});

test("stableStringify: 配列順序は保持する(意味を持つため)", () => {
  const a = stableStringify([1, 2, 3]);
  const b = stableStringify([3, 2, 1]);
  assert.notEqual(a, b);
});

test("contentHashOf: 同一内容+同一解像度は同一ハッシュ", () => {
  const content = { kind: "fill", color: "#000000" };
  const size = { w: 1920, h: 1080 };
  assert.equal(contentHashOf(content, size), contentHashOf(content, size));
});

test("contentHashOf: 出力解像度が違えば別ハッシュ(材料に size を含む)", () => {
  const content = { kind: "fill", color: "#000000" };
  const a = contentHashOf(content, { w: 1920, h: 1080 });
  const b = contentHashOf(content, { w: 1080, h: 1920 });
  assert.notEqual(a, b);
});

test("contentHashOf: カラオケの語境界近くの微小な値差でも別ハッシュ", () => {
  const size = { w: 1920, h: 1080 };
  const near = Array.from({ length: 20 }, (_, i) => ({
    text: "テスト",
    fillProgress: i / 20,
  }));
  const hashes = new Set(near.map((c) => contentHashOf(c, size)));
  assert.equal(hashes.size, near.length);
});
