// src/lib/firstPlan.ts — plan.first.json(§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md
// §5・P5-1)の型・純関数・write-once の単体テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFirstPlan, writeFirstPlan } from "../src/lib/firstPlan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 3.5, text: "こんにちは" },
  { id: 2, start: 3.5, end: 7.25, text: "本題です" },
  { id: 3, start: 7.25, end: 12, text: "脱線" },
];

test("buildFirstPlan: cuts/keeps に元秒(start/end)を併記し、存在しない id は無視する", () => {
  const fp = buildFirstPlan({
    source: "plan --cuts-only",
    reasonIdsEnabled: true,
    pattern: "tool-demo",
    numbered,
    cuts: [
      { id: 3, reason: "脱線", reasonId: "tangent" },
      { id: 999, reason: "存在しない候補" },
    ],
    keeps: [{ id: 1, reasonId: "hook", reason: "冒頭フック" }],
    now: () => new Date("2026-07-20T12:34:56.000Z"),
  });
  assert.equal(fp.schemaVersion, 1);
  assert.equal(fp.writtenAt, "2026-07-20T12:34:56.000Z");
  assert.equal(fp.source, "plan --cuts-only");
  assert.equal(fp.reasonIdsEnabled, true);
  assert.equal(fp.pattern, "tool-demo");
  assert.equal(fp.candidateCount, 3);
  assert.deepEqual(fp.cuts, [{ id: 3, start: 7.25, end: 12, reasonId: "tangent", reason: "脱線" }]);
  assert.deepEqual(fp.keeps, [{ id: 1, start: 0, end: 3.5, reasonId: "hook", reason: "冒頭フック" }]);
});

test("buildFirstPlan: reasonId 省略時はキー自体を持たない・keeps 省略時は空配列", () => {
  const fp = buildFirstPlan({
    source: "plan",
    reasonIdsEnabled: false,
    pattern: "general",
    numbered,
    cuts: [{ id: 3, reason: "脱線" }],
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });
  assert.equal("reasonId" in fp.cuts[0], false);
  assert.deepEqual(fp.keeps, []);
  assert.equal(fp.reasonIdsEnabled, false);
});

test("writeFirstPlan: ファイルが無ければ書く", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-firstplan-"));
  try {
    const fp = buildFirstPlan({
      source: "plan",
      reasonIdsEnabled: false,
      pattern: "general",
      numbered,
      cuts: [],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    writeFirstPlan(dir, fp);
    assert.ok(existsSync(join(dir, "plan.first.json")));
    const written = JSON.parse(readFileSync(join(dir, "plan.first.json"), "utf8"));
    assert.equal(written.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFirstPlan: write-once — 既に存在すれば内容が違っても一切上書きしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-firstplan-"));
  try {
    const original = { schemaVersion: 1, marker: "original" };
    writeFileSync(join(dir, "plan.first.json"), JSON.stringify(original));
    const fp = buildFirstPlan({
      source: "plan",
      reasonIdsEnabled: true,
      pattern: "tool-demo",
      numbered,
      cuts: [{ id: 3, reason: "脱線", reasonId: "tangent" }],
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    writeFirstPlan(dir, fp);
    const onDisk = JSON.parse(readFileSync(join(dir, "plan.first.json"), "utf8"));
    assert.deepEqual(onDisk, original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
