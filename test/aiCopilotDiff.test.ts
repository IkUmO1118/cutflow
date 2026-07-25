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
