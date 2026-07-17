/** スクリプトタブの範囲カット/復元(editor/client/model.ts の
 * cutSourceRange / restoreSourceRange)。
 *
 * 文字ベース編集は「選択した語の範囲(元収録の秒)」を cutplan の keep 集合
 * から抜く/戻す。validate の不変条件(keep は時系列順・重なりなし・最低1つ、
 * cut に speed 禁止)を GUI 側で壊すと保存できなくなるので、ここで固定する。
 * id の分割規約は splitAtPlayhead と同じ「左が保持・右は新規」+
 * 「丸ごと flip は id を引き継ぐ」「頭側だけ吸収されたトリムは id を保つ」。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cutSourceRange, restoreSourceRange, SCRIPT_CUT_REASON, SCRIPT_RESTORE_REASON } from "../editor/client/model.ts";
import type { PlanSegment } from "../src/types.ts";

const MIN = 0.01;

const keep = (start: number, end: number, extra: Partial<PlanSegment> = {}): PlanSegment => ({
  start,
  end,
  action: "keep",
  reason: "keep",
  ...extra,
});
const cut = (start: number, end: number, extra: Partial<PlanSegment> = {}): PlanSegment => ({
  start,
  end,
  action: "cut",
  reason: "cut",
  ...extra,
});

/** validate と同じ不変条件: keep は時系列順・重なりなし */
const assertKeepsSane = (segs: PlanSegment[]) => {
  const keeps = segs.filter((s) => s.action === "keep");
  assert.ok(keeps.length > 0, "keep が1つも無い");
  for (let i = 1; i < keeps.length; i++) {
    assert.ok(keeps[i].start >= keeps[i - 1].end - 1e-9, "keep が重なっている/順不同");
  }
  for (const s of segs) {
    if (s.action === "cut") assert.equal(s.speed, undefined, "cut に speed が残っている");
  }
};

test("cutSourceRange: keep の真ん中を抜くと 2 分割+cut 記録(左が id 保持)", () => {
  const r = cutSourceRange([keep(0, 30, { id: "seg_aaaaaa", speed: 1.5 })], { start: 10, end: 20 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end, s.id ?? null]),
    [
      ["keep", 0, 10, "seg_aaaaaa"],
      ["cut", 10, 20, null],
      ["keep", 20, 30, null],
    ],
  );
  // 分割された keep は speed を引き継ぎ、cut 記録には乗らない
  assert.equal(r.segments[0].speed, 1.5);
  assert.equal(r.segments[2].speed, 1.5);
  assert.equal(r.segments[1].reason, SCRIPT_CUT_REASON);
  assertKeepsSane(r.segments);
});

test("cutSourceRange: keep を丸ごと覆うと cut へ倒れ id を引き継ぐ", () => {
  const r = cutSourceRange(
    [keep(0, 10, { id: "seg_aaaaaa" }), keep(10, 20, { id: "seg_bbbbbb", speed: 2 }), keep(20, 30)],
    { start: 9, end: 21 },
    MIN,
  );
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end, s.id ?? null]),
    [
      ["keep", 0, 9, "seg_aaaaaa"],
      ["cut", 9, 10, null],
      ["cut", 10, 20, "seg_bbbbbb"],
      ["cut", 20, 21, null],
      ["keep", 21, 30, null],
    ],
  );
  assert.equal(r.segments[2].speed, undefined);
  assertKeepsSane(r.segments);
});

test("cutSourceRange: minSpan 未満の切れ端は cut 側へ吸収(頭側吸収は尾側が id を保つトリム)", () => {
  const r = cutSourceRange([keep(10, 20, { id: "seg_aaaaaa" })], { start: 10.005, end: 15 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end, s.id ?? null]),
    [
      ["cut", 10, 15, null],
      ["keep", 15, 20, "seg_aaaaaa"],
    ],
  );
  assertKeepsSane(r.segments);
});

