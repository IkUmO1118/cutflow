import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/lib/config.ts";
import {
  estimateOperationalFloor,
  resolveEffectiveSilenceDb,
  silentOccupancyRatio,
} from "../src/lib/silenceFloor.ts";
import { detect, detectAutoCuts, resolveDetectCandidateParams } from "../src/stages/detect.ts";
import { evaluateHoldout, selectFloorOffset } from "../src/stages/floorCalibration.ts";
import type { FloorCalibrationReport } from "../src/stages/floorCalibration.ts";

const cli = resolve("src/cli.ts");

function spansForRatio(ratio: number, durationSec = 100) {
  return ratio === 0 ? [] : [{ start: 0, end: ratio * durationSec }];
}

test("operational floor: 離散二分探索で最初の5%交差と直前gridを返す", async () => {
  const calls: Array<{ thresholdDb: number; minSilenceSec: number }> = [];
  const result = await estimateOperationalFloor(100, async (thresholdDb, minSilenceSec) => {
    calls.push({ thresholdDb, minSilenceSec });
    return spansForRatio(thresholdDb >= -52.5 ? 0.06 : 0.04);
  });
  assert.deepEqual(result, {
    floorDb: -52.5,
    floorCrossing: {
      belowThresholdDb: -53,
      belowSilentRatio: 0.04,
      thresholdDb: -52.5,
      silentRatio: 0.06,
    },
  });
  assert.ok(calls.every((call) => call.minSilenceSec === 0.1));
  assert.ok(calls.length < 20, "181 gridの全走査ではなく離散二分探索であること");
});

test("operational floor: degenerate・非単調・不正spanを明示error", async () => {
  await assert.rejects(
    estimateOperationalFloor(100, async () => []),
    /探索上限でもtargetへ達しません/,
  );
  await assert.rejects(
    estimateOperationalFloor(100, async () => spansForRatio(0.1)),
    /探索下限ですでにtarget/,
  );
  await assert.rejects(
    estimateOperationalFloor(100, async (thresholdDb) => {
      if (thresholdDb === -51) return spansForRatio(0.055);
      return spansForRatio(thresholdDb >= -52.5 ? 0.06 : 0.04);
    }),
    /単調ではありません/,
  );
  assert.throws(() => silentOccupancyRatio([{ start: 2, end: 1 }], 100), /span\[0\] が不正/);
});

test("effective silenceDb: 0.5dB gridと-90..0範囲を共通検証", () => {
  assert.equal(resolveEffectiveSilenceDb(-90, 0), -90);
  assert.equal(resolveEffectiveSilenceDb(-12, 12), 0);
  assert.equal(resolveEffectiveSilenceDb(-52.5, 12.5), -40);
  assert.throws(() => resolveEffectiveSilenceDb(-50, 0.25), /0\.5dB grid/);
  assert.throws(() => resolveEffectiveSilenceDb(-10, 10.5), /範囲外/);
  assert.throws(() => resolveEffectiveSilenceDb(-90, -0.5), /範囲外/);
});

type FitResult = FloorCalibrationReport["fit"]["results"][number];
function fitResult(offsetDb: number, tail: number, removed: number, matched: number): FitResult {
  return {
    offsetDb,
    effectiveSilenceDb: -50 + offsetDb,
    tailSpeechCount: tail,
    candidateRemovedSec: removed,
    removedRatio: 0.01,
    keepCandidateCount: 1,
    silenceCount: 1,
    boundaryAgreement: { matched, total: 10, ratio: matched / 10 },
  };
}

test("offset選択: removed=0除外、tail最小→matched最大→小offset", () => {
  assert.equal(selectFloorOffset([
    fitResult(0, 0, 0, 10),
    fitResult(3, 1, 1, 9),
    fitResult(6, 0, 1, 4),
    fitResult(9, 0, 1, 7),
    fitResult(12, 0, 1, 7),
  ]), 9);
  assert.throws(() => selectFloorOffset([fitResult(0, 0, 0, 10)]), /選べません/);
});

test("holdout合格条件: keep>=1, tail=0, removed>0, ratio<=.05", () => {
  const base = fitResult(12, 0, 0.77, 0);
  assert.deepEqual(evaluateHoldout({ ...base, removedRatio: 0.05 }), { status: "passed", reasons: [] });
  const failed = evaluateHoldout({
    ...base,
    keepCandidateCount: 0,
    tailSpeechCount: 1,
    candidateRemovedSec: 0,
    removedRatio: 0.051,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reasons.length, 4);
});

function wavPcm16(durationSec: number): Buffer {
  const sampleRate = 8_000;
  const count = durationSec * sampleRate;
  const out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + count * 2, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36);
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) out.writeInt16LE(100, 44 + i * 2);
  return out;
}

