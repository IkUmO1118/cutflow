// effect recipes / examples / pattern / blueprint の非腐敗ゲート(EP4)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EFFECT_REASON_IDS,
  EFFECT_REASON_ID_DISCRIMINATOR,
  EFFECT_REASON_ID_FAMILY,
  EFFECT_REASON_ID_LABEL,
} from "../src/lib/effectReasonIds.ts";
import {
  CUT_PATTERN_IDS,
  EFFECT_BLUEPRINT_BLOCKS,
  EFFECT_PATTERN_INJECTION,
} from "../src/lib/effectPatterns.ts";
import { renderEffectReasonIdsBlock } from "../src/lib/effectReasonIdInjection.ts";

const ROOT = join(import.meta.dirname, "..", "docs", "edit-skills");
const EFFECTS = join(ROOT, "effects");
const RECIPES = join(EFFECTS, "recipes");
const EXAMPLE = join(EFFECTS, "examples", "2026-07-12-tool-demo.md");

const recipe = (id: string): string => readFileSync(join(RECIPES, `${id}.md`), "utf8");
const jsonFences = (src: string): string[] => [...src.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
const section = (src: string, heading: string): string => {
  const start = src.indexOf(heading);
  assert.ok(start >= 0, `${heading} がありません`);
  const rest = src.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
};
const idsIn = (src: string): string[] => [...src.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);

test("effect skills: EFFECT_REASON_IDSとrecipeファイル名が7件で全単射", () => {
  const files = readdirSync(RECIPES).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.equal(EFFECT_REASON_IDS.length, 7);
  assert.deepEqual(files, [...EFFECT_REASON_IDS].sort());
});

const HEADINGS = [
  "## 一行定義",
  "## 判定シグナル",
  "### 語彙(transcript)",
  "### 座標(frames --ocr の box / av の motion 領域)",
  "### 画面(frames / OCR テキスト)",
  "### 時間・格子(アンカーの形)",
  "## 既定の型",
  "## 反例(この型を当てない場合)",
  "## 紛らわしい隣",
  "## worked example",
];

test("effect skills: 全recipeが固定見出しを順番どおり持つ", () => {
  for (const id of EFFECT_REASON_IDS) {
    const src = recipe(id);
    assert.ok(src.startsWith(`# ${id}\n`));
    let cursor = -1;
    for (const heading of HEADINGS) {
      const index = src.indexOf(`\n${heading}\n`, cursor);
      assert.ok(index > cursor, `${id}: ${heading} が順番どおりにありません`);
      cursor = index;
    }
  }
});

const GROUND = /^(実データ\(.+\)|rules\.md(\(.+\))?|想定(\(.+\))?|craft|観測: .+)$/;
test("effect skills: 接地行が許可語彙へ閉じる", () => {
  for (const id of EFFECT_REASON_IDS) {
    const match = recipe(id).match(/^> 接地: (.+)$/m);
    assert.ok(match, `${id}: 接地行がありません`);
    for (const token of match![1].split(/\s*[+·]\s*/).filter(Boolean)) {
      assert.match(token, GROUND, `${id}: 未知の接地語彙 ${token}`);
    }
  }
});

test("effect skills: 反例にJSON fenceがなく、worked JSONは閉包・family整合", () => {
  const expectedEffect = { zoom: "zoom", blur: "blur", annotation: "annotation", none: "none" } as const;
  for (const id of EFFECT_REASON_IDS) {
    const src = recipe(id);
    assert.equal(jsonFences(section(src, "## 反例(この型を当てない場合)")).length, 0);
    const fences = jsonFences(src);
    assert.ok(fences.length > 0, `${id}: worked JSONがありません`);
    for (const raw of fences) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(Object.keys(value).sort(), ["anchorId", "effect", "effectReasonId", "reason"]);
      assert.ok(EFFECT_REASON_IDS.includes(value.effectReasonId as typeof EFFECT_REASON_IDS[number]));
      assert.equal(value.effect, expectedEffect[EFFECT_REASON_ID_FAMILY[value.effectReasonId as typeof EFFECT_REASON_IDS[number]]]);
    }
  }
});

test("effect skills: 紛らわしい隣は7分類へ閉じ、孤立idがない", () => {
  const referenced = new Set<string>();
  for (const id of EFFECT_REASON_IDS) {
    const tokens = idsIn(section(recipe(id), "## 紛らわしい隣"));
    assert.ok(tokens.length > 0, `${id}: 隣接参照がありません`);
    for (const token of tokens) {
      assert.ok((EFFECT_REASON_IDS as readonly string[]).includes(token), `${id}: 未知の隣接id ${token}`);
      referenced.add(token);
    }
  }
  for (const id of EFFECT_REASON_IDS) assert.ok(referenced.has(id), `${id}: 孤立しています`);
});

