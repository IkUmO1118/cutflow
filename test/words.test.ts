// lib/words.ts の transcriptHasWords(語タイムスタンプ資産化の判定。§W0)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptHasWords } from "../src/lib/words.ts";
import type { Transcript } from "../src/types.ts";

test("transcriptHasWords: 1件でも words[] を持つ segment があれば true", () => {
  const transcript: Transcript = {
    language: "ja",
    model: "test",
    segments: [
      { start: 0, end: 1, text: "こんにちは" },
      {
        start: 1, end: 2, text: "世界",
        words: [{ text: "世界", start: 1, end: 2 }],
      },
    ],
  };
  assert.equal(transcriptHasWords(transcript), true);
});

test("transcriptHasWords: どの segment も words を持たなければ false", () => {
  const transcript: Transcript = {
    language: "ja",
    model: "test",
    segments: [
      { start: 0, end: 1, text: "こんにちは" },
      { start: 1, end: 2, text: "世界" },
    ],
  };
  assert.equal(transcriptHasWords(transcript), false);
});

test("transcriptHasWords: words が空配列だけなら false", () => {
  const transcript: Transcript = {
    language: "ja",
    model: "test",
    segments: [
      { start: 0, end: 1, text: "こんにちは", words: [] },
    ],
  };
  assert.equal(transcriptHasWords(transcript), false);
});

test("transcriptHasWords: 章テロップだけ(words 無し)の transcript は false", () => {
  const transcript: Transcript = {
    language: "ja",
    model: "test",
    segments: [
      { start: 0, end: 1, text: "第1章" },
    ],
  };
  assert.equal(transcriptHasWords(transcript), false);
});
