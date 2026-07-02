import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectSilence } from "../lib/ffmpeg.ts";
import type { Config } from "../lib/config.ts";
import type { AutoCuts, Interval, Manifest } from "../types.ts";

/**
 * マイク音声から無音区間を検出し、機械的なカット候補(cuts.auto.json)を
 * 生成する。ここは決定的な処理のみで LLM は使わない。
 * 意味的な判断(冗長・脱線のカット)は plan ステージが行う。
 */
export async function detect(dir: string, cfg: Config): Promise<AutoCuts> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const { silenceDb, minSilenceSec, padSec } = cfg.detect;

  const silences = await detectSilence(
    join(dir, manifest.audio.micWav),
    silenceDb,
    minSilenceSec,
  );

  const keepSegments = complement(
    silences,
    manifest.durationSec,
    padSec,
    cfg.detect.minKeepSec,
  );
  const keptDurationSec = keepSegments.reduce(
    (sum, s) => sum + (s.end - s.start),
    0,
  );

  const cuts: AutoCuts = {
    params: { silenceDb, minSilenceSec, padSec },
    silences,
    keepSegments,
    keptDurationSec: round2(keptDurationSec),
    originalDurationSec: round2(manifest.durationSec),
  };
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
