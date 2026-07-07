import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, threeWayDiff } from "../src/lib/docDiff.ts";
import type { ReviewDocs, Resolution } from "../src/lib/docDiff.ts";

const docs = (): ReviewDocs => ({
  cutplan: {
    approved: false,
    segments: [{ id: "seg_aaaaaa", start: 0, end: 1, action: "keep", reason: "base" }],
  },
  overlays: { captionTracks: [{ id: "ct_aaaaaa", track: 1, style: { color: "#fff" } }] },
  transcript: {
    language: "ja",
    model: "m",
    segments: [{ id: "cap_aaaaaa", start: 0, end: 1, text: "base" }],
  },
  bgm: { tracks: [{ id: "bg_aaaaaa", start: 0, end: 1, file: "a.mp3" }] },
  shorts: {
    shorts: [{ name: "s1", approved: false, ranges: [{ id: "rg_aaaaaa", start: 0, end: 1 }] }],
  },
});

test("threeWayDiff: mine == base なら conflict は空", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  theirs.transcript.segments[0].text = "disk";
  const result = threeWayDiff(base, mine, theirs);
  assert.equal(result.cleanMerge, true);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].conflict, false);
});

test("threeWayDiff: 同じ id の同じフィールドを双方が変更したら conflict", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  mine.cutplan.segments[0].reason = "mine";
  theirs.cutplan.segments[0].reason = "theirs";
  const result = threeWayDiff(base, mine, theirs);
  assert.equal(result.cleanMerge, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].address.label, "cutplan segments seg_aaaaaa .reason");
});

test("threeWayDiff: id 無し配列は配列まるごとの hunk にする", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  delete base.transcript.segments[0].id;
  delete mine.transcript.segments[0].id;
  delete theirs.transcript.segments[0].id;
  mine.transcript.segments[0].text = "mine";
  theirs.transcript.segments[0].text = "theirs";
  const result = threeWayDiff(base, mine, theirs);
  const hunk = result.conflicts.find((h) => h.address.file === "transcript");
  assert.equal(hunk?.kind, "file");
  assert.equal(hunk?.address.arrayKey, "segments");
  assert.equal(hunk?.address.elementId, undefined);
});

test("applyResolution: clean merge は theirs だけの変更と mine だけの変更を合成する", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  mine.cutplan.segments[0].reason = "mine";
  theirs.transcript.segments[0].text = "disk";
  const result = threeWayDiff(base, mine, theirs);
  assert.equal(result.cleanMerge, true);
  const merged = applyResolution(theirs, result, new Map());
  assert.equal(merged.cutplan.segments[0].reason, "mine");
  assert.equal(merged.transcript.segments[0].text, "disk");
});

test("applyResolution: conflict は resolution に従う", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  mine.cutplan.segments[0].reason = "mine";
  theirs.cutplan.segments[0].reason = "theirs";
  const result = threeWayDiff(base, mine, theirs);
  const resolution: Resolution = new Map([[result.conflicts[0], "mine"]]);
  const merged = applyResolution(theirs, result, resolution);
  assert.equal(merged.cutplan.segments[0].reason, "mine");
});

test("approved は hunk に出さず、merge 結果は theirs を保つ", () => {
  const base = docs();
  const mine = docs();
  const theirs = docs();
  mine.cutplan.approved = true;
  theirs.cutplan.approved = false;
  mine.shorts!.shorts[0].approved = true;
  theirs.shorts!.shorts[0].approved = false;
  const result = threeWayDiff(base, mine, theirs);
  assert.equal(result.hunks.some((h) => h.address.field === "approved"), false);
  const merged = applyResolution(theirs, result, new Map());
  assert.equal(merged.cutplan.approved, false);
  assert.equal(merged.shorts!.shorts[0].approved, false);
});

