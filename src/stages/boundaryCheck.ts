import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CutPlan, Manifest, PlanSegment } from "../types.ts";

export const BOUNDARY_SAMPLE_RATE_HZ = 8_000;
export const FLOOR_WINDOW_SEC = 0.1;
export const BOUNDARY_LOOKAHEAD_SEC = 0.12;
export const FLOOR_PERCENTILE = 0.05;
export const THRESHOLD_OFFSET_DB = 12;
export const SILENCE_RMS_DB = -120;
export const SEGMENT_TIME_EPSILON_SEC = 1e-6;

export interface BoundaryFinding {
  keepEndSec: number;
  rmsDb: number;
  discarded: boolean;
  cutDurationSec?: number;
}

export interface BoundaryCheckReport {
  version: 1;
  measurement: {
    decoder: "ffmpeg";
    channels: 1;
    sampleRateHz: number;
    sampleFormat: "signed-pcm16le";
    floorWindowMs: number;
    floorPercentile: number;
    thresholdOffsetDb: number;
    boundaryLookaheadMs: number;
    silenceRmsDb: number;
    noiseFloorDb: number;
    thresholdDb: number;
  };
  summary: {
    keepBoundaries: number;
    flagged: number;
    discarded: number;
  };
  findings: BoundaryFinding[];
}

/** PCM16 の標本範囲の RMS を dBFS で返す。空または実質無音は -120dB。 */
export function pcmRmsDb(samples: Int16Array, startSample: number, endSample: number): number {
  const start = Math.max(0, Math.min(samples.length, startSample));
  const end = Math.max(start, Math.min(samples.length, endSample));
  if (end <= start) return SILENCE_RMS_DB;
  let sumSquares = 0;
  for (let i = start; i < end; i += 1) {
    const normalized = samples[i]! / 32768;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / (end - start));
  return rms < 1e-6 ? SILENCE_RMS_DB : 20 * Math.log10(rms);
}

/** 元調査と同じ非重複100ms窓と `t + 0.1 < duration` の厳密不等号で床を測る。 */
export function noiseFloorDb(samples: Int16Array): number {
  const windowSamples = FLOOR_WINDOW_SEC * BOUNDARY_SAMPLE_RATE_HZ;
  const values: number[] = [];
  for (let start = 0; start + windowSamples < samples.length; start += windowSamples) {
    values.push(pcmRmsDb(samples, start, start + windowSamples));
  }
  if (values.length === 0) {
    throw new Error("音声が短すぎます: ノイズ床の100ms窓を1つも測定できません");
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * FLOOR_PERCENTILE)]!;
}

function sampleRangeRmsDb(samples: Int16Array, startSec: number, endSec: number): number {
  return pcmRmsDb(
    samples,
    Math.floor(startSec * BOUNDARY_SAMPLE_RATE_HZ),
    Math.ceil(endSec * BOUNDARY_SAMPLE_RATE_HZ),
  );
}

