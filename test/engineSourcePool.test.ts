// src/engine/runtime/sourcePool.ts の純関数(decideEviction)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEviction, SourcePool } from "../src/engine/runtime/sourcePool.ts";

test("decideEviction: サイズが上限以下ならnull(何も追い出さない)", () => {
  assert.equal(decideEviction(["a", "b"], 6), null);
  assert.equal(decideEviction(["a", "b", "c"], 3), null);
});

test("decideEviction: 上限を超えたら先頭(最古アクセス)を返す", () => {
  assert.equal(decideEviction(["a", "b", "c"], 2), "a");
});

test("decideEviction: 空配列はnull", () => {
  assert.equal(decideEviction([], 3), null);
});

test("SourcePool: 上限を超えると最古アクセスをdisposeし、直近アクセスは残す", () => {
  const pool = new SourcePool((id) => `/media/${id}`, 2);
  pool.acquire("a");
  pool.acquire("b");
  pool.acquire("c"); // 上限2を超える → "a" が追い出される
  assert.equal(pool.size, 2);
  assert.equal(pool.openSampleCount, 0);
});

test("SourcePool: 同じsourceIdの再取得はLRU順を更新する(再取得直後は追い出されない)", () => {
  const pool = new SourcePool((id) => `/media/${id}`, 2);
  pool.acquire("a");
  pool.acquire("b");
  pool.acquire("a"); // "a" を touch → LRU順は [b, a]
  pool.acquire("c"); // 上限2超過 → 最古の "b" が追い出される
  assert.equal(pool.size, 2);
});

test("SourcePool: disposeAllで全て解放しsizeが0になる", () => {
  const pool = new SourcePool((id) => `/media/${id}`, 6);
  pool.acquire("a");
  pool.acquire("b");
  pool.disposeAll();
  assert.equal(pool.size, 0);
});
