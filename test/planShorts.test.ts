// stages/planShorts.ts — ショート LLM ハイライト選定の純ロジック。
// parseShortsResponse(壊れた LLM 応答への耐性)を固定する。
// shortsFromSelection のテストは同ファイルへ順次追加する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShortsResponse } from "../src/stages/planShorts.ts";

test("parseShortsResponse: 正例(素の JSON)", () => {
  const raw = `{
    "shorts": [
      { "name": "hook-mistake", "ids": [12, 13, 14], "reason": "詰まって直す一連" },
      { "name": "result", "ids": [30], "reason": "驚きの結果" }
    ]
  }`;
  assert.deepEqual(parseShortsResponse(raw), {
    shorts: [
      { name: "hook-mistake", ids: [12, 13, 14], reason: "詰まって直す一連" },
      { name: "result", ids: [30], reason: "驚きの結果" },
    ],
  });
});

test("parseShortsResponse: コードフェンス・前後の説明文を許容", () => {
  const raw =
    "はい、選びました。\n```json\n" +
    `{ "shorts": [ { "name": "a", "ids": [1], "reason": "r" } ] }` +
    "\n```\n以上です。";
  assert.deepEqual(parseShortsResponse(raw), {
    shorts: [{ name: "a", ids: [1], reason: "r" }],
  });
});

test("parseShortsResponse: shorts 欠落時は空配列", () => {
  assert.deepEqual(parseShortsResponse("{}"), { shorts: [] });
  assert.deepEqual(parseShortsResponse(`{ "shorts": "nope" }`), { shorts: [] });
});

test("parseShortsResponse: ids 欠落・非数値は落とす / name・reason 欠落は空文字", () => {
  const raw = `{
    "shorts": [
      { "name": "no-ids" },
      { "ids": [1, "2", 3, null, 4.5], "reason": "混在" }
    ]
  }`;
  assert.deepEqual(parseShortsResponse(raw), {
    shorts: [
      { name: "no-ids", ids: [], reason: "" },
      { name: "", ids: [1, 3, 4.5], reason: "混在" },
    ],
  });
});

test("parseShortsResponse: JSON が無ければ投げる", () => {
  assert.throws(() => parseShortsResponse("JSON はありません"), /JSON が見つかりません/);
});

test("parseShortsResponse: 壊れた JSON は投げる", () => {
  assert.throws(() => parseShortsResponse(`{ "shorts": [ { ] }`), /パースに失敗/);
});
