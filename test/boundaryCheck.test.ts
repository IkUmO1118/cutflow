import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  BOUNDARY_SAMPLE_RATE_HZ,
  analyzeBoundarySamples,
  isAboveBoundaryThreshold,
  noiseFloorDb,
  pcmRmsDb,
} from "../src/stages/boundaryCheck.ts";

const cli = resolve("src/cli.ts");

function samplesWithBaseline(durationSec: number, value = 100): Int16Array {
  const samples = new Int16Array(durationSec * BOUNDARY_SAMPLE_RATE_HZ);
  samples.fill(value);
  return samples;
}

function fillSec(samples: Int16Array, startSec: number, endSec: number, value: number): void {
  samples.fill(
    value,
    Math.floor(startSec * BOUNDARY_SAMPLE_RATE_HZ),
    Math.ceil(endSec * BOUNDARY_SAMPLE_RATE_HZ),
  );
}

function wavPcm16(samples: Int16Array): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(BOUNDARY_SAMPLE_RATE_HZ, 24);
  out.writeUInt32LE(BOUNDARY_SAMPLE_RATE_HZ * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}

function makeRecording(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-boundary-check-"));
  const samples = samplesWithBaseline(2);
  fillSec(samples, 0.5, 0.62, 5_000);
  fillSec(samples, 1.2, 1.32, 4_000);
  writeFileSync(join(dir, "mic.wav"), wavPcm16(samples));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ audio: { micWav: "mic.wav" } }));
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify({
    approved: false,
    segments: [
      { start: 0, end: 0.5, action: "keep", reason: "a" },
      { start: 0.5, end: 0.8, action: "cut", reason: "b" },
      { start: 0.8, end: 1.2, action: "keep", reason: "c" },
    ],
  }));
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

test("純計算: RMS/床p5とkeep終端のflag/discardを決定論的に算出する", () => {
  const silence = new Int16Array(1_000);
  assert.equal(pcmRmsDb(silence, 0, silence.length), -120);

  const samples = samplesWithBaseline(2);
  fillSec(samples, 0.5, 0.62, 5_000);
  fillSec(samples, 1.2, 1.32, 4_000);
  assert.ok(noiseFloorDb(samples) < -50 && noiseFloorDb(samples) > -51);
  const report = analyzeBoundarySamples(samples, {
    segments: [
      { start: 0, end: 0.5, action: "keep", reason: "a" },
      { start: 0.5, end: 0.8, action: "cut", reason: "b" },
      { start: 0.8, end: 1.2, action: "keep", reason: "c" },
    ],
  });
  assert.deepEqual(report.summary, { keepBoundaries: 2, flagged: 2, discarded: 1 });
  assert.equal(report.measurement.noiseFloorDb, -50.3);
  assert.equal(report.measurement.thresholdDb, -38.3);
  assert.deepEqual(report.findings.map((finding) => finding.keepEndSec), [0.5, 1.2]);
  assert.deepEqual(report.findings.map((finding) => finding.discarded), [true, false]);
  assert.equal(report.findings[0]?.cutDurationSec, 0.3);
});

test("threshold比較は厳密 > で、等号はflagしない", () => {
  assert.equal(isAboveBoundaryThreshold(-40, -40), false);
  assert.equal(isAboveBoundaryThreshold(-39.999999, -40), true);
  assert.equal(isAboveBoundaryThreshold(-40.000001, -40), false);
});

test("findingsは0.1dB丸め前のraw RMSで降順にする", () => {
  const samples = samplesWithBaseline(3);
  fillSec(samples, 0.5, 0.62, 5_000);
  fillSec(samples, 1.2, 1.32, 5_020);
  const report = analyzeBoundarySamples(samples, {
    segments: [
      { start: 0, end: 0.5, action: "keep", reason: "a" },
      { start: 0.5, end: 0.8, action: "cut", reason: "b" },
      { start: 0.8, end: 1.2, action: "keep", reason: "c" },
      { start: 1.2, end: 1.5, action: "cut", reason: "d" },
    ],
  });
  assert.equal(report.findings[0]?.rmsDb, report.findings[1]?.rmsDb, "表示値は同じ0.1dBになる前提");
  assert.deepEqual(report.findings.map((finding) => finding.keepEndSec), [1.2, 0.5]);
});

