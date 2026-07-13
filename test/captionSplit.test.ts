// lib/captionSplit.ts のテロップ粒度割り直し。whisper の長い 1 セグメントを
// 「約 maxChars 文字」の文節境界で割り、時刻(words[] があれば語境界)・文言・
// カラオケ補助データ(words[])の整合を保つことを固定する純関数テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLongCaptions } from "../src/lib/captionSplit.ts";
import type { TranscriptSegment, WordTiming } from "../src/types.ts";

// 実データ(2026-07-12 の whisper 生セグメント)を模した 30 字・語タイムスタンプ付き。
// 手編集では「時間もお金も両方持っていかれてるって|結構理不尽じゃないですか」に割れた。
const words30: WordTiming[] = [
  { text: "時間", start: 13.36, end: 13.76 },
  { text: "も", start: 13.76, end: 13.96 },
  { text: "お金", start: 13.96, end: 14.36 },
  { text: "も", start: 14.36, end: 14.56 },
  { text: "両方", start: 14.56, end: 14.94 },
  { text: "持って", start: 14.95, end: 15.55 },
  { text: "いかれてる", start: 15.55, end: 16.61 },
  { text: "って", start: 16.62, end: 16.8 },
  { text: "結構", start: 16.8, end: 17.18 },
  { text: "理不尽", start: 17.18, end: 17.76 },
  { text: "じゃない", start: 17.78, end: 18.58 },
  { text: "ですか", start: 18.58, end: 19.18 },
];
const seg30: TranscriptSegment = {
  start: 13.36,
  end: 19.22,
  text: words30.map((w) => w.text).join(""),
  words: words30,
};

test("maxChars 以下の segment は同一参照でそのまま返す(非改変・バイト等価)", () => {
  const short: TranscriptSegment = { start: 0, end: 2, text: "短いテロップ" };
  const out = splitLongCaptions([short], { maxChars: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0], short); // 同一参照
});

test("maxChars<=0 なら入力配列をそのまま返す(opt-in オフ)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 0 });
  assert.equal(out, [seg30].length === 1 ? out : out); // 型のため
  assert.equal(out.length, 1);
  assert.equal(out[0], seg30);
});

test("長い segment を文節末(って)で割り、各断片は maxChars 以下", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20, minChars: 8 });
  assert.ok(out.length >= 2, `2 断片以上に割れる: ${out.length}`);
  for (const s of out) {
    assert.ok([...s.text].length <= 20, `各断片 20 字以下: "${s.text}"(${[...s.text].length}字)`);
  }
  // 期待する割れ目: 「…って」で 1 枚目が終わる
  assert.equal(out[0].text, "時間もお金も両方持っていかれてるって");
  assert.equal(out[1].text, "結構理不尽じゃないですか");
});

test("分割後の文言を全連結すると元の text に一致(文字の欠落なし)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  assert.equal(out.map((s) => s.text).join(""), seg30.text);
});

test("時刻は語境界そのもの・時系列で連続(捏造しない)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  assert.equal(out[0].start, 13.36); // 先頭語の start
  assert.equal(out[out.length - 1].end, 19.18); // 末尾語の end
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start >= out[i - 1].end, "断片は時系列・非重なり");
    assert.ok(out[i].end > out[i].start, "各断片は正の尺");
  }
});

test("words[] を各断片へ分配してカラオケ補助を保つ(語 atom のとき)", () => {
  const out = splitLongCaptions([seg30], { maxChars: 20 });
  for (const s of out) {
    assert.ok(s.words && s.words.length > 0, `words を保持: "${s.text}"`);
    assert.equal(s.words!.map((w) => w.text).join(""), s.text); // words と text が整合
    assert.equal(s.words![0].start, s.start);
    assert.equal(s.words![s.words!.length - 1].end, s.end);
  }
  // 分配された words の総数は元と一致(欠落・重複なし)
  const total = out.reduce((n, s) => n + (s.words?.length ?? 0), 0);
  assert.equal(total, words30.length);
});

test("words[] が無い長い segment は文字位置で線形補間して割る", () => {
  const noWords: TranscriptSegment = {
    start: 0,
    end: 10,
    text: "あいうえおかきくけこさしすせそたちつてとなにぬねの", // 25 字・句末語なし
  };
  const out = splitLongCaptions([noWords], { maxChars: 20, minChars: 8 });
  assert.ok(out.length >= 2, "文字数上限で割れる");
  assert.equal(out.map((s) => s.text).join(""), noWords.text);
  assert.equal(out[0].start, 0);
  assert.equal(out[out.length - 1].end, 10);
  for (const s of out) assert.ok(!s.words, "words は付かない");
});

test("track/pos/style は全断片へ継承される", () => {
  const styled: TranscriptSegment = {
    ...seg30,
    track: 2,
    pos: { x: 100, y: 200 },
    style: { fontSizePx: 48 },
  };
  const out = splitLongCaptions([styled], { maxChars: 20 });
  assert.ok(out.length >= 2);
  for (const s of out) {
    assert.equal(s.track, 2);
    assert.deepEqual(s.pos, { x: 100, y: 200 });
    assert.deepEqual(s.style, { fontSizePx: 48 });
  }
});
