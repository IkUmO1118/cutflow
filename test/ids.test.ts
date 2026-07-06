// src/lib/ids.ts — 安定 id の採番(ensureIds)・引き継ぎ(carryIds)・
// 一括 stamp(stampDocs)・opt-in 判定(hasAnyId)の純ロジックを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ID_PREFIX,
  ID_RE,
  newId,
  ensureIds,
  carryIds,
  stampDocs,
  hasAnyId,
} from "../src/lib/ids.ts";
import type { EditableDocs } from "../src/lib/ids.ts";

/** 全ファイル null の EditableDocs(空 docs) */
const emptyDocs: EditableDocs = {
  cutplan: null,
  transcript: null,
  overlays: null,
  chapters: null,
  bgm: null,
  shorts: null,
  thumbnail: null,
};

test("newId: ID_RE に一致する id を作る", () => {
  const used = new Set<string>();
  const id = newId(ID_PREFIX.cutSegment, used);
  assert.match(id, ID_RE);
  assert.ok(id.startsWith("seg_"));
});

test("newId: 生成した id は used に登録され、以降の呼び出しと重複しない", () => {
  const used = new Set<string>();
  const ids = new Set(Array.from({ length: 200 }, () => newId("zm", used)));
  // 200個生成して used に全部乗っている(重複が起きていれば used.size は 200 未満になる)
  assert.equal(ids.size, 200);
  assert.equal(used.size, 200);
});

test("newId: 既存 used と衝突する乱数は振り直す(衝突誘発で確認)", () => {
  const used = new Set<string>();
  // Math.random を固定シーケンスで差し替え、最初の2回は同じ値(衝突)を返すようにする
  const orig = Math.random;
  let calls = 0;
  const seq = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
  Math.random = () => seq[calls++ % seq.length];
  try {
    const first = newId("zm", used);
    const second = newId("zm", used);
    assert.notEqual(first, second);
  } finally {
    Math.random = orig;
  }
});

test("ensureIds: 既存 id は不変・欠落だけ採番", () => {
  const used = new Set<string>();
  const arr = [{ id: "seg_abc123", start: 0 }, { start: 1 }, { id: "seg_def456", start: 2 }];
  const out = ensureIds(arr, ID_PREFIX.cutSegment, used);
  assert.equal(out[0].id, "seg_abc123");
  assert.equal(out[2].id, "seg_def456");
  assert.notEqual(out[1].id, undefined);
  assert.match(out[1].id as string, ID_RE);
});

test("ensureIds: 返り値の新規 id はすべて ID_RE に一致する", () => {
  const used = new Set<string>();
  const arr = [{}, {}, {}];
  const out = ensureIds(arr, ID_PREFIX.caption, used);
  for (const x of out) assert.match(x.id as string, ID_RE);
});

test("ensureIds: used に既存 id を渡すと新規採番と衝突しない", () => {
  const used = new Set<string>(["cap_zzzzzz"]);
  const arr = [{}];
  const out = ensureIds(arr, ID_PREFIX.caption, used);
  assert.notEqual(out[0].id, "cap_zzzzzz");
});

test("ensureIds: 新規採番した id は要素の先頭キーになる(types.ts のスキーマ通り)", () => {
  const used = new Set<string>();
  const out = ensureIds([{ start: 0, end: 1 }], ID_PREFIX.cutSegment, used);
  assert.deepEqual(Object.keys(out[0]), ["id", "start", "end"]);
});

test("ensureIds: 破壊的でない(入力配列・要素を変更しない)", () => {
  const used = new Set<string>();
  const original = { start: 0 };
  const arr = [original];
  ensureIds(arr, ID_PREFIX.cutSegment, used);
  assert.equal("id" in original, false);
  assert.equal(arr[0], original);
});

test("carryIds: key 一致で旧 id を運ぶ", () => {
  const oldArr = [{ id: "seg_aaaaaa", start: 0, end: 1 }, { id: "seg_bbbbbb", start: 1, end: 2 }];
  const newArr = [{ start: 1, end: 2 }, { start: 0, end: 1 }];
  const keyFn = (x: { start: number; end: number }) => `${x.start}:${x.end}`;
  const out = carryIds(oldArr, newArr, keyFn);
  assert.equal(out[0].id, "seg_bbbbbb");
  assert.equal(out[1].id, "seg_aaaaaa");
});

test("carryIds: key 不一致は id 無しのまま(採番しない)", () => {
  const oldArr = [{ id: "seg_aaaaaa", start: 0, end: 1 }];
  const newArr = [{ start: 5, end: 6 }];
  const keyFn = (x: { start: number; end: number }) => `${x.start}:${x.end}`;
  const out = carryIds(oldArr, newArr, keyFn);
  assert.equal(out[0].id, undefined);
});

test("carryIds: 同じ key が複数あっても id を使い回さない(キュー消費)", () => {
  const oldArr = [
    { id: "seg_aaaaaa", start: 0, end: 1 },
    { id: "seg_bbbbbb", start: 0, end: 1 },
  ];
  const newArr = [{ start: 0, end: 1 }, { start: 0, end: 1 }];
  const keyFn = (x: { start: number; end: number }) => `${x.start}:${x.end}`;
  const out = carryIds(oldArr, newArr, keyFn);
  assert.equal(out[0].id, "seg_aaaaaa");
  assert.equal(out[1].id, "seg_bbbbbb");
});