function roundDb(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundSec(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertSegments(segments: PlanSegment[], durationSec: number): void {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (
      (segment.action !== "keep" && segment.action !== "cut") ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start
    ) {
      throw new Error(`cutplan.json の segments[${i}] が不正です`);
    }
    if (segment.end > durationSec + SEGMENT_TIME_EPSILON_SEC) {
      throw new Error(
        `cutplan.json の segments[${i}].end (${segment.end}) が音声尺 (${durationSec}) を超えています`,
      );
    }
    const previous = segments[i - 1];
    if (previous !== undefined) {
      if (segment.start < previous.start) {
        throw new Error(`cutplan.json の segments[${i}] が時系列昇順ではありません`);
      }
      const delta = segment.start - previous.end;
      if (delta < -SEGMENT_TIME_EPSILON_SEC) {
        throw new Error(`cutplan.json の segments[${i - 1}] と segments[${i}] が重複しています`);
      }
      if (delta > SEGMENT_TIME_EPSILON_SEC) {
        throw new Error(`cutplan.json の segments[${i - 1}] と segments[${i}] の間に隙間があります`);
      }
    }
  }
}

/** 元測定の判定規則。しきい値と同値は flag にしない。 */
export function isAboveBoundaryThreshold(rmsDb: number, thresholdDb: number): boolean {
  return rmsDb > thresholdDb;
}

/** デコード済み PCM と cutplan から副作用なしで境界レポートを作る。 */
export function analyzeBoundarySamples(
  samples: Int16Array,
  cutplan: Pick<CutPlan, "segments">,
  timelineDurationSec = samples.length / BOUNDARY_SAMPLE_RATE_HZ,
): BoundaryCheckReport {
  if (!Array.isArray(cutplan.segments)) {
    throw new Error("cutplan.json の segments が配列ではありません");
  }
  const durationSec = samples.length / BOUNDARY_SAMPLE_RATE_HZ;
  if (!Number.isFinite(timelineDurationSec) || timelineDurationSec <= 0) {
    throw new Error("音声タイムライン尺が不正です");
  }
  // 抽出済み WAV は元コンテナより末尾が数十ms短い場合がある。CLI は manifest の
  // 収録タイムライン尺を渡し、純計算を直接使う場合は PCM 尺を既定にする。
  assertSegments(cutplan.segments, timelineDurationSec);
  const floor = noiseFloorDb(samples);
  const threshold = floor + THRESHOLD_OFFSET_DB;
  const rawFindings: Array<{ finding: BoundaryFinding; rawRmsDb: number; segmentIndex: number }> = [];
  let keepBoundaries = 0;
  let discarded = 0;

  for (let i = 0; i < cutplan.segments.length; i += 1) {
    const keep = cutplan.segments[i]!;
    if (keep.action !== "keep") continue;
    keepBoundaries += 1;
    const boundaryEnd = Math.min(keep.end + BOUNDARY_LOOKAHEAD_SEC, durationSec);
    const boundaryRms = sampleRangeRmsDb(samples, keep.end, boundaryEnd);
    if (!isAboveBoundaryThreshold(boundaryRms, threshold)) continue;

    const next = cutplan.segments[i + 1];
    let isDiscarded = false;
    let cutDurationSec: number | undefined;
    if (next?.action === "cut") {
      const discardedEnd = Math.min(keep.end + BOUNDARY_LOOKAHEAD_SEC, next.end, durationSec);
      const discardedRms = sampleRangeRmsDb(samples, keep.end, discardedEnd);
      isDiscarded = isAboveBoundaryThreshold(discardedRms, threshold);
      cutDurationSec = roundSec(next.end - next.start);
      if (isDiscarded) discarded += 1;
    }
    rawFindings.push({
      rawRmsDb: boundaryRms,
      segmentIndex: i,
      finding: {
        keepEndSec: keep.end,
        rmsDb: roundDb(boundaryRms),
        discarded: isDiscarded,
        ...(cutDurationSec === undefined ? {} : { cutDurationSec }),
      },
    });
  }

  rawFindings.sort(
    (a, b) => b.rawRmsDb - a.rawRmsDb ||
      a.finding.keepEndSec - b.finding.keepEndSec ||
      a.segmentIndex - b.segmentIndex,
  );
  const findings = rawFindings.map(({ finding }) => finding);
  return {
    version: 1,
    measurement: {
      decoder: "ffmpeg",
      channels: 1,
      sampleRateHz: BOUNDARY_SAMPLE_RATE_HZ,
      sampleFormat: "signed-pcm16le",
      floorWindowMs: FLOOR_WINDOW_SEC * 1000,
      floorPercentile: FLOOR_PERCENTILE,
      thresholdOffsetDb: THRESHOLD_OFFSET_DB,
      boundaryLookaheadMs: BOUNDARY_LOOKAHEAD_SEC * 1000,
      silenceRmsDb: SILENCE_RMS_DB,
      noiseFloorDb: roundDb(floor),
      thresholdDb: roundDb(threshold),
    },
    summary: { keepBoundaries, flagged: findings.length, discarded },
    findings,
  };
}

function readRequiredJson<T>(path: string, name: string): T {
  if (!existsSync(path)) throw new Error(`${name} が見つかりません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${name} を読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** ffmpeg の stdout から mono 8kHz signed PCM16LE を得る。入力ファイルは変更しない。 */
export async function decodeBoundaryPcm(audioPath: string): Promise<Int16Array> {
  const raw = await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error", "-i", audioPath,
      "-ac", "1", "-ar", String(BOUNDARY_SAMPLE_RATE_HZ),
      "-c:a", "pcm_s16le", "-f", "s16le", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg が見つかりません。インストールされているか確認してください"));
      } else {
        reject(new Error(`ffmpeg を起動できません: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg の音声デコードに失敗しました: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
  });
  if (raw.length === 0) throw new Error("ffmpeg の音声デコード結果が空です");
  if (raw.length % 2 !== 0) throw new Error("ffmpeg の PCM16LE 出力バイト数が不正です");
  const samples = new Int16Array(raw.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = raw.readInt16LE(i * 2);
  return samples;
}

/** manifest.audio.micWav と cutplan.json だけを読み、録画フォルダへは書かない。 */
export async function boundaryCheck(dir: string): Promise<BoundaryCheckReport> {
  const manifest = readRequiredJson<Manifest>(resolve(dir, "manifest.json"), "manifest.json");
  const cutplan = readRequiredJson<CutPlan>(resolve(dir, "cutplan.json"), "cutplan.json");
  if (typeof manifest?.audio?.micWav !== "string" || manifest.audio.micWav.length === 0) {
    throw new Error("manifest.json の audio.micWav が不正です");
  }
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const samples = await decodeBoundaryPcm(audioPath);
  const pcmDurationSec = samples.length / BOUNDARY_SAMPLE_RATE_HZ;
  if (
    Number.isFinite(manifest.durationSec) && manifest.durationSec > 0 &&
    Math.abs(manifest.durationSec - pcmDurationSec) > BOUNDARY_LOOKAHEAD_SEC
  ) {
    throw new Error(
      `manifest.json の durationSec (${manifest.durationSec}) とマイク音声尺 (${pcmDurationSec}) の差が` +
        ` ${BOUNDARY_LOOKAHEAD_SEC}秒を超えています`,
    );
  }
  const timelineDurationSec = Number.isFinite(manifest.durationSec) && manifest.durationSec > 0
    ? manifest.durationSec
    : pcmDurationSec;
  return analyzeBoundarySamples(samples, cutplan, timelineDurationSec);
}

export function formatBoundaryCheckReport(report: BoundaryCheckReport): string[] {
  const { measurement, summary } = report;
  const lines = [
    `boundary-check: keep終端 ${summary.keepBoundaries}件 / flag ${summary.flagged}件 / 実際にdiscard ${summary.discarded}件`,
    `測定: mono ${measurement.sampleRateHz}Hz PCM16LE / 床 ${measurement.noiseFloorDb.toFixed(1)}dB / 閾値 ${measurement.thresholdDb.toFixed(1)}dB (床+${measurement.thresholdOffsetDb}dB)`,
  ];
  for (const finding of report.findings) {
    const discardedLabel = finding.discarded ? ` / discarded / cut ${finding.cutDurationSec?.toFixed(2)}s` : "";
    lines.push(`  ${finding.keepEndSec.toFixed(2)}s: ${finding.rmsDb.toFixed(1)}dB${discardedLabel}`);
  }
  return lines;
}
