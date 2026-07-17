import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCutplanApproved } from "../lib/approval.ts";
import type { Config } from "../lib/config.ts";
import { detectSilence } from "../lib/ffmpeg.ts";
import {
  estimateOperationalFloor,
  FLOOR_METHOD,
  resolveEffectiveSilenceDb,
} from "../lib/silenceFloor.ts";
import type { CutPlan, Interval, Manifest } from "../types.ts";
import { analyzeBoundaryDirection } from "./boundaryDirection.ts";
import { analyzeBoundarySamples, decodeBoundaryPcm } from "./boundaryCheck.ts";
import {
  buildAutoCuts,
  SILENCE_COMPACTION_PRESETS,
  type DetectParams,
} from "./detect.ts";
import { cutplanFromAutoKeeps } from "./silenceSweep.ts";

export const COMPACTION_MIN_SILENCE_GRID = [0.3, 0.5, 0.7, 1] as const;
export const COMPACTION_PAD_GRID = [0.05, 0.15, 0.3] as const;
export const COMPACTION_MIN_KEEP_GRID = [0.3, 0.5, 0.8] as const;

export interface CompactionSweepResult {
  minSilenceSec: number;
  padSec: number;
  minKeepSec: number;
  effectiveSilenceDb: number;
  tailSpeechCount: number;
  candidateRemovedSec: number;
  keepCandidateCount: number;
  rescueExpandedPoints: number;
  rescueExpandedSec: number;
  semanticNarrowedPoints: number;
  semanticNarrowedSec: number;
  exactPoints: number;
  ambiguousPoints: number;
}

