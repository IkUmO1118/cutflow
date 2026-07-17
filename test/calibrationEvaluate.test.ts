import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cutplanApprovalHash } from "../src/lib/approval.ts";
import {
  CALIBRATION_EVALUATION_VARIANTS,
  evaluateH6Primary,
  evaluateLimitedDefectImprovement,
  evaluateProgramPrimary,
  exactMcNemar,
  type EvaluationVariant,
} from "../src/stages/calibrationEvaluate.ts";
import { boundaryExactVector } from "../src/stages/silenceSweep.ts";
import type { CutPlan } from "../src/types.ts";

const cli = resolve("src/cli.ts");

test("exact McNemarはhuman boundary出現vectorの改善/悪化を片側で数える", () => {
  assert.deepEqual(boundaryExactVector(
    [{ start: 0, end: 1 }, { start: 1, end: 2 }],
    [{ start: 0, end: 1 }],
  ), [true, true, true, false]);
  assert.deepEqual(exactMcNemar(
    "baseline", "candidate",
    [true, false, false, true],
    [true, true, false, false],
  ), {
    baseline: "baseline", candidate: "candidate",
    improvement: 1, degradation: 1, bothExact: 1, neitherExact: 1, discordant: 2,
    agreementDelta: 0,
    oneSidedImprovementP: 0.75, oneSidedDegradationP: 0.75,
  });
  assert.throws(() => exactMcNemar("a", "b", [true], []), /vector長/);
  const tiny = exactMcNemar("a", "b", Array(105).fill(false), Array(105).fill(true));
  assert.ok(Math.abs(tiny.oneSidedImprovementP / (2 ** -105) - 1) < 1e-12);
  assert.ok(tiny.oneSidedImprovementP > 0);
});

function variant(
  name: EvaluationVariant["name"],
  tail: number,
  expandedPoints = 0,
  expandedSec = 0,
): EvaluationVariant {
  return {
    name,
    params: { silenceDb: -40, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 },
    tailSpeechCount: tail, candidateRemovedSec: 1, keepCandidateCount: 1,
    exact: { matched: 1, total: 1, ratio: 1, vector: [true] },
    direction: { expandedPoints, expandedSec, narrowedPoints: 0, narrowedSec: 0, ambiguousPoints: 0 },
  };
}

function comparison(
  agreementDelta: number,
  oneSidedImprovementP: number,
  oneSidedDegradationP = 1,
) {
  return {
    ...exactMcNemar("baseline", "candidate", [false], [false]),
    agreementDelta,
    oneSidedImprovementP,
    oneSidedDegradationP,
  };
}

test("H6 supportedはtail・5pt・p・rescueを全要求する", () => {
  const baseline = variant("baseline", 2); const calibration = variant("calibration-only", 0);
  const supported = exactMcNemar(
    "baseline", "calibration-only",
    [...Array(95).fill(false), ...Array(5).fill(false)],
    [...Array(95).fill(false), ...Array(5).fill(true)],
  );
  assert.equal(supported.agreementDelta, 0.05);
  assert.equal(supported.oneSidedImprovementP, 0.03125);
  assert.equal(evaluateH6Primary(baseline, calibration, supported), "supported");
  assert.equal(evaluateH6Primary(baseline, calibration, comparison(0.049999, 0.01)), "inconclusive");
  assert.equal(evaluateH6Primary(baseline, calibration, comparison(0.05, 0.05)), "inconclusive");
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 2), comparison(0.05, 0.01)), "inconclusive");
});

test("H6 rejectedはtail増加・有意5pt悪化・rescue点/秒悪化の各条件で成立する", () => {
  const baseline = variant("baseline", 2);
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 3), comparison(0.1, 0.01)), "rejected");
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 0), comparison(-0.05, 1, 0.049)), "rejected");
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 0), comparison(-0.05, 1, 0.05)), "inconclusive");
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 0, 1, 0), comparison(0, 1)), "rejected");
  assert.equal(evaluateH6Primary(baseline, variant("calibration-only", 0, 0, 0.01), comparison(0, 1)), "rejected");
});

test("program primaryはbaseline比tail減少・5pt改善・p<.05を全要求する", () => {
  const baseline = variant("baseline", 2); const balanced = variant("balanced", 1);
  assert.equal(evaluateProgramPrimary(baseline, balanced, comparison(0.05, 0.049)), "achieved");
  assert.equal(evaluateProgramPrimary(baseline, variant("balanced", 2), comparison(0.05, 0.049)), "not-achieved");
  assert.equal(evaluateProgramPrimary(baseline, balanced, comparison(0.049999, 0.001)), "not-achieved");
  assert.equal(evaluateProgramPrimary(baseline, balanced, comparison(0.05, 0.05)), "not-achieved");
  assert.deepEqual(CALIBRATION_EVALUATION_VARIANTS, [
    "baseline", "calibration-only", "gentle", "balanced", "tight",
    "calibration+edgeTrim", "compact-gentle", "compact-balanced", "compact-tight",
    "calibration+edgeTrim+compact-balanced",
  ]);
});

