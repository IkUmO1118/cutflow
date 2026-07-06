// src/lib/mention.ts — @-mention 解決(collectIds / collectIdOccurrences /
// resolveMention)の純ロジックを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectIds, collectIdOccurrences, resolveMention } from "../src/lib/mention.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

/** 全ファイル null の LoadedDocs(id 無し docs のベース) */
const emptyDocs: LoadedDocs = {
  manifest: null,
  cutplan: null,
  transcript: null,
  overlays: null,
  bgm: null,
  chapters: null,
  meta: null,
  shorts: null,
  thumbnail: null,
};

test("collectIds: 全ファイルを網羅する(各種別1件ずつ)", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    cutplan: { approved: false, segments: [{ id: "seg_a1a1a1", start: 0, end: 1, action: "keep", reason: "x" }] },
    transcript: { segments: [{ id: "cap_b2b2b2", start: 0, end: 1, text: "hi" }] },
    overlays: {
      overlays: [{ id: "mat_c3c3c3", start: 0, end: 1, file: "a.png" }],
      inserts: [{ id: "ins_d4d4d4", at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ id: "wf_e5e5e5", start: 0, end: 1 }],
      hideCaption: [{ id: "hc_f6f6f6", start: 0, end: 1 }],
      zooms: [{ id: "zm_g7g7g7", start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      blurs: [{ id: "bl_h8h8h8", start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      captionTracks: [{ id: "ct_i9i9i9", track: 1 }],
    },
    chapters: { chapters: [{ id: "ch_j0j0j0", start: 0, title: "導入" }] },
    bgm: { tracks: [{ id: "bg_k1k1k1", start: 0, end: 1, file: "bgm.mp3" }] },
    shorts: {
      shorts: [
        {
          name: "intro",
          approved: false,
          ranges: [{ id: "rg_l2l2l2", start: 0, end: 1 }],
          captionTracks: [{ id: "ct_m3m3m3", track: 1 }],
        },
      ],
    },
    thumbnail: { t: 0, texts: [{ id: "tx_n4n4n4", text: "hi", pos: { x: 0, y: 0 } }] },
  };
  const index = collectIds(docs);
  for (const id of [
    "seg_a1a1a1", "cap_b2b2b2", "mat_c3c3c3", "ins_d4d4d4", "wf_e5e5e5",
    "hc_f6f6f6", "zm_g7g7g7", "bl_h8h8h8", "ct_i9i9i9", "ch_j0j0j0",
    "bg_k1k1k1", "rg_l2l2l2", "ct_m3m3m3", "tx_n4n4n4", "intro",
  ]) {
    assert.ok(index.has(id), `missing ${id}`);
  }
  assert.equal(index.size, 15);
});

test("resolveMention: '@cap_xxx' と 'cap_xxx' の両方を解決する", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    transcript: { segments: [{ id: "cap_b2b2b2", start: 0, end: 1, text: "hi" }] },
  };
  const index = collectIds(docs);
  const a = resolveMention("@cap_b2b2b2", index);
  const b = resolveMention("cap_b2b2b2", index);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a!.file, "transcript.json");
  assert.equal(a!.kind, "caption");
  assert.equal(a!.path, "segments[0]");
  assert.deepEqual(a, b);
});

test("resolveMention: short は name で解決する('@intro' と '@short:intro' の両方)", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    shorts: { shorts: [{ name: "intro", approved: false, ranges: [{ start: 0, end: 1 }] }] },
  };
  const index = collectIds(docs);
  const a = resolveMention("@intro", index);
  const b = resolveMention("@short:intro", index);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a!.kind, "short");
  assert.equal(a!.file, "shorts.json");
  assert.deepEqual(a, b);
});

test("resolveMention: 未知の id/name は null", () => {
  const index = collectIds(emptyDocs);
  assert.equal(resolveMention("@cap_nope00", index), null);
  assert.equal(resolveMention("nope", index), null);
});

test("collectIds: id の無い docs は空の索引(空 docs でも壊れない)", () => {
  const index = collectIds(emptyDocs);
  assert.equal(index.size, 0);
});

test("collectIds: id 無し要素が混ざっていても id 有りだけ拾う", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 1, action: "keep", reason: "x" },
        { id: "seg_a1a1a1", start: 1, end: 2, action: "cut", reason: "y" },
      ],
    },
  };
  const index = collectIds(docs);
  assert.equal(index.size, 1);
  assert.equal(index.get("seg_a1a1a1")!.path, "segments[1]");
});

test("collectIdOccurrences: 重複 id は複数エントリとして列挙される(最初が既出の所在)", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_dup0001", start: 0, end: 1, action: "keep", reason: "x" },
        { id: "seg_dup0001", start: 1, end: 2, action: "keep", reason: "y" },
      ],
    },
  };
  const occ = collectIdOccurrences(docs).filter(([id]) => id === "seg_dup0001");
  assert.equal(occ.length, 2);
  assert.equal(occ[0][1].path, "segments[0]");
  assert.equal(occ[1][1].path, "segments[1]");
});

test("collectIds: 重複 id は最初の所在を残す(collectIdOccurrences と整合)", () => {
  const docs: LoadedDocs = {
    ...emptyDocs,
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_dup0001", start: 0, end: 1, action: "keep", reason: "x" },
        { id: "seg_dup0001", start: 1, end: 2, action: "keep", reason: "y" },
      ],
    },
  };
  const index = collectIds(docs);
  assert.equal(index.get("seg_dup0001")!.path, "segments[0]");
});
