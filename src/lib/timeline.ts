import {
  DEFAULT_PLAYBACK_SPEED,
  type CutPlan,
  type Interval,
} from "../types.ts";

export interface PlaybackSegment {
  start: number;
  end: number;
  speed: number;
}

export interface TimelineEntry {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  speed: number;
}

/** ベース映像への挿入(インサート編集)。at はアンカー(元収録の秒) */
export interface InsertSpan {
  at: number;
  durationSec: number;
}

export interface RemappedPiece {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  speed: number;
}

export interface BuiltTimeline {
  entries: TimelineEntry[];
  inserts: { start: number; end: number; index: number }[];
  durationSec: number;
}

export function playbackSegmentsOf(cutplan: CutPlan): PlaybackSegment[] {
  const keeps = cutplan.segments
    .filter((s) => s.action === "keep")
    .map((s) => ({
      start: s.start,
      end: s.end,
      speed: s.speed ?? DEFAULT_PLAYBACK_SPEED,
    }))
    .sort((a, b) => a.start - b.start);
  const result: PlaybackSegment[] = [];
  for (const keep of keeps) {
    const last = result[result.length - 1];
    if (
      last &&
      Math.abs(last.end - keep.start) < 0.005 &&
      Math.abs(last.speed - keep.speed) < 1e-9
    ) {
      last.end = keep.end;
    } else {
      result.push({ ...keep });
    }
  }
  return result;
}

export function buildTimeline(
  keeps: PlaybackSegment[] | Interval[],
  inserts: InsertSpan[] = [],
): TimelineEntry[] {
  return buildTimelineModel(keeps, inserts).entries;
}

/** 挿入クリップのカット後の区間。index は inserts 配列の添字 */
export function insertSpans(
  keeps: PlaybackSegment[] | Interval[],
  inserts: InsertSpan[],
): { start: number; end: number; index: number }[] {
  return buildTimelineModel(keeps, inserts).inserts;
}

export function timelineDuration(timeline: TimelineEntry[]): number {
  return timeline.length === 0 ? 0 : timeline[timeline.length - 1].outputEnd;
}

export function buildTimelineModel(
  keeps: PlaybackSegment[] | Interval[],
  inserts: InsertSpan[] = [],
): BuiltTimeline {
  const pending = inserts
    .map((ins, index) => ({ ...ins, index }))
    .sort((a, b) => a.at - b.at);
  const segments = normalizePlaybackSegments(keeps);
  const entries: TimelineEntry[] = [];
  const spans: { start: number; end: number; index: number }[] = [];
  let outCursor = 0;
  const place = (p: { durationSec: number; index: number }) => {
    spans.push({
      start: round2(outCursor),
      end: round2(outCursor + p.durationSec),
      index: p.index,
    });
    outCursor += p.durationSec;
  };
  for (const keep of segments) {
    while (pending.length > 0 && pending[0].at <= keep.start) place(pending.shift()!);
    let segStart = keep.start;
    while (pending.length > 0 && pending[0].at < keep.end) {
      const p = pending.shift()!;
      if (p.at > segStart) {
        const duration = (p.at - segStart) / keep.speed;
        entries.push({
          sourceStart: segStart,
          sourceEnd: p.at,
          outputStart: round2(outCursor),
          outputEnd: round2(outCursor + duration),
          speed: keep.speed,
        });
        outCursor += duration;
        segStart = p.at;
      }
      place(p);
    }
    const duration = (keep.end - segStart) / keep.speed;
    entries.push({
      sourceStart: segStart,
      sourceEnd: keep.end,
      outputStart: round2(outCursor),
      outputEnd: round2(outCursor + duration),
      speed: keep.speed,
    });
    outCursor += duration;
  }
  while (pending.length > 0) place(pending.shift()!);
  return { entries, inserts: spans, durationSec: round2(outCursor) };
}

