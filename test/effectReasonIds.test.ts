import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFECT_REASON_IDS,
  EFFECT_REASON_ID_DISCRIMINATOR,
  EFFECT_REASON_ID_FAMILY,
  EFFECT_REASON_ID_LABEL,
} from "../src/lib/effectReasonIds.ts";
import {
  renderEffectReasonIdsBlock,
  renderEffectReasonIdsOutputBlock,
} from "../src/lib/effectReasonIdInjection.ts";
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
