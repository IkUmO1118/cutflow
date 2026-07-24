/** obs-websocket の outputTimecode(ms) と Swift カーソルヘルパの
 * timestampMs(wall-clock epoch ms)の対応から、ヘルパ時刻→録画内時刻(recTimeMs)
 * への線形写像(offset + drift)を最小二乗ではなく Theil–Sen(全ペア勾配の中央値)
 * で当てる。外部プロセス(OBS)を跨ぐ都合、Date.now() 差だけでは ±100–300ms
 * ずれるため offset だけでは足りない(母艦 §「同期」D5)。
 * §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md D5 */

export interface SyncPair {
  outputTimecodeMs: number;
  helperEpochMs: number;
}

/** obs-websocket GetRecordStatus.outputTimecode("HH:MM:SS.mmm")を ms へ */
export function parseObsTimecodeMs(timecode: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{3})$/.exec(timecode);
  if (!m) {
    throw new Error(`obs-websocket timecode の形式が不正です: ${JSON.stringify(timecode)}`);
  }
  const [, h, min, s, ms] = m as unknown as [string, string, string, string, string];
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms);
}

export interface LinearMapping {
  offsetMs: number;
  driftPpm: number;
}

export function fitLinearMapping(pairs: SyncPair[]): LinearMapping {
  if (pairs.length === 0) return { offsetMs: 0, driftPpm: 0 };
  const points = pairs.map((p) => ({
    x: p.helperEpochMs,
    y: p.outputTimecodeMs - p.helperEpochMs,
  }));
  if (points.length === 1) return { offsetMs: points[0]!.y, driftPpm: 0 };

  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx === 0) continue;
      slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  const slope = slopes.length > 0 ? median(slopes) : 0;
  const offsetMs = median(points.map((p) => p.y - slope * p.x));
  return { offsetMs, driftPpm: slope * 1e6 };
}

/** ヘルパの wall-clock epoch ms を録画内時刻(recTimeMs)へ */
export function mapHelperTimeToRecTime(
  helperEpochMs: number,
  mapping: LinearMapping,
): number {
  return helperEpochMs * (1 + mapping.driftPpm * 1e-6) + mapping.offsetMs;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** OBS の一時停止(PAUSED→RESUMED)区間。recTimeMs は一時停止が始まった
 * 録画内時刻(写像適用前の生時刻)、durationMs はその長さ */
export interface Pause {
  recTimeMs: number;
  durationMs: number;
}

/**
 * 一時停止区間ぶんサンプルを前詰めする(D7)。ヘルパは一時停止中も常駐で
 * サンプリングを続けるため、そのぶんは実際の録画内容に対応しない:
 * 一時停止区間に落ちるサンプルは捨て、それより後のサンプルは経過した
 * 一時停止の合計時間だけ recTimeMs を早める。一時停止より前のサンプルは不変
 */
export function compactPauses<T extends { recTimeMs: number }>(
  samples: T[],
  pauses: Pause[],
): T[] {
  if (pauses.length === 0) return samples.slice();
  const sorted = [...pauses].sort((a, b) => a.recTimeMs - b.recTimeMs);
  const result: T[] = [];
  for (const sample of samples) {
    let shiftMs = 0;
    let droppedInPause = false;
    for (const pause of sorted) {
      if (sample.recTimeMs < pause.recTimeMs) break;
      if (sample.recTimeMs < pause.recTimeMs + pause.durationMs) {
        droppedInPause = true;
        break;
      }
      shiftMs += pause.durationMs;
    }
    if (!droppedInPause) {
      result.push({ ...sample, recTimeMs: sample.recTimeMs - shiftMs });
    }
  }
  return result;
}