function makeRecording(allKeep = false): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-floor-calibration-"));
  writeFileSync(join(dir, "mic.wav"), wavPcm16(1));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 1, audio: { micWav: "mic.wav" } }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify({
    approved: !allKeep,
    segments: allKeep ? [
      { start: 0, end: 1, action: "keep", reason: "initial" },
    ] : [
      { start: 0, end: 0.4, action: "keep", reason: "a" },
      { start: 0.4, end: 0.6, action: "cut", reason: "b" },
      { start: 0.6, end: 1, action: "keep", reason: "c" },
    ],
  }));
  writeFileSync(join(dir, "cuts.auto.json"), "sentinel");
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [
    name, readFileSync(join(dir, name)).toString("base64"),
  ]));
}

test("detect calibration offは従来byte parity、enabledはmetadataを記録", async () => {
  const dir = makeRecording();
  try {
    const baseCfg = loadConfig();
    const legacyCfg = structuredClone(baseCfg);
    delete legacyCfg.detect.calibration;
    delete legacyCfg.detect.silenceCompaction;
    delete legacyCfg.detect.edgeTrim;
    const expected = await detectAutoCuts(
      join(dir, "mic.wav"), 1, resolveDetectCandidateParams(legacyCfg.detect),
    );
    const offCfg = structuredClone(legacyCfg);
    offCfg.detect.calibration = {
      enabled: false,
      method: "silencedetect-occupancy-v1",
      floorOffsetDb: 12,
    };
    const off = await detect(dir, offCfg);
    assert.deepEqual(off, expected);
    assert.equal(readFileSync(join(dir, "cuts.auto.json"), "utf8"), JSON.stringify(expected, null, 2));
    assert.equal("calibration" in off.params, false);

    const enabledCfg = structuredClone(legacyCfg);
    enabledCfg.detect.calibration = {
      enabled: true,
      method: "silencedetect-occupancy-v1",
      floorOffsetDb: 3,
    };
    const enabled = await detect(dir, enabledCfg);
    assert.deepEqual(enabled.params.calibration, {
      method: "silencedetect-occupancy-v1",
      floorDb: -50,
      floorOffsetDb: 3,
      effectiveSilenceDb: -47,
    });
    assert.equal(enabled.params.silenceDb, -47);

    const invalidMethodCfg = structuredClone(legacyCfg);
    invalidMethodCfg.detect.calibration = {
      enabled: true,
      method: "not-supported" as "silencedetect-occupancy-v1",
      floorOffsetDb: 3,
    };
    await assert.rejects(detect(dir, invalidMethodCfg), /method は silencedetect-occupancy-v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config calibration validationと読込", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-floor-config-"));
  try {
    const active = readFileSync(resolve("config.yaml"), "utf8");
    const path = join(dir, "config.yaml");
    writeFileSync(path, active);
    assert.deepEqual(loadConfig(path).detect.calibration, {
      enabled: true, method: "silencedetect-occupancy-v1", floorOffsetDb: 12,
    });
    writeFileSync(path, active.replace("floorOffsetDb: 12", "floorOffsetDb: nope"));
    assert.throws(() => loadConfig(path), /floorOffsetDb は有限の数値/);
    writeFileSync(path, active.replace("floorOffsetDb: 12", "floorOffsetDb: 0.25"));
    assert.throws(() => loadConfig(path), /floorOffsetDb は0\.5dB grid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("floor-calibration CLI --verify JSONは決定論・fit/verify両録画read-only", () => {
  const fit = makeRecording();
  const verify = makeRecording(true);
  try {
    const fitBefore = snapshot(fit);
    const verifyBefore = snapshot(verify);
    const args = [cli, "floor-calibration", fit, "--verify", verify, "--json"];
    const first = execFileSync(process.execPath, args, { encoding: "utf8" });
    const second = execFileSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as {
      method: { name: string };
      fit: { results: unknown[] };
      verification: Array<{ hasHumanReference: boolean }>;
    };
    assert.equal(report.method.name, "silencedetect-occupancy-v1");
    assert.equal(report.fit.results.length, 5);
    assert.equal(report.verification.length, 1);
    assert.equal(report.verification[0]?.hasHumanReference, false);
    assert.deepEqual(snapshot(fit), fitBefore);
    assert.deepEqual(snapshot(verify), verifyBefore);
    assert.doesNotMatch(first, /generatedAt|createdAt|executedAt/);
    assert.doesNotMatch(first, new RegExp(fit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(first, new RegExp(verify.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(fit, { recursive: true, force: true });
    rmSync(verify, { recursive: true, force: true });
  }
});
