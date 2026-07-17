import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isCutplanApproved } from "../lib/approval.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Interval, Manifest } from "../types.ts";
import { detectAutoCuts } from "./detect.ts";

export const DIRECTION_EPSILON_SEC = 1e-6;

type Direction = "expanded" | "narrowed" | "redundant" | "ambiguous";
type DetailKind = "outer" | "split-added-cut" | "touching-extension" | "added-keep" |
  "redundant-adjacent-keep" | "ambiguous";

export interface BoundaryDirectionDetail {
  humanKeepIndex: number;
  side: "start" | "end";
  at: number;
  classification: Direction;
  kind: DetailKind;
  distanceSec: number | null;
}

export interface BoundaryDirectionReport {
  version: 1;
  detect: {
    silenceDb?: number;
    minSilenceSec?: number;
    padSec?: number;
    minKeepSec?: number;
    keepCount: number;
    boundaryCount: number;
  };
  reference: { humanKeepCount: number; humanBoundaryCount: number };
  boundaries: {
    exact: number;
    unmatched: number;
    expanded: number;
    narrowed: number;
    redundant: number;
    ambiguous: number;
    directionalClassificationRate: number;
    directionalCoverageOfAllUnmatched: number;
    expandedShare: number;
    narrowedShare: number;
  };
  structure: {
    splitAddedCutBoundaries: number;
    splitAddedCutGaps: number;
    outerExpanded: number;
    outerNarrowed: number;
    touchingExpanded: number;
    addedHumanKeeps: number;
    deletedDetectKeeps: number;
    joinedDetectGaps: number;
    complexComponents: number;
  };
  distanceSec: {
    expanded: DistanceSummary;
    narrowed: DistanceSummary;
  };
  duration: {
    expandedSec: number;
    narrowedSec: number;
    commonKeepSec: number;
    commonCutSec: number;
    totalSec: number;
  };
  details: BoundaryDirectionDetail[];
  hypothesis: {
    h3: "supported" | "rejected" | "inconclusive";
  };
}

interface DistanceSummary {
  n: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  sum: number;
}
interface Occurrence { humanKeepIndex: number; side: "start" | "end"; at: number; resolved: boolean }

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const close = (a: number, b: number) => Math.abs(a - b) <= DIRECTION_EPSILON_SEC;
const overlaps = (a: Interval, b: Interval) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > DIRECTION_EPSILON_SEC;

function merged(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out[out.length - 1];
    if (last && interval.start <= last.end + DIRECTION_EPSILON_SEC) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

function intervalSec(intervals: Interval[]): number {
  return merged(intervals).reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function intersectionSec(a: Interval[], b: Interval[]): number {
  const left = merged(a); const right = merged(b);
  let i = 0; let j = 0; let total = 0;
  while (i < left.length && j < right.length) {
    total += Math.max(0, Math.min(left[i]!.end, right[j]!.end) - Math.max(left[i]!.start, right[j]!.start));
    if (left[i]!.end < right[j]!.end) i += 1; else j += 1;
  }
  return total;
}

export function summarizeBoundaryDistances(values: number[]): DistanceSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)]!;
  return sorted.length === 0 ? {
    n: 0, min: null, p25: null, median: null, p75: null, p90: null, max: null, sum: 0,
  } : {
    n: sorted.length,
    min: round3(sorted[0]!),
    p25: round3(percentile(0.25)),
    median: round3(percentile(0.5)),
    p75: round3(percentile(0.75)),
    p90: round3(percentile(0.9)),
    max: round3(sorted[sorted.length - 1]!),
    sum: round3(sorted.reduce((sum, value) => sum + value, 0)),
  };
}

export function evaluateBoundaryDirectionH3(input: {
  directionalClassificationRate: number;
  expandedShare: number;
  narrowedShare: number;
  expandedSec: number;
  narrowedSec: number;
}): "supported" | "rejected" | "inconclusive" {
  if (
    input.directionalClassificationRate >= 0.8 && input.expandedShare >= 0.6 &&
    input.expandedSec > input.narrowedSec
  ) return "supported";
  if (
    input.directionalClassificationRate >= 0.8 && input.narrowedShare >= 0.6 &&
    input.narrowedSec > input.expandedSec
  ) return "rejected";
  return "inconclusive";
}

