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

/** ベース映像への挿入(インサート編集)。at はアンカー(元収録の秒) */
export interface InsertSpan {
  at: number;
  durationSec: number;
}

/**
 * keep 区間(+挿入)からカット後タイムラインへの写像を作る。
 * 挿入はアンカー時刻の手前に尺を差し込むので、アンカー以降の keep の
 * offset が挿入の尺ぶん増える(= 元収録の秒で書かれた全要素が自動で
 * 後ろへずれる)。keep の途中に挿入されるとその keep のエントリは割れる
 */
export function buildTimeline(
  keeps: Interval[],
  inserts: InsertSpan[] = [],
): TimelineEntry[] {
  return walk(keeps, inserts).entries;
}

/** 挿入クリップのカット後の区間。index は inserts 配列の添字 */
export function insertSpans(
  keeps: Interval[],
  inserts: InsertSpan[],
): { start: number; end: number; index: number }[] {
  return walk(keeps, inserts).spans;
}

function walk(
  keeps: Interval[],
  inserts: InsertSpan[],
): {
  entries: TimelineEntry[];
  spans: { start: number; end: number; index: number }[];
} {
  // 同じアンカーの挿入は配列順を保つ(安定ソート)
  const pending = inserts
    .map((ins, index) => ({ ...ins, index }))
    .sort((a, b) => a.at - b.at);
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
  for (const k of keeps) {
    // この keep より手前(カット領域や境界)にアンカーされた挿入
    while (pending.length > 0 && pending[0].at <= k.start) place(pending.shift()!);
    let segStart = k.start;
    // keep の途中にアンカーされた挿入は keep を割って差し込む
    while (pending.length > 0 && pending[0].at < k.end) {
      const p = pending.shift()!;
      if (p.at > segStart) {
        entries.push({ start: segStart, end: p.at, offset: outCursor - segStart });
        outCursor += p.at - segStart;
        segStart = p.at;
      }
      place(p);
    }
    entries.push({ start: segStart, end: k.end, offset: outCursor - segStart });
    outCursor += k.end - segStart;
  }
  // 最後の keep より後ろにアンカーされた挿入(エンディング等)
  while (pending.length > 0) place(pending.shift()!);
  return { entries, spans };
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
  for (const e of timeline) {
    const s = Math.max(start, e.start);
    const en = Math.min(end, e.end);
    if (en > s) {
      const iv = { start: round2(s + e.offset), end: round2(en + e.offset) };
      const last = result[result.length - 1];
      if (last && Math.abs(last.end - iv.start) < 0.005) last.end = iv.end;
      else result.push(iv);
    }
  }
  return result;
}

/** カット後の時刻を元動画の時刻へ(toOutputTime の逆変換。エディタが
 * 再生ヘッドの元収録秒を表示するために使う)。範囲外なら null */
export function toSourceTime(
  outT: number,
  timeline: TimelineEntry[],
): number | null {
  for (const e of timeline) {
    if (outT >= e.start + e.offset && outT < e.end + e.offset) {
      return round2(outT - e.offset);
    }
  }
  return null;
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
