// lib/perception.ts — plan(カット判断LLM)へ音特徴(§4)を添える純関数群。
// 最重要不変条件: 既定オフ(audio/ocr 未使用)のとき renderPrompt の出力は
// perception 導入前と1バイトも変わらない(golden。test/rules.test.ts の
// 既存回帰ガードと合わせて二重に固定する)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAudioFeatures,
  formatAudio,
  renderPerceptionBlock,
} from "../src/lib/perception.ts";
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import type { Interval } from "../src/types.ts";

/* ---------------- computeAudioFeatures ---------------- */

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 5, text: "導入" },
  { id: 2, start: 7, end: 13, text: "本編" },
  { id: 3, start: 13, end: 20, text: "まとめ" },
];

test("computeAudioFeatures: 先頭区間の gapBefore は常に0", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].gapBefore, 0);
});

test("computeAudioFeatures: len は end-start", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].len, 5);
  assert.equal(features[1].len, 6);
  assert.equal(features[2].len, 7);
});

test("computeAudioFeatures: gapBefore は直前 keep との間の落ちた秒数", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[1].gapBefore, 2); // 5 → 7 の間に2秒落ちている
  assert.equal(features[2].gapBefore, 0); // 13 → 13 は連続(間なし)
});

test("computeAudioFeatures: silenceWithin は区間内の無音の overlap 積算(部分重なり含む)", () => {
  const silences: Interval[] = [
    { start: 4, end: 6 }, // #1(0-5)と1秒重なる、#2(7-13)とは重ならない
    { start: 10, end: 11 }, // #2 に完全に内包(1秒)
    { start: 19, end: 25 }, // #3(13-20)と1秒重なる(末尾が区間外)
  ];
  const features = computeAudioFeatures(numbered, silences);
  assert.equal(features[0].silenceWithin, 1);
  assert.equal(features[1].silenceWithin, 1);
  assert.equal(features[2].silenceWithin, 1);
});

test("computeAudioFeatures: 秒は小数第1位に丸める", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 1.23456, text: "" }];
  const features = computeAudioFeatures(seg, []);
  assert.equal(features[0].len, 1.2);
});

/* ---------------- formatAudio / renderPerceptionBlock ---------------- */

test("formatAudio: 見出しと #id 行を含む", () => {
  const text = formatAudio(computeAudioFeatures(numbered, []));
  assert.match(text, /^## 各区間の音の特徴/);
  assert.match(text, /#1 尺5\.0 \/ 直前カット0\.0 \/ 内無音0\.0/);
  assert.match(text, /#2 尺6\.0 \/ 直前カット2\.0 \/ 内無音0\.0/);
});

test("renderPerceptionBlock: audio も ocr も null → 空文字(不変条件の核)", () => {
  assert.equal(renderPerceptionBlock(null, null), "");
});

test("renderPerceptionBlock: audio が空配列でも空文字", () => {
  assert.equal(renderPerceptionBlock([], null), "");
});

test("renderPerceptionBlock: audio ありで先頭/末尾が改行、見出しと#idを含む", () => {
  const block = renderPerceptionBlock(computeAudioFeatures(numbered, []), null);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /#1 尺5\.0/);
});

test("renderPerceptionBlock: ocr 引数は現時点では常に未使用(null 以外を渡しても無視される)", () => {
  const block = renderPerceptionBlock(null, [{ id: 1, text: "何か" }]);
  assert.equal(block, "");
});

/* ---------------- バイト等価 golden(§9 不変条件1) ---------------- */

let recDir: string;
let channelDir: string;

before(() => {
  channelDir = mkdtempSync(join(tmpdir(), "cutflow-perception-"));
  recDir = join(channelDir, "2026-07-07-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

const numberedForPrompt: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "こんにちは" },
];
const BRIEF_DEFAULT = "(見せ場リストなし。カット判断基準に従って判断してください)";

test("renderPrompt: perception 省略時(既定オフ)は3テンプレとも brief 既定文の直後に見出しが隣接する(バイト等価 golden)", () => {
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42);
  assert.doesNotMatch(planPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planPrompt, /\{\{/); // プレースホルダの残骸が無い
  assert.match(
    planPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const planCutsPrompt = renderPrompt(recDir, "plan-cuts.md", numberedForPrompt, 42);
  assert.doesNotMatch(planCutsPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planCutsPrompt, /\{\{/);
  assert.match(
    planCutsPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const metaPrompt = renderPrompt(recDir, "meta.md", numberedForPrompt, 42);
  assert.doesNotMatch(metaPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(metaPrompt, /\{\{/);
  assert.match(metaPrompt, new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## 出力形式`));
});

test("renderPrompt: perception を渡すと {{rules}} の直後(区切りなし)に挿入される", () => {
  const perception = "\n## AI 向け知覚情報(発話以外の手掛かり)\n\nダミー\n";
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42, perception);
  assert.match(planPrompt, /ダミー\n\n## カットの判断基準/);
});

test("renderPrompt: 4引数呼び出し(plan-shorts 相当)は perception 省略でバイト等価", () => {
  const withDefault = renderPrompt(recDir, "plan-shorts.md", numberedForPrompt, 42);
  const withEmpty = renderPrompt(recDir, "plan-shorts.md", numberedForPrompt, 42, "");
  assert.equal(withDefault, withEmpty);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
