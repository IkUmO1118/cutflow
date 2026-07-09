import test from "node:test";
import assert from "node:assert/strict";
import { compileEditIntents } from "../src/lib/editIntent.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

const docs = (): LoadedDocs => ({
  manifest: { durationSec: 10, video: { width: 100, height: 100, fps: 30, screenRegion: { x: 0, y: 0, w: 100, h: 100 } } },
  cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
  transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 2, text: "old" }] },
  overlays: {},
  chapters: null,
  bgm: null,
  meta: null,
  shorts: null,
  thumbnail: null,
});

test("compileEditIntents: range中央を3分割しapprovedを変えない", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-range-action",
    range: { startSec: 2, endSec: 4 },
    action: "cut",
    reason: "pause",
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  const cutplan = result.patch.replace?.cutplan;
  assert.equal(cutplan?.approved, false);
  assert.deepEqual(cutplan?.segments.map((segment) => [segment.start, segment.end, segment.action]), [
    [0, 2, "keep"], [2, 4, "cut"], [4, 10, "keep"],
  ]);
  assert.equal(cutplan?.segments[0].id, "seg_aaaaaa");
});

test("compileEditIntents: caption textだけを変更する", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-caption-text",
    target: "@cap_aaaaaa",
    text: "new",
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  assert.equal(result.patch.replace?.transcript?.segments[0].text, "new");
  assert.equal(result.patch.replace?.transcript?.segments[0].start, 1);
});
