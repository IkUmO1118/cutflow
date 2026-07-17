import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../lib/config.ts";
import { detectSilence } from "../lib/ffmpeg.ts";
import {
  estimateOperationalFloor,
  FLOOR_METHOD,
  FLOOR_PROBE_MIN_SILENCE_SEC,
  FLOOR_SEARCH_MAX_DB,
  FLOOR_SEARCH_MIN_DB,
  FLOOR_SEARCH_STEP_DB,
  FLOOR_TARGET_SILENT_RATIO,
  resolveEffectiveSilenceDb,
  type FloorEstimate,
} from "../lib/silenceFloor.ts";
import type { CutPlan, Manifest } from "../types.ts";
import { analyzeBoundarySamples, decodeBoundaryPcm } from "./boundaryCheck.ts";
import { detectAutoCuts } from "./detect.ts";
import { boundaryAgreement, cutplanFromAutoKeeps } from "./silenceSweep.ts";

export const FLOOR_OFFSET_CANDIDATES_DB = [0, 3, 6, 9, 12] as const;

interface CalibrationMetrics {
  effectiveSilenceDb: number;
  tailSpeechCount: number;
  candidateRemovedSec: number;
  removedRatio: number;
  keepCandidateCount: number;
  silenceCount: number;
  boundaryAgreement?: { matched: number; total: number; ratio: number };
}

