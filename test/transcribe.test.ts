// stages/transcribe.ts の buildWords(whisper -ojf の tokens[] → WordTiming[])を固定する。
// 実機の whisper-cli -ojf 実測(docs/plans/2026-07-06-word-timestamps-design.md)を
// 模したミニ fixture で、特殊トークン除外・ms→秒変換・trim・confidence 転記を検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWords, applyTranscriptIds } from "../src/stages/transcribe.ts";
import type { WhisperToken } from "../src/stages/transcribe.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { TranscriptSegment } from "../src/types.ts";

test("buildWords: 実測に近い tokens[] から特殊トークンを除いた words[] を組み立てる", () => {
  const tokens: WhisperToken[] = [
    { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.1 },
    { text: "から", offsets: { from: 880, to: 2630 }, p: 0.976 },
    { text: "テ", offsets: { from: 2630, to: 3100 }, p: 0.92 },
    { text: "スト", offsets: { from: 3100, to: 3600 }, p: 0.88 },
    { text: "[_TT_441]", offsets: { from: 4410, to: 4410 }, p: 0.05 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "から", start: 0.88, end: 2.63, confidence: 0.976 },
    { text: "テ", start: 2.63, end: 3.1, confidence: 0.92 },
    { text: "スト", start: 3.1, end: 3.6, confidence: 0.88 },
  ]);
});

test("buildWords: 英語トークンの先頭空白を trim する", () => {
  const tokens: WhisperToken[] = [
    { text: " Hello", offsets: { from: 0, to: 500 }, p: 0.9 },
    { text: " world", offsets: { from: 500, to: 1000 }, p: 0.9 },
  ];
  const words = buildWords(tokens);
  assert.equal(words[0].text, "Hello");
  assert.equal(words[1].text, "world");
});

test("buildWords: trim 後空文字のトークンは除外", () => {
  const tokens: WhisperToken[] = [
    { text: "  ", offsets: { from: 0, to: 100 }, p: 0.5 },
    { text: "本文", offsets: { from: 100, to: 600 }, p: 0.9 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "本文", start: 0.1, end: 0.6, confidence: 0.9 },
  ]);
});

test("buildWords: from>=to のゼロ幅トークンは除外(角括弧でなくても)", () => {
  const tokens: WhisperToken[] = [
    { text: "ゼロ幅", offsets: { from: 500, to: 500 }, p: 0.5 },
    { text: "逆転", offsets: { from: 700, to: 600 }, p: 0.5 },
    { text: "本文", offsets: { from: 600, to: 900 }, p: 0.9 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "本文", start: 0.6, end: 0.9, confidence: 0.9 },
  ]);
});

test("buildWords: confidence(p)が数値でなければ省略する", () => {
  const tokens: WhisperToken[] = [
    { text: "本文", offsets: { from: 0, to: 500 } },
  ];
  const words = buildWords(tokens);
  assert.equal(words.length, 1);
  assert.equal("confidence" in words[0], false);
});

test("buildWords: tokens が undefined なら空配列", () => {
  assert.deepEqual(buildWords(undefined), []);
});

test("buildWords: tokens が空配列なら空配列", () => {
  assert.deepEqual(buildWords([]), []);
});

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

const segments: TranscriptSegment[] = [
  { start: 0, end: 1, text: "こんにちは" },
  { start: 1, end: 2, text: "今日は" },
];

test("applyTranscriptIds: idCtx 省略時は id に一切触れない(導入前とバイト等価)", () => {
  const out = applyTranscriptIds(segments);
  assert.equal(out, segments); // 同一参照(何も変換していない)
  for (const s of out) assert.equal("id" in s, false);
});

test("applyTranscriptIds: idCtx ありで (start,end,text) 完全一致の旧 id を運ぶ", () => {
  const existingSegments: TranscriptSegment[] = [
    { id: "cap_aaaaaa", start: 0, end: 1, text: "こんにちは" },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const out = applyTranscriptIds(segments, { existingSegments, used });
  assert.equal(out[0].id, "cap_aaaaaa");
  assert.match(out[1].id as string, ID_RE);
});

test("applyTranscriptIds: 内容が変わった(再分割された)セグメントは新 id になる", () => {
  const existingSegments: TranscriptSegment[] = [
    { id: "cap_aaaaaa", start: 0, end: 1, text: "こんにちは(旧文言)" },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const out = applyTranscriptIds(segments, { existingSegments, used });
  assert.notEqual(out[0].id, "cap_aaaaaa");
  assert.match(out[0].id as string, ID_RE);
});
