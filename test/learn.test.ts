// stages/learn.ts の buildLearnPrompt(純関数)。
// renderPrompt の brief と同じ「関数形式 replaceAll」を使っていることの回帰:
// 本文に "$&" / "$1" 等の replace 特殊トークンが混じっても壊れないこと、
// 4プレースホルダが正しく埋まることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLearnPrompt } from "../src/stages/learn.ts";

const template = `# learn ステージ用プロンプト
# existingRules / priorGeneration / finalEdit / finalMeta が置換される

## 既にあるチャンネルルール(これと重複しない差分だけ提案する)

{{existingRules}}

## AI が最初に出した編集案(生成直後)

{{priorGeneration}}

## 人間が仕上げた最終状態(タイムライン要約)

{{finalEdit}}

## 人間が仕上げたタイトル・概要欄

{{finalMeta}}
`;

test("buildLearnPrompt: 4プレースホルダがすべて埋まる", () => {
  const out = buildLearnPrompt(template, {
    existingRules: "(まだチャンネルルールはありません)",
    priorGeneration: "AI の生応答テキスト",
    finalEdit: "describe() の要約テキスト",
    finalMeta: "タイトル案:\n1. サンプル\n\n概要欄:\nサンプル概要",
  });
  assert.doesNotMatch(out, /\{\{existingRules\}\}/);
  assert.doesNotMatch(out, /\{\{priorGeneration\}\}/);
  assert.doesNotMatch(out, /\{\{finalEdit\}\}/);
  assert.doesNotMatch(out, /\{\{finalMeta\}\}/);
  assert.match(out, /\(まだチャンネルルールはありません\)/);
  assert.match(out, /AI の生応答テキスト/);
  assert.match(out, /describe\(\) の要約テキスト/);
  assert.match(out, /タイトル案:\n1\. サンプル/);
});

test("buildLearnPrompt: 本文に $& / $1 等の replace 特殊トークンが混じっても壊れない", () => {
  const out = buildLearnPrompt(template, {
    existingRules: "価格は$&円です",
    priorGeneration: "$1つ目の案",
    finalEdit: "$$エスケープもどき",
    finalMeta: "$`前方一致もどき",
  });
  assert.match(out, /価格は\$&円です/);
  assert.match(out, /\$1つ目の案/);
  assert.match(out, /\$\$エスケープもどき/);
  assert.match(out, /\$`前方一致もどき/);
});

test("buildLearnPrompt: 同じプレースホルダが複数回出てきても全箇所置換される(replaceAll)", () => {
  const dup = "{{existingRules}} / {{existingRules}}";
  const out = buildLearnPrompt(dup, {
    existingRules: "ルール本文",
    priorGeneration: "",
    finalEdit: "",
    finalMeta: "",
  });
  assert.equal(out, "ルール本文 / ルール本文");
});
