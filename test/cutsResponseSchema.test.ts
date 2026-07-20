// P3-1(§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md §0.4 判断3・§8)。
// 穴B(応答スキーマが reasonId/keeps を構造的に禁止していた)を閉じたことの
// 単体テスト。実 LLM は一切呼ばない。
//
// I4: plan.reasonIds.enabled: false → provider へ渡る応答スキーマが
// 旧オブジェクトそのもの(参照同一性)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUTS_RESPONSE_SCHEMA,
  CUTS_RESPONSE_SCHEMA_REASON_IDS,
  cutsResponseSchema,
} from "../src/lib/cutsResponse.ts";
import { PLAN_RESPONSE_SCHEMA, PLAN_RESPONSE_SCHEMA_REASON_IDS, planResponseSchema } from "../src/stages/plan.ts";

/* ------------------------------------------------------------------ */
/* I4: 参照同一性                                                       */
/* ------------------------------------------------------------------ */

test("I4: cutsResponseSchema(false) は CUTS_RESPONSE_SCHEMA そのもの(参照同一性)", () => {
  assert.equal(cutsResponseSchema(false), CUTS_RESPONSE_SCHEMA);
});

test("I4: cutsResponseSchema(true) は CUTS_RESPONSE_SCHEMA_REASON_IDS そのもの(参照同一性)。旧定数とは別オブジェクト", () => {
  assert.equal(cutsResponseSchema(true), CUTS_RESPONSE_SCHEMA_REASON_IDS);
  assert.notEqual(cutsResponseSchema(true), CUTS_RESPONSE_SCHEMA);
});

test("I4: planResponseSchema(false) は PLAN_RESPONSE_SCHEMA そのもの(参照同一性)", () => {
  assert.equal(planResponseSchema(false), PLAN_RESPONSE_SCHEMA);
});

test("I4: planResponseSchema(true) は PLAN_RESPONSE_SCHEMA_REASON_IDS そのもの(参照同一性)。旧定数とは別オブジェクト", () => {
  assert.equal(planResponseSchema(true), PLAN_RESPONSE_SCHEMA_REASON_IDS);
  assert.notEqual(planResponseSchema(true), PLAN_RESPONSE_SCHEMA);
});

test("既存2定数は1バイトも変更されていない(strict:true・additionalProperties:false・reasonId 無し)", () => {
  assert.equal(CUTS_RESPONSE_SCHEMA.strict, true);
  assert.equal(CUTS_RESPONSE_SCHEMA.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(CUTS_RESPONSE_SCHEMA.schema.properties.cuts.items.properties), ["id", "reason"]);
  assert.equal(PLAN_RESPONSE_SCHEMA.strict, true);
  assert.equal(PLAN_RESPONSE_SCHEMA.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(PLAN_RESPONSE_SCHEMA.schema.properties.cuts.items.properties), ["id", "reason"]);
});

test("変種は strict:false で reasonId/keeps が任意フィールドとして足されている", () => {
  assert.equal(CUTS_RESPONSE_SCHEMA_REASON_IDS.strict, false);
  assert.deepEqual(CUTS_RESPONSE_SCHEMA_REASON_IDS.schema.required, ["cuts"]);
  assert.deepEqual(CUTS_RESPONSE_SCHEMA_REASON_IDS.schema.properties.cuts.items.required, ["id", "reason"]);
  assert.ok("reasonId" in CUTS_RESPONSE_SCHEMA_REASON_IDS.schema.properties.cuts.items.properties);
  assert.deepEqual(CUTS_RESPONSE_SCHEMA_REASON_IDS.schema.properties.keeps.items.required, [
    "id",
    "reasonId",
    "reason",
  ]);
  assert.equal(PLAN_RESPONSE_SCHEMA_REASON_IDS.strict, false);
  assert.deepEqual(PLAN_RESPONSE_SCHEMA_REASON_IDS.schema.required, ["cuts", "chapters", "titles", "description"]);
});

/* ------------------------------------------------------------------ */
/* 穴Bの実証: 最小の JSON Schema サブセット検証器で構造適合を判定する。
 * ここで使うキーワードは type/object/array/string/integer/required/
 * properties/additionalProperties だけ(このリポジトリの2定数が使う範囲)。
 * ajv 等の依存を増やさず、この検査専用にリポジトリ内で自己完結させる。   */
/* ------------------------------------------------------------------ */

type JsonSchemaNode = {
  type: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
};

function validates(value: unknown, node: JsonSchemaNode): boolean {
  if (node.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    for (const key of node.required ?? []) {
      if (!(key in obj)) return false;
    }
    if (node.additionalProperties === false) {
      const allowed = new Set(Object.keys(node.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) return false;
      }
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (key in obj && !validates(obj[key], child)) return false;
    }
    return true;
  }
  if (node.type === "array") {
    if (!Array.isArray(value)) return false;
    return node.items ? value.every((v) => validates(v, node.items!)) : true;
  }
  if (node.type === "string") return typeof value === "string";
  if (node.type === "integer") return Number.isInteger(value);
  return false;
}

const REASON_ID_RESPONSE = {
  cuts: [
    { id: 3, reason: "同じ説明の言い直し(前半)", reasonId: "restatement" },
    { id: 12, reason: "発話間の呼吸", reasonId: "gap-trim" },
  ],
  keeps: [{ id: 40, reasonId: "demo-wait", reason: "コマンド実行の結果待ち" }],
};

test("穴Bの実証: reasonId/keeps を含む応答は旧 CUTS_RESPONSE_SCHEMA では構造的に弾かれる(additionalProperties:false)", () => {
  assert.equal(validates(REASON_ID_RESPONSE, CUTS_RESPONSE_SCHEMA.schema as JsonSchemaNode), false);
});

test("穴Bの実証: 同じ応答は CUTS_RESPONSE_SCHEMA_REASON_IDS(cutsResponseSchema(true))を通る", () => {
  assert.equal(validates(REASON_ID_RESPONSE, cutsResponseSchema(true).schema as JsonSchemaNode), true);
});

test("穴Bの実証: 従来形式(reasonId/keeps 無し)は新旧どちらのスキーマも通る(後方互換)", () => {
  const legacy = { cuts: [{ id: 3, reason: "同じ説明の言い直し(前半)" }] };
  assert.equal(validates(legacy, CUTS_RESPONSE_SCHEMA.schema as JsonSchemaNode), true);
  assert.equal(validates(legacy, cutsResponseSchema(true).schema as JsonSchemaNode), true);
});

test("穴Bの実証: keeps の reasonId は必須(required)。欠けると変種スキーマでも弾かれる", () => {
  const bad = { cuts: [], keeps: [{ id: 1, reason: "理由のみ" }] };
  assert.equal(validates(bad, cutsResponseSchema(true).schema as JsonSchemaNode), false);
});

test("穴Bの実証: plan 本編(chapters/titles/description 込み)も同様に reasonId 付き応答が変種スキーマを通る", () => {
  const full = {
    cuts: [{ id: 3, reason: "脱線", reasonId: "tangent" }],
    keeps: [{ id: 1, reasonId: "hook", reason: "冒頭フック" }],
    chapters: [{ startId: 1, title: "今日やること" }],
    titles: ["タイトル案1"],
    description: "概要欄",
  };
  assert.equal(validates(full, PLAN_RESPONSE_SCHEMA.schema as JsonSchemaNode), false);
  assert.equal(validates(full, planResponseSchema(true).schema as JsonSchemaNode), true);
});
