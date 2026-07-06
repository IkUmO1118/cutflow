// stages/planShorts.ts — ショート LLM ハイライト選定の純ロジック。
// parseShortsResponse(壊れた LLM 応答への耐性)を固定する。
// shortsFromSelection のテストは同ファイルへ順次追加する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShortsResponse, shortsFromSelection } from "../src/stages/planShorts.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";

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

// --- shortsFromSelection(番号 → ranges 変換の純ロジック) ---

/** 各区間 [start, end] を10秒刻みで並べたテスト用の番号表(id は 1 始まり) */
function numbered(spans: [number, number][]): NumberedSegment[] {
  return spans.map(([start, end], i) => ({ id: i + 1, start, end, text: "" }));
}

test("shortsFromSelection: 番号を ranges に変換し approved:false・profile:vertical", () => {
  const n = numbered([
    [0, 5],
    [10, 15],
    [20, 25],
  ]);
  const out = shortsFromSelection(
    n,
    { shorts: [{ name: "a", ids: [1, 3], reason: "" }] },
    60,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "a");
  assert.equal(out[0].profile, "vertical");
  assert.equal(out[0].approved, false);
  assert.deepEqual(out[0].ranges, [
    { start: 0, end: 5 },
    { start: 20, end: 25 },
  ]);
});

test("shortsFromSelection: 存在しない id は無視される", () => {
  const n = numbered([
    [0, 5],
    [10, 15],
  ]);
  const out = shortsFromSelection(
    n,
    { shorts: [{ name: "a", ids: [1, 99, 2], reason: "" }] },
    60,
  );
  assert.deepEqual(out[0].ranges, [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
  ]);
});

test("shortsFromSelection: ranges は時系列マージされる(id 順に依らず・隣接は結合)", () => {
  const n = numbered([
    [0, 5], // id1
    [5, 10], // id2(id1 と隣接 → マージ)
    [20, 25], // id3
  ]);
  const out = shortsFromSelection(
    n,
    { shorts: [{ name: "a", ids: [3, 2, 1], reason: "" }] },
    60,
  );
  assert.deepEqual(out[0].ranges, [
    { start: 0, end: 10 },
    { start: 20, end: 25 },
  ]);
});

test("shortsFromSelection: 尺超過で末尾 range が落ちる", () => {
  // 各30秒。3本 = 90秒 > 60 → 末尾を落として2本(60秒)まで
  const n = numbered([
    [0, 30],
    [40, 70],
    [80, 110],
  ]);
  const out = shortsFromSelection(
    n,
    { shorts: [{ name: "a", ids: [1, 2, 3], reason: "" }] },
    60,
  );
  assert.deepEqual(out[0].ranges, [
    { start: 0, end: 30 },
    { start: 40, end: 70 },
  ]);
});

test("shortsFromSelection: name 重複が回避される", () => {
  const n = numbered([
    [0, 5],
    [10, 15],
  ]);
  const out = shortsFromSelection(
    n,
    {
      shorts: [
        { name: "dup", ids: [1], reason: "" },
        { name: "dup", ids: [2], reason: "" },
      ],
    },
    60,
  );
  assert.deepEqual(out.map((s) => s.name), ["dup", "dup-2"]);
});

test("shortsFromSelection: name を正規化し、空なら short-<n>", () => {
  const n = numbered([
    [0, 5],
    [10, 15],
  ]);
  const out = shortsFromSelection(
    n,
    {
      shorts: [
        { name: "Hook Mistake!!", ids: [1], reason: "" },
        { name: "日本語のみ", ids: [2], reason: "" },
      ],
    },
    60,
  );
  assert.deepEqual(out.map((s) => s.name), ["hook-mistake", "short-2"]);
});

test("shortsFromSelection: 有効な区間が無いショートは飛ばす", () => {
  const n = numbered([[0, 5]]);
  const out = shortsFromSelection(
    n,
    {
      shorts: [
        { name: "empty", ids: [99], reason: "" },
        { name: "ok", ids: [1], reason: "" },
      ],
    },
    60,
  );
  assert.deepEqual(out.map((s) => s.name), ["ok"]);
});
