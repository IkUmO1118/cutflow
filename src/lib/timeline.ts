import type { Interval } from "../types.ts";

/**
 * カット編集による時刻の対応表。
 * keep 区間を前から詰めて並べたとき、元動画の時刻 t は t + offset に移る。
 */
export interface TimelineEntry {
  start: number;
  end: number;
  offset: number;
}

export function buildTimeline(keeps: Interval[]): TimelineEntry[] {
  let outCursor = 0;
  return keeps.map((k) => {
    const entry = { start: k.start, end: k.end, offset: outCursor - k.start };
    outCursor += k.end - k.start;
    return entry;
  });
}

/** 元動画の時刻をカット後の時刻へ。カットされた時刻なら null */
export function toOutputTime(
  t: number,
  timeline: TimelineEntry[],
): number | null {
  for (const e of timeline) {
    if (t >= e.start && t < e.end) return round2(t + e.offset);
  }
  return null;
}

/**
 * 元動画の区間(字幕など)をカット後の区間に変換する。
 * カット境界をまたぐ場合は複数に割れ、完全にカット内なら空になる。
 */
export function remapInterval(
  start: number,
  end: number,
  timeline: TimelineEntry[],
): Interval[] {
  const result: Interval[] = [];
  for (const e of timeline) {
    const s = Math.max(start, e.start);
    const en = Math.min(end, e.end);
    if (en > s) {
      result.push({ start: round2(s + e.offset), end: round2(en + e.offset) });
    }
  }
  return result;
}

/**
 * 時刻をカット後のタイムラインへスナップする(章の開始時刻用)。
 * カットされた時刻なら直後の keep 区間の先頭へ。それも無ければ null
 */
export function snapToOutput(
  t: number,
  timeline: TimelineEntry[],
): number | null {
  const direct = toOutputTime(t, timeline);
  if (direct !== null) return direct;
  for (const e of timeline) {
    if (e.start >= t) return round2(e.start + e.offset);
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
