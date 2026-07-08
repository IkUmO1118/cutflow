import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProposalResolution,
  applyResolution,
  proposalDiff,
  threeWayDiff,
} from "../src/lib/docDiff.ts";
import type { ProposalResolution, ReviewDocs, Resolution } from "../src/lib/docDiff.ts";

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

test("proposalDiff: base と proposed の全変更を hunk として出す", () => {
  const base = docs();
  const proposed = docs();
  proposed.cutplan.segments[0].reason = "proposal";
  proposed.transcript.segments[0].text = "shorter";
  const result = proposalDiff(base, proposed);
  assert.equal(result.cleanMerge, true);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.hunks.length, 2);
});

test("applyProposalResolution: すべて不採用なら base と等価", () => {
  const base = docs();
  const proposed = docs();
  proposed.cutplan.segments[0].reason = "proposal";
  proposed.transcript.segments[0].text = "shorter";
  const result = proposalDiff(base, proposed);
  const resolution: ProposalResolution = new Map(result.hunks.map((h) => [h, "mine"] as const));
  const merged = applyProposalResolution(base, proposed, result, resolution);
  assert.deepEqual(merged, base);
});

test("applyProposalResolution: すべて採用なら proposed と等価", () => {
  const base = docs();
  const proposed = docs();
  proposed.cutplan.segments[0].reason = "proposal";
  proposed.transcript.segments[0].text = "shorter";
  const result = proposalDiff(base, proposed);
  const resolution: ProposalResolution = new Map(result.hunks.map((h) => [h, "theirs"] as const));
  const merged = applyProposalResolution(base, proposed, result, resolution);
  assert.deepEqual(merged, proposed);
});

test("applyProposalResolution: 1 hunk だけ不採用にできる", () => {
  const base = docs();
  const proposed = docs();
  proposed.cutplan.segments[0].reason = "proposal";
  proposed.transcript.segments[0].text = "shorter";
  const result = proposalDiff(base, proposed);
  const resolution: ProposalResolution = new Map(result.hunks.map((h) => [h, "theirs"] as const));
  const rejected = result.hunks.find((h) => h.address.file === "transcript");
  assert.ok(rejected);
  resolution.set(rejected, "mine");
  const merged = applyProposalResolution(base, proposed, result, resolution);
  assert.equal(merged.cutplan.segments[0].reason, "proposal");
  assert.equal(merged.transcript.segments[0].text, "base");
});

test("applyProposalResolution: approved は提案差分にも反映結果にも混ぜない", () => {
  const base = docs();
  const proposed = docs();
  base.cutplan.approved = true;
  base.shorts!.shorts[0].approved = true;
  proposed.cutplan.approved = false;
  proposed.shorts!.shorts[0].approved = false;
  proposed.transcript.segments[0].text = "proposal";
  const result = proposalDiff(base, proposed);
  assert.equal(result.hunks.some((h) => h.address.field === "approved"), false);
  const merged = applyProposalResolution(base, proposed, result, new Map());
  assert.equal(merged.cutplan.approved, true);
  assert.equal(merged.shorts!.shorts[0].approved, true);
  assert.equal(merged.transcript.segments[0].text, "proposal");
});
