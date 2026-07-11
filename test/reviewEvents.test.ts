import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewEvents,
  reviewEventStatus,
  warningSummary,
} from "../src/lib/reviewEvents.ts";
import type { Hunk } from "../src/lib/docDiff.ts";
import type { ReviewEvent } from "../src/lib/reviewEvents.ts";
import type { EffectWarning } from "../src/lib/effectCheck.ts";

function hunk(overrides: Partial<Hunk> & { address?: Partial<Hunk["address"]> } = {}): Hunk {
  const { address, ...rest } = overrides;
  return {
    address: {
      file: "overlays",
      arrayKey: "annotations",
      elementId: "ann_aaaaaa",
      field: "rect.x",
      label: "overlays annotations ann_aaaaaa .rect.x",
      ...address,
    },
    kind: "field",
    base: 10,
    mine: 10,
    theirs: 20,
    conflict: false,
    ...rest,
  };
}

function eventWithIndexes(indexes: number[]): ReviewEvent {
  return {
    id: "rev_test",
    kind: "json",
    title: "JSON 変更",
    subtitle: "test",
    hunkLabels: [],
    hunkIndexes: indexes,
    jsonPaths: [],
    checkPoints: [],
    warnings: [],
    reviewFrameReasons: [],
  };
}

test("buildReviewEvents: annotation の field hunks を 1 event にまとめる", () => {
  const hunks = [
    hunk(),
    hunk({
      address: { field: "rect.y", label: "overlays annotations ann_aaaaaa .rect.y" },
      base: 30,
      mine: 30,
      theirs: 40,
    }),
  ];
  const events = buildReviewEvents({ hunks });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "annotation");
  assert.equal(events[0].title, "注釈の位置を変更");
  assert.deepEqual(events[0].hunkIndexes, [0, 1]);
});

test("buildReviewEvents: caption text hunk に字幕文言タイトルを付ける", () => {
  const events = buildReviewEvents({
    hunks: [
      hunk({
        address: {
          file: "transcript",
          arrayKey: "segments",
          elementId: "cap_aaaaaa",
          field: "text",
          label: "transcript segments cap_aaaaaa .text",
        },
        base: "before",
        mine: "before",
        theirs: "after",
      }),
    ],
  });
  assert.equal(events[0].kind, "caption");
  assert.equal(events[0].title, "字幕文言を変更");
});

test("buildReviewEvents: blur add に確認ポイントを付ける", () => {
  const events = buildReviewEvents({
    hunks: [
      hunk({
        address: {
          file: "overlays",
          arrayKey: "blurs",
          elementId: "blr_aaaaaa",
          field: undefined,
          label: "overlays blurs blr_aaaaaa",
        },
        kind: "element-add",
        base: undefined,
        mine: undefined,
        theirs: { id: "blr_aaaaaa", start: 4, end: 6, rect: { x: 1, y: 2, w: 3, h: 4 } },
      }),
    ],
  });
  assert.equal(events[0].kind, "blur");
  assert.equal(events[0].title, "ぼかしを追加");
  assert.deepEqual(events[0].checkPoints, [
    "隠したい範囲を覆えているか",
    "不要な場所まで隠していないか",
    "動きに対して範囲がずれていないか",
  ]);
});

