import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cutplanApprovalHash } from "../src/lib/approval.ts";
import { loadConfig } from "../src/lib/config.ts";
import {
  collectCompactionSilences,
  evaluateH7,
  type CompactionSweepResult,
} from "../src/stages/compactionSweep.ts";
import {
  buildAutoCuts,
  resolveDetectCandidateParams,
  SILENCE_COMPACTION_PRESETS,
} from "../src/stages/detect.ts";
import type { CutPlan } from "../src/types.ts";

const cli = resolve("src/cli.ts");

test("preset resolver: 全presetは時間3ノブだけ置換しthresholdに触れない", () => {
  assert.deepEqual(SILENCE_COMPACTION_PRESETS, {
    gentle: { minSilenceSec: 1, padSec: 0.3, minKeepSec: 0.3 },
    balanced: { minSilenceSec: 0.7, padSec: 0.3, minKeepSec: 0.5 },
    tight: { minSilenceSec: 1, padSec: 0.3, minKeepSec: 0.8 },
    "compact-gentle": { minSilenceSec: 0.7, padSec: 0.1, minKeepSec: 0.5 },
    "compact-balanced": { minSilenceSec: 0.7, padSec: 0.05, minKeepSec: 0.5 },
    "compact-tight": { minSilenceSec: 0.6, padSec: 0.05, minKeepSec: 0.5 },
  });
  const cfg = loadConfig();
  for (const preset of Object.keys(SILENCE_COMPACTION_PRESETS) as Array<keyof typeof SILENCE_COMPACTION_PRESETS>) {
    const next = structuredClone(cfg.detect);
    next.silenceCompaction = { enabled: true, preset };
    const resolved = resolveDetectCandidateParams(next);
    assert.equal(resolved.silenceDb, cfg.detect.silenceDb);
    assert.deepEqual(
      { minSilenceSec: resolved.minSilenceSec, padSec: resolved.padSec, minKeepSec: resolved.minKeepSec },
      SILENCE_COMPACTION_PRESETS[preset],
    );
  }
  const invalid = structuredClone(cfg.detect);
  invalid.silenceCompaction = { enabled: true, preset: "unknown" as "gentle" };
  assert.throws(() => resolveDetectCandidateParams(invalid), /preset は gentle .* compact-tight/);
});

test("compact presetはcalibration-onlyから詰め方向へ単調", () => {
  const calibrationOnly = { minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 };
  const compact = [
    SILENCE_COMPACTION_PRESETS["compact-gentle"],
    SILENCE_COMPACTION_PRESETS["compact-balanced"],
    SILENCE_COMPACTION_PRESETS["compact-tight"],
  ];
  let previous = calibrationOnly;
  for (const current of compact) {
    assert.ok(current.minSilenceSec <= previous.minSilenceSec);
    assert.ok(current.padSec <= previous.padSec);
    assert.ok(current.minKeepSec >= previous.minKeepSec);
    previous = current;
  }
});

test("silenceCompaction offはAutoCuts byte等価、enabledだけmetadata追加", () => {
  const cfg = loadConfig();
  const off = structuredClone(cfg.detect);
  off.silenceCompaction = { enabled: false, preset: "tight" };
  const before = buildAutoCuts([], 2, resolveDetectCandidateParams(cfg.detect));
  const after = buildAutoCuts([], 2, resolveDetectCandidateParams(off));
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  const enabled = structuredClone(cfg.detect);
  enabled.silenceCompaction = { enabled: true, preset: "balanced" };
  const cuts = buildAutoCuts([], 2, resolveDetectCandidateParams(enabled));
  assert.deepEqual(cuts.params.silenceCompaction, { preset: "balanced", minKeepSec: 0.5 });
  assert.equal(cuts.params.minSilenceSec, 0.7);
  assert.equal(cuts.params.padSec, 0.3);
});

