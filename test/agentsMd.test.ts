// AGENTS_CONTRACT.md(リポジトリ直下・英語・Claude 非依存の機械可読契約)の列挙が、
// コード側の単一の出所と食い違ったら落ちるドリフト検知テスト
// (docs/plans/2026-07-07-machine-contract-design.md §論点6-d)。
// 散文の言い回しは検査せず、列挙の網羅だけを機械照合する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_FILE, GENERATED_FILES } from "../src/lib/files.ts";
import { ID_PREFIX } from "../src/lib/ids.ts";
import { APPLY_FILE_NAME } from "../src/lib/applyEdits.ts";

const ROOT = join(import.meta.dirname, "..");
const AGENTS_MD = readFileSync(join(ROOT, "AGENTS_CONTRACT.md"), "utf8");
const CLI_TS = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");

/** 8編集ファイルの一次資料(test/schema.test.ts と同じ導出。§理由はそちらの
 * コメント参照: files.ts の EDITABLE_FILES は plan/transcribe 再実行時の
 * backup 対象という狭い5件集合で、8編集ファイル全体の出所ではない) */
const EDITABLE_FILE_NAMES: string[] = [...Object.values(APPLY_FILE_NAME), "meta.json"];

/** src/cli.ts の `.command("<name> ...")` 登録から実際のコマンド名だけを
 * 抽出する(CLI 登録が単一の出所) */
function extractCliCommandNames(source: string): string[] {
  return [...source.matchAll(/\.command\("([a-zA-Z0-9-]+)/g)].map((m) => m[1]);
}

test("AGENTS_CONTRACT.md: 編集ファイル表が8編集ファイルを過不足なく含む", () => {
  for (const f of EDITABLE_FILE_NAMES) {
    assert.ok(AGENTS_MD.includes(`\`${f}\``), `${f} が AGENTS_CONTRACT.md に見つかりません`);
  }
});

test("AGENTS_CONTRACT.md: deny節がGENERATED_FILES + APPROVAL_FILEを過不足なく含む", () => {
  for (const f of GENERATED_FILES) {
    assert.ok(AGENTS_MD.includes(f), `${f}(GENERATED_FILES)が AGENTS_CONTRACT.md に見つかりません`);
  }
  assert.ok(AGENTS_MD.includes(APPROVAL_FILE), `${APPROVAL_FILE}(APPROVAL_FILE)が AGENTS_CONTRACT.md に見つかりません`);
});

test("AGENTS_CONTRACT.md: コマンド表がCLI登録の全コマンド名を過不足なく含む", () => {
  const names = extractCliCommandNames(CLI_TS);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(AGENTS_MD.includes(`| \`${name}`), `${name} が AGENTS_CONTRACT.md のコマンド表に見つかりません`);
  }
});

test("AGENTS_CONTRACT.md: id接頭辞節がID_PREFIXの全値を過不足なく含む", () => {
  const prefixes = Object.values(ID_PREFIX);
  assert.ok(prefixes.length > 0);
  for (const prefix of prefixes) {
    assert.ok(AGENTS_MD.includes(`\`${prefix}\``), `接頭辞 ${prefix} が AGENTS_CONTRACT.md に見つかりません`);
  }
});

test("AGENTS_CONTRACT.md: Claude固有語(claude -p / Claude Code)を持ち込まない", () => {
  assert.ok(!/claude -p/i.test(AGENTS_MD));
  assert.ok(!/Claude Code/.test(AGENTS_MD));
});
