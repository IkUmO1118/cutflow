import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeJson } from "../src/stages/describe.ts";
import { buildFirstEffectsPlan, writeFirstEffectsPlan } from "../src/lib/firstEffectsPlan.ts";
import { EFFECT_REASON_IDS, EFFECT_REASON_ID_FAMILY } from "../src/lib/effectReasonIds.ts";
import type { EffectAnchor, EffectDecision } from "../src/lib/effectAnchors.ts";

const makeDir = (): string => mkdtempSync(join(tmpdir(), "cutflow-effect-coverage-"));
const write = (dir: string, file: string, value: unknown): void =>
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2));

function base(dir: string, overlays: unknown = {}): void {
  write(dir, "manifest.json", {
    source: "raw.mkv",
    durationSec: 20,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-21T00:00:00Z",
  });
  write(dir, "cutplan.json", { approved: false, segments: [{ start: 0, end: 20, action: "keep", reason: "" }] });
  write(dir, "transcript.json", { language: "ja", model: "test", segments: [] });
  write(dir, "overlays.json", overlays);
}

test("legacy: effect reasonIdもfirst fileも無い旧収録はsummaryがdeepEqualで不変", () => {
  const dir = makeDir();
  try {
    base(dir, { zooms: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 960, h: 540 } }] });
    assert.deepEqual(describeJson(dir).summary, {
      approved: false,
      outDurationSec: 20,
      keptSec: 20,
      cutSec: 0,
      keepCount: 1,
      captionCount: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage/projection: 分母はzoom+blur+annotation、非none4分類を固定順0込みで集計", () => {
  const dir = makeDir();
  try {
    base(dir, {
      zooms: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 960, h: 540 }, reasonId: "tiny-target" }],
      blurs: [{ start: 3, end: 4, rect: { x: 1, y: 1, w: 10, h: 10 }, reasonId: "secret-exposure" }],
      annotations: [
        { type: "box", start: 5, end: 6, rect: { x: 2, y: 2, w: 20, h: 20 }, reasonId: "attention-scatter" },
        { type: "box", start: 7, end: 8, rect: { x: 3, y: 3, w: 30, h: 30 } },
      ],
    });
    const projection = describeJson(dir);
    assert.equal(projection.overlays.zooms[0].reasonId, "tiny-target");
    assert.equal(projection.overlays.blurs[0].reasonId, "secret-exposure");
    assert.equal(projection.overlays.annotations[0].reasonId, "attention-scatter");
    assert.equal("reasonId" in projection.overlays.annotations[1], false);
    const coverage = projection.summary.effectReasonIds!.coverage;
    assert.deepEqual(coverage, {
      effects: 4,
      labeled: 3,
      ratio: 0.75,
      byId: { "tiny-target": 1, "focus-shift": 0, "secret-exposure": 1, "attention-scatter": 1 },
    });
    assert.deepEqual(
      Object.keys(coverage.byId),
      EFFECT_REASON_IDS.filter((id) => EFFECT_REASON_ID_FAMILY[id] !== "none"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firstVsFinal: 元秒join・0.01未満許容・重複consume・rect無視・none遷移・addedを集計", () => {
  const dir = makeDir();
  try {
    base(dir, {
      blurs: [{ start: 5, end: 6, rect: { x: 999, y: 999, w: 1, h: 1 } }],
      zooms: [
        { start: 7.005, end: 8.005, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { start: 11, end: 12, rect: { x: 0, y: 0, w: 1, h: 1 } },
      ],
      annotations: [
        { type: "box", start: 3, end: 4, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { type: "box", start: 5, end: 6, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { type: "box", start: 15, end: 16, rect: { x: 0, y: 0, w: 1, h: 1 } },
      ],
    });
    write(dir, "plan-effects.first.json", {
      schemaVersion: 1,
      writtenAt: "2026-07-21T00:00:00.000Z",
      source: "plan-effects",
      effectReasonIdsEnabled: true,
      pattern: "tool-demo",
      anchorCount: 8,
      generated: {
        zooms: [
          { start: 1, end: 2, rect: { x: 10, y: 10, w: 100, h: 100 }, reasonId: "tiny-target" },
          { start: 17, end: 18, rect: { x: 30, y: 30, w: 300, h: 300 }, reasonId: "tiny-target" },
          { start: 13, end: 14, rect: { x: 10, y: 10, w: 100, h: 100 } },
        ],
        blurs: [
          { start: 3, end: 4, rect: { x: 10, y: 10, w: 100, h: 100 }, reasonId: "secret-exposure" },
        ],
        annotations: [
          { type: "box", start: 5, end: 6, rect: { x: 10, y: 10, w: 100, h: 100 } },
          {
            type: "box",
            start: 5,
            end: 6,
            rect: { x: 20, y: 20, w: 200, h: 200 },
            reasonId: "attention-scatter",
          },
        ],
      },
      none: [
        { anchorId: 5, start: 7, end: 8, effectReasonId: "already-legible", reason: "読める" },
        { anchorId: 6, start: 9, end: 10, effectReasonId: "concept-talk", reason: "概念" },
      ],
    });
    assert.deepEqual(describeJson(dir).summary.effectReasonIds!.firstVsFinal, {
      source: "plan-effects",
      effectReasonIdsEnabled: true,
      pattern: "tool-demo",
      compared: 8,
      flipped: 6,
      rate: 0.75,
      transitions: [
        { effectReasonId: "tiny-target", from: "zoom", to: "none", count: 2 },
        { effectReasonId: "secret-exposure", from: "blur", to: "annotation", count: 1 },
        { effectReasonId: "attention-scatter", from: "annotation", to: "blur", count: 1 },
        { effectReasonId: "already-legible", from: "none", to: "zoom", count: 1 },
        { from: "zoom", to: "none", count: 1 },
      ],
      added: [
        { effect: "zoom", count: 1 },
        { effect: "annotation", count: 1 },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broken first: malformed/構造不正ともcoverageは出すがfirstVsFinalを省略する", () => {
  const dir = makeDir();
  try {
    base(dir);
    writeFileSync(join(dir, "plan-effects.first.json"), "{broken");
    for (const summary of [describeJson(dir).summary, (() => {
      write(dir, "plan-effects.first.json", { schemaVersion: 1, source: "plan-effects" });
      return describeJson(dir).summary;
    })()]) {
      assert.ok(summary.effectReasonIds);
      assert.equal(summary.effectReasonIds!.coverage.effects, 0);
      assert.equal("firstVsFinal" in summary.effectReasonIds!, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firstEffectsPlan: generatedを正規化しvalid noneを上限内にしてwrite-once", () => {
  const dir = makeDir();
  try {
    const anchors: EffectAnchor[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      start: index,
      end: index + 0.5,
      ...(index % 2 === 0 ? { rect: { x: index, y: index, w: 10, h: 10 } } : {}),
      source: "ocr",
      text: `a${index}`,
    }));
    const decisions: EffectDecision[] = [
      { anchorId: 999, effect: "none", reason: "invalid" },
      ...Array.from({ length: 20 }, (_, index): EffectDecision => ({
        anchorId: index + 1,
        effect: "none",
        effectReasonId: "already-legible",
        reason: `none${index}`,
      })),
    ];
    const payload = buildFirstEffectsPlan({
      effectReasonIdsEnabled: true,
      pattern: "general",
      anchors,
      decisions,
      generated: {},
      now: () => new Date("2026-07-21T01:02:03.000Z"),
    });
    assert.equal(payload.source, "plan-effects");
    assert.equal(payload.writtenAt, "2026-07-21T01:02:03.000Z");
    assert.deepEqual(payload.generated, { zooms: [], blurs: [], annotations: [] });
    assert.equal(payload.none.length, 12);
    assert.equal(payload.none[0].anchorId, 1);
    assert.equal(payload.none[0].effectReasonId, "already-legible");
    assert.equal("reasonId" in payload.none[0], false);
    assert.deepEqual(payload.none[0].rect, { x: 0, y: 0, w: 10, h: 10 });

    writeFileSync(join(dir, "plan-effects.first.json"), "{broken");
    writeFirstEffectsPlan(dir, payload);
    assert.equal(readFileSync(join(dir, "plan-effects.first.json"), "utf8"), "{broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
