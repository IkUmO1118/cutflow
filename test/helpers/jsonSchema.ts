// テスト専用の vendored JSON Schema(draft 2020-12 の部分集合)バリデータ。
// docs/plans/2026-07-07-machine-contract-design.md §論点1 の決定:
// ajv 等の runtime 依存を足さず、schemas/ が使うキーワードだけを実装した
// 純関数にする(依存追加ゼロ)。対応キーワード: $ref / $defs / type / required /
// properties / additionalProperties / enum / const / pattern / items /
// oneOf / minimum / maximum / minItems。
//
// schemas/ 側はこの部分集合に意図的に収める(§論点1)。このファイル自体は
// test/helpers/jsonSchema.test.ts で固定する(自前ロジックなので必ず単体
// テストで固める)。

export interface JsonSchema {
  $id?: string;
  $schema?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

/** $ref(例 "common.schema.json#/$defs/id" / "#/$defs/Region")を解決して
 * 参照先の JsonSchema を返す関数。呼び出し側(test/schema.test.ts 等)が
 * スキーマ集合を知っているので、解決ロジックはそちら側に委ねる */
export type SchemaResolver = (ref: string) => JsonSchema;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (isObj(a) && isObj(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  return false;
}

function matchesType(data: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObj(data);
    case "array":
      return Array.isArray(data);
    case "string":
      return typeof data === "string";
    case "number":
      return typeof data === "number" && Number.isFinite(data);
    case "integer":
      return typeof data === "number" && Number.isInteger(data);
    case "boolean":
      return typeof data === "boolean";
    case "null":
      return data === null;
    default:
      return false;
  }
}

/**
 * data が schema(2020-12 の部分集合)に適合するかを検査し、違反メッセージの
 * 配列を返す(空配列 = valid)。resolve は $ref の解決に使う。
 */
export function validateAgainstSchema(
  data: unknown,
  schema: JsonSchema,
  resolve: SchemaResolver,
  path = "$",
): string[] {
  if (schema.$ref !== undefined) {
    return validateAgainstSchema(data, resolve(schema.$ref), resolve, path);
  }

  const errors: string[] = [];

  if (schema.oneOf !== undefined) {
    const passCount = schema.oneOf.filter(
      (s) => validateAgainstSchema(data, s, resolve, path).length === 0,
    ).length;
    if (passCount !== 1) {
      errors.push(`${path}: oneOf に ${passCount} 件マッチしました(ちょうど1件が必要)`);
    }
    return errors;
  }

  if (schema.const !== undefined && !deepEqual(data, schema.const)) {
    errors.push(`${path}: const と一致しません(期待: ${JSON.stringify(schema.const)}、実際: ${JSON.stringify(data)})`);
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, data))) {
    errors.push(`${path}: enum に含まれません(実際: ${JSON.stringify(data)})`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(`${path}: type 不一致(期待: ${types.join("|")}、実際: ${JSON.stringify(data)})`);
      return errors; // 型が違えば以降の構造検査は無意味
    }
  }

  if (schema.pattern !== undefined) {
    if (typeof data !== "string" || !new RegExp(schema.pattern).test(data)) {
      errors.push(`${path}: pattern(${schema.pattern})に一致しません(実際: ${JSON.stringify(data)})`);
    }
  }

  if (schema.minimum !== undefined && typeof data === "number" && data < schema.minimum) {
    errors.push(`${path}: minimum(${schema.minimum})未満です(実際: ${data})`);
  }
  if (schema.maximum !== undefined && typeof data === "number" && data > schema.maximum) {
    errors.push(`${path}: maximum(${schema.maximum})を超えています(実際: ${data})`);
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: minItems(${schema.minItems})未満です(実際: ${data.length}件)`);
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, resolve, `${path}[${i}]`));
      });
    }
  }

  if (isObj(data)) {
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (!(key in data)) errors.push(`${path}: required プロパティがありません: ${key}`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, value] of Object.entries(data)) {
        const sub = schema.properties[key];
        if (sub !== undefined) {
          errors.push(...validateAgainstSchema(value, sub, resolve, `${path}.${key}`));
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}: 未知のプロパティです: ${key}`);
        }
      }
    }
  }

  return errors;
}

/** JSON Pointer(例 "/$defs/id")をルートドキュメントから解決する */
export function resolveJsonPointer(doc: JsonSchema, pointer: string): JsonSchema {
  if (pointer === "" || pointer === "/") return doc;
  const segs = pointer.split("/").filter((s) => s.length > 0);
  let node: unknown = doc;
  for (const seg of segs) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(node)) throw new Error(`JSON pointer 解決失敗: ${pointer}`);
    node = node[key];
  }
  if (node === undefined) throw new Error(`JSON pointer 解決失敗: ${pointer}`);
  return node as JsonSchema;
}

/**
 * ファイル名 → JsonSchema のレジストリから SchemaResolver を作る。
 * $ref は "<file>#<pointer>"(他ファイル参照)または "#<pointer>"(自ファイル内)
 * の形を取る。currentFile は自ファイル参照の解決先。
 */
export function makeRegistryResolver(
  registry: Record<string, JsonSchema>,
  currentFile: string,
): SchemaResolver {
  return (ref: string) => {
    const hashIdx = ref.indexOf("#");
    const file = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
    const pointer = hashIdx === -1 ? "" : ref.slice(hashIdx + 1);
    const targetFile = file === "" ? currentFile : file;
    const doc = registry[targetFile];
    if (!doc) throw new Error(`未知のスキーマファイル参照です: ${ref}(登録済み: ${Object.keys(registry).join(", ")})`);
    return resolveJsonPointer(doc, pointer);
  };
}
