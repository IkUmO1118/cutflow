import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cutplanApprovalHash } from "../src/lib/approval.ts";
import {
  analyzeBoundaryDirection,
  evaluateBoundaryDirectionH3,
  summarizeBoundaryDistances,
} from "../src/stages/boundaryDirection.ts";
import type { CutPlan, Interval } from "../src/types.ts";

const cli = resolve("src/cli.ts");
const plan = (keeps: Interval[], duration: number): CutPlan => {
  const segments: CutPlan["segments"] = [];
  let cursor = 0;
  for (const keep of keeps) {
    if (keep.start > cursor) segments.push({ start: cursor, end: keep.start, action: "cut", reason: "cut" });
    segments.push({ ...keep, action: "keep", reason: "keep" });
    cursor = keep.end;
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, action: "cut", reason: "cut" });
  return { approved: true, segments };
};

test("純分類: outer expanded/narrowed・split-added-cut・touching・added/deleted", () => {
  const split = analyzeBoundaryDirection([{ start: 0, end: 10 }], plan([
    { start: 0, end: 4 }, { start: 6, end: 10 },
  ], 10), 10);
  assert.equal(split.structure.splitAddedCutBoundaries, 2);
  assert.equal(split.structure.splitAddedCutGaps, 1);
  assert.equal(split.boundaries.narrowed, 2);
  assert.equal(split.structure.outerExpanded, 0, "exact済み外側境界を構造数へ水増ししない");
  assert.equal(split.structure.outerNarrowed, 0);

  const expanded = analyzeBoundaryDirection([{ start: 1, end: 9 }], plan([{ start: 0, end: 10 }], 10), 10);
  assert.equal(expanded.structure.outerExpanded, 2);
  assert.equal(expanded.distanceSec.expanded.sum, 2);

  const narrowed = analyzeBoundaryDirection([{ start: 0, end: 10 }], plan([{ start: 1, end: 9 }], 10), 10);
  assert.equal(narrowed.structure.outerNarrowed, 2);

  const touching = analyzeBoundaryDirection([{ start: 0, end: 5 }], plan([
    { start: 0, end: 5 }, { start: 5, end: 7 },
  ], 7), 7);
  assert.equal(touching.structure.touchingExpanded, 1);
  assert.equal(touching.distanceSec.expanded.sum, 2);

  const structural = analyzeBoundaryDirection(
    [{ start: 0, end: 2 }, { start: 6, end: 7 }],
    plan([{ start: 0, end: 2 }, { start: 4, end: 5 }], 7),
    7,
  );
  assert.equal(structural.structure.addedHumanKeeps, 1);
  assert.equal(structural.structure.deletedDetectKeeps, 1);
});

test("純分類: redundant・joined・N:M ambiguous", () => {
  const redundantPlan: CutPlan = { approved: true, segments: [
    { start: 0, end: 2, action: "keep", reason: "a" },
    { start: 2, end: 4, action: "keep", reason: "b" },
  ] };
  const redundant = analyzeBoundaryDirection([{ start: 0, end: 4 }], redundantPlan, 4);
  assert.equal(redundant.boundaries.redundant, 2);

  const joined = analyzeBoundaryDirection(
    [{ start: 0, end: 2 }, { start: 3, end: 5 }],
    plan([{ start: 0, end: 5 }], 5), 5,
  );
  assert.equal(joined.structure.joinedDetectGaps, 1);

  const complex = analyzeBoundaryDirection(
    [{ start: 0, end: 4 }, { start: 5, end: 9 }],
    plan([{ start: 0, end: 6 }, { start: 7, end: 9 }], 9), 9,
  );
  assert.equal(complex.structure.complexComponents, 1);
  assert.ok(complex.boundaries.ambiguous > 0);
});