function normalizePlaybackSegments(
  keeps: PlaybackSegment[] | Interval[],
): PlaybackSegment[] {
  return keeps.map((keep) => ({
    start: keep.start,
    end: keep.end,
    speed: "speed" in keep && typeof keep.speed === "number"
      ? keep.speed
      : DEFAULT_PLAYBACK_SPEED,
  }));
}

/**
 * 隣接・重複する区間をまとめる(時系列順が前提)。エディタの分割編集は
 * keep を同じ境界で2つに割るので、ffmpeg のカット(trim+concat)や
 * preview の stale 判定は、割れ方ではなく「実際に残る映像」で扱う
 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const iv of list) {
    const last = result[result.length - 1];
    if (last && iv.start - last.end < 0.005) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      result.push({ start: iv.start, end: iv.end });
    }
  }
  return result;
}

/** pred が false→true に切り替わる最初の添字(単調前提の二分探索) */
export function lowerBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 元動画の時刻をカット後の時刻へ。カットされた時刻なら null */
export function toOutputTime(
  t: number,
  timeline: TimelineEntry[],
): number | null {
  const i = lowerBound(timeline.length, (j) => timeline[j].sourceEnd > t);
  const e = timeline[i];
  return e !== undefined && t >= e.sourceStart
    ? round2(e.outputStart + (t - e.sourceStart) / e.speed)
    : null;
}

/**
 * 元動画の区間(字幕など)をカット後の区間に変換する。
 * カット境界をまたいでも、隣り合う keep はカット後は連続なので1つに
 * まとまる。挿入で時間が割り込まれる場合だけ複数に割れ、
 * 完全にカット内なら空になる。
 */
export function remapInterval(
  start: number,
  end: number,
  timeline: TimelineEntry[],
): Interval[] {
  const result: Interval[] = [];
  const i0 = lowerBound(timeline.length, (j) => timeline[j].sourceEnd > start);
  for (let i = i0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.sourceStart >= end) break;
    const s = Math.max(start, e.sourceStart);
    const en = Math.min(end, e.sourceEnd);
    if (en > s) {
      const iv = {
        start: round2(e.outputStart + (s - e.sourceStart) / e.speed),
        end: round2(e.outputStart + (en - e.sourceStart) / e.speed),
      };
      const last = result[result.length - 1];
      if (last && Math.abs(last.end - iv.start) < 0.005) last.end = iv.end;
      else result.push(iv);
    }
  }
  return result;
}

export function remapIntervalPieces(
  start: number,
  end: number,
  timeline: TimelineEntry[],
): RemappedPiece[] {
  const result: RemappedPiece[] = [];
  const i0 = lowerBound(timeline.length, (j) => timeline[j].sourceEnd > start);
  for (let i = i0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.sourceStart >= end) break;
    const sourceStart = Math.max(start, e.sourceStart);
    const sourceEnd = Math.min(end, e.sourceEnd);
    if (sourceEnd > sourceStart) {
      result.push({
        sourceStart,
        sourceEnd,
        outputStart: round2(
          e.outputStart + (sourceStart - e.sourceStart) / e.speed,
        ),
        outputEnd: round2(
          e.outputStart + (sourceEnd - e.sourceStart) / e.speed,
        ),
        speed: e.speed,
      });
    }
  }
  return result;
}

/** カット後の時刻を元動画の時刻へ(toOutputTime の逆変換) */
export function toSourceTime(
  outT: number,
  timeline: TimelineEntry[],
): number | null {
  const i = lowerBound(timeline.length, (j) => timeline[j].outputEnd > outT);
  const e = timeline[i];
  return e !== undefined && outT >= e.outputStart
    ? round2(e.sourceStart + (outT - e.outputStart) * e.speed)
    : null;
}

/** 時刻をカット後のタイムラインへスナップする(章の開始時刻用) */
export function snapToOutput(
  t: number,
  timeline: TimelineEntry[],
): number | null {
  const direct = toOutputTime(t, timeline);
  if (direct !== null) return direct;
  const i = lowerBound(timeline.length, (j) => timeline[j].sourceStart >= t);
  const e = timeline[i];
  return e !== undefined ? e.outputStart : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
