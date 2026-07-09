// lib/timeline.ts — 全機能が依存する時刻写像(元収録の秒 ⇔ カット後の秒)。
// カット・挿入で時刻がどう移るかの心臓部なので手厚く固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTimeline,
  insertSpans,
  mergeIntervals,
  playbackSegmentsOf,
  remapInterval,
  remapIntervalPieces,
  snapToOutput,
  toOutputTime,
  toSourceTime,
} from "../src/lib/timeline.ts";

// keep 0–10 と 20–30 を繋ぐと、10–20 のカットで後半が 10 秒前へ詰まる
const keeps = [
  { start: 0, end: 10 },
  { start: 20, end: 30 },
];

test("buildTimeline: keep ごとに source/output 範囲を持つエントリ", () => {
  assert.deepEqual(buildTimeline(keeps), [
    { sourceStart: 0, sourceEnd: 10, outputStart: 0, outputEnd: 10, speed: 1 },
    { sourceStart: 20, sourceEnd: 30, outputStart: 10, outputEnd: 20, speed: 1 },
  ]);
});

test("toOutputTime: keep 内は写像、カット内は null(end は排他)", () => {
  const tl = buildTimeline(keeps);
  assert.equal(toOutputTime(5, tl), 5);
  assert.equal(toOutputTime(25, tl), 15);
  assert.equal(toOutputTime(15, tl), null); // カット領域
  assert.equal(toOutputTime(10, tl), null); // 区間終端は含まない
});

test("toSourceTime: カット後の秒を元収録の秒へ逆変換", () => {
  const tl = buildTimeline(keeps);
  assert.equal(toSourceTime(5, tl), 5);
  assert.equal(toSourceTime(15, tl), 25);
  assert.equal(toSourceTime(25, tl), null); // 出力の尺(20秒)より後
});

test("snapToOutput: カット内は直後の keep 先頭へ、後ろが無ければ null", () => {
  const tl = buildTimeline(keeps);
  assert.equal(snapToOutput(5, tl), 5); // keep 内はそのまま
  assert.equal(snapToOutput(15, tl), 10); // カット内 → 次の keep 20 → 出力 10
  assert.equal(snapToOutput(35, tl), null); // 最後の keep より後ろ
});

test("remapInterval: カット境界をまたぐ区間は連続なので1つにまとまる", () => {
  const tl = buildTimeline(keeps);
  // 5–25 は keep1 の 5–10 と keep2 の 20–25 に落ち、出力では 5–15 に連続する
  assert.deepEqual(remapInterval(5, 25, tl), [{ start: 5, end: 15 }]);
  // 完全にカット内なら空
  assert.deepEqual(remapInterval(12, 18, tl), []);
});

test("mergeIntervals: 隣接・重複はまとめ、離れていれば分ける", () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }]), [
    { start: 0, end: 20 },
  ]);
  assert.deepEqual(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 15 }]), [
    { start: 0, end: 15 },
  ]);
  assert.deepEqual(mergeIntervals([{ start: 0, end: 5 }, { start: 10, end: 15 }]), [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
  ]);
});

test("挿入は keep を割り、アンカー以降を後ろへずらす", () => {
  const single = [{ start: 0, end: 10 }];
  const inserts = [{ at: 5, durationSec: 2 }];
  assert.deepEqual(buildTimeline(single, inserts), [
    { sourceStart: 0, sourceEnd: 5, outputStart: 0, outputEnd: 5, speed: 1 },
    { sourceStart: 5, sourceEnd: 10, outputStart: 7, outputEnd: 12, speed: 1 },
  ]);
  assert.deepEqual(insertSpans(single, inserts), [{ start: 5, end: 7, index: 0 }]);
});

test("remapIntervalPieces: keep/cut/insert をまたいでも piece を結合しない", () => {
  const tl = buildTimeline(
    [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    [{ at: 12, durationSec: 2 }],
  );
  assert.deepEqual(remapIntervalPieces(4, 14, tl), [
    { sourceStart: 4, sourceEnd: 5, outputStart: 4, outputEnd: 5, speed: 1 },
    { sourceStart: 10, sourceEnd: 12, outputStart: 5, outputEnd: 7, speed: 1 },
    { sourceStart: 12, sourceEnd: 14, outputStart: 9, outputEnd: 11, speed: 1 },
  ]);
});

test("speed 2 の keep は出力尺が半分になる", () => {
  const tl = buildTimeline([{ start: 10, end: 20, speed: 2 }]);
  assert.deepEqual(tl, [
    { sourceStart: 10, sourceEnd: 20, outputStart: 0, outputEnd: 5, speed: 2 },
  ]);
  assert.equal(toOutputTime(14, tl), 2);
  assert.equal(toSourceTime(2, tl), 14);
});

test("playbackSegmentsOf: 隣接 keep は同 speed のときだけ結合する", () => {
  const out = playbackSegmentsOf({
    approved: false,
    segments: [
      { start: 0, end: 5, action: "keep", reason: "a" },
      { start: 5, end: 10, action: "keep", reason: "b" },
      { start: 10, end: 15, action: "keep", reason: "c", speed: 2 },
      { start: 15, end: 20, action: "keep", reason: "d", speed: 2 },
    ],
  });
  assert.deepEqual(out, [
    { start: 0, end: 10, speed: 1 },
    { start: 10, end: 20, speed: 2 },
  ]);
});
