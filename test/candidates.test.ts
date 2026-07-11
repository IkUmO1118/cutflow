// lib/candidates.ts — plan の候補格子を語境界で細分化(C1)+ 候補テキストの
// 語ベース化(C8)。§docs/plans/2026-07-11-c1-word-candidate-grid-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateText,
  collectWords,
  splitPointsForKeep,
  subdivideCandidates,
} from "../src/lib/candidates.ts";
import type { CandidatesCfg } from "../src/lib/candidates.ts";
import type { Interval, Transcript, WordTiming } from "../src/types.ts";
import { numberSegments, numberSegmentsWords } from "../src/stages/plan.ts";

const CFG: CandidatesCfg = {
  enabled: true,
  splitOnlyLongerThanSec: 6,
  minSplitGapSec: 0.3,
  minCandidateSec: 0.5,
  fillers: ["えー", "えっと", "あの"],
};

/** 10秒の keep に、0.2秒間隔で発話した語+1箇所の大きな間+1箇所のフィラーを置く */
function makeTranscript(): Transcript {
  const words: WordTiming[] = [
    { text: "これは", start: 0, end: 1 },
    { text: "テスト", start: 1, end: 2 },
    { text: "です", start: 2, end: 3 },
    // 3〜4.5 が大きな間(1.5秒 >= minSplitGapSec)
    { text: "えー", start: 4.5, end: 5 },
    { text: "つづき", start: 5, end: 6 },
    { text: "です", start: 6, end: 7 },
    { text: "ね", start: 7, end: 10 },
  ];
  return {
    language: "ja",
    model: "test",
    segments: [{ start: 0, end: 10, text: words.map((w) => w.text).join(""), words }],
  };
}

test("collectWords: 全 segment の words を時系列に集める", () => {
  const t = makeTranscript();
  const words = collectWords(t);
  assert.equal(words.length, 7);
  assert.equal(words[0].text, "これは");
  assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start));
});

test("タイル性: subdivideCandidates は各元 keep を隙間・重なりなく完全被覆する", () => {
  const t = makeTranscript();
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const out = subdivideCandidates(keeps, t, CFG);
  assert.ok(out.length > 1, "分割されているはず");
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 10);
  for (let i = 0; i + 1 < out.length; i++) {
    assert.equal(out[i].end, out[i + 1].start, `隙間/重なり: ${JSON.stringify(out)}`);
  }
});

test("恒等: enabled=false は入力配列と同一(参照そのもの)", () => {
  const t = makeTranscript();
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const out = subdivideCandidates(keeps, t, { ...CFG, enabled: false });
  assert.equal(out, keeps);
});

test("恒等: words 皆無なら入力配列と同一(参照そのもの)", () => {
  const t: Transcript = { language: "ja", model: "test", segments: [{ start: 0, end: 10, text: "words無し" }] };
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const out = subdivideCandidates(keeps, t, CFG);
  assert.equal(out, keeps);
});

test("splitOnlyLongerThanSec: 閾値以下の keep は分割されない", () => {
  const t = makeTranscript();
  const keeps: Interval[] = [{ start: 0, end: 5 }];
  const out = subdivideCandidates(keeps, t, { ...CFG, splitOnlyLongerThanSec: 6 });
  assert.deepEqual(out, keeps);
});

test("minCandidateSec: 近接分割点が間引かれ、どの sub も minCandidateSec 以上", () => {
  const t = makeTranscript();
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const out = subdivideCandidates(keeps, t, { ...CFG, minCandidateSec: 2 });
  for (const seg of out) {
    assert.ok(seg.end - seg.start >= 2 - 1e-9, `短すぎる sub: ${JSON.stringify(seg)}`);
  }
});

test("語境界(C7): 分割点は語間ギャップの中(前語 end < p < 次語 start)", () => {
  const t = makeTranscript();
  const words = collectWords(t);
  const pts = splitPointsForKeep({ start: 0, end: 10 }, words, CFG);
  // 3(です end)〜4.5(えー start) の間のギャップ由来の分割点があるはず
  const gapPoint = pts.find((p) => p > 3 && p < 4.5);
  assert.ok(gapPoint !== undefined, `ギャップ内の分割点が無い: ${JSON.stringify(pts)}`);
});

test("フィラー: フィラー語が単独 sub-candidate として切り出せる", () => {
  const t = makeTranscript();
  const words = collectWords(t);
  const pts = splitPointsForKeep({ start: 0, end: 10 }, words, CFG);
  assert.ok(pts.includes(4.5), `フィラー開始(えー start=4.5)が分割点に無い: ${JSON.stringify(pts)}`);
  assert.ok(pts.includes(5), `フィラー終了(えー end=5)が分割点に無い: ${JSON.stringify(pts)}`);
});

test("candidateText(C8): 中点がその候補に入る語だけを連結する(隣候補と重複しない)", () => {
  const words: WordTiming[] = [
    { text: "abc", start: 0, end: 2 }, // 中点1.0
    { text: "def", start: 2, end: 4 }, // 中点3.0
  ];
  assert.equal(candidateText({ start: 0, end: 2.5 }, words), "abc");
  assert.equal(candidateText({ start: 2.5, end: 4 }, words), "def");
});

test("candidateText: words 皆無なら null(呼び出し側フォールバック用)", () => {
  assert.equal(candidateText({ start: 0, end: 1 }, []), null);
});

test("plan 経路: numberSegmentsWords は words フォールバック時 numberSegments と一致する", () => {
  const t: Transcript = {
    language: "ja",
    model: "test",
    segments: [{ start: 0, end: 10, text: "words無しの発話" }],
  };
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  assert.deepEqual(numberSegmentsWords(keeps, t), numberSegments(keeps, t));
});
