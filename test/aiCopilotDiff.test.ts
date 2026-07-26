import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffPreviewRange, DIFF_PREVIEW_BEHAVIOR } from "../src/lib/review.ts";

describe("AI Copilot Diff: 統合", () => {
  it("diffPreviewRange: full-clip は overlay/insert だけの想定", () => {
    const allKinds = Object.keys(DIFF_PREVIEW_BEHAVIOR);
    for (const kind of allKinds) {
      const behavior = DIFF_PREVIEW_BEHAVIOR[kind as keyof typeof DIFF_PREVIEW_BEHAVIOR];
      assert.ok(
        behavior.mode === "bounded" || behavior.mode === "full-clip",
        `${kind}: mode が bounded でも full-clip でもない`,
      );
      if (behavior.mode === "bounded") {
        assert.ok(
          behavior.padSec > 0,
          `${kind}: bounded なのに padSec が 0`,
        );
      }
      if (behavior.mode === "full-clip") {
        assert.ok(
          kind === "overlay" || kind === "insert",
          `${kind}: full-clip は overlay/insert だけの想定`,
        );
      }
    }
  });

  it("diffPreviewRange: bounded は開始位置が 0 未満にならない", () => {
    const range = diffPreviewRange({ startSec: 0.5, endSec: 2 }, "cut");
    assert.ok(range);
    assert.equal(range!.startSec, 0);
  });

  it("diffPreviewRange: full-clip は padSec が 0", () => {
    const range = diffPreviewRange({ startSec: 10, endSec: 20 }, "overlay");
    assert.ok(range);
    assert.equal(range!.mode, "full-clip");
    assert.equal(range!.startSec, 10);
    assert.equal(range!.endSec, 20);
  });

  it("全 kind が diffPreviewRange で null を返さない", () => {
    const allKinds = Object.keys(DIFF_PREVIEW_BEHAVIOR);
    for (const kind of allKinds) {
      const range = diffPreviewRange(
        { startSec: 10, endSec: 15 },
        kind as keyof typeof DIFF_PREVIEW_BEHAVIOR,
      );
      assert.ok(
        range,
        `${kind}: timeRange があるのに null が返った`,
      );
    }
  });
});

import {
  buildDiffTracks,
  resolutionForOnly,
  shouldEnterCopilotMode,
  DIFF_TRACK_PREFIX,
} from "../editor/client/model.ts";
import type { ReviewEvent } from "../src/lib/reviewEvents.ts";
import type { TrackDef } from "../editor/client/model.ts";

describe("AI Copilot Diff: モード遷移(F6)", () => {
  it("提案が1件以上あれば Copilot モードに入る", () => {
    assert.equal(
      shouldEnterCopilotMode({ hunkCount: 3, externalChanged: false }),
      true,
    );
  });

  it("差分ゼロ件では Copilot モードに入らない", () => {
    assert.equal(
      shouldEnterCopilotMode({ hunkCount: 0, externalChanged: false }),
      false,
    );
  });

  it("外部変更があれば提案があっても Copilot モードに入らない", () => {
    assert.equal(
      shouldEnterCopilotMode({ hunkCount: 3, externalChanged: true }),
      false,
    );
  });

});

describe("AI Copilot Diff: diffレーンの組み立て(F2/F3)", () => {
  const tracks: TrackDef[] = [
    { id: "caption", label: "テロップ" },
    { id: "zoom", label: "ズーム" },
    { id: "cut", label: "映像" },
  ];
  const ev = (id: string, kind: string, start: number, end: number): ReviewEvent =>
    ({
      id,
      kind,
      title: id,
      subtitle: "",
      hunkIndexes: [0],
      hunkLabels: ["transcript segments"],
      jsonPaths: [],
      timeRange: { axis: "source", startSec: start, endSec: end },
    }) as unknown as ReviewEvent;

  const passthrough = (s: number, e: number) => ({ start: s, end: e, inCut: false });

  it("timeRange を持たない提案はレーンに載らない", () => {
    const noTime = { ...ev("a", "caption", 0, 1), timeRange: undefined } as ReviewEvent;
    const lanes = buildDiffTracks([noTime], tracks, passthrough);
    assert.equal(lanes.length, 0);
  });

  it("換算が null を返す提案はレーンに載らない", () => {
    const lanes = buildDiffTracks([ev("a", "caption", 0, 1)], tracks, () => null);
    assert.equal(lanes.length, 0);
  });

  it("存在しないトラック向けの提案はレーンを作らない", () => {
    const lanes = buildDiffTracks([ev("a", "blur", 0, 1)], tracks, passthrough);
    assert.equal(lanes.length, 0);
  });

  it("同じトラックの提案は1本のレーンにまとまり、時系列で並ぶ", () => {
    const lanes = buildDiffTracks(
      [ev("late", "caption", 30, 31), ev("early", "caption", 5, 6)],
      tracks,
      passthrough,
    );
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].track.id, `${DIFF_TRACK_PREFIX}caption`);
    assert.equal(lanes[0].eventCount, 2);
    assert.deepEqual(lanes[0].clips.map((c) => c.event.id), ["early", "late"]);
  });

  it("レーンは元トラックの表示順に並ぶ", () => {
    const lanes = buildDiffTracks(
      [ev("z", "zoom", 1, 2), ev("c", "caption", 1, 2)],
      tracks,
      passthrough,
    );
    assert.deepEqual(lanes.map((l) => l.sourceTrack.id), ["caption", "zoom"]);
  });

  it("換算した output 秒がクリップに載る(source 秒のままにしない)", () => {
    const lanes = buildDiffTracks(
      [ev("a", "caption", 100, 105)],
      tracks,
      () => ({ start: 40, end: 45, inCut: false }),
    );
    assert.equal(lanes[0].clips[0].outStart, 40);
    assert.equal(lanes[0].clips[0].outEnd, 45);
    assert.equal(lanes[0].clips[0].event.timeRange?.startSec, 100);
  });

  it("カット内の提案は inCut として幅ゼロで載る", () => {
    const lanes = buildDiffTracks(
      [ev("a", "caption", 100, 105)],
      tracks,
      () => ({ start: 40, end: 40, inCut: true }),
    );
    assert.equal(lanes[0].clips[0].inCut, true);
    assert.equal(lanes[0].clips[0].outStart, lanes[0].clips[0].outEnd);
  });
});

import type { Hunk } from "../src/lib/docDiff.ts";

describe("AI Copilot Diff: 単一適用の resolution(F8)", () => {
  const mk = (label: string) =>
    ({
      address: { file: "overlays", label },
      kind: "field", base: 0, mine: 0, theirs: 1, conflict: false,
    }) as unknown as Hunk;

  it("対象以外はすべて mine で塞がれる", () => {
    const a = mk("a"), b = mk("b"), c = mk("c");
    const r = resolutionForOnly([a, b, c], [b]);
    assert.equal(r.get(a), "mine");
    assert.equal(r.get(b), "theirs");
    assert.equal(r.get(c), "mine");
  });

  it("全 hunk が map に入る(既定 theirs の穴を残さない)", () => {
    const a = mk("a"), b = mk("b");
    const r = resolutionForOnly([a, b], []);
    assert.equal(r.size, 2);
    assert.equal([...r.values()].every((v) => v === "mine"), true);
  });

  it("複数を同時に当てられる", () => {
    const a = mk("a"), b = mk("b"), c = mk("c");
    const r = resolutionForOnly([a, b, c], [a, c]);
    assert.deepEqual([r.get(a), r.get(b), r.get(c)], ["theirs", "mine", "theirs"]);
  });
});