test("effect skills: G2ペアは両recipeから双方向参照される", () => {
  for (const { a, b } of EFFECT_REASON_ID_DISCRIMINATOR) {
    assert.ok(idsIn(section(recipe(a), "## 紛らわしい隣")).includes(b));
    assert.ok(idsIn(section(recipe(b), "## 紛らわしい隣")).includes(a));
  }
});

test("effect skills: README 7分類表の一行定義がLABELと一致", () => {
  const src = readFileSync(join(EFFECTS, "README.md"), "utf8");
  const labels = new Map<string, string>();
  for (const match of src.matchAll(/^\| [^|]+ \| \[`([a-z][a-z0-9-]*)`\]\(recipes\/[a-z0-9-]+\.md\) \| (.+?) \| [^|]+ \|$/gm)) {
    labels.set(match[1], match[2]);
  }
  assert.deepEqual([...labels.keys()].sort(), [...EFFECT_REASON_IDS].sort());
  for (const id of EFFECT_REASON_IDS) assert.equal(labels.get(id), EFFECT_REASON_ID_LABEL[id]);
});

test("effect example: 判断JSONの見出し・id・familyが内部整合し、4zoom実測値と連鎖が一致", () => {
  const src = readFileSync(EXAMPLE, "utf8");
  assert.match(src, /effectReasonId[^\n]*導入前/);
  assert.match(src, /後付け分類した分析/);
  const expected = [
    [1, "tiny-target", 189.88, 194.16, 107, 57, 960, 540],
    [2, "focus-shift", 433.29, 445.32, 406, 426, 960, 540],
    [3, "focus-shift", 445.32, 454.80, 857, 0, 960, 540],
    [4, "tiny-target", 540.76, 552.15, 956, 20, 960, 540],
  ] as const;
  const entries = [...src.matchAll(
    /^### #(\d+) ([a-z][a-z0-9-]*)\n\n```text\n\[([0-9.]+)-([0-9.]+)\] rect \[([0-9]+),([0-9]+) ([0-9]+)x([0-9]+)\][\s\S]*?```\n\n```json\n([^\n]+)\n```/gm,
  )];
  assert.equal(entries.length, 4);
  entries.forEach((match, index) => {
    const actual = [
      Number(match[1]), match[2], Number(match[3]), Number(match[4]),
      Number(match[5]), Number(match[6]), Number(match[7]), Number(match[8]),
    ];
    assert.deepEqual(actual, [...expected[index]]);
    const decision = JSON.parse(match[9]) as Record<string, unknown>;
    assert.equal(decision.anchorId, expected[index][0]);
    assert.equal(decision.effectReasonId, expected[index][1]);
    assert.equal(decision.effect, "zoom");
  });
  assert.equal(expected[1][3], expected[2][2], "#2/#3は隣接連鎖");
  const coverage = new Map(
    [...src.matchAll(/^\| `([a-z][a-z0-9-]*)` \| (\d+) \|/gm)].map((match) => [match[1], Number(match[2])]),
  );
  assert.deepEqual(Object.fromEntries(coverage), {
    "tiny-target": 2,
    "focus-shift": 2,
    "secret-exposure": 0,
    "attention-scatter": 0,
  });
});

test("effect pattern/blueprint: 共有key・recipe/見出し閉包・8行/1600文字予算", () => {
  assert.deepEqual(Object.keys(EFFECT_PATTERN_INJECTION), [...CUT_PATTERN_IDS]);
  for (const pattern of CUT_PATTERN_IDS) {
    for (const id of EFFECT_PATTERN_INJECTION[pattern].recipes) assert.ok(EFFECT_REASON_IDS.includes(id));
    assert.ok(renderEffectReasonIdsBlock(true, pattern).length <= 1600);
  }
  const referenced = [...new Set(CUT_PATTERN_IDS.map((p) => EFFECT_PATTERN_INJECTION[p].blueprint).filter(Boolean))].sort();
  assert.deepEqual(Object.keys(EFFECT_BLUEPRINT_BLOCKS).sort(), referenced);
  const blueprints = readFileSync(join(ROOT, "blueprints.md"), "utf8");
  const headings = [...blueprints.matchAll(/^## `([a-z][a-z0-9-]*)`$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(headings, referenced);
  for (const id of referenced) assert.ok(EFFECT_BLUEPRINT_BLOCKS[id].length <= 8);
});