test("集合差尺はexpanded+narrowed+commonKeep+commonCut=duration", () => {
  const report = analyzeBoundaryDirection(
    [{ start: 1, end: 5 }, { start: 7, end: 9 }],
    plan([{ start: 0, end: 4 }, { start: 8, end: 10 }], 10),
    10,
  );
  const d = report.duration;
  assert.equal(d.expandedSec, 2);
  assert.equal(d.narrowedSec, 2);
  assert.equal(d.commonKeepSec, 4);
  assert.equal(d.commonCutSec, 2);
  assert.equal(d.expandedSec + d.narrowedSec + d.commonKeepSec + d.commonCutSec, d.totalSec);
});

test("H3判定はdirectionalClassificationRateを使い3状態を返す", () => {
  assert.equal(evaluateBoundaryDirectionH3({
    directionalClassificationRate: 0.8, expandedShare: 0.6, narrowedShare: 0.4,
    expandedSec: 2, narrowedSec: 1,
  }), "supported");
  assert.equal(evaluateBoundaryDirectionH3({
    directionalClassificationRate: 0.9, expandedShare: 0.2, narrowedShare: 0.8,
    expandedSec: 1, narrowedSec: 2,
  }), "rejected");
  assert.equal(evaluateBoundaryDirectionH3({
    directionalClassificationRate: 0.79, expandedShare: 0.8, narrowedShare: 0.2,
    expandedSec: 3, narrowedSec: 1,
  }), "inconclusive");
});

test("距離percentileはraw順位でfloor((n-1)*p)、最後だけround3", () => {
  assert.deepEqual(summarizeBoundaryDistances([0.1006, 0.10049, 0.10051, 0.1004]), {
    n: 4,
    min: 0.1,
    p25: 0.1,
    median: 0.1,
    p75: 0.101,
    p90: 0.101,
    max: 0.101,
    sum: 0.402,
  });
});

test("純関数入口はdetect/human keepの有限・正・昇順・非重複・duration内を検証", () => {
  assert.throws(
    () => analyzeBoundaryDirection([{ start: 0, end: 2 }, { start: 1, end: 3 }], plan([{ start: 0, end: 3 }], 3), 3),
    /detectKeeps.*重複または昇順外/,
  );
  assert.throws(
    () => analyzeBoundaryDirection([{ start: 0, end: 3 }], plan([{ start: 0, end: 4 }], 4), 3),
    /humanKeeps.*duration外/,
  );
});

function wav(): Buffer {
  const count = 8_000; const out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + count * 2, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8_000, 24); out.writeUInt32LE(16_000, 28); out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) out.writeInt16LE(100, 44 + i * 2);
  return out;
}

function fixture(approved: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-boundary-direction-"));
  const cutplan = plan([{ start: 0, end: 1 }], 1);
  writeFileSync(join(dir, "mic.wav"), wav());
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 1, audio: { micWav: "mic.wav" } }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan));
  if (approved) writeFileSync(join(dir, "approvals.json"), JSON.stringify({
    version: 1, cutplan: { hash: cutplanApprovalHash(cutplan), approvedAt: "fixed", by: "cli" },
  }));
  return dir;
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((name) => [
  name, readFileSync(join(dir, name)).toString("base64"),
]));

test("CLIはhash一致approval必須・JSON決定論・録画read-only・transcript不要", () => {
  const approved = fixture(true); const unapproved = fixture(false);
  try {
    const before = snapshot(approved);
    const first = execFileSync(process.execPath, [cli, "boundary-direction", approved, "--json"], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cli, "boundary-direction", approved, "--json"], { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as { detect: Record<string, number> };
    for (const key of ["silenceDb", "minSilenceSec", "padSec", "minKeepSec", "keepCount", "boundaryCount"]) {
      assert.equal(typeof report.detect[key], "number", `detect.${key}`);
    }
    assert.deepEqual(snapshot(approved), before);
    assert.doesNotMatch(first, /generatedAt|createdAt|executedAt/);
    assert.doesNotMatch(first, new RegExp(approved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const refused = spawnSync(process.execPath, [cli, "boundary-direction", unapproved, "--json"], { encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /承認レコードがありません/);
  } finally {
    rmSync(approved, { recursive: true, force: true });
    rmSync(unapproved, { recursive: true, force: true });
  }
});
