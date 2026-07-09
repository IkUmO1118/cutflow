import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicObservation } from "../src/lib/reviewObservation.ts";

test("buildDeterministicObservation: fail/warn/skip の規則を集約する", () => {
  const observation = buildDeterministicObservation({
    before: {
      durationSec: 12,
      keepCount: 2,
      cutCount: 1,
      captionCount: 1,
      visibleCaptionTexts: ["before"],
      motion: { sceneChanges: 1, frozenSec: 0, meanSceneScore: 0.1 },
      sound: { integratedLufs: -16, truePeakDbtp: -1, silenceSec: 0.5, clippingSamples: 0 },
      ocr: { lines: ["hello"] },
    },
    after: {
      durationSec: 0,
      keepCount: 1,
      cutCount: 2,
      captionCount: 2,
      visibleCaptionTexts: ["after"],
      motion: { sceneChanges: 1, frozenSec: 2.5, meanSceneScore: 0.1 },
      sound: { integratedLufs: -16, truePeakDbtp: 0.3, silenceSec: 2, clippingSamples: 3 },
      ocr: { lines: [] },
    },
    validateErrors: [{ file: "cutplan.json", where: "segments[0]", message: "bad" }],
    unresolvedAfterFrames: 1,
    requestedOcr: true,
    ocrSupported: false,
  });

  assert.equal(observation.delta.durationSec, -12);
  assert.ok(observation.checks.some((check) => check.id === "candidate-invalid" && check.status === "fail"));
  assert.ok(observation.checks.some((check) => check.id === "after-duration" && check.status === "fail"));
  assert.ok(observation.checks.some((check) => check.id === "after-frame-mapping" && check.status === "fail"));
  assert.ok(observation.checks.some((check) => check.id === "after-true-peak" && check.status === "fail"));
  assert.ok(observation.checks.some((check) => check.id === "after-clipping" && check.status === "fail"));
  assert.ok(observation.checks.some((check) => check.id === "silence-increase" && check.status === "warn"));
  assert.ok(observation.checks.some((check) => check.id === "freeze-increase" && check.status === "warn"));
  assert.ok(observation.checks.some((check) => check.id === "ocr-supported" && check.status === "skip"));
});
