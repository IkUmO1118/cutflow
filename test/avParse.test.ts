import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateMaxByWindow,
  elapsedSpanSec,
  elapsedToSource,
  keepsHash,
  mapSamplesToOutput,
  parseAstats,
  parseAstatsMetadata,
  parseEbur128,
  parseFreezedetect,
  parseScdet,
} from "../src/lib/avParse.ts";
import { buildTimeline } from "../src/lib/timeline.ts";

test("parseEbur128: summary と envelope を取れる", () => {
  const parsed = parseEbur128(`
[Parsed_ebur128_0] t: 0.399977 TARGET:-23 LUFS M: -21.1 S:-120.7 I: -21.1 LUFS LRA: 0.0 LU FTPK: -18.1 dBFS TPK: -18.1 dBFS
[Parsed_ebur128_0] t: 0.999977 TARGET:-23 LUFS M: -21.1 S: -19.4 I: -21.1 LUFS LRA: 0.0 LU FTPK: -18.1 dBFS TPK: -18.1 dBFS
  Integrated loudness:
    I:         -21.1 LUFS
  Loudness range:
    LRA:         0.0 LU
  True peak:
    Peak:      -18.1 dBFS
`);
  assert.equal(parsed.integratedLufs, -21.1);
  assert.equal(parsed.loudnessRangeLu, 0);
  assert.equal(parsed.truePeakDbtp, -18.1);
  assert.deepEqual(parsed.envelope[1], { t: 0.999977, shortTermLufs: -19.4 });
});

test("parseAstats / parseAstatsMetadata: overall と時系列 RMS を取れる", () => {
  const parsed = parseAstats(`
lavfi.astats.Overall.Peak_level=-1.200000
lavfi.astats.Overall.RMS_level=-14.800000
lavfi.astats.Overall.Abs_Peak_count=3.000000
`);
  assert.deepEqual(parsed, { peakDbfs: -1.2, clippedSamples: 3, rmsDb: -14.8 });

  const samples = parseAstatsMetadata(`
frame:0    pts:0       pts_time:0
lavfi.astats.Overall.RMS_level=-22.0
frame:1    pts:1024    pts_time:0.5
lavfi.astats.Overall.RMS_level=-18.5
`);
  assert.deepEqual(samples, [{ t: 0, rmsDb: -22 }, { t: 0.5, rmsDb: -18.5 }]);
});

test("parseScdet / parseFreezedetect: stderr から time span を取れる", () => {
  assert.deepEqual(
    parseScdet("[Parsed_scdet_1] lavfi.scd.score: 85.547, lavfi.scd.time: 1"),
    [{ t: 1, value: 0.85547 }],
  );
  assert.deepEqual(
    parseFreezedetect(`
[Parsed_freezedetect_1] lavfi.freezedetect.freeze_start: 0
[Parsed_freezedetect_1] lavfi.freezedetect.freeze_end: 1
`),
    [{ start: 0, end: 1 }],
  );
});

test("mapSamplesToOutput / aggregateMaxByWindow / keepsHash", () => {
  const timeline = buildTimeline([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
  const segs = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  const mapped = mapSamplesToOutput([{ t: 0 }, { t: 12 }], timeline, segs);
  assert.deepEqual(mapped, [
    { t: 0, outSec: 0, sourceSec: 10 },
    { t: 12, outSec: 12, sourceSec: 32 },
  ]);
  assert.deepEqual(
    aggregateMaxByWindow([{ t: 0.1, value: 0.2 }, { t: 0.8, value: 0.9 }, { t: 1.2, value: 0.4 }], 2, 1),
    [{ t: 0, value: 0.9 }, { t: 1, value: 0.4 }, { t: 2, value: 0 }],
  );
  assert.equal(keepsHash([{ start: 1, end: 2 }]).length, 64);
});

test("elapsedToSource: concat の経過秒を keep をまたいで元収録の秒へ戻す", () => {
  const segs = [{ start: 0, end: 8 }, { start: 12, end: 30 }];
  assert.equal(elapsedToSource(0, segs), 0);
  assert.equal(elapsedToSource(8, segs), 8);
  assert.equal(elapsedToSource(10, segs), 14);
  assert.equal(elapsedToSource(26, segs), 30);
  assert.equal(elapsedToSource(27, segs), null);
});

test("mapSamplesToOutput: 挿入があっても elapsed→source→output で正しく写す", () => {
  const timeline = buildTimeline([{ start: 0, end: 30 }], [{ at: 8, durationSec: 4 }]);
  const segs = [{ start: 0, end: 8 }, { start: 8, end: 30 }];
  const [sample] = mapSamplesToOutput([{ t: 20 }], timeline, segs);
  assert.equal(sample.sourceSec, 20);
  assert.equal(sample.outSec, 24);
});

test("mapSamplesToOutput: 挿入が無ければ elapsed == output", () => {
  const timeline = buildTimeline([{ start: 0, end: 10 }, { start: 20, end: 30 }]);
  const segs = [{ start: 0, end: 10 }, { start: 20, end: 30 }];
  for (const t of [0, 5, 10, 15, 19.99]) {
    const [sample] = mapSamplesToOutput([{ t }], timeline, segs);
    assert.equal(sample.outSec, Math.round(t * 100) / 100);
  }
});

test("elapsedSpanSec: 挿入は含まれない", () => {
  assert.equal(elapsedSpanSec([{ start: 0, end: 8 }, { start: 8, end: 30 }]), 30);
});
