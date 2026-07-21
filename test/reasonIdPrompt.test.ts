// plan.reasonIds(§docs/plans/2026-07-20-cut-knowledge-p1-p2-design.md §4.2/§6)の
// プロンプト注入面。最重要不変条件(I2): plan.reasonIds.enabled: false(既定)
// のとき renderPrompt(plan-cuts.md / plan.md / meta.md)の出力は導入前と
// 1バイトも変わらない。T-g(§7)はこれを golden 文字列(md5)で固定する。
//
// この golden は AGENTS_CONTRACT.md 実装前に親が実測した OFF path ベースライン
// (scratchpad/offpath.mjs)と同一の入力・同一の md5 を使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, renderCritiquePrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import { renderReasonIdsBlock, renderReasonIdsOutputBlock } from "../src/lib/reasonIdInjection.ts";
import { CUT_REASON_IDS } from "../src/lib/reasonIds.ts";
import { CUT_PATTERN_INJECTION } from "../src/lib/cutPatterns.ts";

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 3.5, text: "こんにちは、今日はCutFlowを紹介します" },
  { id: 2, start: 3.5, end: 7.25, text: "えー、まあ、その、動画編集のツールですね" },
  { id: 3, start: 7.25, end: 12, text: "" },
];

const GOLDEN: Record<string, { md5: string; len: number }> = {
  "plan-cuts.md": { md5: "286177e3329f003331c4feab888930b3", len: 712 },
  "plan.md": { md5: "2e31b1df5dedaee81238f25fbd552983", len: 932 },
  "meta.md": { md5: "8046c97a515d20ba1c883620f5492e5e", len: 778 },
};

const FEATURE_TOKENS = ["reasonId", "分類", "recipe", "レシピ", "cut-recipes", "収録タイプ", "edit-skills"];

