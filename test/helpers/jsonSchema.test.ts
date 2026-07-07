// test/helpers/jsonSchema.ts(vendored JSON Schema 部分集合バリデータ)の
// 単体テスト。以降の test/schema.test.ts 全体の土台になる自前ロジックなので、
// キーワードごとに最小ケースで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeRegistryResolver,
  resolveJsonPointer,
  validateAgainstSchema,
} from "./jsonSchema.ts";
import type { JsonSchema } from "./jsonSchema.ts";

const noRef = (): JsonSchema => {
  throw new Error("この検査では $ref を解決しない");
};

test("type: 期待どおりの型は valid", () => {
  assert.deepEqual(validateAgainstSchema("x", { type: "string" }, noRef), []);
  assert.deepEqual(validateAgainstSchema(1, { type: "number" }, noRef), []);
  assert.deepEqual(validateAgainstSchema(true, { type: "boolean" }, noRef), []);
  assert.deepEqual(validateAgainstSchema([], { type: "array" }, noRef), []);
  assert.deepEqual(validateAgainstSchema({}, { type: "object" }, noRef), []);
});

test("type: 不一致は1件のエラー", () => {
  const errs = validateAgainstSchema(1, { type: "string" }, noRef);
  assert.equal(errs.length, 1);
});

test("type: integer は非整数を弾く", () => {
  assert.deepEqual(validateAgainstSchema(3, { type: "integer" }, noRef), []);
  assert.equal(validateAgainstSchema(3.5, { type: "integer" }, noRef).length, 1);
});

test("required: 欠落プロパティを検出する", () => {
  const schema: JsonSchema = { type: "object", required: ["a", "b"] };
  assert.deepEqual(validateAgainstSchema({ a: 1, b: 2 }, schema, noRef), []);
  const errs = validateAgainstSchema({ a: 1 }, schema, noRef);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /required.*: b/);
});

test("properties: 各プロパティを再帰検査する", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
  };
  assert.deepEqual(validateAgainstSchema({ a: 1, b: "x" }, schema, noRef), []);
  const errs = validateAgainstSchema({ a: "x", b: "y" }, schema, noRef);
  assert.equal(errs.length, 1);
});

test("additionalProperties:false は未知キーを検出する", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: false,
  };
  assert.deepEqual(validateAgainstSchema({ a: 1 }, schema, noRef), []);
  const errs = validateAgainstSchema({ a: 1, z: 2 }, schema, noRef);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /未知のプロパティ.*z/);
});

test("additionalProperties 未指定は未知キーを許容する", () => {
  const schema: JsonSchema = { type: "object", properties: { a: { type: "number" } } };
  assert.deepEqual(validateAgainstSchema({ a: 1, z: 2 }, schema, noRef), []);
});

test("enum: 許可リスト外を検出する", () => {
  const schema: JsonSchema = { enum: ["blur", "mosaic"] };
  assert.deepEqual(validateAgainstSchema("blur", schema, noRef), []);
  assert.equal(validateAgainstSchema("glow", schema, noRef).length, 1);
});

test("const: 判別子フィールドの固定値を検出する", () => {
  const schema: JsonSchema = { const: "arrow" };
  assert.deepEqual(validateAgainstSchema("arrow", schema, noRef), []);
  assert.equal(validateAgainstSchema("box", schema, noRef).length, 1);
});

test("pattern: 正規表現不一致を検出する", () => {
  const schema: JsonSchema = { type: "string", pattern: "^[a-z]{2,3}_[0-9a-z]{6}$" };
  assert.deepEqual(validateAgainstSchema("seg_a1b2c3", schema, noRef), []);
  assert.equal(validateAgainstSchema("not-an-id", schema, noRef).length, 1);
});

test("minimum/maximum: 範囲外を検出する", () => {
  const schema: JsonSchema = { type: "number", minimum: 0, maximum: 1 };
  assert.deepEqual(validateAgainstSchema(0.5, schema, noRef), []);
  assert.equal(validateAgainstSchema(-0.1, schema, noRef).length, 1);
  assert.equal(validateAgainstSchema(1.1, schema, noRef).length, 1);
});

test("items/minItems: 配列要素と最小件数を検査する", () => {
  const schema: JsonSchema = { type: "array", minItems: 1, items: { type: "string" } };
  assert.deepEqual(validateAgainstSchema(["a", "b"], schema, noRef), []);
  assert.equal(validateAgainstSchema([], schema, noRef).length, 1);
  assert.equal(validateAgainstSchema([1], schema, noRef).length, 1);
});

test("oneOf: discriminated union で1件だけマッチすることを要求する", () => {
  const schema: JsonSchema = {
    oneOf: [
      { type: "object", properties: { type: { const: "arrow" } }, required: ["type"] },
      { type: "object", properties: { type: { const: "box" } }, required: ["type"] },
    ],
  };
  assert.deepEqual(validateAgainstSchema({ type: "arrow" }, schema, noRef), []);
  assert.deepEqual(validateAgainstSchema({ type: "box" }, schema, noRef), []);
  assert.equal(validateAgainstSchema({ type: "spotlight" }, schema, noRef).length, 1);
});

test("$ref: 自ファイル内の $defs を解決する", () => {
  const doc: JsonSchema = {
    $defs: { Pos: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } },
  };
  const resolve = makeRegistryResolver({ "self.schema.json": doc }, "self.schema.json");
  const schema: JsonSchema = { $ref: "#/$defs/Pos" };
  assert.deepEqual(validateAgainstSchema({ x: 1, y: 2 }, schema, resolve), []);
  assert.equal(validateAgainstSchema({ x: "1", y: 2 }, schema, resolve).length, 1);
});

test("$ref: 他ファイルの $defs を解決する(common.schema.json 相当)", () => {
  const common: JsonSchema = {
    $defs: { id: { type: "string", pattern: "^[a-z]{2,3}_[0-9a-z]{6}$" } },
  };
  const user: JsonSchema = { type: "object", properties: { id: { $ref: "common.schema.json#/$defs/id" } } };
  const registry = { "common.schema.json": common, "user.schema.json": user };
  const resolve = makeRegistryResolver(registry, "user.schema.json");
  assert.deepEqual(validateAgainstSchema({ id: "seg_a1b2c3" }, user, resolve), []);
  assert.equal(validateAgainstSchema({ id: "bad" }, user, resolve).length, 1);
});

test("resolveJsonPointer: ネストしたパスを解決する", () => {
  const doc: JsonSchema = { $defs: { A: { properties: { b: { type: "string" } } } } };
  const node = resolveJsonPointer(doc, "/$defs/A/properties/b");
  assert.deepEqual(node, { type: "string" });
});

test("resolveJsonPointer: 空/ルートポインタはドキュメント自体を返す", () => {
  const doc: JsonSchema = { type: "object" };
  assert.equal(resolveJsonPointer(doc, ""), doc);
  assert.equal(resolveJsonPointer(doc, "/"), doc);
});
