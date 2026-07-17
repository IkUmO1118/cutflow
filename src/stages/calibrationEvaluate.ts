import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCutplanApproved } from "../lib/approval.ts";
import type { Config } from "../lib/config.ts";
import { detectSilence } from "../lib/ffmpeg.ts";
import { estimateOperationalFloor, FLOOR_METHOD, resolveEffectiveSilenceDb } from "../lib/silenceFloor.ts";
import type { CutPlan, Interval, Manifest } from "../types.ts";
import { analyzeBoundaryDirection } from "./boundaryDirection.ts";
import { analyzeBoundarySamples, decodeBoundaryPcm } from "./boundaryCheck.ts";
import { buildAutoCuts, SILENCE_COMPACTION_PRESETS } from "./detect.ts";
import { boundaryAgreement, boundaryExactVector, cutplanFromAutoKeeps } from "./silenceSweep.ts";

export const CALIBRATION_EVALUATION_VARIANTS = [
  "baseline", "calibration-only", "gentle", "balanced", "tight",
] as const;
type VariantName = typeof CALIBRATION_EVALUATION_VARIANTS[number];

export interface EvaluationVariant {
  name: VariantName;
  params: { silenceDb: number; minSilenceSec: number; padSec: number; minKeepSec: number };
  tailSpeechCount: number;
  candidateRemovedSec: number;
  keepCandidateCount: number;
  exact: { matched: number; total: number; ratio: number; vector: boolean[] };
  direction: {
    expandedPoints: number;
    expandedSec: number;
    narrowedPoints: number;
    narrowedSec: number;
    ambiguousPoints: number;
  };
}

export interface McNemarComparison {
  baseline: string;
  candidate: string;
  improvement: number;
  degradation: number;
  bothExact: number;
  neitherExact: number;
  discordant: number;
  agreementDelta: number;
  oneSidedImprovementP: number;
  oneSidedDegradationP: number;
}

export interface CalibrationEvaluateReport {
  version: 1;
  reference: { humanApproved: true; humanKeepCount: number; humanBoundaryCount: number };
  floor: { method: typeof FLOOR_METHOD; floorDb: number; offsetDb: 12; effectiveSilenceDb: number };
  primaryCandidate: "balanced";
  variants: EvaluationVariant[];
  comparisons: { h6Primary: McNemarComparison; programPrimary: McNemarComparison };
  hypotheses: {
    h6: "supported" | "rejected" | "inconclusive";
    program: "achieved" | "not-achieved";
  };
  verdict: {
    limitedDefectImprovement: boolean;
    h6: "supported" | "rejected" | "inconclusive";
    programSuccess: "achieved" | "not-achieved";
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function binomialUpperTail(n: number, k: number): number {
  if (n === 0 || k <= 0) return 1;
  if (k > n) return 0;
  let probability = 2 ** -n;
  let sum = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) sum += probability;
    if (i < n) probability *= (n - i) / (i + 1);
  }
  return Math.min(1, sum);
}

export function exactMcNemar(
  baselineName: string,
  candidateName: string,
  baseline: boolean[],
  candidate: boolean[],
): McNemarComparison {
  if (baseline.length !== candidate.length) throw new Error("McNemar vector長が一致しません");
  let improvement = 0; let degradation = 0; let bothExact = 0; let neitherExact = 0;
  for (let i = 0; i < baseline.length; i += 1) {
    if (baseline[i] && candidate[i]) bothExact += 1;
    else if (!baseline[i] && !candidate[i]) neitherExact += 1;
    else if (!baseline[i] && candidate[i]) improvement += 1;
    else degradation += 1;
  }
  const discordant = improvement + degradation;
  const agreementDelta = baseline.length === 0
    ? 0
    : round6((bothExact + improvement) / baseline.length - (bothExact + degradation) / baseline.length);
  return {
    baseline: baselineName,
    candidate: candidateName,
    improvement,
    degradation,
    bothExact,
    neitherExact,
    discordant,
    agreementDelta,
    oneSidedImprovementP: binomialUpperTail(discordant, improvement),
    oneSidedDegradationP: binomialUpperTail(discordant, degradation),
  };
}

export function evaluateH6Primary(
  baseline: EvaluationVariant,
  calibrationOnly: EvaluationVariant,
  comparison: McNemarComparison,
): "supported" | "rejected" | "inconclusive" {
  const rescueWorsened = calibrationOnly.direction.expandedPoints > baseline.direction.expandedPoints ||
    calibrationOnly.direction.expandedSec > baseline.direction.expandedSec;
  if (
    calibrationOnly.tailSpeechCount < baseline.tailSpeechCount &&
    comparison.agreementDelta >= 0.05 && comparison.oneSidedImprovementP < 0.05 &&
    !rescueWorsened
  ) return "supported";
  if (
    calibrationOnly.tailSpeechCount > baseline.tailSpeechCount ||
    (comparison.agreementDelta <= -0.05 && comparison.oneSidedDegradationP < 0.05) ||
    rescueWorsened
  ) return "rejected";
  return "inconclusive";
}

