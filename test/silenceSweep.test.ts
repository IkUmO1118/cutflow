import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/lib/config.ts";
import {
  buildAutoCuts,
  complement,
  detect,
  detectAutoCuts,
  resolveDetectCandidateParams,
} from "../src/stages/detect.ts";
import {
  boundaryAgreement,
  buildSilenceSweepReport,
  cutplanFromAutoKeeps,
  evaluateSweepHypotheses,
  type SilenceSweepResult,
} from "../src/stages/silenceSweep.ts";
import type { AutoCuts, CutPlan } from "../src/types.ts";

const cli = resolve("src/cli.ts");

function wavPcm16(durationSec: number): Buffer {
  const sampleRate = 8_000;
  const sampleCount = durationSec * sampleRate;
  const dataBytes = sampleCount * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < sampleCount; i += 1) out.writeInt16LE(100, 44 + i * 2);
  return out;
}

function makeRecording(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-silence-sweep-"));
  writeFileSync(join(dir, "mic.wav"), wavPcm16(2));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    durationSec: 2,
    audio: { micWav: "mic.wav" },
  }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify({
    approved: false,
    segments: [
      { start: 0, end: 0.8, action: "keep", reason: "a" },
      { start: 0.8, end: 1.2, action: "cut", reason: "b" },
      { start: 1.2, end: 2, action: "keep", reason: "c" },
    ],
  }));
  writeFileSync(join(dir, "cuts.auto.json"), "sentinel-cuts-auto");
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

test("detect refactor: buildAutoCutsは従来算術・JSON形とバイト等価", () => {
  const silences = [{ start: 1, end: 2 }, { start: 3, end: 4.5 }];
  const params = { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 };
  const keepSegments = complement(silences, 6, params.padSec, params.minKeepSec);
  const legacy: AutoCuts = {
    params: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15 },
    silences,
    keepSegments,
    keptDurationSec: Math.round(
      keepSegments.reduce((sum, keep) => sum + keep.end - keep.start, 0) * 100,
    ) / 100,
    originalDurationSec: 6,
  };
  assert.equal(
    JSON.stringify(buildAutoCuts(silences, 6, params), null, 2),
    JSON.stringify(legacy, null, 2),
  );
});

test("候補keepから0..duration連続被覆cutplanを作る", () => {
  const plan = cutplanFromAutoKeeps([{ start: 0.2, end: 0.8 }, { start: 1, end: 1.5 }], 2);
  assert.deepEqual(plan.segments.map(({ start, end, action }) => ({ start, end, action })), [
    { start: 0, end: 0.2, action: "cut" },
    { start: 0.2, end: 0.8, action: "keep" },
    { start: 0.8, end: 1, action: "cut" },
    { start: 1, end: 1.5, action: "keep" },
    { start: 1.5, end: 2, action: "cut" },
  ]);
  assert.throws(() => cutplanFromAutoKeeps([], Number.NaN), /有限の正数/);
  assert.throws(
    () => cutplanFromAutoKeeps([{ start: 0.5, end: 1 }, { start: 0.8, end: 1.5 }], 2),
    /重複または昇順外/,
  );
  assert.throws(() => cutplanFromAutoKeeps([{ start: 0, end: 2.1 }], 2), /音声尺外/);
});

test("境界一致はhuman keep start/endを分母に±1e-6で数えratioを6桁丸め", () => {
  const agreement = boundaryAgreement(
    [{ start: 0, end: 1 }, { start: 2, end: 3 }],
    [{ start: 0.0000005, end: 1.5 }, { start: 2, end: 2.5 }],
  );
  assert.deepEqual(agreement, { matched: 2, total: 4, ratio: 0.5 });

  const epsilonEdges = boundaryAgreement(
    [{ start: 1, end: 2 }, { start: 1, end: 2 }],
    [
      { start: 1 + 1e-6, end: 2 - 1e-6 },
      { start: 10, end: 11 }, // 候補余剰は分母を増やさない
    ],
  );
  assert.deepEqual(epsilonEdges, { matched: 4, total: 4, ratio: 1 });
  assert.deepEqual(
    boundaryAgreement([{ start: 1, end: 2 }], [{ start: 1 + 1.01e-6, end: 2 }]),
    { matched: 1, total: 2, ratio: 0.5 },
  );
  assert.throws(() => boundaryAgreement([], [{ start: 0, end: 1 }]), /比較できません/);
});

function sweepResult(tail: number, ratio: number, matched = Math.round(ratio * 10)): SilenceSweepResult {
  return {
    silenceDb: -35,
    tailSpeechCount: tail,
    candidateRemovedSec: 0,
    keepCandidateCount: 0,
    boundaryAgreement: { matched, total: 10, ratio },
  };
}

