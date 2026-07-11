// lib/candidateSplit.ts — H6(apply ハイブリッドで候補内部を語境界分割・R0 突破)の純関数。
// §docs/plans/2026-07-11-h6-apply-hybrid-r0-breakthrough-design.md §2.3/§2.4/§4
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCandidateSplits,
  splitSegmentAtWords,
  wordsForCandidate,
} from "../src/lib/candidateSplit.ts";
import type { CandidateSplitCfg, SplitOp } from "../src/lib/candidateSplit.ts";
import type { CutPlan, WordTiming } from "../src/types.ts";

const CFG: CandidateSplitCfg = { minCandidateSec: 0.5 };

/** seg=[10,20] に0.2秒の間隔を挟んだ10語(word i: [10+i, 10+i+0.8]) */
function tenWords(): WordTiming[] {
  return Array.from({ length: 10 }, (_, i) => ({
    text: `w${i + 1}`,
    start: 10 + i,
    end: 10 + i + 0.8,
  }));
}

test("wordsForCandidate: 語の中点が seg に入るものだけ(境界の重複表示を防ぐ)", () => {
  const words: WordTiming[] = [
    { text: "before", start: 8, end: 9.9 }, // mid=8.95 < 10 → 除外
    { text: "in", start: 10, end: 11 }, // mid=10.5 → 採用
    { text: "edge", start: 19.5, end: 20.5 }, // mid=20 → seg.end 未満でない → 除外
  ];
  const got = wordsForCandidate({ start: 10, end: 20 }, words);
  assert.deepEqual(got.map((w) => w.text), ["in"]);
});

test("splitSegmentAtWords: tile 不変(隙間なく覆い・時系列順・非重なり)+ 語境界スナップ", () => {
  const words = tenWords();
  const result = splitSegmentAtWords(
    { start: 10, end: 20 },
    words,
    [{ i: 3, j: 5, reason: "言い直し" }],
    CFG,
  );
  assert.ok("segments" in result, "分割が成功するはず");
  if (!("segments" in result)) return;
  const segs = result.segments;
  // 隙間なく覆う
  assert.equal(segs[0]!.start, 10);
  assert.equal(segs[segs.length - 1]!.end, 20);
  for (let i = 0; i + 1 < segs.length; i++) {
    assert.equal(segs[i]!.end, segs[i + 1]!.start, "隣接 segment は隙間なく繋がる");
  }
  // 語境界スナップ(gap 中点。SD2 の規約と同じ round2)
  // i=3 の前境界 = midpoint(words[1].end=11.8, words[2].start=12.0) = 11.9
  // j=5 の後境界 = midpoint(words[4].end=14.8, words[5].start=15.0) = 14.9
  assert.deepEqual(
    segs.map((s) => [s.start, s.end, s.action]),
    [
      [10, 11.9, "keep"],
      [11.9, 14.9, "cut"],
      [14.9, 20, "keep"],
    ],
  );
  assert.equal(segs[1]!.reason, "言い直し");
});

test("splitSegmentAtWords: 隣接/重複する cutWordRanges は併合され reason が連結される", () => {
  const words = tenWords();
  const result = splitSegmentAtWords(
    { start: 10, end: 20 },
    words,
    [
      { i: 1, j: 2, reason: "r1" },
      { i: 3, j: 3, reason: "r2" },
    ],
    CFG,
  );
  assert.ok("segments" in result);
  if (!("segments" in result)) return;
  // i=1(先頭語)→ 前境界=seg.start=10。j=3 の後境界 = midpoint(12.8,13.0)=12.9
  assert.deepEqual(
    result.segments.map((s) => [s.start, s.end, s.action, s.reason]),
    [
      [10, 12.9, "cut", "r1 / r2"],
      [12.9, 20, "keep", ""],
    ],
  );
});

