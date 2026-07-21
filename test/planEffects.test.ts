import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEffectCheckWarnings,
  renderEffectsPrompt,
  resolveEffectReasonIdInjection,
  planEffects,
} from "../src/stages/planEffects.ts";
import { renderEffectReasonIdsBlock, renderEffectReasonIdsOutputBlock } from "../src/lib/effectReasonIdInjection.ts";
import type { EffectAnchor } from "../src/lib/effectAnchors.ts";
import type { Config } from "../src/lib/config.ts";

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

test("renderEffectsPrompt: reasonIds offの空blockは導入前とバイト等価、onだけ分類+出力例を追記", () => {
  const dir = tmpDir();
  try {
    const before = renderEffectsPrompt(dir, anchors, "");
    const off = renderEffectsPrompt(
      dir,
      anchors,
      "",
      renderEffectReasonIdsBlock(false),
      renderEffectReasonIdsOutputBlock(false),
    );
    assert.equal(off, before);
    const on = renderEffectsPrompt(
      dir,
      anchors,
      "",
      renderEffectReasonIdsBlock(true),
      renderEffectReasonIdsOutputBlock(true),
    );
    assert.ok(on.startsWith(before));
    assert.match(on, /## 演出判断の分類\(effectReasonId\)/);
    assert.match(on, /"effectReasonId": "tiny-target"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planEffects: resolveReasonIdsCfgのpatternを演出注入へ伝播する", () => {
  const general = resolveEffectReasonIdInjection({
    plan: { reasonIds: { enabled: true, pattern: "general" } },
  } as Config);
  const toolDemo = resolveEffectReasonIdInjection({
    plan: { reasonIds: { enabled: true, pattern: "tool-demo" } },
  } as Config);

  assert.equal(general.pattern, "general");
  assert.equal(toolDemo.pattern, "tool-demo");
  assert.doesNotMatch(general.block, /この収録は画面が主役です/);
  assert.match(toolDemo.block, /この収録は画面が主役です/);
  assert.match(toolDemo.block, /tool-demo-arc/);
  assert.equal(toolDemo.outputBlock, general.outputBlock);
});

function buildPlanEffectsFixture(dir: string): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    source: "raw.mkv",
    durationSec: 20,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-21T00:00:00Z",
  }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify({
    approved: false,
    segments: [{ start: 0, end: 20, action: "keep", reason: "" }],
  }));
  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ language: "ja", model: "test", segments: [] }));
  writeFileSync(join(dir, "overlays.json"), "{}");
  mkdirSync(join(dir, "frames"), { recursive: true });
  writeFileSync(join(dir, "frames", "out5s.ocr.json"), JSON.stringify({
    sourceSec: 5,
    lines: [{ text: "small target", box: { x: 100, y: 100, w: 600, h: 300 } }],
  }));
}

const classifiedResponse = JSON.stringify({
  decisions: [
    { anchorId: 2, effect: "zoom", effectReasonId: "tiny-target", reason: "small" },
    { anchorId: 1, effect: "none", effectReasonId: "concept-talk", reason: "intro" },
  ],
});

test("planEffects: validate成功後にdeterministic変換済み初版をwrite-once保存する", async () => {
  const dir = tmpDir();
  try {
    buildPlanEffectsFixture(dir);
    const cfg = { plan: { reasonIds: { enabled: true, pattern: "tool-demo" } } } as Config;
    await planEffects(dir, cfg, { complete: async () => classifiedResponse });
    const first = JSON.parse(readFileSync(join(dir, "plan-effects.first.json"), "utf8"));
    assert.equal(first.source, "plan-effects");
    assert.equal(first.effectReasonIdsEnabled, true);
    assert.equal(first.pattern, "tool-demo");
    assert.equal(first.generated.zooms.length, 1);
    assert.equal(first.generated.zooms[0].reasonId, "tiny-target");
    assert.equal(first.none.length, 1);
    assert.equal(first.none[0].effectReasonId, "concept-talk");
    assert.equal("reasonId" in first.none[0], false);

    writeFileSync(join(dir, "plan-effects.first.json"), "{broken existing");
    await planEffects(dir, cfg, { complete: async () => classifiedResponse });
    assert.equal(readFileSync(join(dir, "plan-effects.first.json"), "utf8"), "{broken existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planEffects: validate失敗時はoverlaysもplan-effects.first.jsonも作らない", async () => {
  const dir = tmpDir();
  try {
    buildPlanEffectsFixture(dir);
    const overlaysPath = join(dir, "overlays.json");
    const before = JSON.parse(readFileSync(overlaysPath, "utf8"));
    before.colorFilter = { brightness: 4 };
    writeFileSync(overlaysPath, JSON.stringify(before, null, 2));
    const beforeBytes = readFileSync(overlaysPath, "utf8");
    const cfg = { plan: { reasonIds: { enabled: true, pattern: "general" } } } as Config;
    await assert.rejects(
      planEffects(dir, cfg, { complete: async () => classifiedResponse }),
      /生成した演出が検査に失敗/,
    );
    assert.equal(readFileSync(overlaysPath, "utf8"), beforeBytes);
    assert.equal(existsSync(join(dir, "plan-effects.first.json")), false);
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