test("config silenceCompaction validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-compaction-config-validation-"));
  try {
    const source = readFileSync(resolve("config.yaml"), "utf8");
    const active = source.replace(
      "  silenceCutReason: 無音",
      "  silenceCutReason: 無音\n  silenceCompaction:\n    enabled: true\n    preset: balanced",
    );
    const path = join(dir, "config.yaml"); writeFileSync(path, active);
    assert.deepEqual(loadConfig(path).detect.silenceCompaction, { enabled: true, preset: "balanced" });
    writeFileSync(path, active.replace("preset: balanced", "preset: compact-balanced"));
    assert.deepEqual(loadConfig(path).detect.silenceCompaction, {
      enabled: true, preset: "compact-balanced",
    });
    writeFileSync(path, active.replace("preset: balanced", "preset: unknown"));
    assert.throws(() => loadConfig(path), /preset は.*gentle.*balanced.*tight.*compact-gentle.*compact-balanced.*compact-tight/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function result(removed: number, tail = 0, rescuePoints = 2, rescueSec = 1.19): CompactionSweepResult {
  return {
    minSilenceSec: 1, padSec: 0.3, minKeepSec: 0.3, effectiveSilenceDb: -40.5,
    tailSpeechCount: tail, candidateRemovedSec: removed, keepCandidateCount: 1,
    rescueExpandedPoints: rescuePoints, rescueExpandedSec: rescueSec,
    semanticNarrowedPoints: 1, semanticNarrowedSec: 1, exactPoints: 1, ambiguousPoints: 0,
  };
}

test("H7 supported/rejected/inconclusive", () => {
  assert.equal(evaluateH7({ gentle: result(200), balanced: result(215), tight: result(230) }), "supported");
  assert.equal(evaluateH7({ gentle: result(200), balanced: result(215, 1), tight: result(230) }), "rejected");
  assert.equal(evaluateH7({ gentle: result(200), balanced: result(204), tight: result(208) }), "inconclusive");
  assert.equal(evaluateH7({
    gentle: result(100), balanced: { ...result(115), effectiveSilenceDb: -40 }, tight: result(125),
  }), "inconclusive", "thresholdが違えば分離の証明にならない");
  assert.equal(evaluateH7({
    gentle: result(200), balanced: result(204, 1), tight: result(209),
  }), "inconclusive", "unsafeでもremoval差が10未満なら判定不能");
  assert.equal(evaluateH7({
    gentle: result(200), balanced: result(205), tight: result(210),
  }), "supported", "10秒かつminRemovedの5%ちょうどを含む");
  assert.equal(evaluateH7({
    gentle: result(200, 0, 2, 1.19), balanced: result(215, 0, 2, 1.24), tight: result(230, 0, 2, 1.2),
  }), "supported", "rescueSec range 0.05ちょうどを含む");
  assert.equal(evaluateH7({
    gentle: result(200, 0, 2, 1.19), balanced: result(215, 0, 2, 1.241), tight: result(230, 0, 2, 1.2),
  }), "rejected");
});

test("grid用silencedetectはminSilence 4値ごとに1回だけ", async () => {
  const calls: number[] = [];
  const cache = await collectCompactionSilences(async (minSilenceSec) => {
    calls.push(minSilenceSec); return [];
  });
  assert.deepEqual(calls, [0.3, 0.5, 0.7, 1]);
  assert.equal(cache.size, 4);
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

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-compaction-sweep-"));
  const cutplan: CutPlan = { approved: true, segments: [
    { start: 0, end: 1, action: "keep", reason: "human" },
  ] };
  writeFileSync(join(dir, "mic.wav"), wav());
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 1, audio: { micWav: "mic.wav" } }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan));
  writeFileSync(join(dir, "approvals.json"), JSON.stringify({
    version: 1, cutplan: { hash: cutplanApprovalHash(cutplan), approvedAt: "fixed", by: "cli" },
  }));
  writeFileSync(join(dir, "cuts.auto.json"), "sentinel");
  return dir;
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((name) => [
  name, readFileSync(join(dir, name)).toString("base64"),
]));

test("compaction-sweep CLIは36件・JSON決定論・録画read-only", () => {
  const dir = fixture(); const configDir = mkdtempSync(join(tmpdir(), "cutflow-compaction-config-"));
  try {
    const active = readFileSync(resolve("config.yaml"), "utf8");
    const configPath = join(configDir, "config.yaml"); writeFileSync(configPath, active);
    const before = snapshot(dir);
    const args = [cli, "--config", configPath, "compaction-sweep", dir, "--json"];
    const first = execFileSync(process.execPath, args, { encoding: "utf8" });
    const second = execFileSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as { grid: { candidateCount: number }; results: unknown[] };
    assert.equal(report.grid.candidateCount, 36); assert.equal(report.results.length, 36);
    assert.deepEqual(snapshot(dir), before);
    assert.doesNotMatch(first, /generatedAt|createdAt|executedAt/);
    assert.doesNotMatch(first, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(configDir, { recursive: true, force: true });
  }
});

test("compaction-sweep CLIはcalibration offを明示拒否", () => {
  const dir = fixture(); const configDir = mkdtempSync(join(tmpdir(), "cutflow-compaction-off-config-"));
  try {
    const source = readFileSync(resolve("config.yaml"), "utf8");
    const off = source.replace(
      "    enabled: true\n    method: silencedetect-occupancy-v1\n    floorOffsetDb: 12",
      "    enabled: false\n    method: silencedetect-occupancy-v1\n    floorOffsetDb: 12",
    );
    const configPath = join(configDir, "config.yaml"); writeFileSync(configPath, off);
    const result = spawnSync(
      process.execPath, [cli, "--config", configPath, "compaction-sweep", dir, "--json"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /detect\.calibration\.enabled: true が必要/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});
