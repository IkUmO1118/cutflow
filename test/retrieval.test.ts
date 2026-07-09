import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchIndex, tokenizeRetrievalText, type RetrievalIndex } from "../src/lib/retrieval.ts";
import { buildRetrievalIndex } from "../src/stages/retrievalIndex.ts";

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

test("buildRetrievalIndex: recording 外を指す material path は結果へ載せない", () => {
  const root = mkdtempSync(join(tmpdir(), "cutflow-retrieval-"));
  const recording = join(root, "rec-1");
  try {
    mkdirSync(recording, { recursive: true });
    mkdirSync(join(recording, "materials.probe"), { recursive: true });
    writeFileSync(join(recording, "manifest.json"), JSON.stringify({
      source: "raw.mp4",
      durationSec: 10,
      video: { width: 1280, height: 720, fps: 30, screenRegion: { x: 0, y: 0, w: 1280, h: 720 } },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
      layout: "plain",
    }, null, 2));
    writeFileSync(join(recording, "materials.probe", "index.json"), JSON.stringify({
      materials: [{
        file: "../secret.png",
        ocr: "hidden text",
      }],
    }, null, 2));
    const index = buildRetrievalIndex(root);
    const results = searchIndex(index, { query: "hidden text", kind: "material" });
    assert.ok(results.length >= 1);
    assert.ok(results.every((result) => result.relativePath === undefined));
    assert.ok(index.warnings.some((warning) => warning.includes("invalid material path")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