export interface FloorCalibrationReport {
  version: 1;
  method: {
    name: typeof FLOOR_METHOD;
    probeMinSilenceSec: number;
    targetSilentRatio: number;
    searchMinDb: number;
    searchMaxDb: number;
    searchStepDb: number;
    thresholdMeasurement: "silencedetect-amplitude";
    safetyMeasurement: "pcm-rms-v0";
  };
  offsetCandidatesDb: number[];
  selectedOffsetDb: number;
  fit: {
    hasHumanReference: true;
    floorDb: number;
    floorCrossing: FloorEstimate["floorCrossing"];
    results: Array<{ offsetDb: number } & CalibrationMetrics & {
      boundaryAgreement: { matched: number; total: number; ratio: number };
    }>;
  };
  verification: Array<{
    hasHumanReference: boolean;
    floorDb: number | null;
    floorCrossing: FloorEstimate["floorCrossing"] | null;
    effectiveSilenceDb: number | null;
    tailSpeechCount: number | null;
    candidateRemovedSec: number | null;
    removedRatio: number | null;
    keepCandidateCount: number | null;
    silenceCount: number | null;
    boundaryAgreement?: { matched: number; total: number; ratio: number };
    status: "passed" | "failed";
    reasons: string[];
  }>;
  hypotheses: {
    singleOffset: "supported" | "rejected" | "inconclusive";
    h1: "supported" | "rejected" | "inconclusive";
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function readJson<T>(path: string, name: string): T {
  if (!existsSync(path)) throw new Error(`${name} が見つかりません: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${name} を読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasHumanReference(cutplan: CutPlan, durationSec: number): boolean {
  if (!Array.isArray(cutplan.segments)) return false;
  if (
    cutplan.approved === false && cutplan.segments.length === 1 &&
    cutplan.segments[0]?.action === "keep" && cutplan.segments[0].start === 0 &&
    Math.abs(cutplan.segments[0].end - durationSec) <= 1e-6
  ) return false;
  return cutplan.segments.some((segment) => segment.action === "keep");
}

async function loadRecording(dir: string): Promise<{
  manifest: Manifest;
  cutplan: CutPlan;
  audioPath: string;
  samples: Int16Array;
}> {
  const manifest = readJson<Manifest>(resolve(dir, "manifest.json"), "manifest.json");
  const cutplan = readJson<CutPlan>(resolve(dir, "cutplan.json"), "cutplan.json");
  if (!Number.isFinite(manifest.durationSec) || manifest.durationSec <= 0) {
    throw new Error("manifest.json の durationSec が不正です");
  }
  if (typeof manifest.audio?.micWav !== "string" || manifest.audio.micWav.length === 0) {
    throw new Error("manifest.json の audio.micWav が不正です");
  }
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const samples = await decodeBoundaryPcm(audioPath);
  analyzeBoundarySamples(samples, cutplan, manifest.durationSec);
  return { manifest, cutplan, audioPath, samples };
}

function cachedSilenceProbe(audioPath: string) {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof detectSilence>>>>();
  return (thresholdDb: number, minSilenceSec: number) => {
    const key = `${thresholdDb}:${minSilenceSec}`;
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = detectSilence(audioPath, thresholdDb, minSilenceSec);
      cache.set(key, pending);
    }
    return pending;
  };
}

async function measureMetrics(
  recording: Awaited<ReturnType<typeof loadRecording>>,
  cfg: Config,
  effectiveSilenceDb: number,
  humanReference: boolean,
): Promise<CalibrationMetrics> {
  const cuts = await detectAutoCuts(recording.audioPath, recording.manifest.durationSec, {
    silenceDb: effectiveSilenceDb,
    minSilenceSec: cfg.detect.minSilenceSec,
    padSec: cfg.detect.padSec,
    minKeepSec: cfg.detect.minKeepSec,
  });
  const boundary = analyzeBoundarySamples(
    recording.samples,
    cutplanFromAutoKeeps(cuts.keepSegments, recording.manifest.durationSec),
    recording.manifest.durationSec,
  );
  const candidateRemovedSec = round2(cuts.originalDurationSec - cuts.keptDurationSec);
  const metrics: CalibrationMetrics = {
    effectiveSilenceDb,
    tailSpeechCount: boundary.summary.discarded,
    candidateRemovedSec,
    removedRatio: round4(candidateRemovedSec / cuts.originalDurationSec),
    keepCandidateCount: cuts.keepSegments.length,
    silenceCount: cuts.silences.length,
  };
  if (humanReference) {
    metrics.boundaryAgreement = boundaryAgreement(
      recording.cutplan.segments.filter((segment) => segment.action === "keep"),
      cuts.keepSegments,
    );
  }
  return metrics;
}

export function selectFloorOffset(
  results: FloorCalibrationReport["fit"]["results"],
): number {
  const eligible = results.filter((result) => result.candidateRemovedSec > 0);
  if (eligible.length === 0) throw new Error("floor calibration は削減秒が正のoffset候補を選べません");
  eligible.sort((a, b) =>
    a.tailSpeechCount - b.tailSpeechCount ||
    b.boundaryAgreement.matched - a.boundaryAgreement.matched ||
    a.offsetDb - b.offsetDb
  );
  return eligible[0]!.offsetDb;
}

export function evaluateHoldout(metrics: CalibrationMetrics): { status: "passed" | "failed"; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.keepCandidateCount < 1) reasons.push("keepCandidateCount が1未満です");
  if (metrics.tailSpeechCount !== 0) reasons.push("tailSpeechCount が0ではありません");
  if (metrics.candidateRemovedSec <= 0) reasons.push("candidateRemovedSec が正ではありません");
  if (metrics.removedRatio > 0.05) reasons.push("removedRatio が0.05を超えています");
  return { status: reasons.length === 0 ? "passed" : "failed", reasons };
}

export async function floorCalibration(
  fitDir: string,
  verifyDirs: string[],
  cfg: Config,
): Promise<FloorCalibrationReport> {
  const fitRecording = await loadRecording(fitDir);
  if (!hasHumanReference(fitRecording.cutplan, fitRecording.manifest.durationSec)) {
    throw new Error("fit録画に人間の最終keep境界がありません");
  }
  const fitProbe = cachedSilenceProbe(fitRecording.audioPath);
  const fitFloor = await estimateOperationalFloor(fitRecording.manifest.durationSec, fitProbe);
  const fitResults: FloorCalibrationReport["fit"]["results"] = [];
  for (const offsetDb of FLOOR_OFFSET_CANDIDATES_DB) {
    const effectiveSilenceDb = resolveEffectiveSilenceDb(fitFloor.floorDb, offsetDb);
    const metrics = await measureMetrics(fitRecording, cfg, effectiveSilenceDb, true);
    fitResults.push({ offsetDb, ...metrics, boundaryAgreement: metrics.boundaryAgreement! });
  }
  const selectedOffsetDb = selectFloorOffset(fitResults);

  const verification: FloorCalibrationReport["verification"] = [];
  for (const dir of verifyDirs) {
    try {
      const recording = await loadRecording(dir);
      const humanReference = hasHumanReference(recording.cutplan, recording.manifest.durationSec);
      const floor = await estimateOperationalFloor(
        recording.manifest.durationSec,
        cachedSilenceProbe(recording.audioPath),
      );
      const metrics = await measureMetrics(
        recording,
        cfg,
        resolveEffectiveSilenceDb(floor.floorDb, selectedOffsetDb),
        humanReference,
      );
      const verdict = evaluateHoldout(metrics);
      verification.push({
        hasHumanReference: humanReference,
        floorDb: floor.floorDb,
        floorCrossing: floor.floorCrossing,
        ...metrics,
        status: verdict.status,
        reasons: verdict.reasons,
      });
    } catch (error) {
      verification.push({
        hasHumanReference: false,
        floorDb: null,
        floorCrossing: null,
        effectiveSilenceDb: null,
        tailSpeechCount: null,
        candidateRemovedSec: null,
        removedRatio: null,
        keepCandidateCount: null,
        silenceCount: null,
        status: "failed",
        reasons: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  const successfulFloors = verification
    .map((result) => result.floorDb)
    .filter((value): value is number => value !== null);
  const hypotheses: FloorCalibrationReport["hypotheses"] = {
    singleOffset: verification.length === 0
      ? "inconclusive"
      : verification.every((result) => result.status === "passed") ? "supported" : "rejected",
    h1: successfulFloors.length === 0
      ? "inconclusive"
      : successfulFloors.some((floorDb) => Math.abs(floorDb - fitFloor.floorDb) >= 3)
        ? "supported" : "rejected",
  };
  return {
    version: 1,
    method: {
      name: FLOOR_METHOD,
      probeMinSilenceSec: FLOOR_PROBE_MIN_SILENCE_SEC,
      targetSilentRatio: FLOOR_TARGET_SILENT_RATIO,
      searchMinDb: FLOOR_SEARCH_MIN_DB,
      searchMaxDb: FLOOR_SEARCH_MAX_DB,
      searchStepDb: FLOOR_SEARCH_STEP_DB,
      thresholdMeasurement: "silencedetect-amplitude",
      safetyMeasurement: "pcm-rms-v0",
    },
    offsetCandidatesDb: [...FLOOR_OFFSET_CANDIDATES_DB],
    selectedOffsetDb,
    fit: {
      hasHumanReference: true,
      floorDb: fitFloor.floorDb,
      floorCrossing: fitFloor.floorCrossing,
      results: fitResults,
    },
    verification,
    hypotheses,
  };
}

export function formatFloorCalibrationReport(report: FloorCalibrationReport): string[] {
  const lines = [
    `floor-calibration: floor ${report.fit.floorDb}dB / selected offset +${report.selectedOffsetDb}dB`,
  ];
  for (const result of report.fit.results) {
    lines.push(
      `  fit +${result.offsetDb}: ${result.effectiveSilenceDb}dB / tail ${result.tailSpeechCount} / ` +
        `removed ${result.candidateRemovedSec.toFixed(2)}s / agreement ${result.boundaryAgreement.matched}`,
    );
  }
  report.verification.forEach((result, index) => {
    lines.push(
      `  verify[${index}]: ${result.status}` +
        (result.floorDb === null ? ` / ${result.reasons.join("; ")}` : ` / floor ${result.floorDb}dB`),
    );
  });
  lines.push(`H1: ${report.hypotheses.h1} / single offset: ${report.hypotheses.singleOffset}`);
  return lines;
}