test("buildReviewEvents: id 無し配列 hunk も event にする", () => {
  const events = buildReviewEvents({
    hunks: [
      hunk({
        address: {
          file: "transcript",
          arrayKey: "segments",
          elementId: undefined,
          field: undefined,
          label: "transcript segments",
        },
        kind: "file",
        base: [{ start: 0, end: 1, text: "base" }],
        mine: [{ start: 0, end: 1, text: "base" }],
        theirs: [{ start: 0, end: 1, text: "theirs" }],
      }),
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "caption");
  assert.equal(events[0].title, "JSON 変更");
});

test("buildReviewEvents: start/end field から source timeRange を作る", () => {
  const events = buildReviewEvents({
    hunks: [
      hunk({
        address: {
          file: "transcript",
          arrayKey: "segments",
          elementId: "cap_aaaaaa",
          field: "start",
          label: "transcript segments cap_aaaaaa .start",
        },
        base: 1,
        mine: 1,
        theirs: 3.25,
      }),
      hunk({
        address: {
          file: "transcript",
          arrayKey: "segments",
          elementId: "cap_aaaaaa",
          field: "end",
          label: "transcript segments cap_aaaaaa .end",
        },
        base: 2,
        mine: 2,
        theirs: 5.5,
      }),
    ],
  });
  assert.deepEqual(events[0].timeRange, { axis: "source", startSec: 3.25, endSec: 5.5 });
});

test("reviewEventStatus: 全 theirs は use", () => {
  const hunks = [hunk(), hunk({ address: { field: "rect.y", label: "overlays annotations ann_aaaaaa .rect.y" } })];
  const resolution = new Map<Hunk, "theirs" | "mine">([[hunks[0], "theirs"], [hunks[1], "theirs"]]);
  assert.equal(reviewEventStatus({ event: eventWithIndexes([0, 1]), hunks, resolution }), "use");
});

test("reviewEventStatus: 全 mine は skip", () => {
  const hunks = [hunk(), hunk({ address: { field: "rect.y", label: "overlays annotations ann_aaaaaa .rect.y" } })];
  const resolution = new Map<Hunk, "theirs" | "mine">([[hunks[0], "mine"], [hunks[1], "mine"]]);
  assert.equal(reviewEventStatus({ event: eventWithIndexes([0, 1]), hunks, resolution }), "skip");
});

test("reviewEventStatus: 採否が混ざると mixed", () => {
  const hunks = [hunk(), hunk({ address: { field: "rect.y", label: "overlays annotations ann_aaaaaa .rect.y" } })];
  const resolution = new Map<Hunk, "theirs" | "mine">([[hunks[0], "mine"], [hunks[1], "theirs"]]);
  assert.equal(reviewEventStatus({ event: eventWithIndexes([0, 1]), hunks, resolution }), "mixed");
});

test("warningSummary: event warning を kind ごとに集計する", () => {
  const events: ReviewEvent[] = [
    { ...eventWithIndexes([0]), kind: "caption", warnings: ["a", "b"] },
    { ...eventWithIndexes([1]), kind: "caption", warnings: ["c"] },
    { ...eventWithIndexes([2]), kind: "blur", warnings: ["d"] },
  ];
  assert.deepEqual(warningSummary(events), {
    total: 4,
    groups: [
      { label: "ぼかし", count: 1 },
      { label: "字幕", count: 3 },
    ],
  });
});

// --- E6: effectWarnings による reviewEvents merge ---

const blurHunk = hunk({
  address: {
    file: "overlays",
    arrayKey: "blurs",
    elementId: "bl_aaaaaa",
    field: undefined,
    label: "overlays blurs bl_aaaaaa",
  },
  kind: "element-add",
  base: undefined,
  mine: undefined,
  theirs: { id: "bl_aaaaaa", start: 10, end: 12, rect: { x: 1, y: 2, w: 3, h: 4 } },
});

test("buildReviewEvents: effectWarnings 未指定は既存挙動とバイト等価", () => {
  const hunks = [blurHunk];
  const withoutArg = buildReviewEvents({ hunks });
  const withUndefined = buildReviewEvents({ hunks, effectWarnings: undefined });
  const withEmpty = buildReviewEvents({ hunks, effectWarnings: [] });
  assert.deepEqual(withUndefined, withoutArg);
  assert.deepEqual(withEmpty, withoutArg);
  // 中身も cut/caption/insert 等の既存フィールドが不変であることを確認
  assert.equal(withoutArg.length, 1);
  assert.equal(withoutArg[0].kind, "blur");
  assert.deepEqual(withoutArg[0].warnings, []);
});

test("buildReviewEvents: effectWarnings が既存 blur イベントへ merge される", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 10,
      endSec: 12,
      message: "blur(bl_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
    },
  ];
  const events = buildReviewEvents({ hunks: [blurHunk], effectWarnings: warnings });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "blur");
  assert.deepEqual(events[0].hunkIndexes, [0]); // 既存イベントのまま(独立イベントを作らない)
  assert.deepEqual(events[0].warnings, [warnings[0].message]);
  assert.ok(events[0].checkPoints.includes("覆えているか"));
});

test("buildReviewEvents: 一致するイベントが無い effectWarnings は独立イベントを作る", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "annotation-too-long",
      refId: "ann_zzzzzz",
      startSec: 100,
      endSec: 110,
      message: "annotation(ann_zzzzzz)の表示尺(10.0s)が上限(8s)を超えています",
    },
  ];
  const events = buildReviewEvents({ hunks: [blurHunk], effectWarnings: warnings });
  assert.equal(events.length, 2);
  const standalone = events.find((e) => e.kind === "annotation");
  assert.ok(standalone);
  assert.deepEqual(standalone!.hunkIndexes, []);
  assert.deepEqual(standalone!.warnings, [warnings[0].message]);
  assert.deepEqual(standalone!.timeRange, { axis: "source", startSec: 100, endSec: 110 });
});

test("buildReviewEvents: fixRef があるとき warnings に補正候補の参照が付く", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 10,
      endSec: 12,
      message: "blur(bl_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
      suggestions: [{ op: "set", target: "@bl_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 1, h: 1 } }],
    },
  ];
  const events = buildReviewEvents({ hunks: [blurHunk], effectWarnings: warnings });
  assert.ok(events[0].warnings.some((w) => w.includes("effect-fix.suggested.json#@bl_aaaaaa")));
});

test("warningSummary: effectWarnings の merge を反映する", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 10,
      endSec: 12,
      message: "blur(bl_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
    },
  ];
  const events = buildReviewEvents({ hunks: [blurHunk], effectWarnings: warnings });
  const summary = warningSummary(events);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.groups, [{ label: "ぼかし", count: 1 }]);
});
