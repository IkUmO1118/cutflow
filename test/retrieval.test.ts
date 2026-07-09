import test from "node:test";
import assert from "node:assert/strict";
import { searchIndex, tokenizeRetrievalText, type RetrievalIndex } from "../src/lib/retrieval.ts";

test("tokenizeRetrievalText: NFKC、ASCII、日本語2/3-gram", () => {
  const tokens = tokenizeRetrievalText("ＡＰＩ ログイン画面");
  assert.ok(tokens.includes("api"));
  assert.ok(tokens.includes("ログ"));
  assert.ok(tokens.includes("画面"));
});

test("searchIndex: weighting、scope、stable result", () => {
  const index: RetrievalIndex = {
    schemaVersion: 1,
    builtAt: "2026-01-01",
    root: "recordings",
    warnings: [],
    recordings: [
      { name: "current", fingerprint: "a", mtimeMs: 2 },
      { name: "old", fingerprint: "b", mtimeMs: 1 },
    ],
    documents: [
      { id: "a", recordingDir: "current", kind: "material", title: "other", text: "ログイン", file: "materials/a.png", fingerprint: "a", tokens: tokenizeRetrievalText("ログイン") },
      { id: "b", recordingDir: "old", kind: "material", title: "ログイン", text: "", file: "materials/b.png", fingerprint: "b", tokens: [] },
    ],
  };
  const results = searchIndex(index, { query: "ログイン", kind: "material", scope: "other", currentRecording: "current" });
  assert.equal(results.length, 1);
  assert.equal(results[0].recording, "old");
  assert.equal(results[0].relativePath, "materials/b.png");
});