export interface CompactionSweepReport {
  version: 1;
  boundaryPolicy: {
    method: typeof FLOOR_METHOD;
    floorDb: number;
    floorOffsetDb: number;
    effectiveSilenceDb: number;
  };
  grid: {
    minSilenceSec: number[];
    padSec: number[];
    minKeepSec: number[];
    candidateCount: number;
  };
  results: CompactionSweepResult[];
  selectedPresets: Record<keyof typeof SILENCE_COMPACTION_PRESETS, CompactionSweepResult>;
  twoThreshold: { status: "not-adopted"; reason: "dominated-or-insufficient-gain" };
  hypothesis: { h7: "supported" | "rejected" | "inconclusive" };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export async function collectCompactionSilences(
  probe: (minSilenceSec: number) => Promise<Interval[]>,
): Promise<Map<number, Interval[]>> {
  const result = new Map<number, Interval[]>();
  for (const minSilenceSec of COMPACTION_MIN_SILENCE_GRID) {
    result.set(minSilenceSec, await probe(minSilenceSec));
  }
  return result;
}

export function evaluateH7(
  selected: Record<keyof typeof SILENCE_COMPACTION_PRESETS, CompactionSweepResult>,
): "supported" | "rejected" | "inconclusive" {
  const values = [selected.gentle, selected.balanced, selected.tight];
  if (!values.every((result) => result.effectiveSilenceDb === values[0]!.effectiveSilenceDb)) {
    return "inconclusive";
  }
  const removed = values.map((result) => result.candidateRemovedSec);
  const removalDifference = Math.max(...removed) - Math.min(...removed);
  const meaningfulRemovalDifference = removalDifference >= 10 && removalDifference >= Math.min(...removed) * 0.05;
  if (!meaningfulRemovalDifference) return "inconclusive";
  const allTailSafe = values.every((result) => result.tailSpeechCount === 0);
  const sameRescuePoints = values.every(
    (result) => result.rescueExpandedPoints === values[0]!.rescueExpandedPoints,
  );
  const rescueSecs = values.map((result) => result.rescueExpandedSec);
  const rescueStable = Math.max(...rescueSecs) - Math.min(...rescueSecs) <= 0.05 + 1e-9;
  if (allTailSafe && sameRescuePoints && rescueStable) return "supported";
  if (!allTailSafe || !sameRescuePoints || !rescueStable) return "rejected";
  return "inconclusive";
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function compactionSweep(dir: string, cfg: Config): Promise<CompactionSweepReport> {
  const manifest = readJson<Manifest>(resolve(dir, "manifest.json"));
  const humanCutplan = readJson<CutPlan>(resolve(dir, "cutplan.json"));
  const gate = isCutplanApproved(dir, humanCutplan);
  if (!gate.ok) throw new Error(`human final として使えません: ${gate.reason}`);
  if (cfg.detect.calibration?.enabled !== true) {
    throw new Error("compaction-sweep には detect.calibration.enabled: true が必要です");
  }
  if (cfg.detect.calibration.method !== FLOOR_METHOD) {
    throw new Error(`detect.calibration.method は ${FLOOR_METHOD} である必要があります`);
  }
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const floor = await estimateOperationalFloor(
    manifest.durationSec,
    (thresholdDb, minSilenceSec) => detectSilence(audioPath, thresholdDb, minSilenceSec),
  );
  const effectiveSilenceDb = resolveEffectiveSilenceDb(
    floor.floorDb,
    cfg.detect.calibration.floorOffsetDb,
  );
  const silences = await collectCompactionSilences(
    (minSilenceSec) => detectSilence(audioPath, effectiveSilenceDb, minSilenceSec),
  );
  const samples = await decodeBoundaryPcm(audioPath);
  const results: CompactionSweepResult[] = [];
  for (const minSilenceSec of COMPACTION_MIN_SILENCE_GRID) {
    for (const padSec of COMPACTION_PAD_GRID) {
      for (const minKeepSec of COMPACTION_MIN_KEEP_GRID) {
        const params: DetectParams = { silenceDb: effectiveSilenceDb, minSilenceSec, padSec, minKeepSec };
        const cuts = buildAutoCuts(silences.get(minSilenceSec)!, manifest.durationSec, params);
        const memoryCutplan = cutplanFromAutoKeeps(cuts.keepSegments, manifest.durationSec);
        const safety = analyzeBoundarySamples(samples, memoryCutplan, manifest.durationSec);
        const direction = analyzeBoundaryDirection(cuts.keepSegments, humanCutplan, manifest.durationSec, {
          silenceDb: effectiveSilenceDb, minSilenceSec, padSec, minKeepSec,
        });
        results.push({
          minSilenceSec, padSec, minKeepSec, effectiveSilenceDb,
          tailSpeechCount: safety.summary.discarded,
          candidateRemovedSec: round2(cuts.originalDurationSec - cuts.keptDurationSec),
          keepCandidateCount: cuts.keepSegments.length,
          rescueExpandedPoints: direction.boundaries.expanded,
          rescueExpandedSec: direction.duration.expandedSec,
          semanticNarrowedPoints: direction.boundaries.narrowed,
          semanticNarrowedSec: direction.duration.narrowedSec,
          exactPoints: direction.boundaries.exact,
          ambiguousPoints: direction.boundaries.ambiguous,
        });
      }
    }
  }
  const resultForPreset = (preset: keyof typeof SILENCE_COMPACTION_PRESETS) => {
    const target = SILENCE_COMPACTION_PRESETS[preset];
    const result = results.find((item) =>
      item.minSilenceSec === target.minSilenceSec && item.padSec === target.padSec &&
      item.minKeepSec === target.minKeepSec
    );
    if (!result) throw new Error(`preset ${preset} に対応するgrid resultがありません`);
    return result;
  };
  const selectedPresets = {
    gentle: resultForPreset("gentle"),
    balanced: resultForPreset("balanced"),
    tight: resultForPreset("tight"),
  };
  return {
    version: 1,
    boundaryPolicy: {
      method: FLOOR_METHOD,
      floorDb: floor.floorDb,
      floorOffsetDb: cfg.detect.calibration.floorOffsetDb,
      effectiveSilenceDb,
    },
    grid: {
      minSilenceSec: [...COMPACTION_MIN_SILENCE_GRID],
      padSec: [...COMPACTION_PAD_GRID],
      minKeepSec: [...COMPACTION_MIN_KEEP_GRID],
      candidateCount: results.length,
    },
    results,
    selectedPresets,
    twoThreshold: { status: "not-adopted", reason: "dominated-or-insufficient-gain" },
    hypothesis: { h7: evaluateH7(selectedPresets) },
  };
}

export function formatCompactionSweepReport(report: CompactionSweepReport): string[] {
  const lines = [`compaction-sweep: ${report.results.length} candidates / H7 ${report.hypothesis.h7}`];
  for (const preset of ["gentle", "balanced", "tight"] as const) {
    const result = report.selectedPresets[preset];
    lines.push(`${preset}: tail ${result.tailSpeechCount} / removed ${result.candidateRemovedSec}s / keep ${result.keepCandidateCount}`);
  }
  return lines;
}
