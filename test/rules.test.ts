// stages/plan.ts の rules 注入(renderRulesBlock / renderPrompt の {{rules}} 配線)。
// 最重要不変条件: rules ファイルが無いとき、renderPrompt の出力は rules 注入前と
// 完全一致すること(テンプレの空行を {{rules}} 行に置換しただけなので、
// {{rules}} が "" に replaceAll されると元の空行に戻る = 行数が増えない)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, renderRulesBlock } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";

const BRIEF_DEFAULT = "(見せ場リストなし。カット判断基準に従って判断してください)";
const numbered: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "こんにちは" }];

test("renderRulesBlock: 両方 null/空 は空文字(不変条件の核)", () => {
  assert.equal(renderRulesBlock(null, null), "");
  assert.equal(renderRulesBlock("", ""), "");
  assert.equal(renderRulesBlock("   ", null), "");
});

test("renderRulesBlock: channel のみ → channel 本文を含み先頭/末尾が改行", () => {
  const block = renderRulesBlock("ですます調で話す", null);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /チャンネル方針/);
  assert.match(block, /ですます調で話す/);
  assert.doesNotMatch(block, /この収録だけのルール/);
});

test("renderRulesBlock: recording のみ → recording 本文を含む", () => {
  const block = renderRulesBlock(null, "今回はゲスト回なので敬語を強める");
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /チャンネル方針/);
  assert.match(block, /今回はゲスト回なので敬語を強める/);
  assert.match(block, /この収録だけのルール/);
});

test("renderRulesBlock: 両方あり → channel → recording の順で並び precedence 注記を含む", () => {
  const block = renderRulesBlock("全収録共通の方針テキスト", "この回だけの例外テキスト");
  const iChannel = block.indexOf("全収録共通の方針テキスト");
  const iRecording = block.indexOf("この回だけの例外テキスト");
  assert.ok(iChannel >= 0 && iRecording >= 0);
  assert.ok(iChannel < iRecording, "channel が recording より前に来る");
  assert.match(block, /全収録共通のルール/);
  assert.match(block, /この収録だけのルール/);
  assert.match(block, /収録固有.*優先/);
});

test("renderRulesBlock: $& のような replace 特殊トークンが本文にあっても壊れない", () => {
  const block = renderRulesBlock("価格は$&円です", "$1も気をつけて");
  assert.match(block, /価格は\$&円です/);
  assert.match(block, /\$1も気をつけて/);
});

let channelDir: string;
let recDir: string;

before(() => {
  // channel = dirname(dir) をテストでも再現するため、channelDir 直下に
  // 収録フォルダ相当の recDir を作る(mkdtemp で一括作成・一括削除できる
  // ようスコープを channelDir にまとめる)
  channelDir = mkdtempSync(join(tmpdir(), "cutflow-rules-"));
  recDir = join(channelDir, "2026-07-07-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

test("renderPrompt: rules ファイル無しの4テンプレは「チャンネル方針」見出しが無く、brief 既定文と次見出しが隣接する(現状バイト等価の回帰ガード)", () => {
  const planPrompt = renderPrompt(recDir, "plan.md", numbered, 42);
  assert.doesNotMatch(planPrompt, /チャンネル方針/);
  assert.match(
    planPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const planCutsPrompt = renderPrompt(recDir, "plan-cuts.md", numbered, 42);
  assert.doesNotMatch(planCutsPrompt, /チャンネル方針/);
  assert.match(
    planCutsPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const metaPrompt = renderPrompt(recDir, "meta.md", numbered, 42);
  assert.doesNotMatch(metaPrompt, /チャンネル方針/);
  assert.match(metaPrompt, new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## 出力形式`));

  const shortsPrompt = renderPrompt(recDir, "plan-shorts.md", numbered, 42);
  assert.doesNotMatch(shortsPrompt, /チャンネル方針/);
  assert.match(shortsPrompt, /元の収録は 42 秒です。\n\n## ショートの選び方/);
});

test("renderPrompt: <channel>/rules.md を置くと出力にその本文が含まれる", () => {
  writeFileSync(join(channelDir, "rules.md"), "# 全チャンネル共通\nですます調を守る");
  try {
    const prompt = renderPrompt(recDir, "plan.md", numbered, 42);
    assert.match(prompt, /チャンネル方針/);
    assert.match(prompt, /ですます調を守る/);
    assert.doesNotMatch(prompt, /この収録だけのルール/);
  } finally {
    rmSync(join(channelDir, "rules.md"), { force: true });
  }
});

test("renderPrompt: <dir>/rules.md も置くと channel/recording 両方が含まれる", () => {
  writeFileSync(join(channelDir, "rules.md"), "# 全チャンネル共通\nですます調を守る");
  writeFileSync(join(recDir, "rules.md"), "# この回だけ\nゲスト敬称は「さん」");
  try {
    const prompt = renderPrompt(recDir, "plan.md", numbered, 42);
    assert.match(prompt, /チャンネル方針/);
    assert.match(prompt, /ですます調を守る/);
    assert.match(prompt, /この収録だけのルール/);
    assert.match(prompt, /ゲスト敬称は「さん」/);
  } finally {
    rmSync(join(channelDir, "rules.md"), { force: true });
    rmSync(join(recDir, "rules.md"), { force: true });
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
