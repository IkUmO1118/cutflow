// stages/bootstrap.ts が動画だけの収録フォルダに書く初期 transcript /
// cutplan が、stages/validate.ts の検査(validateDocs)を通ることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTranscript, initialCutplan } from "../src/stages/bootstrap.ts";
import { validateDocs } from "../src/stages/validate.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

const DIR = "/tmp/cutflow-test";

function baseDocs(over: Partial<LoadedDocs> = {}): LoadedDocs {
  return {
    manifest: { durationSec: 100 },
    cutplan: initialCutplan(100),
    transcript: emptyTranscript(),
    overlays: {},
    bgm: null,
    chapters: null,
    meta: null,
    shorts: null,
    thumbnail: null,
    ...over,
  };
}

test("初期 transcript(空)は validateDocs を通る", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
});

test("初期 cutplan(全編 keep)は validateDocs を通る", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
  assert.equal(initialCutplan(100).segments[0].end, 100);
  assert.equal(initialCutplan(100).approved, false);
});