test("T-g: renderPrompt(reasonIds 省略)は brief.md/rules.md 無しの素の収録で golden md5 と一致(I2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-offpath-"));
  try {
    for (const [tpl, expected] of Object.entries(GOLDEN)) {
      const out = renderPrompt(dir, tpl, numbered, 120);
      const md5 = createHash("md5").update(out).digest("hex");
      assert.equal(md5, expected.md5, `${tpl} の md5 が golden と不一致`);
      assert.equal(out.length, expected.len, `${tpl} の長さが golden と不一致`);
      for (const token of FEATURE_TOKENS) {
        assert.ok(!out.includes(token), `${tpl} に新機能の語 "${token}" が OFF path で漏れています`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-g: renderPrompt に reasonIds を明示的に空文字で渡しても golden と同一(9引数呼び出しの既定と一致)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-offpath2-"));
  try {
    const withDefault = renderPrompt(dir, "plan-cuts.md", numbered, 120);
    const withEmpty = renderPrompt(dir, "plan-cuts.md", numbered, 120, "", undefined, "", "");
    assert.equal(withDefault, withEmpty);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P2-7: 注入ブロックの生成(renderReasonIdsBlock)                        */
/* ------------------------------------------------------------------ */

test("renderReasonIdsBlock: enabled=false は空文字(バイト等価の核)", () => {
  assert.equal(renderReasonIdsBlock(false), "");
});

test("renderReasonIdsBlock: enabled=true は前後 \\n を伴う1ブロックで13分類全てを id + 一行定義で列挙する", () => {
  const block = renderReasonIdsBlock(true);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /## 判断の分類\(reasonId\)/);
  assert.match(block, /## 残す判断の記録\(keeps\)/);
  assert.match(block, /max\(12, 候補数の10%\)/);
  for (const id of CUT_REASON_IDS) {
    assert.match(block, new RegExp(`- ${id} — `), `${id} が注入ブロックに無い`);
  }
  // recipe 本文(判定シグナル等)は読みに行かない=注入されない(§6 却下案2)
  assert.doesNotMatch(block, /判定シグナル/);
  assert.doesNotMatch(block, /worked example/);
});

test("renderReasonIdsBlock: golden(id+一行定義+系の並び。候補数に依存しない固定文字列)", () => {
  const block = renderReasonIdsBlock(true);
  const md5 = createHash("md5").update(block).digest("hex");
  // P6-T6(REASON_ID_LABEL を craft で研ぐ)+ P6-T7(紛らわしい境目の弁別行)で
  // golden を更新(§7 I9 の予算上限1800文字は別テストで検査。ここは
  // 「固定文字列であること」の回帰検知)
  assert.equal(md5, "732d4a2f06550ce0b48693fafbfe77b3");
  assert.equal(block.length, 1346);
});

/* ------------------------------------------------------------------ */
/* plan.ts への配線(generateCutsOnce だけ・plan.loop/harness は対象外)     */
/* ------------------------------------------------------------------ */

test("renderPrompt: reasonIds を渡すと {{styleProfile}} 直後(区切りなし)・## カットの判断基準の直前に挿入される(plan-cuts.md)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-wire-"));
  try {
    const block = renderReasonIdsBlock(true);
    const prompt = renderPrompt(dir, "plan-cuts.md", numbered, 120, "", undefined, "", block);
    assert.match(prompt, /## 判断の分類\(reasonId\)/);
    assert.ok(prompt.includes(`${block}\n## カットの判断基準`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-2: 穴A(plan.md/critique に {{reasonIds}} を追加)・穴C({{reasonIdsOutput}})*/
/* ------------------------------------------------------------------ */

const CRITIQUE_GOLDEN = { md5: "2de4c2d2b28a5b28fe714c05a4b610d2", len: 951 };

test("T-g': renderCritiquePrompt(reasonIds 省略)は golden md5 と一致(I2'。plan-cuts-critique.md)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-critique-offpath-"));
  try {
    const observation = "keepCount=2 outDurationSec=8.5 目標尺(15秒)未達";
    const currentCuts = [{ id: 3, reason: "余談カット" }];
    const out = renderCritiquePrompt(dir, numbered, 120, "", observation, currentCuts);
    const md5 = createHash("md5").update(out).digest("hex");
    assert.equal(md5, CRITIQUE_GOLDEN.md5);
    assert.equal(out.length, CRITIQUE_GOLDEN.len);
    for (const token of FEATURE_TOKENS) {
      assert.ok(!out.includes(token), `critique 出力に新機能の語 "${token}" が OFF path で漏れています`);
    }
    assert.doesNotMatch(out, /\{\{/, "未置換のプレースホルダが残っています");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderPrompt: plan.md でも reasonIds が {{styleProfile}} 直後・## カットの判断基準の直前に挿入される(穴A)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-planmd-"));
  try {
    const block = renderReasonIdsBlock(true);
    const prompt = renderPrompt(dir, "plan.md", numbered, 120, "", undefined, "", block);
    assert.match(prompt, /## 判断の分類\(reasonId\)/);
    assert.ok(prompt.includes(`${block}\n## カットの判断基準`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCritiquePrompt: reasonIds を渡すと {{perception}} 直後(区切りなし)に挿入される(穴A・critique)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-critique-"));
  try {
    const block = renderReasonIdsBlock(true);
    const prompt = renderCritiquePrompt(dir, numbered, 120, "", "obs", [], undefined, block);
    assert.match(prompt, /## 判断の分類\(reasonId\)/);
    assert.ok(prompt.includes(`${block}\nobs`), "reasonIds ブロックの直後に {{observation}} が続いていません");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderReasonIdsOutputBlock: enabled=false は空文字(バイト等価の核)", () => {
  assert.equal(renderReasonIdsOutputBlock(false), "");
});

test("renderReasonIdsOutputBlock: enabled=true は reasonId 付き例 + keeps 配列の例を含む(既存 JSON 例は書き換えない)", () => {
  const block = renderReasonIdsOutputBlock(true);
  assert.match(block, /^\n/);
  assert.match(block, /"reasonId": "restatement"/);
  assert.match(block, /"keeps"/);
  assert.match(block, /"reasonId": "demo-wait"/);
});

test("renderPrompt: reasonIdsOutput は ## 出力形式 節の末尾(既存の cuts 例の後ろ)に挿入される(plan-cuts.md・穴C)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-reasonid-output-"));
  try {
    const outBlock = renderReasonIdsOutputBlock(true);
    const prompt = renderPrompt(dir, "plan-cuts.md", numbered, 120, "", undefined, "", "", outBlock);
    const legacyExampleIdx = prompt.indexOf('"reason": "同じ説明の言い直し(前半)"');
    const newExampleIdx = prompt.indexOf('"reasonId": "restatement"');
    assert.ok(legacyExampleIdx >= 0 && newExampleIdx > legacyExampleIdx, "新例は旧例より後ろにある必要があります");
    assert.ok(prompt.endsWith(`${outBlock}\n`), "reasonIdsOutput ブロックが末尾(cuts 例の後ろ)に来ていません");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-4: pattern による選択注入(collections/cutPatterns.ts)                */
/* ------------------------------------------------------------------ */

test("renderReasonIdsBlock(true, \"general\") は P2 の出力(pattern省略時)とバイト一致", () => {
  assert.equal(renderReasonIdsBlock(true, "general"), renderReasonIdsBlock(true));
  const md5 = createHash("md5").update(renderReasonIdsBlock(true, "general")).digest("hex");
  assert.equal(md5, "732d4a2f06550ce0b48693fafbfe77b3");
});

test("renderReasonIdsBlock(true, \"tool-demo\") は11分類(tangent/failure-and-fixを落とす)+ note 1行を持つ", () => {
  const block = renderReasonIdsBlock(true, "tool-demo");
  assert.match(block, new RegExp(CUT_PATTERN_INJECTION["tool-demo"].note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const id of CUT_PATTERN_INJECTION["tool-demo"].recipes) {
    assert.match(block, new RegExp(`- ${id} — `), `${id} が tool-demo の注入ブロックに無い`);
  }
  assert.doesNotMatch(block, /- tangent — /);
  assert.doesNotMatch(block, /- failure-and-fix — /);
  // note が先頭行(見出しより前)にあること
  assert.ok(block.indexOf(CUT_PATTERN_INJECTION["tool-demo"].note) < block.indexOf("## 判断の分類"));
});

test("renderReasonIdsBlock(false, ...) は pattern に関わらず常に空文字(バイト等価の核)", () => {
  assert.equal(renderReasonIdsBlock(false, "tool-demo"), "");
  assert.equal(renderReasonIdsBlock(false, "general"), "");
});

test("renderReasonIdsBlock: 未知の pattern(cutPatterns.ts に無い id)は general へフォールバックする", () => {
  // @ts-expect-error テスト目的で未知の pattern id を渡す(実運用は resolveReasonIdsCfg が防ぐ)
  const block = renderReasonIdsBlock(true, "nonexistent");
  assert.equal(block, renderReasonIdsBlock(true, "general"));
});

/* ------------------------------------------------------------------ */
/* P4-2: blueprint の末尾連結                                            */
/* ------------------------------------------------------------------ */

test("renderReasonIdsBlock(true, \"general\") は P4-2 後も引き続きバイト一致(blueprint 無し)", () => {
  const md5 = createHash("md5").update(renderReasonIdsBlock(true, "general")).digest("hex");
  assert.equal(md5, "732d4a2f06550ce0b48693fafbfe77b3");
});

test("renderReasonIdsBlock(true, \"tool-demo\") の末尾に blueprint(tool-demo-arc)が8行以内で連結される", () => {
  const block = renderReasonIdsBlock(true, "tool-demo");
  assert.match(block, /## この収録の流れ\(tool-demo-arc\)/);
  assert.match(block, /demo-wait が支配的。dead-air と取り違えない/);
  const blueprintStart = block.indexOf("## この収録の流れ");
  assert.ok(blueprintStart > block.indexOf("## 残す判断の記録"), "blueprint は keeps 節より後ろに来る必要があります");
  const blueprintLines = block.slice(blueprintStart).trimEnd().split("\n");
  assert.ok(blueprintLines.length <= 8, `blueprint は8行以内(実際 ${blueprintLines.length}行)`);
  // 尺の秒数を書かない規約(§3)
  assert.doesNotMatch(block.slice(blueprintStart), /\d+秒/);
});
