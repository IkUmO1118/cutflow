// stages/plan.ts の plan --cuts-only 応答パーサ(parseCutsResponse)。
// LLM 応答が壊れていても(コードフェンス混入・cuts 欠落等)壊れ方を
// 固定して検出できるようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCutsResponse } from "../src/stages/plan.ts";

test("正常な cuts 応答をパースできる", () => {
  const raw = JSON.stringify({
    cuts: [{ id: 3, reason: "同じ説明の言い直し(前半)" }],
  });
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 3, reason: "同じ説明の言い直し(前半)" }]);
});

test("コードフェンスや前後の説明文が混ざっていても拾う", () => {
  const raw =
    "以下がカット判断です:\n```json\n" +
    JSON.stringify({ cuts: [{ id: 1, reason: "脱線" }] }) +
    "\n```\nご確認ください。";
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 1, reason: "脱線" }]);
});

test("cuts が空でもエラーにならない(カット不要)", () => {
  const parsed = parseCutsResponse(JSON.stringify({ cuts: [] }));
  assert.deepEqual(parsed.cuts, []);
});

test("cuts が欠落していても空配列にフォールバックする", () => {
  const parsed = parseCutsResponse(JSON.stringify({}));
  assert.deepEqual(parsed.cuts, []);
});

test("chapters/titles/description が混ざっていても cuts だけ拾う", () => {
  // --cuts-only 用プロンプトのはずが LLM が旧フォーマットで章等を含めて
  // 返してきても、cuts-only の呼び出し側はそれらを無視できることを確認
  const raw = JSON.stringify({
    cuts: [{ id: 2, reason: "繰り返し" }],
    chapters: [{ startId: 1, title: "導入" }],
    titles: ["タイトル案"],
    description: "概要欄",
  });
  const parsed = parseCutsResponse(raw);
  assert.deepEqual(parsed.cuts, [{ id: 2, reason: "繰り返し" }]);
});

test("JSON が見つからない応答はエラーを投げる", () => {
  assert.throws(() => parseCutsResponse("カットはありません。"));
});

test("壊れた JSON はエラーを投げる", () => {
  assert.throws(() => parseCutsResponse("{ cuts: [id: 1] "));
});
