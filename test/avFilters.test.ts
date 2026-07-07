import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConcatAudioFilter, buildMotionMetricFilter, buildMotionStripFilter } from "../src/lib/avFilters.ts";

test("buildMotionStripFilter: trim/concat/tile を組む", () => {
  const filter = buildMotionStripFilter({
    segments: [{ start: 1, end: 3 }, { start: 5, end: 7 }],
    everySec: 2,
    cols: 5,
    rows: 1,
    stripWidthPx: 320,
  });
  assert.match(filter, /trim=start=1:end=3/);
  assert.match(filter, /concat=n=2:v=1:a=0\[vcat\]/);
  assert.match(filter, /fps=0.5/);
  assert.match(filter, /tile=5x1/);
});

test("buildMotionMetricFilter: scdet と freezedetect を分けて組む", () => {
  const filters = buildMotionMetricFilter({
    segments: [{ start: 0, end: 2 }],
    scdetThreshold: 8,
    freezeNoiseDb: -50,
    freezeDurationSec: 1,
  });
  assert.match(filters.scdet, /scdet=threshold=8/);
  assert.match(filters.freeze, /freezedetect=n=-50dB:d=1/);
});

test("buildConcatAudioFilter: keeps を concat した mix を組む", () => {
  const filter = buildConcatAudioFilter({
    micStream: 0,
    systemStream: 1,
    systemVolumeDb: -6,
    denoiseMic: true,
    noiseFloorDb: -25,
  }, [{ start: 0, end: 1 }]);
  assert.match(filter, /afftdn=nf=-25/);
  assert.match(filter, /volume=-6dB/);
  assert.match(filter, /concat=n=1:v=0:a=1\[mix\]/);
});
