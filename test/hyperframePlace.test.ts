// buildPlacePatch(hyperframe-place の純パッチ組み立て)を固定する。
// fs/ffprobe には依存しない(hyperframePlace オーケストレータ本体は
// self-check の dry-run で確認する。単体テストは純関数だけを対象にする)。
//
// buildPlacePatch は overlaysExists の真偽で op の形を変える:
// - true  → 既存 overlays.json への `add`(schemas/apply-patch.schema.json の
//   AddOp。src/lib/applyEdits.ts の compileOps は add の対象ファイルが
//   ディスクに無いと拒否するため、add はあくまで追記専用)
// - false → overlays.json を新規作成する whole-file `replace`
//   (ApplyBody.overlays 全体を overlays.schema.json で検査できる形)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlacePatch } from "../src/stages/hyperframePlace.ts";
import { makeRegistryResolver, validateAgainstSchema } from "./helpers/jsonSchema.ts";
import type { JsonSchema } from "./helpers/jsonSchema.ts";

const SCHEMAS_DIR = join(import.meta.dirname, "..", "schemas");

/** apply-patch.schema.json の replace.overlays が $ref する overlays.schema.json
 * (さらにその rect が $ref する common.schema.json)まで含めたレジストリ。
 * test/schema.test.ts の loadRegistry と同じ組み立て方 */
function loadPatchSchemaRegistry(): Record<string, JsonSchema> {
  const registry: Record<string, JsonSchema> = {};
  registry["common.schema.json"] = JSON.parse(readFileSync(join(SCHEMAS_DIR, "common.schema.json"), "utf8"));
  registry["overlays.schema.json"] = JSON.parse(readFileSync(join(SCHEMAS_DIR, "overlays.schema.json"), "utf8"));
  registry["apply-patch.schema.json"] = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, "apply-patch.schema.json"), "utf8"),
  );
  return registry;
}

function assertPatchValid(patch: unknown): void {
  const registry = loadPatchSchemaRegistry();
  const schema = registry["apply-patch.schema.json"];
  const resolve = makeRegistryResolver(registry, "apply-patch.schema.json");
  const errs = validateAgainstSchema(patch, schema, resolve);
  assert.deepEqual(errs, [], `patch が invalid: ${errs.join("; ")}`);
}

/* ------------------------------------------------------------------ */
/* overlaysExists: true → add                                          */
/* ------------------------------------------------------------------ */

test("buildPlacePatch: overlay 既定・overlays.json あり(fade/rect/track/startFrom 省略)は add", () => {
  const patch = buildPlacePatch({ name: "intro", kind: "overlay", at: 10, durationSec: 4 }, true);
  assert.deepEqual(patch, {
    ops: [
      {
        op: "add",
        target: "overlays.overlays",
        value: {
          start: 10,
          end: 14,
          file: "materials/hyperframes/intro.mp4",
          fit: "contain",
          volume: 0,
        },
      },
    ],
  });
  assertPatchValid(patch);
});

test("buildPlacePatch: overlay は end === at + durationSec", () => {
  const patch = buildPlacePatch({ name: "x", kind: "overlay", at: 5.5, durationSec: 2.25 }, true);
  const op = patch.ops?.[0] as { value: { start: number; end: number } };
  assert.equal(op.value.start, 5.5);
  assert.equal(op.value.end, 7.75);
});

test("buildPlacePatch: insert・overlays.json あり は target overlays.inserts で at/durationSec を持ち start/end を持たない", () => {
  const patch = buildPlacePatch({ name: "outro", kind: "insert", at: 30, durationSec: 3 }, true);
  assert.deepEqual(patch, {
    ops: [
      {
        op: "add",
        target: "overlays.inserts",
        value: {
          at: 30,
          file: "materials/hyperframes/outro.mp4",
          durationSec: 3,
          fit: "contain",
          volume: 0,
        },
      },
    ],
  });
  const value = patch.ops?.[0] && "value" in patch.ops[0] ? (patch.ops[0].value as Record<string, unknown>) : {};
  assert.ok(!("start" in value));
  assert.ok(!("end" in value));
  assertPatchValid(patch);
});

/* ------------------------------------------------------------------ */
/* overlaysExists: false → replace(whole-file 新規作成)                  */
/* ------------------------------------------------------------------ */

test("buildPlacePatch: overlay・overlays.json 無し は replace で overlays.overlays を1件だけ作る", () => {
  const patch = buildPlacePatch({ name: "intro", kind: "overlay", at: 10, durationSec: 4 }, false);
  assert.deepEqual(patch, {
    replace: {
      overlays: {
        overlays: [
          {
            start: 10,
            end: 14,
            file: "materials/hyperframes/intro.mp4",
            fit: "contain",
            volume: 0,
          },
        ],
      },
    },
  });
  assertPatchValid(patch);
});