test("cutplan時間軸は昇順・非重複・連続・音声尺内を要求する", () => {
  const samples = samplesWithBaseline(2);
  const segment = (start: number, end: number, action: "keep" | "cut" = "keep") =>
    ({ start, end, action, reason: "test" });

  assert.throws(
    () => analyzeBoundarySamples(samples, { segments: [segment(0, 0.8), segment(0.7, 1, "cut")] }),
    /重複/,
  );
  assert.throws(
    () => analyzeBoundarySamples(samples, { segments: [segment(0, 0.5), segment(0.6, 1, "cut")] }),
    /隙間/,
  );
  assert.throws(
    () => analyzeBoundarySamples(samples, { segments: [segment(0.5, 1), segment(0, 0.5, "cut")] }),
    /時系列昇順/,
  );
  assert.throws(
    () => analyzeBoundarySamples(samples, { segments: [segment(0, 2.01)] }),
    /音声尺.*超えています/,
  );

  const nearAdjacent = analyzeBoundarySamples(samples, {
    segments: [segment(0, 0.5), segment(0.5000005, 0.8, "cut")],
  });
  assert.equal(nearAdjacent.findings.length, 0);
});

test("cutDurationSecはkeep.endではなく後続cut自身のstart/endから算出する", () => {
  const samples = samplesWithBaseline(2);
  fillSec(samples, 0.5, 0.62, 5_000);
  const report = analyzeBoundarySamples(samples, {
    segments: [
      { start: 0, end: 0.5, action: "keep", reason: "a" },
      { start: 0.5000005, end: 0.8, action: "cut", reason: "b" },
    ],
  });
  assert.equal(report.findings[0]?.cutDurationSec, 0.3);
});

test("CLI --json: transcript不要・バイト決定論・録画フォルダ完全read-only", () => {
  const dir = makeRecording();
  try {
    assert.equal(existsSync(join(dir, "transcript.json")), false);
    const before = snapshot(dir);
    const first = execFileSync(process.execPath, [cli, "boundary-check", dir, "--json"], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cli, "boundary-check", dir, "--json"], { encoding: "utf8" });
    assert.equal(first, second);
    const report = JSON.parse(first) as { summary: { keepBoundaries: number; flagged: number; discarded: number }; findings: unknown[] };
    assert.deepEqual(report.summary, { keepBoundaries: 2, flagged: 2, discarded: 1 });
    assert.equal(report.findings.length, 2);
    assert.deepEqual(snapshot(dir), before);
    assert.doesNotMatch(first, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(first, /generatedAt|createdAt|durationMs|executedAt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 人間表示を提供する", () => {
  const dir = makeRecording();
  try {
    const stdout = execFileSync(process.execPath, [cli, "boundary-check", dir], { encoding: "utf8" });
    assert.match(stdout, /keep終端 2件 \/ flag 2件 \/ 実際にdiscard 1件/);
    assert.match(stdout, /0\.50s:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest収録尺とPCM尺の差がlookaheadを超えれば明示error", () => {
  const dir = makeRecording();
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      durationSec: 2.2,
      audio: { micWav: "mic.wav" },
    }));
    const result = spawnSync(process.execPath, [cli, "boundary-check", dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durationSec .*マイク音声尺.*差.*0\.12秒を超えています/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不正入力: manifest欠落とffmpegデコード失敗を明示する", () => {
  const missing = mkdtempSync(join(tmpdir(), "cutflow-boundary-missing-"));
  const broken = mkdtempSync(join(tmpdir(), "cutflow-boundary-broken-"));
  try {
    const missingResult = spawnSync(process.execPath, [cli, "boundary-check", missing], { encoding: "utf8" });
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /manifest\.json が見つかりません/);

    writeFileSync(join(broken, "manifest.json"), JSON.stringify({ audio: { micWav: "mic.wav" } }));
    writeFileSync(join(broken, "cutplan.json"), JSON.stringify({ approved: false, segments: [] }));
    writeFileSync(join(broken, "mic.wav"), "not audio");
    const brokenResult = spawnSync(process.execPath, [cli, "boundary-check", broken], { encoding: "utf8" });
    assert.notEqual(brokenResult.status, 0);
    assert.match(brokenResult.stderr, /ffmpeg の音声デコードに失敗しました/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});
