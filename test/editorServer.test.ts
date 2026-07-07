// editor/server.ts — GUI 保存(saveProject)の id 採番ロジック(stampSaveBody)。
// サーバー本体(HTTP・esbuild バンドル)は起動せず、export された純関数だけを
// 固定する(実 UI の round-trip は人間の GUI 実測に委ねる。MEMORY: エディタの
// コードはサーバー再起動まで反映されない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampSaveBody } from "../editor/server.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { SaveRequest } from "../editor/client/apiTypes.ts";

test("stampSaveBody: idEnabled=false は body をそのまま返す(参照も同一・バイト等価)", () => {
  const body: SaveRequest = {
    cutplan: { approved: false, segments: [{ start: 0, end: 1, action: "keep", reason: "" }] },
  };
  const out = stampSaveBody(body, false, new Set());
  assert.equal(out, body);
});

test("stampSaveBody: idEnabled=true で新規要素(id 無し)に採番する", () => {
  const body: SaveRequest = {
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_aaaaaa", start: 0, end: 1, action: "keep", reason: "" },
        { start: 1, end: 2, action: "keep", reason: "" },
      ],
    },
  };
  const used = new Set<string>(["seg_aaaaaa"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.cutplan!.segments[0].id, "seg_aaaaaa");
  assert.match(out.cutplan!.segments[1].id as string, ID_RE);
});

test("stampSaveBody: idEnabled=true でも既存 id は保持する(round-trip)", () => {
  const body: SaveRequest = {
    transcript: {
      segments: [{ id: "cap_bbbbbb", start: 0, end: 1, text: "hi" }],
    },
  };
  const used = new Set<string>(["cap_bbbbbb"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.transcript!.segments[0].id, "cap_bbbbbb");
});

test("stampSaveBody: overlays の全「指せる配列」に採番する", () => {
  const body: SaveRequest = {
    overlays: {
      overlays: [{ start: 0, end: 1, file: "a.png" }],
      inserts: [{ at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ start: 0, end: 1 }],
      hideCaption: [{ start: 0, end: 1 }],
      zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      blurs: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      captionTracks: [{ track: 1 }],
    },
  };
  const out = stampSaveBody(body, true, new Set());
  assert.match(out.overlays!.overlays![0].id as string, ID_RE);
  assert.match(out.overlays!.inserts![0].id as string, ID_RE);
  assert.match(out.overlays!.wipeFull![0].id as string, ID_RE);
  assert.match(out.overlays!.hideCaption![0].id as string, ID_RE);
  assert.match(out.overlays!.zooms![0].id as string, ID_RE);
  assert.match(out.overlays!.blurs![0].id as string, ID_RE);
  assert.match(out.overlays!.captionTracks![0].id as string, ID_RE);
});

test("stampSaveBody: bgm/shorts にも採番する", () => {
  const body: SaveRequest = {
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
  };
  const out = stampSaveBody(body, true, new Set());
  assert.match(out.bgm!.tracks[0].id as string, ID_RE);
  assert.match(out.shorts!.shorts[0].ranges[0].id as string, ID_RE);
  assert.match(out.shorts!.shorts[0].captionTracks![0].id as string, ID_RE);
});

test("stampSaveBody: bgm/shorts の null(削除シグナル)は idEnabled=true でも保つ", () => {
  const body: SaveRequest = { bgm: null, shorts: null };
  const out = stampSaveBody(body, true, new Set());
  assert.equal(out.bgm, null);
  assert.equal(out.shorts, null);
});

test("stampSaveBody: body に無いドキュメントは undefined のまま(触らない)", () => {
  const body: SaveRequest = {};
  const out = stampSaveBody(body, true, new Set());
  assert.equal(out.cutplan, undefined);
  assert.equal(out.overlays, undefined);
  assert.equal(out.transcript, undefined);
  assert.equal(out.bgm, undefined);
  assert.equal(out.shorts, undefined);
});
