import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EFFECT_REASON_IDS,
  EFFECT_REASON_ID_DISCRIMINATOR,
  EFFECT_REASON_ID_FAMILY,
  EFFECT_REASON_ID_LABEL,
} from "../src/lib/effectReasonIds.ts";
import {
  effectReasonIdDiscriminatorLines,
  renderEffectReasonIdsBlock,
  renderEffectReasonIdsOutputBlock,
} from "../src/lib/effectReasonIdInjection.ts";
import {
  CUT_PATTERN_IDS,
  EFFECT_BLUEPRINT_BLOCKS,
  EFFECT_PATTERN_INJECTION,
} from "../src/lib/effectPatterns.ts";
import { renderReasonIdsBlock } from "../src/lib/reasonIdInjection.ts";
import {
  PLAN_EFFECTS_RESPONSE_SCHEMA,
  PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS,
  planEffectsResponseSchema,
} from "../src/stages/planEffects.ts";

test("effectReasonIds: 7分類のfamily/labelが全単射でdiscriminatorが閉じる", () => {
  assert.equal(EFFECT_REASON_IDS.length, 7);
  assert.deepEqual(Object.keys(EFFECT_REASON_ID_FAMILY), [...EFFECT_REASON_IDS]);
  assert.deepEqual(Object.keys(EFFECT_REASON_ID_LABEL), [...EFFECT_REASON_IDS]);
  for (const pair of EFFECT_REASON_ID_DISCRIMINATOR) {
    assert.ok(EFFECT_REASON_IDS.includes(pair.a));
    assert.ok(EFFECT_REASON_IDS.includes(pair.b));
    assert.match(pair.discriminator, /^弁別子は/);
  }
});

test("effectReasonId injection: offは空文字、onは7 id・G2・none上限を含む", () => {
  assert.equal(renderEffectReasonIdsBlock(false), "");
  assert.equal(renderEffectReasonIdsOutputBlock(false), "");
  const block = renderEffectReasonIdsBlock(true);
  for (const id of EFFECT_REASON_IDS) assert.match(block, new RegExp(`- ${id} —`));
  assert.match(block, /tiny-target ↔ already-legible/);
  assert.match(block, /attention-scatter ↔ motion-carries/);
  assert.match(block, /max\(12, ceil\(アンカー数の10%\)\)/);
  assert.match(renderEffectReasonIdsOutputBlock(true), /"effectReasonId": "tiny-target"/);
});

test("effect patterns: key集合は共有CUT_PATTERN_IDSと一致し、recipeは7分類へ閉じる", () => {
  assert.deepEqual(Object.keys(EFFECT_PATTERN_INJECTION), [...CUT_PATTERN_IDS]);
  for (const pattern of CUT_PATTERN_IDS) {
    for (const recipe of EFFECT_PATTERN_INJECTION[pattern].recipes) {
      assert.ok(EFFECT_REASON_IDS.includes(recipe), `${pattern} に未知のeffect recipe ${recipe}があります`);
    }
  }
});

test("effect patterns: generalはEP2の全7分類注入とバイト等価、tool-demoも安全/G2閉包を保つ", () => {
  assert.deepEqual(EFFECT_PATTERN_INJECTION.general.recipes, EFFECT_REASON_IDS);
  assert.deepEqual(EFFECT_PATTERN_INJECTION["tool-demo"].recipes, EFFECT_REASON_IDS);
  assert.equal(renderEffectReasonIdsBlock(true, "general"), renderEffectReasonIdsBlock(true));
  assert.equal(
    createHash("md5").update(renderEffectReasonIdsBlock(true, "general")).digest("hex"),
    "4562c718446ad229b937fcc3ba5aa848",
  );
  const toolDemo = renderEffectReasonIdsBlock(true, "tool-demo");
  assert.match(toolDemo, /秘匿情報は区間に関わらず blur を優先/);
  assert.match(toolDemo, /## この収録の演出の流れ\(tool-demo-arc\)/);
  for (const id of EFFECT_REASON_IDS) assert.match(toolDemo, new RegExp(`- ${id} —`));
});

test("effect discriminator: G2対比はrecipeの両側があるときだけ注入する", () => {
  assert.equal(effectReasonIdDiscriminatorLines(["tiny-target"]).length, 0);
  assert.deepEqual(effectReasonIdDiscriminatorLines(["tiny-target", "already-legible"]), [
    `- tiny-target ↔ already-legible — ${EFFECT_REASON_ID_DISCRIMINATOR[0].discriminator}`,
  ]);
  assert.equal(effectReasonIdDiscriminatorLines(["attention-scatter"]).length, 0);
  assert.match(
    effectReasonIdDiscriminatorLines(["attention-scatter", "motion-carries"])[0],
    /attention-scatter ↔ motion-carries/,
  );
});

test("effect blueprint: 参照id・block key・blueprints.md見出しが全単射", () => {
  const referenced = [...new Set(
    CUT_PATTERN_IDS.map((pattern) => EFFECT_PATTERN_INJECTION[pattern].blueprint).filter((id) => id !== ""),
  )].sort();
  assert.deepEqual(Object.keys(EFFECT_BLUEPRINT_BLOCKS).sort(), referenced);

  const docs = readFileSync(new URL("../docs/edit-skills/blueprints.md", import.meta.url), "utf8");
  const headings = [...docs.matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(headings, referenced);
  for (const id of referenced) {
    assert.match(EFFECT_BLUEPRINT_BLOCKS[id][0], new RegExp(`\\(${id}\\)$`));
  }
});

test("effect injection: 全patternが1600文字以内、cut側の既知注入は不変", () => {
  for (const pattern of CUT_PATTERN_IDS) {
    const block = renderEffectReasonIdsBlock(true, pattern);
    assert.ok(block.length <= 1600, `${pattern} の注入が文字予算を超過: ${block.length}`);
  }
  assert.equal(
    createHash("md5").update(renderReasonIdsBlock(true, "general")).digest("hex"),
    "732d4a2f06550ce0b48693fafbfe77b3",
  );
});

test("response schema: offは旧object参照そのもの、onはstrict+7 enum必須", () => {
  assert.equal(planEffectsResponseSchema(false), PLAN_EFFECTS_RESPONSE_SCHEMA);
  assert.equal(planEffectsResponseSchema(true), PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS);
  assert.equal(PLAN_EFFECTS_RESPONSE_SCHEMA.strict, true);
  assert.deepEqual(
    PLAN_EFFECTS_RESPONSE_SCHEMA.schema.properties.decisions.items.required,
    ["anchorId", "effect", "reason"],
  );
  assert.equal(PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS.strict, true);
  assert.ok(
    PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS.schema.properties.decisions.items.required.includes("effectReasonId"),
  );
  assert.deepEqual(
    PLAN_EFFECTS_RESPONSE_SCHEMA_REASON_IDS.schema.properties.decisions.items.properties.effectReasonId.enum,
    EFFECT_REASON_IDS,
  );
});