function validateKeeps(name: string, keeps: Interval[], durationSec: number): void {
  for (let i = 0; i < keeps.length; i += 1) {
    const keep = keeps[i]!;
    if (
      !Number.isFinite(keep.start) || !Number.isFinite(keep.end) || keep.start < 0 ||
      keep.end <= keep.start || keep.end > durationSec + DIRECTION_EPSILON_SEC
    ) throw new Error(`${name}[${i}] が不正またはduration外です`);
    const previous = keeps[i - 1];
    if (previous && keep.start < previous.end - DIRECTION_EPSILON_SEC) {
      throw new Error(`${name}[${i - 1}] と ${name}[${i}] が重複または昇順外です`);
    }
  }
}

export function analyzeBoundaryDirection(
  detectKeeps: Interval[],
  humanCutplan: CutPlan,
  durationSec: number,
  detectParams?: { silenceDb: number; minSilenceSec: number; padSec: number; minKeepSec: number },
): BoundaryDirectionReport {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("durationSec が不正です");
  const humanKeeps = humanCutplan.segments.filter((segment) => segment.action === "keep");
  if (humanKeeps.length === 0) throw new Error("human cutplan に keep がありません");
  validateKeeps("detectKeeps", detectKeeps, durationSec);
  validateKeeps("humanKeeps", humanKeeps, durationSec);
  const detectBoundaries = detectKeeps.flatMap((keep) => [keep.start, keep.end]);
  const occurrences: Occurrence[] = humanKeeps.flatMap((keep, humanKeepIndex) => [
    { humanKeepIndex, side: "start" as const, at: keep.start, resolved: false },
    { humanKeepIndex, side: "end" as const, at: keep.end, resolved: false },
  ]);
  let exact = 0;
  for (const occurrence of occurrences) {
    if (detectBoundaries.some((boundary) => close(boundary, occurrence.at))) {
      occurrence.resolved = true; exact += 1;
    }
  }

  const details: BoundaryDirectionDetail[] = [];
  const distances = { expanded: [] as number[], narrowed: [] as number[] };
  const structure = {
    splitAddedCutBoundaries: 0, splitAddedCutGaps: 0, outerExpanded: 0, outerNarrowed: 0,
    touchingExpanded: 0, addedHumanKeeps: 0, deletedDetectKeeps: 0,
    joinedDetectGaps: 0, complexComponents: 0,
  };
  const resolveOccurrence = (
    humanKeepIndex: number, side: "start" | "end", classification: Direction,
    kind: DetailKind, distanceSec: number | null,
  ): boolean => {
    const occurrence = occurrences.find((item) =>
      !item.resolved && item.humanKeepIndex === humanKeepIndex && item.side === side
    );
    if (!occurrence) return false;
    occurrence.resolved = true;
    const roundedDistance = distanceSec === null ? null : round3(distanceSec);
    if (roundedDistance !== null && (classification === "expanded" || classification === "narrowed")) {
      distances[classification].push(distanceSec!);
    }
    details.push({ humanKeepIndex, side, at: occurrence.at, classification, kind, distanceSec: roundedDistance });
    return true;
  };

  // exactでないkeep→keep同時刻は操作上の境界ではないため両出現をredundantにする。
  for (let i = 0; i + 1 < humanKeeps.length; i += 1) {
    if (close(humanKeeps[i]!.end, humanKeeps[i + 1]!.start)) {
      resolveOccurrence(i, "end", "redundant", "redundant-adjacent-keep", null);
      resolveOccurrence(i + 1, "start", "redundant", "redundant-adjacent-keep", null);
    }
  }

  const dAdj = detectKeeps.map(() => [] as number[]);
  const hAdj = humanKeeps.map(() => [] as number[]);
  for (let d = 0; d < detectKeeps.length; d += 1) for (let h = 0; h < humanKeeps.length; h += 1) {
    if (overlaps(detectKeeps[d]!, humanKeeps[h]!)) { dAdj[d]!.push(h); hAdj[h]!.push(d); }
  }
  const seenD = new Set<number>(); const seenH = new Set<number>();
  for (let seed = 0; seed < detectKeeps.length; seed += 1) {
    if (seenD.has(seed) || dAdj[seed]!.length === 0) continue;
    const ds: number[] = []; const hs: number[] = []; const queue: Array<["d" | "h", number]> = [["d", seed]];
    while (queue.length) {
      const [kind, index] = queue.shift()!;
      if (kind === "d") {
        if (seenD.has(index)) continue; seenD.add(index); ds.push(index);
        dAdj[index]!.forEach((h) => queue.push(["h", h]));
      } else {
        if (seenH.has(index)) continue; seenH.add(index); hs.push(index);
        hAdj[index]!.forEach((d) => queue.push(["d", d]));
      }
    }
    ds.sort((a, b) => detectKeeps[a]!.start - detectKeeps[b]!.start);
    hs.sort((a, b) => humanKeeps[a]!.start - humanKeeps[b]!.start);
    const dStart = detectKeeps[ds[0]!]!.start; const dEnd = detectKeeps[ds[ds.length - 1]!]!.end;
    const hStart = humanKeeps[hs[0]!]!.start; const hEnd = humanKeeps[hs[hs.length - 1]!]!.end;
    const classifyOuter = (hIndex: number, side: "start" | "end", hv: number, dv: number) => {
      if (close(hv, dv)) return;
      const expanded = side === "start" ? hv < dv : hv > dv;
      const didResolve = resolveOccurrence(
        hIndex, side, expanded ? "expanded" : "narrowed", "outer", Math.abs(hv - dv),
      );
      if (didResolve) {
        if (expanded) structure.outerExpanded += 1; else structure.outerNarrowed += 1;
      }
    };
    classifyOuter(hs[0]!, "start", hStart, dStart);
    classifyOuter(hs[hs.length - 1]!, "end", hEnd, dEnd);
    if (ds.length === 1 && hs.length > 1) {
      for (let i = 0; i + 1 < hs.length; i += 1) {
        const left = hs[i]!; const right = hs[i + 1]!;
        if (humanKeeps[right]!.start - humanKeeps[left]!.end > DIRECTION_EPSILON_SEC) {
          const before = details.length;
          resolveOccurrence(left, "end", "narrowed", "split-added-cut", null);
          resolveOccurrence(right, "start", "narrowed", "split-added-cut", null);
          const added = details.length - before;
          structure.splitAddedCutBoundaries += added;
          if (added > 0) structure.splitAddedCutGaps += 1;
        }
      }
    } else if (ds.length > 1 && hs.length === 1) {
      structure.joinedDetectGaps += ds.length - 1;
    } else if (ds.length > 1 && hs.length > 1) {
      structure.complexComponents += 1;
      for (const h of hs) for (const side of ["start", "end"] as const) {
        resolveOccurrence(h, side, "ambiguous", "ambiguous", null);
      }
    }
  }
  structure.deletedDetectKeeps = detectKeeps.filter((_, index) => dAdj[index]!.length === 0).length;
  for (let h = 0; h < humanKeeps.length; h += 1) {
    if (hAdj[h]!.length !== 0) continue;
    const keep = humanKeeps[h]!;
    const touches = detectKeeps.some((detect) => close(keep.start, detect.end) || close(keep.end, detect.start));
    if (touches) {
      const before = details.length;
      resolveOccurrence(h, "start", "expanded", "touching-extension", keep.end - keep.start);
      resolveOccurrence(h, "end", "expanded", "touching-extension", keep.end - keep.start);
      structure.touchingExpanded += details.length - before;
    } else {
      structure.addedHumanKeeps += 1;
      resolveOccurrence(h, "start", "expanded", "added-keep", null);
      resolveOccurrence(h, "end", "expanded", "added-keep", null);
    }
  }
  for (const occurrence of occurrences) {
    if (!occurrence.resolved) resolveOccurrence(
      occurrence.humanKeepIndex, occurrence.side, "ambiguous", "ambiguous", null,
    );
  }
  details.sort((a, b) => a.at - b.at || a.humanKeepIndex - b.humanKeepIndex || a.side.localeCompare(b.side));
  const counts = (classification: Direction) => details.filter((detail) => detail.classification === classification).length;
  const unmatched = occurrences.length - exact;
  const expanded = counts("expanded"); const narrowed = counts("narrowed");
  const redundant = counts("redundant"); const ambiguous = counts("ambiguous");
  const classified = expanded + narrowed;
  const commonKeep = intersectionSec(humanKeeps, detectKeeps);
  const humanSec = intervalSec(humanKeeps); const detectSec = intervalSec(detectKeeps);
  const expandedSec = humanSec - commonKeep; const narrowedSec = detectSec - commonKeep;
  const directionalDenominator = unmatched - redundant - ambiguous;
  const directionalClassificationRate = directionalDenominator === 0 ? 1 : classified / directionalDenominator;
  const directionalCoverageOfAllUnmatched = unmatched === 0 ? 1 : classified / unmatched;
  const expandedShare = classified === 0 ? 0 : expanded / classified;
  const narrowedShare = classified === 0 ? 0 : narrowed / classified;
  const h3 = evaluateBoundaryDirectionH3({
    directionalClassificationRate, expandedShare, narrowedShare, expandedSec, narrowedSec,
  });
  return {
    version: 1,
    detect: {
      ...(detectParams ?? {}),
      keepCount: detectKeeps.length,
      boundaryCount: detectBoundaries.length,
    },
    reference: { humanKeepCount: humanKeeps.length, humanBoundaryCount: occurrences.length },
    boundaries: {
      exact, unmatched, expanded, narrowed, redundant, ambiguous,
      directionalClassificationRate: round6(directionalClassificationRate),
      directionalCoverageOfAllUnmatched: round6(directionalCoverageOfAllUnmatched),
      expandedShare: round6(expandedShare), narrowedShare: round6(narrowedShare),
    },
    structure,
    distanceSec: {
      expanded: summarizeBoundaryDistances(distances.expanded),
      narrowed: summarizeBoundaryDistances(distances.narrowed),
    },
    duration: {
      expandedSec: round3(expandedSec), narrowedSec: round3(narrowedSec),
      commonKeepSec: round3(commonKeep),
      commonCutSec: round3(durationSec - commonKeep - expandedSec - narrowedSec),
      totalSec: round3(durationSec),
    },
    details,
    hypothesis: { h3 },
  };
}

