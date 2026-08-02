import { createHash } from "node:crypto";
import { toOutputTime, type TimelineEntry } from "./timeline.ts";
import type { Interval } from "../types.ts";

const EPS = 1e-6;

export interface Ebur128EnvelopeSample {
  t: number;
  shortTermLufs: number;
}

export interface Ebur128Stats {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
  envelope: Ebur128EnvelopeSample[];
}

export interface AstatsStats {
  peakDbfs: number;
  clippedSamples: number;
  rmsDb: number;
}

export interface AstatsEnvelopeSample {
  t: number;
  rmsDb: number;
}

export interface TimeValueSample {
  t: number;
  value: number;
}

export function parseEbur128(stderr: string): Ebur128Stats {
  const envelope: Ebur128EnvelopeSample[] = [];
  let integratedLufs = Number.NaN;
  let loudnessRangeLu = Number.NaN;
  let truePeakDbtp = Number.NaN;
  for (const line of stderr.split("\n")) {
    const t = line.match(/t:\s*([-\d.]+)/);
    const s = line.match(/\bS:\s*([-\d.]+)/);
    if (t && s) {
      envelope.push({ t: Number(t[1]), shortTermLufs: Number(s[1]) });
    }
    const i = line.match(/^\s*I:\s*([-\d.]+)\s+LUFS/);
    if (i) integratedLufs = Number(i[1]);
    const lra = line.match(/^\s*LRA:\s*([-\d.]+)\s+LU/);
    if (lra) loudnessRangeLu = Number(lra[1]);
    const peak = line.match(/^\s*Peak:\s*([-\d.]+)\s+dBFS/);
    if (peak) truePeakDbtp = Number(peak[1]);
  }
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(loudnessRangeLu) || !Number.isFinite(truePeakDbtp)) {
    throw new Error("ebur128 の実測結果を解析できませんでした");
  }
  return { integratedLufs, loudnessRangeLu, truePeakDbtp, envelope };
}

export function parseAstats(stderr: string): AstatsStats {
  let peakDbfs = Number.NaN;
  let clippedSamples = Number.NaN;
  let rmsDb = Number.NaN;
  for (const line of stderr.split("\n")) {
    const peak = line.match(/Overall\.Peak_level=([-\d.]+)/) ?? line.match(/Peak level dB:\s*([-\d.]+)/);
    if (peak) peakDbfs = Number(peak[1]);
    const clipped = line.match(/Overall\.(?:Abs_)?Peak_count=([-\d.]+)/) ?? line.match(/Abs Peak count:\s*([-\d.]+)/);
    if (clipped) clippedSamples = Number(clipped[1]);
    const rms = line.match(/Overall\.RMS_level=([-\d.]+)/) ?? line.match(/RMS level dB:\s*([-\d.]+)/);
    if (rms) rmsDb = Number(rms[1]);
  }
  if (!Number.isFinite(peakDbfs) || !Number.isFinite(clippedSamples) || !Number.isFinite(rmsDb)) {
    throw new Error("astats の結果を解析できませんでした");
  }
  return { peakDbfs, clippedSamples: Math.round(clippedSamples), rmsDb };
}

export function parseAstatsMetadata(stdout: string): AstatsEnvelopeSample[] {
  const out: AstatsEnvelopeSample[] = [];
  let t: number | null = null;
  for (const line of stdout.split("\n")) {
    const frame = line.match(/pts_time:([-\d.]+)/);
    if (frame) {
      t = Number(frame[1]);
      continue;
    }
    const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=([-\d.]+)/);
    if (t !== null && rms) {
      out.push({ t, rmsDb: Number(rms[1]) });
    }
  }
  return out;
}

export function parseScdet(stderr: string): TimeValueSample[] {
  return stderr
    .split("\n")
    .map((line) => {
      const m = line.match(/lavfi\.scd\.score:\s*([-\d.]+),\s*lavfi\.scd\.time:\s*([-\d.]+)/);
      return m ? { t: Number(m[2]), value: Number(m[1]) / 100 } : null;
    })
    .filter((v): v is TimeValueSample => v !== null);
}

export function parseFreezedetect(stderr: string): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/lavfi\.freezedetect\.freeze_start:\s*([-\d.]+)/);
    if (s) {
      start = Number(s[1]);
      continue;
    }
    const e = line.match(/lavfi\.freezedetect\.freeze_end:\s*([-\d.]+)/);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

export function keepsHash(keeps: Interval[]): string {
  return createHash("sha256").update(JSON.stringify(keeps)).digest("hex");
}

/** concat した keep 映像/音声の経過秒(elapsed)を元収録の秒へ戻す。
 *  ffmpeg は segments だけを連結して測るので、経過秒には挿入クリップが含まれない。 */
export function elapsedToSource(elapsedSec: number, segments: Interval[]): number | null {
  if (elapsedSec < -EPS) return null;
  let acc = 0;
  for (const seg of segments) {
    const len = seg.end - seg.start;
    if (elapsedSec <= acc + len + EPS) {
      return round2(seg.start + Math.max(0, elapsedSec - acc));
    }
    acc += len;
  }
  return null;
}

/** concat の総経過秒。挿入があると出力尺より短くなる。 */
export function elapsedSpanSec(segments: Interval[]): number {
  return round2(segments.reduce((a, s) => a + (s.end - s.start), 0));
}

export function mapSamplesToOutput<T extends { t: number }>(
  samples: T[],
  timeline: TimelineEntry[],
  segments: Interval[],
): Array<T & { outSec: number; sourceSec: number }> {
  return samples.flatMap((sample) => {
    const sourceSec = elapsedToSource(sample.t, segments);
    if (sourceSec === null) return [];
    const outSec = toOutputTimeInclusiveEnd(sourceSec, timeline);
    return outSec === null ? [] : [{ ...sample, outSec, sourceSec }];
  });
}

export function toOutputTimeInclusiveEnd(sourceSec: number, timeline: TimelineEntry[]): number | null {
  const direct = toOutputTime(sourceSec, timeline);
  if (direct !== null) return direct;
  const endEntry = timeline.find((entry) => Math.abs(entry.sourceEnd - sourceSec) <= EPS);
  return endEntry ? endEntry.outputEnd : null;
}

export function aggregateMaxByWindow(
  samples: TimeValueSample[],
  durationSec: number,
  windowSec: number,
): TimeValueSample[] {
  const out: TimeValueSample[] = [];
  for (let t = 0; t <= durationSec + 0.0001; t += windowSec) {
    const end = t + windowSec;
    const bucket = samples.filter((s) => s.t >= t && s.t < end);
    out.push({ t: round2(t), value: bucket.length > 0 ? Math.max(...bucket.map((s) => s.value)) : 0 });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