test("cutSourceRange: 既にカット済みの範囲は noop、全 keep を覆う範囲は empty", () => {
  const segs = [keep(0, 10), cut(10, 20), keep(20, 30)];
  const noop = cutSourceRange(segs, { start: 12, end: 18 }, MIN);
  assert.deepEqual(noop, { ok: false, reason: "noop" });
  const empty = cutSourceRange(segs, { start: 0, end: 30 }, MIN);
  assert.deepEqual(empty, { ok: false, reason: "empty" });
});

test("cutSourceRange: 既存の cut 記録はそのまま維持される", () => {
  const r = cutSourceRange([keep(0, 10), cut(10, 20, { id: "seg_cccccc" }), keep(20, 30)], { start: 5, end: 25 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end, s.id ?? null]),
    [
      ["keep", 0, 5, null],
      ["cut", 5, 10, null],
      ["cut", 10, 20, "seg_cccccc"],
      ["cut", 20, 25, null],
      ["keep", 25, 30, null],
    ],
  );
  assertKeepsSane(r.segments);
});

test("restoreSourceRange: cut 記録の真ん中を戻すと記録が割れ、隙間が keep になる", () => {
  const r = restoreSourceRange([keep(0, 10), cut(10, 30, { id: "seg_cccccc" }), keep(30, 40)], { start: 15, end: 20 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end, s.id ?? null]),
    [
      ["keep", 0, 10, null],
      ["cut", 10, 15, "seg_cccccc"],
      ["keep", 15, 20, null],
      ["cut", 20, 30, null],
      ["keep", 30, 40, null],
    ],
  );
  const restored = r.segments.find((s) => s.start === 15);
  assert.equal(restored?.reason, SCRIPT_RESTORE_REASON);
  assertKeepsSane(r.segments);
});

test("restoreSourceRange: 既存 keep と重なる範囲は隙間だけ復元する(keep の重なりを作らない)", () => {
  const r = restoreSourceRange([keep(0, 10), cut(10, 20), keep(20, 30)], { start: 5, end: 25 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end]),
    [
      ["keep", 0, 10],
      ["keep", 10, 20],
      ["keep", 20, 30],
    ],
  );
  assertKeepsSane(r.segments);
});

test("restoreSourceRange: 既に keep の範囲は noop", () => {
  const r = restoreSourceRange([keep(0, 30)], { start: 5, end: 25 }, MIN);
  assert.deepEqual(r, { ok: false, reason: "noop" });
});

test("restoreSourceRange: 記録の無い隙間(トリム痕)も戻せる", () => {
  // keep のトリムで cut 記録の無い区間ができることがある(App の restoreCutSeg と
  // 同様、スクリプトからは「言葉があるのに残っていない」区間として見える)
  const r = restoreSourceRange([keep(0, 10), keep(20, 30)], { start: 10, end: 20 }, MIN);
  assert.ok(r.ok);
  assert.deepEqual(
    r.segments.map((s) => [s.action, s.start, s.end]),
    [
      ["keep", 0, 10],
      ["keep", 10, 20],
      ["keep", 20, 30],
    ],
  );
  assertKeepsSane(r.segments);
});

test("カット → 復元の round-trip で keep 集合が元に戻る", () => {
  const orig = [keep(0, 10, { id: "seg_aaaaaa" }), keep(15, 30, { id: "seg_bbbbbb" })];
  const cutR = cutSourceRange(orig, { start: 5, end: 20 }, MIN);
  assert.ok(cutR.ok);
  const backR = restoreSourceRange(cutR.segments, { start: 5, end: 20 }, MIN);
  assert.ok(backR.ok);
  const keepsOf = (segs: PlanSegment[]) =>
    segs.filter((s) => s.action === "keep").map((s) => [s.start, s.end]);
  // 復元は [5,20] 全体を1つの keep で戻すので、元の keep 間の隙間 [10,15] も
  // keep になる(スクリプト上は選択範囲が全部戻る、が期待動作)。
  // 結合後の keep 集合は [0,30] で連続(境界一致の隣接 keep は再生・レンダーの
  // playbackSegmentsOf が1つにまとめる)
  assert.deepEqual(keepsOf(backR.segments), [
    [0, 5],
    [5, 20],
    [20, 30],
  ]);
  assertKeepsSane(backR.segments);
});
