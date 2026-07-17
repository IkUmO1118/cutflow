// C7(境界の精密化): detect が置いた keep 端を、実音声 RMS の発話エッジへ
// 決定論でトリムする opt-in(detect.edgeTrim)。silencedetect(ピーク寄り)の
// edge + 固定 padSec が keep 内に残す「発話後の静かな尾」を、boundary-check と
// 同じ測定系(mono 8kHz PCM16LE / 非重複100ms窓 p5 床)で詰める。
// §docs/programs/edit-precision-program.md C7 / deterministic-calibration-program.md 2026-07-17。
// LLM 不使用・transcript.words 不使用(境界の判定は実音声のみ=較正母艦 §2.6 の不変条件)。

import {
  BOUNDARY_SAMPLE_RATE_HZ,
  noiseFloorDb,
  pcmRmsDb,
} from "../stages/boundaryCheck.ts";
import type { Config } from "./config.ts";
import type { Interval } from "../types.ts";

/** 発話エッジ判定の RMS 窓(boundary-check の床窓と同じ100ms) */
export const EDGE_TRIM_WINDOW_SEC = 0.1;
/** 窓の走査刻み(境界の分解能) */
export const EDGE_TRIM_HOP_SEC = 0.025;

export const DEFAULT_EDGE_TRIM_FLOOR_OFFSET_DB = 12;
/** 既定 0.1: 実測(2026-07-12)で pad 0.05 は人間が意図的に残す語尾後の余白
 *  (rules.md の「少し余白を残してから切る」)まで削った。0.1 はトリム量の
 *  大半を保ちつつ人間 keep への食い込みを半減する */
export const DEFAULT_EDGE_TRIM_PAD_SEC = 0.1;
export const DEFAULT_EDGE_TRIM_MAX_TRIM_SEC = 1.5;

export interface EdgeTrimCfg {
  /** 発話とみなす RMS threshold = 床 + これ(dB) */
  floorOffsetDb: number;
  /** 発話エッジの外側へ残す余白(秒) */
  padSec: number;
  /** 1辺あたりの最大トリム量(秒)。誤検出時の安全上限 */
  maxTrimSec: number;
  /** トリム後にこの尺を割る keep はトリムせず原状維持(detect.minKeepSec を渡す) */
  minKeepSec: number;
}

export interface EdgeTrimResult {
  keeps: Interval[];
  floorDb: number;
  thresholdDb: number;
  /** 全 keep で詰めた合計秒数 */
  trimmedSec: number;
  /** 実際に動いた辺の数(start/end それぞれ1と数える) */
  trimmedEdges: number;
}

/** detect.edgeTrim を既定値で解決する(minKeepSec は解決済み detect 側の値を渡す)。 */
export function resolveEdgeTrimCfg(
  detectCfg: Config["detect"],
  minKeepSec: number,
): EdgeTrimCfg {
  const e = detectCfg.edgeTrim ?? { enabled: false };
  return {
    floorOffsetDb: e.floorOffsetDb ?? DEFAULT_EDGE_TRIM_FLOOR_OFFSET_DB,
    padSec: e.padSec ?? DEFAULT_EDGE_TRIM_PAD_SEC,
    maxTrimSec: e.maxTrimSec ?? DEFAULT_EDGE_TRIM_MAX_TRIM_SEC,
    minKeepSec,
  };
}

function windowRmsDb(samples: Int16Array, startSec: number): number {
  const start = Math.floor(startSec * BOUNDARY_SAMPLE_RATE_HZ);
  const end = Math.floor((startSec + EDGE_TRIM_WINDOW_SEC) * BOUNDARY_SAMPLE_RATE_HZ);
  return pcmRmsDb(samples, start, end);
}

/** keep 終端側の発話エッジ(発話とみなせる最後の時刻)を探す。
 *  [end-maxTrim, end] の範囲を 100ms 窓・25ms 刻みで末尾から走査し、
 *  threshold を超える最初(=最も遅い)の窓の右端を返す。
 *  範囲内に発話が無ければ範囲の下限(=最大トリム位置)を返す。 */
function speechEndWithin(
  samples: Int16Array,
  keep: Interval,
  thresholdDb: number,
  maxTrimSec: number,
): number {
  const floorSec = Math.max(keep.start, keep.end - maxTrimSec);
  for (let t = keep.end - EDGE_TRIM_WINDOW_SEC; t >= floorSec; t -= EDGE_TRIM_HOP_SEC) {
    if (windowRmsDb(samples, t) > thresholdDb) return t + EDGE_TRIM_WINDOW_SEC;
  }
  return floorSec;
}

/** keep 先頭側の発話エッジ(発話とみなせる最初の時刻)。speechEndWithin の対称。 */
function speechStartWithin(
  samples: Int16Array,
  keep: Interval,
  thresholdDb: number,
  maxTrimSec: number,
): number {
  const ceilSec = Math.min(keep.end, keep.start + maxTrimSec);
  for (let t = keep.start; t + EDGE_TRIM_WINDOW_SEC <= ceilSec + EDGE_TRIM_WINDOW_SEC; t += EDGE_TRIM_HOP_SEC) {
    if (t > ceilSec) break;
    if (windowRmsDb(samples, t) > thresholdDb) return t;
  }
  return ceilSec;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** keep 群の両端を実音声の発話エッジ+padSec へ詰める純関数(副作用なし)。
 *  - 縮める方向にしか動かさない(keep を広げない)。
 *  - トリム後に minKeepSec を割る keep は原状維持(消さない)。
 *  - 入力が時系列・非重なりなら出力もそのまま保たれる(内側へ縮むだけ)。 */
export function trimKeepEdges(
  keeps: Interval[],
  samples: Int16Array,
  cfg: EdgeTrimCfg,
): EdgeTrimResult {
  const floorDb = noiseFloorDb(samples);
  const thresholdDb = floorDb + cfg.floorOffsetDb;
  const out: Interval[] = [];
  let trimmedSec = 0;
  let trimmedEdges = 0;
  for (const keep of keeps) {
    const speechEnd = speechEndWithin(samples, keep, thresholdDb, cfg.maxTrimSec);
    const speechStart = speechStartWithin(samples, keep, thresholdDb, cfg.maxTrimSec);
    const newEnd = Math.min(keep.end, round2(speechEnd + cfg.padSec));
    const newStart = Math.max(keep.start, round2(speechStart - cfg.padSec));
    if (newEnd - newStart < cfg.minKeepSec || newEnd <= newStart) {
      out.push({ ...keep });
      continue;
    }
    if (newStart > keep.start) trimmedEdges += 1;
    if (newEnd < keep.end) trimmedEdges += 1;
    trimmedSec += (keep.end - keep.start) - (newEnd - newStart);
    out.push({ start: newStart, end: newEnd });
  }
  return {
    keeps: out,
    floorDb,
    thresholdDb,
    trimmedSec: round2(trimmedSec),
    trimmedEdges,
  };
}
