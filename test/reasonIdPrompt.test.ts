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
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import { renderReasonIdsBlock } from "../src/lib/reasonIdInjection.ts";
import { CUT_REASON_IDS } from "../src/lib/reasonIds.ts";

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
  assert.equal(md5, "4d5203bf5315167ec232962a63634992");
  assert.equal(block.length, 1036);
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
