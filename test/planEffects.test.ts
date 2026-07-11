import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEffectCheckWarnings, renderEffectsPrompt } from "../src/stages/planEffects.ts";
import type { EffectAnchor } from "../src/lib/effectAnchors.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cutflow-plan-effects-"));
}

const anchors: EffectAnchor[] = [
  { id: 1, start: 1, end: 2, source: "ocr", text: "hello", rect: { x: 0, y: 0, w: 10, h: 10 } },
];

test("renderEffectsPrompt: observation 省略と空文字はバイト等価", () => {
  const dir = tmpDir();
  try {
    const omitted = renderEffectsPrompt(dir, anchors);
    const explicitEmpty = renderEffectsPrompt(dir, anchors, "");
    assert.equal(omitted, explicitEmpty);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderEffectsPrompt: observation が非空のときだけ観測ブロックが追記される(base は不変)", () => {
  const dir = tmpDir();
  try {
    const base = renderEffectsPrompt(dir, anchors, "");
    const withObservation = renderEffectsPrompt(dir, anchors, "前回3件の演出警告がありました。");
    assert.ok(withObservation.startsWith(base));
    assert.notEqual(withObservation, base);
    assert.match(withObservation, /前回3件の演出警告がありました。/);
    assert.match(withObservation, /参考情報/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEffectCheckWarnings: effect-check.json が無ければ空配列(優雅な劣化)", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readEffectCheckWarnings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEffectCheckWarnings: effect-check.json の warnings をそのまま読む", () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      join(dir, "effect-check.json"),
      JSON.stringify({
        schemaVersion: 1,
        warnings: [{ kind: "density", startSec: 0, endSec: 5, message: "x" }],
      }),
    );
    const warnings = readEffectCheckWarnings(dir);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "density");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEffectCheckWarnings: 壊れた JSON は空配列(例外を投げない)", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, "effect-check.json"), "{not json");
    assert.deepEqual(readEffectCheckWarnings(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