test("仮説判定: H2 supported/rejected/inconclusive とH6 proxy", () => {
  assert.deepEqual(evaluateSweepHypotheses([
    sweepResult(2, 0.5), sweepResult(0, 0.4), sweepResult(0, 0.3), sweepResult(0, 0.2),
  ]), {
    h2: { status: "supported", nonIncreasing: true, strictDecrease: true },
    h6Proxy: { status: "not-supported" },
  });
  assert.equal(
    evaluateSweepHypotheses([sweepResult(2, 0.3), sweepResult(1, 0.4)]).h6Proxy.status,
    "preliminary-supported",
  );
  assert.equal(
    evaluateSweepHypotheses([
      sweepResult(2, 1, 10),
      sweepResult(1, 0.8, 8),
      sweepResult(1, 0.9, 9),
      sweepResult(0, 0.85, 8), // 直前よりtail減でもbaselineのmatchedを超えない
    ]).h6Proxy.status,
    "not-supported",
  );
  assert.equal(
    evaluateSweepHypotheses([sweepResult(1, 0.3), sweepResult(2, 0.4)]).h2.status,
    "rejected",
  );
  assert.deepEqual(evaluateSweepHypotheses([sweepResult(1, 0.3), sweepResult(1, 0.4)]), {
    h2: { status: "inconclusive", nonIncreasing: true, strictDecrease: false },
    h6Proxy: { status: "inconclusive" },
  });
});

test("report指標: removedSec/keep数/referenceと固定JSONキー順", () => {
  const cfg = loadConfig();
  const human: CutPlan = {
    approved: false,
    segments: [
      { start: 0, end: 1, action: "keep", reason: "a" },
      { start: 1, end: 2, action: "cut", reason: "b" },
    ],
  };
  const auto = (silenceDb: number): AutoCuts => ({
    params: { silenceDb, minSilenceSec: 0.7, padSec: 0.15 },
    silences: [],
    keepSegments: [{ start: 0, end: 1 }],
    keptDurationSec: 1.23,
    originalDurationSec: 3.46,
  });
  const report = buildSilenceSweepReport(cfg, human, [-35, -40, -45, -50].map(auto), [2, 0, 0, 0]);
  assert.deepEqual(report.reference, { humanKeepCount: 1, humanBoundaryCount: 2 });
  assert.equal(report.results[0]?.candidateRemovedSec, 2.23);
  assert.equal(report.results[0]?.keepCandidateCount, 1);
  assert.deepEqual(Object.keys(report), [
    "version", "thresholdsDb", "fixed", "reference", "results", "hypotheses",
  ]);
  assert.throws(() => buildSilenceSweepReport(cfg, human, [], []), /各4件必要/);
  const wrongThreshold = [-35, -40, -45, -50].map(auto);
  wrongThreshold[2] = auto(-44);
  assert.throws(
    () => buildSilenceSweepReport(cfg, human, wrongThreshold, [2, 0, 0, 0]),
    /threshold -45 と一致しません/,
  );
});

test("detectAutoCutsと通常detectの戻り値・cuts.auto.jsonはdeep/byte parity", async () => {
  const dir = makeRecording();
  try {
    const cfg = loadConfig();
    delete cfg.detect.calibration;
    delete cfg.detect.silenceCompaction;
    delete cfg.detect.edgeTrim;
    const readOnly = await detectAutoCuts(
      join(dir, "mic.wav"), 2, resolveDetectCandidateParams(cfg.detect),
    );
    const writtenResult = await detect(dir, cfg);
    assert.deepEqual(writtenResult, readOnly);
    assert.equal(
      readFileSync(join(dir, "cuts.auto.json"), "utf8"),
      JSON.stringify(readOnly, null, 2),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --jsonはバイト決定論・録画folder read-only・cuts.auto不変", () => {
  const dir = makeRecording();
  try {
    const before = snapshot(dir);
    const first = execFileSync(process.execPath, [cli, "silence-sweep", dir, "--json"], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cli, "silence-sweep", dir, "--json"], { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as { thresholdsDb: number[]; results: unknown[] };
    assert.deepEqual(report.thresholdsDb, [-35, -40, -45, -50]);
    assert.equal(report.results.length, 4);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(readFileSync(join(dir, "cuts.auto.json"), "utf8"), "sentinel-cuts-auto");
    assert.doesNotMatch(first, /generatedAt|createdAt|executedAt/);
    assert.doesNotMatch(first, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
