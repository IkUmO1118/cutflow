import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../lib/config.ts";
import type { AutoCuts, CutPlan, Interval, Manifest, PlanSegment } from "../types.ts";
import { analyzeBoundarySamples, decodeBoundaryPcm } from "./boundaryCheck.ts";
import { detectAutoCuts } from "./detect.ts";

export const SILENCE_SWEEP_THRESHOLDS_DB = [-35, -40, -45, -50] as const;
export const BOUNDARY_AGREEMENT_TOLERANCE_SEC = 1e-6;

export interface SilenceSweepResult {
  silenceDb: number;
  tailSpeechCount: number;
  candidateRemovedSec: number;
  keepCandidateCount: number;
  boundaryAgreement: { matched: number; total: number; ratio: number };
}

export interface SilenceSweepReport {
  version: 1;
  thresholdsDb: number[];
  fixed: {
    minSilenceSec: number;
    padSec: number;
    minKeepSec: number;
    boundaryToleranceSec: number;
  };
  reference: { humanKeepCount: number; humanBoundaryCount: number };
  results: SilenceSweepResult[];
  hypotheses: {
    h2: {
      status: "supported" | "rejected" | "inconclusive";
      nonIncreasing: boolean;
      strictDecrease: boolean;
    };
    h6Proxy: { status: "preliminary-supported" | "not-supported" | "inconclusive" };
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** AutoCuts keep の補区間を cut で埋め、0..duration を連続被覆するメモリcutplan。 */
export function cutplanFromAutoKeeps(keeps: Interval[], durationSec: number): CutPlan {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("silence-sweep の durationSec は有限の正数である必要があります");
  }
  for (let i = 0; i < keeps.length; i += 1) {
    const keep = keeps[i]!;
    if (
      !Number.isFinite(keep.start) || !Number.isFinite(keep.end) ||
      keep.start < 0 || keep.end <= keep.start || keep.end > durationSec
    ) {
      throw new Error(`silence-sweep の keepSegments[${i}] が不正または音声尺外です`);
    }
    const previous = keeps[i - 1];
    if (previous !== undefined && keep.start < previous.end) {
      throw new Error(`silence-sweep の keepSegments[${i - 1}] と keepSegments[${i}] が重複または昇順外です`);
    }
  }
  const segments: PlanSegment[] = [];
  let cursor = 0;
  for (const keep of keeps) {
    if (keep.start > cursor) {
      segments.push({ start: cursor, end: keep.start, action: "cut", reason: "silence-sweep" });
    }
    segments.push({ start: keep.start, end: keep.end, action: "keep", reason: "silence-sweep" });
    cursor = keep.end;
  }
  if (cursor < durationSec) {
    segments.push({ start: cursor, end: durationSec, action: "cut", reason: "silence-sweep" });
  }
  if (segments.length === 0 && durationSec > 0) {
    segments.push({ start: 0, end: durationSec, action: "cut", reason: "silence-sweep" });
  }
  return { approved: false, segments };
}

export function boundaryAgreement(
  humanKeeps: Interval[],
  candidateKeeps: Interval[],
): { matched: number; total: number; ratio: number } {
  const vector = boundaryExactVector(humanKeeps, candidateKeeps);
  const matched = vector.filter(Boolean).length;
  return {
    matched,
    total: vector.length,
    ratio: round6(matched / vector.length),
  };
}

/** human boundary出現(start/end各1)ごとのexact一致vector。重複出現も別々に保持する。 */
export function boundaryExactVector(humanKeeps: Interval[], candidateKeeps: Interval[]): boolean[] {
  const human = humanKeeps.flatMap((keep) => [keep.start, keep.end]);
  if (human.length === 0) {
    throw new Error("人間の最終 cutplan に keep がなく、境界一致を比較できません");
  }
  const candidate = candidateKeeps.flatMap((keep) => [keep.start, keep.end]);
  return human.map((boundary) =>
    candidate.some((other) => Math.abs(boundary - other) <= BOUNDARY_AGREEMENT_TOLERANCE_SEC)
  );
}

export function evaluateSweepHypotheses(results: SilenceSweepResult[]): SilenceSweepReport["hypotheses"] {
  const pairs = results.slice(1).map((result, index) => [results[index]!, result] as const);
  const nonIncreasing = pairs.every(([previous, current]) =>
    current.tailSpeechCount <= previous.tailSpeechCount
  );
  const strictDecrease = pairs.some(([previous, current]) =>
    current.tailSpeechCount < previous.tailSpeechCount
  );
  const h2Status = !nonIncreasing ? "rejected" : strictDecrease ? "supported" : "inconclusive";
  const baseline = results[0];
  const later = baseline === undefined ? [] : results.slice(1);
  const tailDecreaseFromBaseline = later.some((current) =>
    current.tailSpeechCount < baseline!.tailSpeechCount
  );
  const tailDecreaseWithAgreementIncrease = later.some((current) =>
    current.tailSpeechCount < baseline!.tailSpeechCount &&
    current.boundaryAgreement.matched > baseline!.boundaryAgreement.matched
  );
  return {
    h2: { status: h2Status, nonIncreasing, strictDecrease },
    h6Proxy: {
      status: tailDecreaseWithAgreementIncrease
        ? "preliminary-supported"
        : tailDecreaseFromBaseline ? "not-supported" : "inconclusive",
    },
  };
}

export function buildSilenceSweepReport(
  cfg: Config,
  humanCutplan: CutPlan,
  autoCuts: AutoCuts[],
  tailSpeechCounts: number[],
): SilenceSweepReport {
  if (
    autoCuts.length !== SILENCE_SWEEP_THRESHOLDS_DB.length ||
    tailSpeechCounts.length !== SILENCE_SWEEP_THRESHOLDS_DB.length
  ) {
    throw new Error("silence-sweep は thresholds/autoCuts/tailSpeechCounts が各4件必要です");
  }
  for (let i = 0; i < SILENCE_SWEEP_THRESHOLDS_DB.length; i += 1) {
    if (autoCuts[i]!.params.silenceDb !== SILENCE_SWEEP_THRESHOLDS_DB[i]) {
      throw new Error(
        `autoCuts[${i}].params.silenceDb が threshold ${SILENCE_SWEEP_THRESHOLDS_DB[i]} と一致しません`,
      );
    }
  }
  const humanKeeps = humanCutplan.segments.filter((segment) => segment.action === "keep");
  const results = autoCuts.map((cuts, index): SilenceSweepResult => ({
    silenceDb: SILENCE_SWEEP_THRESHOLDS_DB[index]!,
    tailSpeechCount: tailSpeechCounts[index]!,
    candidateRemovedSec: round2(cuts.originalDurationSec - cuts.keptDurationSec),
    keepCandidateCount: cuts.keepSegments.length,
    boundaryAgreement: boundaryAgreement(humanKeeps, cuts.keepSegments),
  }));
  return {
    version: 1,
    thresholdsDb: [...SILENCE_SWEEP_THRESHOLDS_DB],
    fixed: {
      minSilenceSec: cfg.detect.minSilenceSec,
      padSec: cfg.detect.padSec,
      minKeepSec: cfg.detect.minKeepSec,
      boundaryToleranceSec: BOUNDARY_AGREEMENT_TOLERANCE_SEC,
    },
    reference: {
      humanKeepCount: humanKeeps.length,
      humanBoundaryCount: humanKeeps.length * 2,
    },
    results,
    hypotheses: evaluateSweepHypotheses(results),
  };
}

function readJson<T>(path: string, name: string): T {
  if (!existsSync(path)) throw new Error(`${name} が見つかりません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${name} を読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 4条件をread-onlyで測る。PCM decodeは全条件で共有し1回だけ行う。 */
export async function silenceSweep(dir: string, cfg: Config): Promise<SilenceSweepReport> {
  const manifest = readJson<Manifest>(resolve(dir, "manifest.json"), "manifest.json");
  const humanCutplan = readJson<CutPlan>(resolve(dir, "cutplan.json"), "cutplan.json");
  if (typeof manifest?.audio?.micWav !== "string" || manifest.audio.micWav.length === 0) {
    throw new Error("manifest.json の audio.micWav が不正です");
  }
  if (!Number.isFinite(manifest.durationSec) || manifest.durationSec <= 0) {
    throw new Error("manifest.json の durationSec が不正です");
  }
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const samples = await decodeBoundaryPcm(audioPath);
  // 人間cutplanもV0と同じ構造検証へ通す。計測結果自体はreference境界だけを使う。
  analyzeBoundarySamples(samples, humanCutplan, manifest.durationSec);

  const autoCuts: AutoCuts[] = [];
  const tailSpeechCounts: number[] = [];
  for (const silenceDb of SILENCE_SWEEP_THRESHOLDS_DB) {
    const cuts = await detectAutoCuts(audioPath, manifest.durationSec, {
      silenceDb,
      minSilenceSec: cfg.detect.minSilenceSec,
      padSec: cfg.detect.padSec,
      minKeepSec: cfg.detect.minKeepSec,
    });
    const candidateCutplan = cutplanFromAutoKeeps(cuts.keepSegments, manifest.durationSec);
    const boundaryReport = analyzeBoundarySamples(samples, candidateCutplan, manifest.durationSec);
    autoCuts.push(cuts);
    tailSpeechCounts.push(boundaryReport.summary.discarded);
  }
  return buildSilenceSweepReport(cfg, humanCutplan, autoCuts, tailSpeechCounts);
}

export function formatSilenceSweepReport(report: SilenceSweepReport): string[] {
  const lines = [
    "silence-sweep: threshold / 語尾食い / 削減秒 / keep候補 / 人間境界一致",
  ];
  for (const result of report.results) {
    lines.push(
      `  ${result.silenceDb}dB: ${result.tailSpeechCount}件 / ${result.candidateRemovedSec.toFixed(2)}秒 / ` +
        `${result.keepCandidateCount}件 / ${result.boundaryAgreement.matched}/${result.boundaryAgreement.total}`,
    );
  }
  lines.push(`H2: ${report.hypotheses.h2.status} / H6 proxy: ${report.hypotheses.h6Proxy.status}`);
  return lines;
}