test("splitSegmentAtWords: 拒否系(index範囲外・i>j・words皆無)はエラーで書込みに進まない", () => {
  const words = tenWords();
  assert.ok("error" in splitSegmentAtWords({ start: 10, end: 20 }, words, [{ i: 0, j: 2, reason: "x" }], CFG));
  assert.ok("error" in splitSegmentAtWords({ start: 10, end: 20 }, words, [{ i: 5, j: 20, reason: "x" }], CFG));
  assert.ok("error" in splitSegmentAtWords({ start: 10, end: 20 }, words, [{ i: 5, j: 3, reason: "x" }], CFG));
  assert.ok("error" in splitSegmentAtWords({ start: 10, end: 20 }, [], [{ i: 1, j: 1, reason: "x" }], CFG));
});

test("splitSegmentAtWords: sub-segment が minCandidateSec 未満になる分割は拒否", () => {
  const words: WordTiming[] = [
    { text: "a", start: 0, end: 0.9 },
    { text: "b", start: 1.0, end: 5 },
    { text: "c", start: 5.1, end: 10 },
  ];
  // 前境界=midpoint(0.9,1.0)=0.95 → 先頭 keep [0,0.95] が 0.95秒。
  // minCandidateSec=2 のとき短すぎて拒否される
  const result = splitSegmentAtWords(
    { start: 0, end: 10 },
    words,
    [{ i: 2, j: 2, reason: "mid" }],
    { minCandidateSec: 2 },
  );
  assert.ok("error" in result);
});

test("applyCandidateSplits: splits:[] で base をそのまま返す(§1-1 バイト等価の要)", () => {
  const base: CutPlan = { approved: false, segments: [{ start: 0, end: 10, action: "keep", reason: "" }] };
  const result = applyCandidateSplits(base, [], [], CFG);
  assert.equal(result, base);
});

test("applyCandidateSplits: span一致する候補 segment を分割結果へ置換する", () => {
  const base: CutPlan = {
    approved: false,
    segments: [
      { start: 0, end: 10, action: "keep", reason: "" },
      { start: 10, end: 20, action: "keep", reason: "" },
    ],
  };
  const op: SplitOp = { candidateId: 2, segStart: 10, segEnd: 20, cutWordRanges: [{ i: 3, j: 5, reason: "言い直し" }] };
  const result = applyCandidateSplits(base, [op], tenWords(), CFG);
  assert.equal(result.approved, false);
  assert.equal(result.segments.length, 4); // 元1 + 分割後3
  assert.deepEqual(
    result.segments.map((s) => [s.start, s.end, s.action]),
    [
      [0, 10, "keep"],
      [10, 11.9, "keep"],
      [11.9, 14.9, "cut"],
      [14.9, 20, "keep"],
    ],
  );
});

test("applyCandidateSplits: span 不一致の split は捨てる(再実行耐性)", () => {
  const base: CutPlan = { approved: false, segments: [{ start: 0, end: 10, action: "keep", reason: "" }] };
  const op: SplitOp = { candidateId: 9, segStart: 100, segEnd: 110, cutWordRanges: [{ i: 1, j: 1, reason: "x" }] };
  const result = applyCandidateSplits(base, [op], [], CFG);
  assert.equal(result, base);
});

test("applyCandidateSplits: idCtx があれば置換後の sub-segment に新規採番する", () => {
  const base: CutPlan = {
    approved: false,
    segments: [{ id: "seg_aaaaaa", start: 10, end: 20, action: "keep", reason: "" }],
  };
  const op: SplitOp = { candidateId: 1, segStart: 10, segEnd: 20, cutWordRanges: [{ i: 3, j: 5, reason: "x" }] };
  const used = new Set<string>(["seg_aaaaaa"]);
  const result = applyCandidateSplits(base, [op], tenWords(), CFG, { used });
  assert.equal(result.segments.length, 3);
  for (const s of result.segments) {
    assert.match(s.id ?? "", /^seg_[0-9a-z]{6}$/);
  }
  // 新採番は既存 id と衝突しない(span が変わったので旧 id は運ばれない)
  const ids = new Set(result.segments.map((s) => s.id));
  assert.equal(ids.size, 3);
  assert.ok(!ids.has("seg_aaaaaa"));
});
