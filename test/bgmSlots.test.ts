// src/lib/bgmSlots.ts(B1+B3 の純ロジック)+ 応答パーサの堅牢性を固定する。
// §docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorsToSlots,
  buildBgmAnchors,
  buildBgmChoices,
  assignmentsToTracks,
} from "../src/lib/bgmSlots.ts";
import type { BgmAnchor, BgmChoice, BgmSlot, BgmSlotCfg } from "../src/lib/bgmSlots.ts";
import { parseAssignmentsResponse } from "../src/stages/planBgm.ts";
import type { Chapters, CutPlan } from "../src/types.ts";

function cutplan(segments: { start: number; end: number; action: "keep" | "cut" }[]): CutPlan {
  return {
    approved: false,
    segments: segments.map((s) => ({ ...s, reason: "" })),
  };
}

function chapters(list: { start: number; title: string }[]): Chapters {
  return { chapters: list };
}

const CFG: BgmSlotCfg = { bigCutSec: 3.0, minSlotSec: 1.0, maxSlots: 12 };

/* ---------------- buildBgmAnchors ---------------- */

test("buildBgmAnchors: 章 start がアンカーになる", () => {
  const cp = cutplan([{ start: 0, end: 100, action: "keep" }]);
  const ch = chapters([
    { start: 0, title: "導入" },
    { start: 40, title: "本編" },
    { start: 80, title: "まとめ" },
  ]);
  const anchors = buildBgmAnchors(cp, ch, 100, CFG);
  // 0秒は章 start とも重なるため章タイトル("導入")を優先してマージされる
  assert.deepEqual(
    anchors.map((a) => [a.timeSec, a.source, a.label]),
    [
      [0, "chapter", "導入"],
      [40, "chapter", "本編"],
      [80, "chapter", "まとめ"],
      [100, "end", "終了"],
    ],
  );
});

test("buildBgmAnchors: 大カット(cut尺 >= bigCutSec)がアンカー、小カットは無視", () => {
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 15, action: "cut" }, // 5秒 >= 3.0 → アンカー化(終端 15)
    { start: 15, end: 30, action: "keep" },
    { start: 30, end: 31, action: "cut" }, // 1秒 < 3.0 → 無視
    { start: 31, end: 50, action: "keep" },
  ]);
  const anchors = buildBgmAnchors(cp, null, 50, { ...CFG, minSlotSec: 0.5 });
  assert.deepEqual(
    anchors.map((a) => [a.timeSec, a.source]),
    [
      [0, "start"],
      [15, "cut"],
      [50, "end"],
    ],
  );
});

test("buildBgmAnchors: 先頭0・末尾総尺を含む", () => {
  const cp = cutplan([{ start: 0, end: 200, action: "keep" }]);
  const anchors = buildBgmAnchors(cp, null, 200, CFG);
  assert.equal(anchors[0].timeSec, 0);
  assert.equal(anchors[0].source, "start");
  assert.equal(anchors[anchors.length - 1].timeSec, 200);
  assert.equal(anchors[anchors.length - 1].source, "end");
});

test("buildBgmAnchors: 近接アンカーはマージされる(章タイトルを優先して残す)", () => {
  const cp = cutplan([
    { start: 0, end: 20, action: "keep" },
    { start: 20, end: 25, action: "cut" }, // 5秒 → アンカー終端 25
    { start: 25, end: 100, action: "keep" },
  ]);
  const ch = chapters([{ start: 24.97, title: "境目" }]);
  const anchors = buildBgmAnchors(cp, ch, 100, { ...CFG, minSlotSec: 1.0 });
  // 24.97(章) と 25(大カット)は 1.0 秒未満の近接 → 章タイトルを残して1本化
  assert.deepEqual(
    anchors.map((a) => [a.timeSec, a.source, a.label]),
    [
      [0, "start", "開始"],
      [24.97, "chapter", "境目"],
      [100, "end", "終了"],
    ],
  );
});

test("buildBgmAnchors: chapters が null でも大カット境界だけで動く", () => {
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 15, action: "cut" },
    { start: 15, end: 40, action: "keep" },
  ]);
  const anchors = buildBgmAnchors(cp, null, 40, { ...CFG, minSlotSec: 0.5 });
  assert.deepEqual(
    anchors.map((a) => a.source),
    ["start", "cut", "end"],
  );
});

/* ---------------- anchorsToSlots ---------------- */