export function evaluateProgramPrimary(
  baseline: EvaluationVariant,
  balanced: EvaluationVariant,
  comparison: McNemarComparison,
): "achieved" | "not-achieved" {
  return balanced.tailSpeechCount < baseline.tailSpeechCount &&
    comparison.agreementDelta >= 0.05 && comparison.oneSidedImprovementP < 0.05
    ? "achieved" : "not-achieved";
}

export function evaluateLimitedDefectImprovement(
  baseline: EvaluationVariant,
  calibrationOnly: EvaluationVariant,
): boolean {
  return calibrationOnly.tailSpeechCount < baseline.tailSpeechCount && (
    calibrationOnly.direction.expandedPoints < baseline.direction.expandedPoints ||
    calibrationOnly.direction.expandedSec < baseline.direction.expandedSec
  );
}

export async function calibrationEvaluate(dir: string, _cfg: Config): Promise<CalibrationEvaluateReport> {
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as Manifest;
  const humanCutplan = JSON.parse(readFileSync(resolve(dir, "cutplan.json"), "utf8")) as CutPlan;
  const gate = isCutplanApproved(dir, humanCutplan);
  if (!gate.ok) throw new Error(`human final として使えません: ${gate.reason}`);
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const floor = await estimateOperationalFloor(
    manifest.durationSec,
    (thresholdDb, minSilenceSec) => detectSilence(audioPath, thresholdDb, minSilenceSec),
  );
  const effectiveSilenceDb = resolveEffectiveSilenceDb(floor.floorDb, 12);
  const samples = await decodeBoundaryPcm(audioPath);
  const humanKeeps = humanCutplan.segments.filter((segment) => segment.action === "keep");
  const definitions: Array<{ name: VariantName; params: EvaluationVariant["params"] }> = [
    { name: "baseline", params: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 } },
    { name: "calibration-only", params: { silenceDb: effectiveSilenceDb, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 } },
    ...(["gentle", "balanced", "tight"] as const).map((name) => ({
      name,
      params: { silenceDb: effectiveSilenceDb, ...SILENCE_COMPACTION_PRESETS[name] },
    })),
  ];
  const silenceCache = new Map<string, Interval[]>();
  const variants: EvaluationVariant[] = [];
  for (const definition of definitions) {
    const key = `${definition.params.silenceDb}:${definition.params.minSilenceSec}`;
    let silences = silenceCache.get(key);
    if (!silences) {
      silences = await detectSilence(audioPath, definition.params.silenceDb, definition.params.minSilenceSec);
      silenceCache.set(key, silences);
    }
    const cuts = buildAutoCuts(silences, manifest.durationSec, definition.params);
    const memoryCutplan = cutplanFromAutoKeeps(cuts.keepSegments, manifest.durationSec);
    const safety = analyzeBoundarySamples(samples, memoryCutplan, manifest.durationSec);
    const direction = analyzeBoundaryDirection(cuts.keepSegments, humanCutplan, manifest.durationSec, definition.params);
    const vector = boundaryExactVector(humanKeeps, cuts.keepSegments);
    const agreement = boundaryAgreement(humanKeeps, cuts.keepSegments);
    variants.push({
      name: definition.name,
      params: definition.params,
      tailSpeechCount: safety.summary.discarded,
      candidateRemovedSec: round2(cuts.originalDurationSec - cuts.keptDurationSec),
      keepCandidateCount: cuts.keepSegments.length,
      exact: { ...agreement, vector },
      direction: {
        expandedPoints: direction.boundaries.expanded,
        expandedSec: direction.duration.expandedSec,
        narrowedPoints: direction.boundaries.narrowed,
        narrowedSec: direction.duration.narrowedSec,
        ambiguousPoints: direction.boundaries.ambiguous,
      },
    });
  }
  const byName = (name: VariantName) => variants.find((variant) => variant.name === name)!;
  const baseline = byName("baseline");
  const calibrationOnly = byName("calibration-only");
  const balanced = byName("balanced");
  const h6Primary = exactMcNemar("baseline", "calibration-only", baseline.exact.vector, calibrationOnly.exact.vector);
  const programPrimary = exactMcNemar("baseline", "balanced", baseline.exact.vector, balanced.exact.vector);
  const h6 = evaluateH6Primary(baseline, calibrationOnly, h6Primary);
  const program = evaluateProgramPrimary(baseline, balanced, programPrimary);
  return {
    version: 1,
    reference: { humanApproved: true, humanKeepCount: humanKeeps.length, humanBoundaryCount: humanKeeps.length * 2 },
    floor: { method: FLOOR_METHOD, floorDb: floor.floorDb, offsetDb: 12, effectiveSilenceDb },
    primaryCandidate: "balanced",
    variants,
    comparisons: { h6Primary, programPrimary },
    hypotheses: { h6, program },
    verdict: {
      limitedDefectImprovement: evaluateLimitedDefectImprovement(baseline, calibrationOnly),
      h6,
      programSuccess: program,
    },
  };
}

export function formatCalibrationEvaluateReport(report: CalibrationEvaluateReport): string[] {
  const lines = [`calibration-evaluate: H6 ${report.hypotheses.h6} / program ${report.hypotheses.program}`];
  for (const variant of report.variants) {
    lines.push(`${variant.name}: tail ${variant.tailSpeechCount} / exact ${variant.exact.matched}/${variant.exact.total} / removed ${variant.candidateRemovedSec}s`);
  }
  return lines;
}
