// stages/plan.ts の plan --cuts-only 応答パーサ(parseCutsResponse)。
// LLM 応答が壊れていても(コードフェンス混入・cuts 欠落等)壊れ方を
// 固定して検出できるようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCutsResponse,
  buildCutplan,
  buildChapterEntries,
  buildChapterTelopEntries,
} from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import { ID_RE } from "../src/lib/ids.ts";

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

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "導入" },
  { id: 2, start: 10, end: 20, text: "本編" },
  { id: 3, start: 20, end: 30, text: "余談" },
];

test("buildCutplan: idCtx 省略時は id に一切触れない(導入前とバイト等価)", () => {
  const cutplan = buildCutplan(numbered, [{ id: 3, reason: "余談カット" }]);
  for (const s of cutplan.segments) assert.equal("id" in s, false);
});

test("buildCutplan: idCtx ありで span 一致の旧 segment.id を運ぶ", () => {
  const existingSegments = [
    { id: "seg_aaaaaa", start: 0, end: 10, action: "keep" as const, reason: "旧" },
    { id: "seg_bbbbbb", start: 10, end: 20, action: "keep" as const, reason: "旧" },
  ];
  const used = new Set<string>(["seg_aaaaaa", "seg_bbbbbb"]);
  const cutplan = buildCutplan(numbered, [{ id: 3, reason: "余談カット" }], {
    existingSegments,
    used,
  });
  assert.equal(cutplan.segments[0].id, "seg_aaaaaa");
  assert.equal(cutplan.segments[1].id, "seg_bbbbbb");
  // span 20-30 は旧 segments に無いので新規採番
  assert.match(cutplan.segments[2].id as string, ID_RE);
  assert.notEqual(cutplan.segments[2].id, "seg_aaaaaa");
  assert.notEqual(cutplan.segments[2].id, "seg_bbbbbb");
});

test("buildCutplan: span が変わった segment は新 id になる", () => {
  const existingSegments = [
    { id: "seg_aaaaaa", start: 0, end: 5, action: "keep" as const, reason: "旧(span 違う)" },
  ];
  const used = new Set<string>(["seg_aaaaaa"]);
  const cutplan = buildCutplan(numbered, [], { existingSegments, used });
  assert.notEqual(cutplan.segments[0].id, "seg_aaaaaa");
  assert.match(cutplan.segments[0].id as string, ID_RE);
});

test("buildChapterEntries: idCtx 省略時は id に一切触れない", () => {
  const entries = buildChapterEntries([{ startId: 1, title: "導入" }], numbered, []);
  assert.equal("id" in entries[0], false);
});

test("buildChapterEntries: idCtx ありで title 一致の旧 id を運ぶ", () => {
  const existingChapters = [{ id: "ch_aaaaaa", start: 0, title: "導入" }];
  const used = new Set<string>(["ch_aaaaaa"]);
  const entries = buildChapterEntries(
    [{ startId: 1, title: "導入" }, { startId: 2, title: "新しい章" }],
    numbered,
    existingChapters,
    { used },
  );
  assert.equal(entries[0].id, "ch_aaaaaa");
  assert.match(entries[1].id as string, ID_RE);
});

test("buildChapterTelopEntries: idCtx 省略時は id に一切触れない", () => {
  const telops = buildChapterTelopEntries(
    { chapters: [{ start: 0, title: "導入" }] },
    3,
    2,
    [],
  );
  assert.equal("id" in telops[0], false);
});

test("buildChapterTelopEntries: idCtx ありで title 一致の旧 id を運ぶ", () => {
  const existingTelops = [
    { id: "cap_aaaaaa", start: 0, end: 2, text: "導入", track: 3 },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const telops = buildChapterTelopEntries(
    { chapters: [{ start: 0, title: "導入" }, { start: 20, title: "新章" }] },
    3,
    2,
    existingTelops,
    { used },
  );
  assert.equal(telops[0].id, "cap_aaaaaa");
  assert.match(telops[1].id as string, ID_RE);
});
