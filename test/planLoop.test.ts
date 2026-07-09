import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutsSetEqual,
  deriveLoopAssertions,
  selectPlanLoopReviewTimes,
  shouldStop,
  summarizeObservation,
} from "../src/lib/planLoop.ts";
import type { AssertOutcome } from "../src/stages/assert.ts";
import type { DescribeProjection } from "../src/stages/describe.ts";

const loopCfg = {
  maxIterations: 3,
  targetOutDurationSec: 30,
  stopWhenAssertionsPass: true,
};

test("deriveLoopAssertions: assertions.json と目標尺をマージする", () => {
  const spec = deriveLoopAssertions(loopCfg, {
    schemaVersion: 1,
    assertions: [{ type: "timeKept", at: 12, kept: true, label: "見せ場" }],
  });
  assert.deepEqual(spec, {
    schemaVersion: 1,
    assertions: [
      { type: "timeKept", at: 12, kept: true, label: "見せ場" },
      { label: "plan.loop.targetOutDurationSec", type: "outDuration", op: "<=", value: 30 },
    ],
  });
});

test("deriveLoopAssertions: 目標尺が null なら disk assertions のみ", () => {
  const spec = deriveLoopAssertions({ targetOutDurationSec: null }, null);
  assert.deepEqual(spec, { schemaVersion: 1, assertions: [] });
});

test("cutsSetEqual: reason と順序を無視して cut id 集合を比較する", () => {
  assert.equal(
    cutsSetEqual(
      [{ id: 2, reason: "a" }, { id: 1, reason: "b" }],
      [{ id: 1, reason: "x" }, { id: 2, reason: "y" }],
    ),
    true,
  );
  assert.equal(cutsSetEqual([{ id: 1, reason: "" }], [{ id: 2, reason: "" }]), false);
});

test("summarizeObservation: 尺・期待値・現在の cut 選択を整形する", () => {
  const proj = {
    summary: { outDurationSec: 32.5, keepCount: 2 },
    cuts: [{}, {}],
  } as DescribeProjection;
  const outcomes: AssertOutcome[] = [
    { index: 0, type: "outDuration", status: "fail", message: "出力尺 0:32.5 <= 0:30.0: 満たされていません" },
  ];
  const text = summarizeObservation(proj, outcomes, [{ id: 3, reason: "脱線" }], loopCfg);
  assert.match(text, /出力尺: 32\.5 秒 \(目標: 30\.0 秒\) -> 2\.5 秒 超過/);
  assert.match(text, /\[fail\] 出力尺/);
  assert.match(text, /#3 脱線/);
});

test("selectPlanLoopReviewTimes: 変更境界の前後を優先し 0.2 秒以内を重複除去する", () => {
  const times = selectPlanLoopReviewTimes({
    projection: {
      source: { durationSec: 30 },
      summary: { outDurationSec: 30, keepCount: 2 },
      cuts: [{ start: 10, end: 12 }],
    } as DescribeProjection,
    previousProjection: {
      source: { durationSec: 30 },
      summary: { outDurationSec: 30, keepCount: 2 },
      cuts: [],
    } as DescribeProjection,
    limit: 2,
  });
  assert.deepEqual(times, [10.1, 12.1]);
});

test("shouldStop: max-iterations / assertions-pass / fixpoint を判定する", () => {
  const fail: AssertOutcome[] = [{ index: 0, type: "outDuration", status: "fail", message: "fail" }];
  const pass: AssertOutcome[] = [{ index: 0, type: "outDuration", status: "pass", message: "pass" }];

  assert.deepEqual(
    shouldStop({
      iteration: 2,
      maxIterations: 3,
      loopCfg,
      outcomes: fail,
      prevCuts: [{ id: 1, reason: "" }],
      cuts: [{ id: 2, reason: "" }],
    }),
    { stop: true, reason: "max-iterations" },
  );
  assert.deepEqual(
    shouldStop({
      iteration: 0,
      maxIterations: 3,
      loopCfg,
      outcomes: pass,
      prevCuts: null,
      cuts: [{ id: 1, reason: "" }],
    }),
    { stop: true, reason: "assertions-pass" },
  );
  assert.deepEqual(
    shouldStop({
      iteration: 1,
      maxIterations: 3,
      loopCfg,
      outcomes: fail,
      prevCuts: [{ id: 1, reason: "old" }],
      cuts: [{ id: 1, reason: "new" }],
    }),
    { stop: true, reason: "fixpoint" },
  );
});
