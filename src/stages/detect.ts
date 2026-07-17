import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectSilence } from "../lib/ffmpeg.ts";
import type { Config } from "../lib/config.ts";
import type { AutoCuts, Interval, Manifest } from "../types.ts";
import {
  estimateOperationalFloor,
  FLOOR_METHOD,
  resolveEffectiveSilenceDb,
} from "../lib/silenceFloor.ts";
import { resolveEdgeTrimCfg, trimKeepEdges } from "../lib/edgeTrim.ts";
import { decodeBoundaryPcm } from "./boundaryCheck.ts";

export interface DetectParams {
  silenceDb: number;
  minSilenceSec: number;
  padSec: number;
  minKeepSec: number;
  calibration?: AutoCuts["params"]["calibration"];
  silenceCompaction?: AutoCuts["params"]["silenceCompaction"];
}

export const SILENCE_COMPACTION_PRESETS = {
  gentle: { minSilenceSec: 1, padSec: 0.3, minKeepSec: 0.3 },
  balanced: { minSilenceSec: 0.7, padSec: 0.3, minKeepSec: 0.5 },
  tight: { minSilenceSec: 1, padSec: 0.3, minKeepSec: 0.8 },
} as const;

export function resolveDetectCandidateParams(cfg: Config["detect"]): DetectParams {
  if (
    cfg.silenceCompaction?.enabled === true &&
    !Object.prototype.hasOwnProperty.call(SILENCE_COMPACTION_PRESETS, cfg.silenceCompaction.preset)
  ) {
    throw new Error(`detect.silenceCompaction.preset は gentle | balanced | tight である必要があります`);
  }
  const selected = cfg.silenceCompaction?.enabled === true
    ? SILENCE_COMPACTION_PRESETS[cfg.silenceCompaction.preset]
    : null;
  return {
    silenceDb: cfg.silenceDb,
    minSilenceSec: selected?.minSilenceSec ?? cfg.minSilenceSec,
    padSec: selected?.padSec ?? cfg.padSec,
    minKeepSec: selected?.minKeepSec ?? cfg.minKeepSec,
    ...(selected === null ? {} : {
      silenceCompaction: {
        preset: cfg.silenceCompaction!.preset,
        minKeepSec: selected.minKeepSec,
      },
    }),
  };
}

/** 検出済み無音から従来と同じ cuts.auto 算術を副作用なしで組み立てる。 */
export function buildAutoCuts(
  silences: Interval[],
  durationSec: number,
  params: DetectParams,
): AutoCuts {
  const keepSegments = complement(
    silences,
    durationSec,
    params.padSec,
    params.minKeepSec,
  );
  const keptDurationSec = keepSegments.reduce(
    (sum, segment) => sum + (segment.end - segment.start),
    0,
  );
  return {
    params: {
      silenceDb: params.silenceDb,
      minSilenceSec: params.minSilenceSec,
      padSec: params.padSec,
      ...(params.calibration === undefined ? {} : { calibration: params.calibration }),
      ...(params.silenceCompaction === undefined ? {} : { silenceCompaction: params.silenceCompaction }),
    },
    silences,
    keepSegments,
    keptDurationSec: round2(keptDurationSec),
    originalDurationSec: round2(durationSec),
  };
}

/** 音声を読むだけで無音検出と cuts.auto 算術を行う。ファイルは書かない。 */
export async function detectAutoCuts(
  audioPath: string,
  durationSec: number,
  params: DetectParams,
): Promise<AutoCuts> {
  const silences = await detectSilence(audioPath, params.silenceDb, params.minSilenceSec);
  return buildAutoCuts(silences, durationSec, params);
}

/** 解決済み候補paramsでread-only detectする共通API。 */
export async function detectCandidate(
  audioPath: string,
  durationSec: number,
  params: DetectParams,
): Promise<AutoCuts> {
  return detectAutoCuts(audioPath, durationSec, params);
}