test("limited defect improvementはtail減少とrescue点数または秒数の改善を要求する", () => {
  const baseline = variant("baseline", 2, 2, 1);
  assert.equal(evaluateLimitedDefectImprovement(baseline, variant("calibration-only", 1, 1, 1)), true);
  assert.equal(evaluateLimitedDefectImprovement(baseline, variant("calibration-only", 1, 2, 0.5)), true);
  assert.equal(evaluateLimitedDefectImprovement(baseline, variant("calibration-only", 1, 2, 1)), false);
  assert.equal(evaluateLimitedDefectImprovement(baseline, variant("calibration-only", 2, 1, 0.5)), false);
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
  const dir = mkdtempSync(join(tmpdir(), "cutflow-calibration-evaluate-"));
  const cutplan: CutPlan = { approved: true, segments: [{ start: 0, end: 1, action: "keep", reason: "human" }] };
  writeFileSync(join(dir, "mic.wav"), wav());
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 1, audio: { micWav: "mic.wav" } }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan));
  if (approved) writeFileSync(join(dir, "approvals.json"), JSON.stringify({
    version: 1, cutplan: { hash: cutplanApprovalHash(cutplan), approvedAt: "fixed", by: "cli" },
  }));
  writeFileSync(join(dir, "cuts.auto.json"), "sentinel");
  return dir;
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((name) => [
  name, readFileSync(join(dir, name)).toString("base64"),
]));

test("calibration-evaluate CLIは固定順・決定論・録画read-onlyでhuman final有無に応じて列を切り替える", () => {
  const dir = fixture(true); const noApproval = fixture(false); const noCutplan = fixture(false);
  rmSync(join(noCutplan, "cutplan.json"));
  try {
    const before = snapshot(dir);
    const first = execFileSync(process.execPath, [cli, "calibration-evaluate", dir, "--json"], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cli, "calibration-evaluate", dir, "--json"], { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as {
      reference: { humanApproved: boolean };
      floor: { method: string };
      primaryCandidate: string;
      variants: Array<{
        name: string;
        tailSpeechCount: number;
        candidateRemovedSec: number;
        keepCandidateCount: number;
        exact?: unknown;
        direction?: unknown;
      }>;
      comparisons?: Record<string, unknown>;
      hypotheses?: { h6: string; program: string };
      verdict?: { h6: string; programSuccess: string; limitedDefectImprovement: boolean };
    };
    assert.equal(report.reference.humanApproved, true);
    assert.equal(report.floor.method, "silencedetect-occupancy-v1");
    assert.equal(report.primaryCandidate, "balanced");
    assert.deepEqual(report.variants.map((item) => item.name), [...CALIBRATION_EVALUATION_VARIANTS]);
    assert.deepEqual(Object.keys(report.comparisons!), ["h6Primary", "programPrimary"]);
    assert.equal(report.verdict!.h6, report.hypotheses!.h6);
    assert.equal(report.verdict!.programSuccess, report.hypotheses!.program);
    assert.equal(typeof report.verdict!.limitedDefectImprovement, "boolean");
    for (const item of report.variants) {
      assert.equal(typeof item.tailSpeechCount, "number");
      assert.equal(typeof item.candidateRemovedSec, "number");
      assert.equal(typeof item.keepCandidateCount, "number");
      assert.ok(item.exact !== undefined);
      assert.ok(item.direction !== undefined);
    }
    assert.deepEqual(snapshot(dir), before);
    assert.doesNotMatch(first, /generatedAt|createdAt|executedAt/);
    assert.doesNotMatch(first, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const unapprovedBefore = snapshot(noApproval);
    const degraded = spawnSync(
      process.execPath, [cli, "calibration-evaluate", noApproval, "--json"], { encoding: "utf8" },
    );
    assert.equal(degraded.status, 0, degraded.stderr);
    const degradedReport = JSON.parse(degraded.stdout) as typeof report;
    assert.deepEqual(degradedReport.reference, { humanApproved: false });
    assert.equal(degradedReport.comparisons, undefined);
    assert.equal(degradedReport.hypotheses, undefined);
    assert.equal(degradedReport.verdict, undefined);
    assert.deepEqual(degradedReport.variants.map((item) => item.name), [...CALIBRATION_EVALUATION_VARIANTS]);
    for (const item of degradedReport.variants) {
      assert.equal(item.exact, undefined);
      assert.equal(item.direction, undefined);
      assert.equal(typeof item.tailSpeechCount, "number");
      assert.equal(typeof item.candidateRemovedSec, "number");
      assert.equal(typeof item.keepCandidateCount, "number");
    }
    assert.deepEqual(snapshot(noApproval), unapprovedBefore);
    const noCutplanBefore = snapshot(noCutplan);
    const withoutCutplan = spawnSync(
      process.execPath, [cli, "calibration-evaluate", noCutplan, "--json"], { encoding: "utf8" },
    );
    assert.equal(withoutCutplan.status, 0, withoutCutplan.stderr);
    assert.deepEqual(JSON.parse(withoutCutplan.stdout).reference, { humanApproved: false });
    assert.deepEqual(snapshot(noCutplan), noCutplanBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(noApproval, { recursive: true, force: true });
    rmSync(noCutplan, { recursive: true, force: true });
  }
});