test("carryIds: 既に id を持つ新要素は上書きしない", () => {
  const oldArr = [{ id: "seg_aaaaaa", start: 0, end: 1 }];
  const newArr = [{ id: "seg_zzzzzz", start: 0, end: 1 }];
  const keyFn = (x: { start: number; end: number }) => `${x.start}:${x.end}`;
  const out = carryIds(oldArr, newArr, keyFn);
  assert.equal(out[0].id, "seg_zzzzzz");
});

test("hasAnyId: 全 id 無しで false", () => {
  const docs: EditableDocs = {
    ...emptyDocs,
    cutplan: { approved: false, segments: [{ start: 0, end: 1, action: "keep", reason: "x" }] },
    transcript: { language: "ja", model: "m", segments: [{ start: 0, end: 1, text: "a" }] },
  };
  assert.equal(hasAnyId(docs), false);
});

test("hasAnyId: 空 docs(全ファイル null)で false", () => {
  assert.equal(hasAnyId(emptyDocs), false);
});

test("hasAnyId: 1つでも id が有れば true(深い場所=shorts.ranges でも検出)", () => {
  const docs: EditableDocs = {
    ...emptyDocs,
    shorts: {
      shorts: [
        {
          name: "s1",
          approved: false,
          ranges: [{ id: "rg_abc123", start: 0, end: 1 }],
        },
      ],
    },
  };
  assert.equal(hasAnyId(docs), true);
});

test("stampDocs: 空 docs(全ファイル null)は no-op", () => {
  const out = stampDocs(emptyDocs);
  assert.deepEqual(out, emptyDocs);
});

test("stampDocs: 全「指せる配列」に id を採番する", () => {
  const docs: EditableDocs = {
    cutplan: { approved: false, segments: [{ start: 0, end: 1, action: "keep", reason: "x" }] },
    transcript: { language: "ja", model: "m", segments: [{ start: 0, end: 1, text: "a" }] },
    overlays: {
      overlays: [{ start: 0, end: 1, file: "a.png" }],
      inserts: [{ at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ start: 0, end: 1 }],
      hideCaption: [{ start: 0, end: 1 }],
      zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 10, h: 10 } }],
      blurs: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 10, h: 10 } }],
      captionTracks: [{ track: 1 }],
    },
    chapters: { chapters: [{ start: 0, title: "導入" }] },
    bgm: { tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] },
    shorts: {
      shorts: [
        {
          name: "s1",
          approved: false,
          ranges: [{ start: 0, end: 1 }],
          captionTracks: [{ track: 1 }],
        },
      ],
    },
    thumbnail: { t: 0, texts: [{ text: "hi", pos: { x: 0, y: 0 } }] },
  };
  const out = stampDocs(docs);
  assert.match(out.cutplan!.segments[0].id as string, /^seg_/);
  assert.match(out.transcript!.segments[0].id as string, /^cap_/);
  assert.match(out.overlays!.overlays![0].id as string, /^mat_/);
  assert.match(out.overlays!.inserts![0].id as string, /^ins_/);
  assert.match(out.overlays!.wipeFull![0].id as string, /^wf_/);
  assert.match(out.overlays!.hideCaption![0].id as string, /^hc_/);
  assert.match(out.overlays!.zooms![0].id as string, /^zm_/);
  assert.match(out.overlays!.blurs![0].id as string, /^bl_/);
  assert.match(out.overlays!.captionTracks![0].id as string, /^ct_/);
  assert.match(out.chapters!.chapters[0].id as string, /^ch_/);
  assert.match(out.bgm!.tracks[0].id as string, /^bg_/);
  assert.match(out.shorts!.shorts[0].ranges[0].id as string, /^rg_/);
  assert.match(out.shorts!.shorts[0].captionTracks![0].id as string, /^ct_/);
  assert.match(out.thumbnail!.texts[0].id as string, /^tx_/);
});

test("stampDocs: 冪等(2回通して deepEqual)", () => {
  const docs: EditableDocs = {
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 1, action: "keep", reason: "x" },
        { start: 1, end: 2, action: "cut", reason: "y" },
      ],
    },
    transcript: { language: "ja", model: "m", segments: [{ start: 0, end: 1, text: "a" }] },
    overlays: null,
    chapters: null,
    bgm: null,
    shorts: null,
    thumbnail: null,
  };
  const once = stampDocs(docs);
  const twice = stampDocs(once);
  assert.deepEqual(once, twice);
});

test("stampDocs: 既存 id は保ち、ファイル間で衝突しない一意な id を割り振る", () => {
  const docs: EditableDocs = {
    ...emptyDocs,
    cutplan: {
      approved: false,
      segments: [{ id: "seg_keep01", start: 0, end: 1, action: "keep", reason: "x" }],
    },
    transcript: {
      language: "ja",
      model: "m",
      segments: Array.from({ length: 50 }, (_, i) => ({ start: i, end: i + 0.5, text: `t${i}` })),
    },
  };
  const out = stampDocs(docs);
  assert.equal(out.cutplan!.segments[0].id, "seg_keep01");
  const ids = out.transcript!.segments.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});