function anchor(timeSec: number, source: BgmAnchor["source"], label: string): BgmAnchor {
  return { timeSec, source, label };
}

test("anchorsToSlots: minSlotSec 未満のスロットは前後へ吸収される", () => {
  const anchors = [
    anchor(0, "start", "A0"),
    anchor(5, "chapter", "A5"),
    anchor(8, "chapter", "A8"),
    anchor(20, "chapter", "A20"),
    anchor(50, "end", "A50"),
  ];
  const cp = cutplan([{ start: 0, end: 50, action: "keep" }]);
  const slots = anchorsToSlots(anchors, cp, { ...CFG, minSlotSec: 10 });
  assert.deepEqual(
    slots.map((s) => [s.id, s.start, s.end, s.label]),
    [
      [1, 0, 20, "A0"],
      [2, 20, 50, "A20"],
    ],
  );
});

test("anchorsToSlots: keepSec はカット控除後の可視尺(窓の長さそのものではない)", () => {
  const anchors = [anchor(0, "start", "S"), anchor(10, "chapter", "M"), anchor(50, "end", "E")];
  const cp = cutplan([
    { start: 0, end: 10, action: "keep" },
    { start: 10, end: 15, action: "cut" }, // このぶんは可視ではない
    { start: 15, end: 50, action: "keep" },
  ]);
  const slots = anchorsToSlots(anchors, cp, { ...CFG, minSlotSec: 1 });
  assert.deepEqual(
    slots.map((s) => [s.start, s.end, s.keepSec]),
    [
      [0, 10, 10], // カット無し→窓長と一致
      [10, 50, 35], // 窓長40だが5秒カットが挟まるので可視は35
    ],
  );
});

test("anchorsToSlots: id は1始まり連番", () => {
  const anchors = [anchor(0, "start", "A"), anchor(10, "chapter", "B"), anchor(20, "end", "C")];
  const cp = cutplan([{ start: 0, end: 20, action: "keep" }]);
  const slots = anchorsToSlots(anchors, cp, { ...CFG, minSlotSec: 1 });
  assert.deepEqual(slots.map((s) => s.id), [1, 2]);
});

test("anchorsToSlots: maxSlots で打ち切られる", () => {
  const anchors = [0, 10, 20, 30, 40, 50].map((t, i) => anchor(t, i === 0 ? "start" : "chapter", `L${t}`));
  const cp = cutplan([{ start: 0, end: 50, action: "keep" }]);
  const slots = anchorsToSlots(anchors, cp, { ...CFG, minSlotSec: 1, maxSlots: 3 });
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => s.id), [1, 2, 3]);
  assert.equal(slots[2].end, 30);
});

/* ---------------- buildBgmChoices ---------------- */

test("buildBgmChoices: id は1始まり連番でファイルをそのまま列挙する", () => {
  const choices = buildBgmChoices(["materials/calm.mp3", "bgm.mp3"]);
  assert.deepEqual(choices, [
    { id: 1, file: "materials/calm.mp3" },
    { id: 2, file: "bgm.mp3" },
  ]);
});

test("buildBgmChoices: 0件なら空配列", () => {
  assert.deepEqual(buildBgmChoices([]), []);
});

/* ---------------- assignmentsToTracks ---------------- */

function slot(id: number, start: number, end: number): BgmSlot {
  return { id, start, end, label: "", keepSec: end - start };
}

const SLOTS: BgmSlot[] = [slot(1, 0, 10), slot(2, 10, 20), slot(3, 20, 30), slot(4, 30, 40)];
const CHOICES: BgmChoice[] = [
  { id: 1, file: "materials/calm.mp3" },
  { id: 2, file: "materials/upbeat.mp3" },
];

test("assignmentsToTracks: 存在しない slotId / file 番号を捨てる", () => {
  const tracks = assignmentsToTracks(
    [
      { slotId: 99, file: 1, reason: "" },
      { slotId: 1, file: 99, reason: "" },
      { slotId: 1, file: 1, reason: "ok" },
    ],
    SLOTS,
    CHOICES,
  );
  assert.deepEqual(tracks, [{ start: 0, end: 10, file: "materials/calm.mp3" }]);
});

test("assignmentsToTracks: file:null のスロットは track を作らない(無音)", () => {
  const tracks = assignmentsToTracks([{ slotId: 1, file: null, reason: "" }], SLOTS, CHOICES);
  assert.deepEqual(tracks, []);
});

