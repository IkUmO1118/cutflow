import type { Interval } from "../types.ts";

export const FLOOR_METHOD = "silencedetect-occupancy-v1" as const;
export const FLOOR_PROBE_MIN_SILENCE_SEC = 0.1;
export const FLOOR_TARGET_SILENT_RATIO = 0.05;
export const FLOOR_SEARCH_MIN_DB = -90;
export const FLOOR_SEARCH_MAX_DB = 0;
export const FLOOR_SEARCH_STEP_DB = 0.5;

export interface FloorEstimate {
  floorDb: number;
  floorCrossing: {
    belowThresholdDb: number;
    belowSilentRatio: number;
    thresholdDb: number;
    silentRatio: number;
  };
}

export type SilenceProbe = (thresholdDb: number, minSilenceSec: number) => Promise<Interval[]>;

/** floor+offsetをsilencedetect探索grid上の安全な実効thresholdへ解決する。 */
export function resolveEffectiveSilenceDb(floorDb: number, floorOffsetDb: number): number {
  if (!Number.isFinite(floorDb) || !Number.isFinite(floorOffsetDb)) {
    throw new Error("floor/offset は有限の数値である必要があります");
  }
  if (!Number.isInteger(floorOffsetDb * 2)) {
    throw new Error("floorOffsetDb は0.5dB gridで指定してください");
  }
  const effective = floorDb + floorOffsetDb;
  if (effective < FLOOR_SEARCH_MIN_DB || effective > FLOOR_SEARCH_MAX_DB) {
    throw new Error(
      `effective silenceDb (${effective}) は ${FLOOR_SEARCH_MIN_DB}..${FLOOR_SEARCH_MAX_DB}dB の範囲外です`,
    );
  }
  return effective;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function silentOccupancyRatio(spans: Interval[], durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("floor calibration の音声尺が不正です");
  }
  let total = 0;
  let previousEnd = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    if (
      !Number.isFinite(span.start) || !Number.isFinite(span.end) ||
      span.start < 0 || span.end <= span.start || span.start >= durationSec ||
      span.start < previousEnd
    ) {
      throw new Error(`floor calibration の silence span[${i}] が不正です`);
    }
    // ffmpeg は末尾をコンテナ尺よりごく僅かに大きく出すことがあるため、
    // occupancy はmanifestの測定区間との交差長で数える。
    const end = Math.min(span.end, durationSec);
    total += end - span.start;
    previousEnd = end;
  }
  return round6(total / durationSec);
}

/** 離散二分探索で silent occupancy が初めて5%へ達する最小thresholdを求める。 */
export async function estimateOperationalFloor(
  durationSec: number,
  probe: SilenceProbe,
): Promise<FloorEstimate> {
  const count = Math.round((FLOOR_SEARCH_MAX_DB - FLOOR_SEARCH_MIN_DB) / FLOOR_SEARCH_STEP_DB) + 1;
  const thresholdAt = (index: number) => FLOOR_SEARCH_MIN_DB + index * FLOOR_SEARCH_STEP_DB;
  const cache = new Map<number, number>();
  const measure = async (index: number): Promise<number> => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const ratio = silentOccupancyRatio(
      await probe(thresholdAt(index), FLOOR_PROBE_MIN_SILENCE_SEC),
      durationSec,
    );
    cache.set(index, ratio);
    return ratio;
  };

  let below = 0;
  let crossing = count - 1;
  const minRatio = await measure(below);
  const maxRatio = await measure(crossing);
  if (minRatio >= FLOOR_TARGET_SILENT_RATIO) {
    throw new Error("floor calibration は探索下限ですでにtargetへ達し、交差を特定できません");
  }
  if (maxRatio < FLOOR_TARGET_SILENT_RATIO) {
    throw new Error("floor calibration は探索上限でもtargetへ達しません");
  }
  while (crossing - below > 1) {
    const middle = Math.floor((below + crossing) / 2);
    if (await measure(middle) >= FLOOR_TARGET_SILENT_RATIO) crossing = middle;
    else below = middle;
  }
  const belowRatio = await measure(below);
  const crossingRatio = await measure(crossing);
  const ordered = [...cache.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]![1] < ordered[i - 1]![1]) {
      throw new Error("floor calibration のsilent ratioがthresholdに対して単調ではありません");
    }
  }
  if (
    belowRatio >= FLOOR_TARGET_SILENT_RATIO ||
    crossingRatio < FLOOR_TARGET_SILENT_RATIO ||
    crossing !== below + 1
  ) {
    throw new Error("floor calibration の交差検証に失敗しました");
  }
  const thresholdDb = thresholdAt(crossing);
  return {
    floorDb: thresholdDb,
    floorCrossing: {
      belowThresholdDb: thresholdAt(below),
      belowSilentRatio: belowRatio,
      thresholdDb,
      silentRatio: crossingRatio,
    },
  };
}
