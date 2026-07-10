import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectSecondaryObservationFrames,
  validateSecondaryObservationPayload,
} from "../src/lib/vlmObservation.ts";

const frames = [
  {
    frameId: "rf_after",
    side: "after" as const,
    file: "/tmp/after.png",
    mediaType: "image/png" as const,
    sourceSec: 1,
    outputSec: 1,
    reason: "caption",
  },
  {
    frameId: "rf_before",
    side: "before" as const,
    file: "/tmp/before.png",
    mediaType: "image/png" as const,
    sourceSec: 1,
    outputSec: 1,
    reason: "caption",
  },
];

test("validateSecondaryObservationPayload: 不正itemだけ捨て、validation warningを返す", () => {
  const payload = validateSecondaryObservationPayload({
    summary: ["ok"],
    items: [
      {
        frameId: "rf_after",
        side: "after",
        severity: "warn",
        category: "readability",
        message: "small text",
      },
      {
        frameId: "missing",
        side: "after",
        severity: "warn",
        category: "readability",
        message: "unknown frame",
      },
    ],
    uncertainties: [],
    confidence: "medium",
  }, frames);

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0]?.frameId, "rf_after");
  assert.match(payload.validationWarnings.join(" / "), /unknown frameId/);
});

test("validateSecondaryObservationPayload: 全item不正ならsecondary observationなしにできるようthrowする", () => {
  assert.throws(() =>
    validateSecondaryObservationPayload({
      summary: ["bad"],
      items: [
        {
          frameId: "missing",
          side: "after",
          severity: "warn",
          category: "readability",
          message: "unknown frame",
        },
      ],
      uncertainties: [],
      confidence: "low",
    }, frames),
  /all response items are invalid/);
});

test("selectSecondaryObservationFrames: afterを優先しつつ上限内へ間引く", () => {
  const selected = selectSecondaryObservationFrames([
    {
      requested: { reason: "first" },
      before: { file: "/tmp/before-1.png", sourceSec: 1, outSec: 1 },
      after: { file: "/tmp/after-1.png", sourceSec: 1, outSec: 1 },
    },
    {
      requested: { reason: "second" },
      before: { file: "/tmp/before-2.png", sourceSec: 2, outSec: 2 },
      after: { file: "/tmp/after-2.png", sourceSec: 2, outSec: 2 },
    },
  ], 2);

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((frame) => frame.side), ["after", "after"]);
});