test("assignmentsToTracks: 隣接スロットの同一 file 番号を連結する", () => {
  const tracks = assignmentsToTracks(
    [
      { slotId: 1, file: 1, reason: "" },
      { slotId: 2, file: 1, reason: "" },
      { slotId: 3, file: 2, reason: "" },
    ],
    SLOTS,
    CHOICES,
  );
  assert.deepEqual(tracks, [
    { start: 0, end: 20, file: "materials/calm.mp3" },
    { start: 20, end: 30, file: "materials/upbeat.mp3" },
  ]);
});

test("assignmentsToTracks: track の start/end はスロットの実時刻(LLM値を混ぜない)", () => {
  const tracks = assignmentsToTracks([{ slotId: 2, file: 1, reason: "" }], SLOTS, CHOICES);
  assert.deepEqual(tracks, [{ start: 10, end: 20, file: "materials/calm.mp3" }]);
});

test("assignmentsToTracks: volumeDb 等の余計なキーを付けない", () => {
  const tracks = assignmentsToTracks([{ slotId: 1, file: 1, reason: "" }], SLOTS, CHOICES);
  assert.deepEqual(Object.keys(tracks[0]).sort(), ["end", "file", "start"]);
});

test("assignmentsToTracks: 同一 slotId への重複割り当ては先着優先", () => {
  const tracks = assignmentsToTracks(
    [
      { slotId: 1, file: 1, reason: "first" },
      { slotId: 1, file: 2, reason: "second" },
    ],
    SLOTS,
    CHOICES,
  );
  assert.deepEqual(tracks, [{ start: 0, end: 10, file: "materials/calm.mp3" }]);
});

/* ---------------- parseAssignmentsResponse(応答パーサの堅牢性) ---------------- */

test("parseAssignmentsResponse: 正例(素の JSON)", () => {
  const raw = `{ "assignments": [ { "slotId": 1, "file": 2, "reason": "合う" } ] }`;
  assert.deepEqual(parseAssignmentsResponse(raw), {
    assignments: [{ slotId: 1, file: 2, reason: "合う" }],
  });
});

test("parseAssignmentsResponse: file:null を許容する", () => {
  const raw = `{ "assignments": [ { "slotId": 1, "file": null, "reason": "無音" } ] }`;
  assert.deepEqual(parseAssignmentsResponse(raw), {
    assignments: [{ slotId: 1, file: null, reason: "無音" }],
  });
});

test("parseAssignmentsResponse: コードフェンス・前後の説明文を許容", () => {
  const raw =
    "選びました。\n```json\n" +
    `{ "assignments": [ { "slotId": 1, "file": 1, "reason": "r" } ] }` +
    "\n```\n以上です。";
  assert.deepEqual(parseAssignmentsResponse(raw), {
    assignments: [{ slotId: 1, file: 1, reason: "r" }],
  });
});

test("parseAssignmentsResponse: assignments 欠如→空配列", () => {
  assert.deepEqual(parseAssignmentsResponse("{}"), { assignments: [] });
  assert.deepEqual(parseAssignmentsResponse(`{ "assignments": "nope" }`), { assignments: [] });
});

test("parseAssignmentsResponse: slotId が数値でない要素を落とす", () => {
  const raw = `{
    "assignments": [
      { "slotId": "1", "file": 1, "reason": "bad" },
      { "slotId": 2, "file": 1, "reason": "ok" }
    ]
  }`;
  assert.deepEqual(parseAssignmentsResponse(raw), {
    assignments: [{ slotId: 2, file: 1, reason: "ok" }],
  });
});

test("parseAssignmentsResponse: file が int でも null でもない要素を落とす", () => {
  const raw = `{
    "assignments": [
      { "slotId": 1, "file": "2", "reason": "bad" },
      { "slotId": 2, "file": 2, "reason": "ok" },
      { "slotId": 3, "file": null, "reason": "ok-null" }
    ]
  }`;
  assert.deepEqual(parseAssignmentsResponse(raw), {
    assignments: [
      { slotId: 2, file: 2, reason: "ok" },
      { slotId: 3, file: null, reason: "ok-null" },
    ],
  });
});

test("parseAssignmentsResponse: JSON が無ければ投げる", () => {
  assert.throws(() => parseAssignmentsResponse("JSON はありません"), /JSON が見つかりません/);
});

test("parseAssignmentsResponse: 壊れた JSON は投げる", () => {
  assert.throws(() => parseAssignmentsResponse(`{ "assignments": [ { ] }`), /パースに失敗/);
});