/**
 * マイク音声から無音区間を検出し、機械的なカット候補(cuts.auto.json)を
 * 生成する。ここは決定的な処理のみで LLM は使わない。
 * 意味的な判断(冗長・脱線のカット)は plan ステージが行う。
 */
export async function detect(dir: string, cfg: Config): Promise<AutoCuts> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const audioPath = join(dir, manifest.audio.micWav);
  let params = resolveDetectCandidateParams(cfg.detect);
  if (cfg.detect.calibration?.enabled === true) {
    if (cfg.detect.calibration.method !== FLOOR_METHOD) {
      throw new Error(`detect.calibration.method は ${FLOOR_METHOD} である必要があります`);
    }
    const estimate = await estimateOperationalFloor(
      manifest.durationSec,
      (thresholdDb, minSilenceSec) => detectSilence(audioPath, thresholdDb, minSilenceSec),
    );
    const effectiveSilenceDb = resolveEffectiveSilenceDb(
      estimate.floorDb,
      cfg.detect.calibration.floorOffsetDb,
    );
    params = {
      ...params,
      silenceDb: effectiveSilenceDb,
      calibration: {
        method: FLOOR_METHOD,
        floorDb: estimate.floorDb,
        floorOffsetDb: cfg.detect.calibration.floorOffsetDb,
        effectiveSilenceDb,
      },
    };
  }
  let cuts = await detectAutoCuts(
    audioPath,
    manifest.durationSec,
    params,
  );
  // C7(detect.edgeTrim): keep 端を実音声 RMS の発話エッジ+padSec へ詰める
  // opt-in。off なら cuts はここまでの内容のままバイト等価
  if (cfg.detect.edgeTrim?.enabled === true) {
    const trimCfg = resolveEdgeTrimCfg(cfg.detect, params.minKeepSec);
    const samples = await decodeBoundaryPcm(audioPath);
    const trimmed = trimKeepEdges(cuts.keepSegments, samples, trimCfg);
    cuts = {
      ...cuts,
      params: {
        ...cuts.params,
        edgeTrim: {
          floorOffsetDb: trimCfg.floorOffsetDb,
          padSec: trimCfg.padSec,
          maxTrimSec: trimCfg.maxTrimSec,
          floorDb: Math.round(trimmed.floorDb * 10) / 10,
          thresholdDb: Math.round(trimmed.thresholdDb * 10) / 10,
          trimmedSec: trimmed.trimmedSec,
          trimmedEdges: trimmed.trimmedEdges,
        },
      },
      keepSegments: trimmed.keeps,
      keptDurationSec: round2(
        trimmed.keeps.reduce((sum, k) => sum + (k.end - k.start), 0),
      ),
    };
  }
  writeFileSync(join(dir, "cuts.auto.json"), JSON.stringify(cuts, null, 2));
  return cuts;
}

/**
 * 無音区間の補集合(=残す区間)を求める。各区間の前後に padSec の
 * 余白を付け、重なった区間はマージする。
 */
export function complement(
  silences: Interval[],
  duration: number,
  padSec: number,
  minKeepSec: number,
): Interval[] {
  const keeps: Interval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) keeps.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) keeps.push({ start: cursor, end: duration });

  // パディングを付けてからマージ
  const padded = keeps.map((k) => ({
    start: Math.max(0, k.start - padSec),
    end: Math.min(duration, k.end + padSec),
  }));
  const merged: Interval[] = [];
  for (const k of padded) {
    const last = merged[merged.length - 1];
    if (last && k.start <= last.end) {
      last.end = Math.max(last.end, k.end);
    } else {
      merged.push({ ...k });
    }
  }
  // 一瞬だけ音が鳴った断片(呼吸音など)は残しても不自然なので捨てる
  return merged
    .filter((k) => k.end - k.start >= minKeepSec)
    .map((k) => ({ start: round2(k.start), end: round2(k.end) }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
