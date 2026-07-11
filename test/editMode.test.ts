// lib/editMode.ts — plan(カット判断LLM)の編集モード(X4)。
// 最重要不変条件: editMode 省略(=safe・目標尺なし)のとき、3テンプレ経由の
// プロンプトは X4 導入前と1バイトも変わらない(safe が「現状の固定行」と
// 完全一致することを golden で固定する)。
// §docs/plans/2026-07-11-x4-editing-aggressiveness-design.md
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asEditMode,
  DEFAULT_EDIT_MODE,
  editModeMarker,
  renderEditModeBlock,
  resolveEditMode,
} from "../src/lib/editMode.ts";
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";

// X4 導入前に3テンプレ(plan.md/plan-cuts.md/plan-cuts-critique.md)にハードコード
// されていた「カットの判断基準」最後の1行。safe はこの文字列と完全一致でなければ
// ならない(§1-1 のバイト等価の逃げ道)。
const PRE_X4_SAFE_LINE =
  "- 迷ったら残す。過剰カットより冗長の方がまし(人間が後から調整できる)";

/* ---------------- asEditMode / editModeMarker ---------------- */

test("asEditMode: 3値は通す、未知値・非文字列は null", () => {
  assert.equal(asEditMode("safe"), "safe");
  assert.equal(asEditMode("balanced"), "balanced");
  assert.equal(asEditMode("aggressive"), "aggressive");
  assert.equal(asEditMode("foo"), null);
  assert.equal(asEditMode(undefined), null);
  assert.equal(asEditMode(123), null);
});

test("editModeMarker: 日本語/英語どちらのラベルも拾う", () => {
  assert.equal(editModeMarker("編集モード: aggressive"), "aggressive");
  assert.equal(editModeMarker("edit-mode: safe"), "safe");
  assert.equal(editModeMarker("edit_mode:safe"), "safe");
  assert.equal(editModeMarker("EditMode : Balanced"), "balanced");
  assert.equal(editModeMarker("マーカーなしの普通の文章"), null);
});

test("editModeMarker: 複数一致は最後の一致が勝つ(後勝ち)", () => {
  assert.equal(editModeMarker("編集モード: safe\n...\n編集モード: aggressive"), "aggressive");
});

/* ---------------- resolveEditMode ---------------- */

test("resolveEditMode: 既定は balanced(configMode/rules/brief すべて空)", () => {
  assert.equal(
    resolveEditMode({ configMode: undefined, rules: "", brief: "" }),
    DEFAULT_EDIT_MODE,
  );
  assert.equal(resolveEditMode({ configMode: undefined, rules: "", brief: "" }), "balanced");
});

test("resolveEditMode: config 値をそのまま反映", () => {
  assert.equal(
    resolveEditMode({ configMode: "aggressive", rules: "", brief: "" }),
    "aggressive",
  );
  assert.equal(resolveEditMode({ configMode: "safe", rules: "", brief: "" }), "safe");
});

test("resolveEditMode: config が未対応値なら warn して balanced にフォールバック", () => {
  const warnings: string[] = [];
  const mode = resolveEditMode({
    configMode: "foo",
    rules: "",
    brief: "",
    warn: (m) => warnings.push(m),
  });
  assert.equal(mode, "balanced");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plan\.editMode/);
  assert.match(warnings[0], /foo/);
});

test("resolveEditMode: 優先順位は brief > rules > config", () => {
  assert.equal(
    resolveEditMode({ configMode: "aggressive", rules: "", brief: "編集モード: safe" }),
    "safe",
  );
  assert.equal(
    resolveEditMode({ configMode: "safe", rules: "edit-mode: aggressive", brief: "" }),
    "aggressive",
  );
  assert.equal(
    resolveEditMode({
      configMode: "safe",
      rules: "edit-mode: aggressive",
      brief: "編集モード: balanced",
    }),
    "balanced",
  );
});

/* ---------------- renderEditModeBlock ---------------- */

test("renderEditModeBlock: 目標尺 null は1行のみ", () => {
  const block = renderEditModeBlock("safe", null);
  assert.equal(block, PRE_X4_SAFE_LINE);
  assert.equal(block.split("\n").length, 1);
});

test("renderEditModeBlock: 目標尺ありは2行目に秒数を含む", () => {
  const block = renderEditModeBlock("balanced", 600);
  const lines = block.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /約 600 秒/);
});

/* ---------------- プレースホルダ配線(renderPrompt 統合) ---------------- */

let channelDir: string;
let recDir: string;
const numbered: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "こんにちは" }];

before(() => {
  channelDir = mkdtempSync(join(tmpdir(), "cutflow-editmode-"));
  recDir = join(channelDir, "2026-07-11-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

test("renderPrompt: editModeCfg 省略(既定 safe・目標尺なし)は導入前とバイト等価", () => {
  for (const templateFile of ["plan.md", "plan-cuts.md"]) {
    const prompt = renderPrompt(recDir, templateFile, numbered, 42);
    assert.doesNotMatch(prompt, /\{\{editMode\}\}/);
    assert.match(
      prompt,
      new RegExp(
        `エラーや失敗の場面は「見せ場」なのでカットしない\\(解決とセットで残す\\)\\n${escapeRe(PRE_X4_SAFE_LINE)}\\n\\n## 出力形式`,
      ),
    );
  }
});

test("renderPrompt: balanced を渡すとモード文が差し替わる", () => {
  const prompt = renderPrompt(recDir, "plan-cuts.md", numbered, 42, "", {
    configMode: "balanced",
    targetOutDurationSec: null,
  });
  assert.doesNotMatch(prompt, new RegExp(escapeRe(PRE_X4_SAFE_LINE)));
  assert.match(prompt, /明確な冗長・言い直し・脱線は積極的に切ってテンポを作る/);
});

test("renderPrompt: targetOutDurationSec 指定時は目標尺行が入る", () => {
  const prompt = renderPrompt(recDir, "plan-cuts.md", numbered, 42, "", {
    configMode: "aggressive",
    targetOutDurationSec: 180,
  });
  assert.match(prompt, /目標の出力尺は約 180 秒/);
});

test("renderPrompt: brief.md のマーカー行が config を上書きする(統合)", () => {
  writeFileSync(join(recDir, "brief.md"), "見せ場: 冒頭のデモ\n編集モード: aggressive");
  try {
    const prompt = renderPrompt(recDir, "plan-cuts.md", numbered, 42, "", {
      configMode: "safe",
      targetOutDurationSec: null,
    });
    assert.match(prompt, /冗長・重複・長い沈黙・脱線はためらわず切る/);
  } finally {
    rmSync(join(recDir, "brief.md"), { force: true });
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