export async function boundaryDirection(dir: string, cfg: Config): Promise<BoundaryDirectionReport> {
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as Manifest;
  const cutplan = JSON.parse(readFileSync(resolve(dir, "cutplan.json"), "utf8")) as CutPlan;
  const gate = isCutplanApproved(dir, cutplan);
  if (!gate.ok) throw new Error(`human final として使えません: ${gate.reason}`);
  const audioPath = resolve(dir, manifest.audio.micWav);
  if (!existsSync(audioPath)) throw new Error(`マイク音声が見つかりません: ${audioPath}`);
  const cuts = await detectAutoCuts(audioPath, manifest.durationSec, {
    silenceDb: cfg.detect.silenceDb,
    minSilenceSec: cfg.detect.minSilenceSec,
    padSec: cfg.detect.padSec,
    minKeepSec: cfg.detect.minKeepSec,
  });
  return analyzeBoundaryDirection(cuts.keepSegments, cutplan, manifest.durationSec, {
    silenceDb: cfg.detect.silenceDb,
    minSilenceSec: cfg.detect.minSilenceSec,
    padSec: cfg.detect.padSec,
    minKeepSec: cfg.detect.minKeepSec,
  });
}

export function formatBoundaryDirectionReport(report: BoundaryDirectionReport): string[] {
  const b = report.boundaries; const d = report.duration;
  return [
    `boundary-direction: exact ${b.exact} / unmatched ${b.unmatched}`,
    `expanded ${b.expanded} / narrowed ${b.narrowed} / redundant ${b.redundant} / ambiguous ${b.ambiguous}`,
    `duration: expanded ${d.expandedSec}s / narrowed ${d.narrowedSec}s / common keep ${d.commonKeepSec}s`,
    `H3: ${report.hypothesis.h3}`,
  ];
}