test("buildPlacePatch: insert・overlays.json 無し は replace で overlays.inserts を1件だけ作る", () => {
  const patch = buildPlacePatch({ name: "outro", kind: "insert", at: 30, durationSec: 3 }, false);
  assert.deepEqual(patch, {
    replace: {
      overlays: {
        inserts: [
          {
            at: 30,
            file: "materials/hyperframes/outro.mp4",
            durationSec: 3,
            fit: "contain",
            volume: 0,
          },
        ],
      },
    },
  });
  assertPatchValid(patch);
});

test("buildPlacePatch: replace 形でも rect/track/startFrom/fade は同じ value を持つ", () => {
  const patch = buildPlacePatch(
    {
      name: "a",
      kind: "overlay",
      at: 0,
      durationSec: 2,
      rect: { x: 10, y: 20, w: 300, h: 400 },
      track: 2,
      startFrom: 1.5,
      fadeSec: 0.5,
    },
    false,
  );
  const value = patch.replace?.overlays?.overlays?.[0] as unknown as Record<string, unknown>;
  assert.deepEqual(value.rect, { x: 10, y: 20, w: 300, h: 400 });
  assert.equal(value.track, 2);
  assert.equal(value.startFrom, 1.5);
  assert.equal(value.fadeInSec, 0.5);
  assert.equal(value.fadeOutSec, 0.5);
  assertPatchValid(patch);
});

/* ------------------------------------------------------------------ */
/* value の中身自体は overlaysExists に依存しない                         */
/* ------------------------------------------------------------------ */

test("buildPlacePatch: --fade は fadeInSec/fadeOutSec を両方セットする", () => {
  const patch = buildPlacePatch({ name: "a", kind: "overlay", at: 0, durationSec: 2, fadeSec: 0.5 }, true);
  const value = patch.ops?.[0] as { value: Record<string, unknown> };
  assert.equal(value.value.fadeInSec, 0.5);
  assert.equal(value.value.fadeOutSec, 0.5);
});

test("buildPlacePatch: fadeSec 省略/0 は fadeInSec/fadeOutSec を出さない", () => {
  const noFade = buildPlacePatch({ name: "a", kind: "overlay", at: 0, durationSec: 2 }, true);
  const zeroFade = buildPlacePatch({ name: "a", kind: "overlay", at: 0, durationSec: 2, fadeSec: 0 }, true);
  for (const patch of [noFade, zeroFade]) {
    const value = patch.ops?.[0] as { value: Record<string, unknown> };
    assert.ok(!("fadeInSec" in value.value));
    assert.ok(!("fadeOutSec" in value.value));
  }
});

test("buildPlacePatch: rect/track/startFrom は指定したときだけ出る(overlay)", () => {
  const withAll = buildPlacePatch(
    {
      name: "a",
      kind: "overlay",
      at: 0,
      durationSec: 2,
      rect: { x: 10, y: 20, w: 300, h: 400 },
      track: 2,
      startFrom: 1.5,
    },
    true,
  );
  const value = (withAll.ops?.[0] as { value: Record<string, unknown> }).value;
  assert.deepEqual(value.rect, { x: 10, y: 20, w: 300, h: 400 });
  assert.equal(value.track, 2);
  assert.equal(value.startFrom, 1.5);
  assertPatchValid(withAll);

  const without = buildPlacePatch({ name: "a", kind: "overlay", at: 0, durationSec: 2 }, true);
  const valueWithout = (without.ops?.[0] as { value: Record<string, unknown> }).value;
  assert.ok(!("rect" in valueWithout));
  assert.ok(!("track" in valueWithout));
  assert.ok(!("startFrom" in valueWithout));
});

test("buildPlacePatch: startFrom は指定したときだけ出る(insert)", () => {
  const withStart = buildPlacePatch({ name: "a", kind: "insert", at: 0, durationSec: 2, startFrom: 3 }, true);
  const value = (withStart.ops?.[0] as { value: Record<string, unknown> }).value;
  assert.equal(value.startFrom, 3);
  assertPatchValid(withStart);
});

test("buildPlacePatch: id/approved を一切出さない(add/replace どちらでも)", () => {
  for (const overlaysExists of [true, false]) {
    const overlay = buildPlacePatch({ name: "a", kind: "overlay", at: 0, durationSec: 2 }, overlaysExists);
    const insert = buildPlacePatch({ name: "a", kind: "insert", at: 0, durationSec: 2 }, overlaysExists);
    for (const patch of [overlay, insert]) {
      const value = overlaysExists
        ? (patch.ops?.[0] as { value: Record<string, unknown> }).value
        : ((patch.replace?.overlays?.overlays?.[0] ?? patch.replace?.overlays?.inserts?.[0]) as unknown as Record<
            string,
            unknown
          >);
      assert.ok(!("id" in value));
      assert.ok(!("approved" in value));
    }
  }
});
