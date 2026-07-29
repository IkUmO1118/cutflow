// src/engine/runtime/frameSource.ts の純関数部分(decideFetchStrategy)を固定する。
// 実 movie を使う I/O 部分は M3a Phase5 の開発ページで実測する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFetchStrategy, ITERATE_AHEAD_WINDOW_SEC } from "../src/engine/runtime/frameSource.ts";

test("decideFetchStrategy: 未取得(currentTimestamp=null)なら常に reseek", () => {
  assert.equal(
    decideFetchStrategy({ currentTimestamp: null, currentDuration: 0 }, 5),
    "reseek",
  );
});

test("decideFetchStrategy: 目標時刻が保持サンプルの[timestamp, timestamp+duration)内なら current", () => {
  assert.equal(
    decideFetchStrategy({ currentTimestamp: 10, currentDuration: 0.033 }, 10.02),
    "current",
  );
  // 下端は含む・上端は含まない
  assert.equal(
    decideFetchStrategy({ currentTimestamp: 10, currentDuration: 0.033 }, 10),
    "current",
  );
});

test("decideFetchStrategy: durationを過ぎたがITERATE_AHEAD_WINDOW_SEC以内はadvance", () => {
  assert.equal(
    decideFetchStrategy({ currentTimestamp: 10, currentDuration: 0.033 }, 10 + ITERATE_AHEAD_WINDOW_SEC - 0.01),
    "advance",
  );
});

test("decideFetchStrategy: ITERATE_AHEAD_WINDOW_SECを超えたらreseek", () => {
  assert.equal(
    decideFetchStrategy({ currentTimestamp: 10, currentDuration: 0.033 }, 10 + ITERATE_AHEAD_WINDOW_SEC + 0.01),
    "reseek",
  );
});

test("decideFetchStrategy: 目標時刻が保持サンプルより前(巻き戻り)ならreseek", () => {
  assert.equal(
    decideFetchStrategy({ currentTimestamp: 10, currentDuration: 0.033 }, 5),
    "reseek",
  );
});
