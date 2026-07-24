import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactPauses,
  fitLinearMapping,
  mapHelperTimeToRecTime,
  parseObsTimecodeMs,
} from "../src/lib/cursorSync.ts";

test("parseObsTimecodeMs: HH:MM:SS.mmm を ms へ", () => {
  assert.equal(parseObsTimecodeMs("00:00:00.000"), 0);
  assert.equal(parseObsTimecodeMs("00:00:01.500"), 1500);
  assert.equal(parseObsTimecodeMs("00:01:02.003"), 62_003);
  assert.equal(parseObsTimecodeMs("01:00:00.000"), 3_600_000);
});

test("parseObsTimecodeMs: 不正な形式は例外", () => {
  assert.throws(() => parseObsTimecodeMs("not-a-timecode"));
  assert.throws(() => parseObsTimecodeMs("00:00:00"));
});

test("fitLinearMapping: drift 込みの合成対を厳密に復元する", () => {
  const trueOffsetMs = 1500;
  const trueDriftPpm = 200; // 200ppm
  const pairs = [0, 5_000, 10_000, 20_000, 40_000, 80_000].map((helperEpochMs) => ({
    helperEpochMs,
    outputTimecodeMs:
      helperEpochMs * (1 + trueDriftPpm * 1e-6) + trueOffsetMs,
  }));
  const mapping = fitLinearMapping(pairs);
  assert.ok(
    Math.abs(mapping.offsetMs - trueOffsetMs) < 1e-6,
    `offsetMs=${mapping.offsetMs}`,
  );
  assert.ok(
    Math.abs(mapping.driftPpm - trueDriftPpm) < 1e-6,
    `driftPpm=${mapping.driftPpm}`,
  );
  // mapHelperTimeToRecTime が同じ写像を再現する
  for (const p of pairs) {
    const rec = mapHelperTimeToRecTime(p.helperEpochMs, mapping);
    assert.ok(Math.abs(rec - p.outputTimecodeMs) < 1e-6);
  }
});

test("fitLinearMapping: 外れ値耐性(1点の異常値に引きずられない)", () => {
  const trueOffsetMs = 200;
  const trueDriftPpm = 0;
  const clean = [0, 10_000, 20_000, 30_000, 40_000, 50_000].map((helperEpochMs) => ({
    helperEpochMs,
    outputTimecodeMs: helperEpochMs + trueOffsetMs,
  }));
  const outlier = { helperEpochMs: 25_000, outputTimecodeMs: 25_000 + 50_000 };
  const mapping = fitLinearMapping([...clean, outlier]);
  assert.ok(
    Math.abs(mapping.offsetMs - trueOffsetMs) < 50,
    `offsetMs=${mapping.offsetMs} should stay close to ${trueOffsetMs}`,
  );
  assert.ok(Math.abs(mapping.driftPpm) < 100, `driftPpm=${mapping.driftPpm}`);
});

test("fitLinearMapping: 対2点未満は offset のみ(drift=0)", () => {
  assert.deepEqual(fitLinearMapping([]), { offsetMs: 0, driftPpm: 0 });
  const single = fitLinearMapping([
    { helperEpochMs: 1000, outputTimecodeMs: 1300 },
  ]);
  assert.equal(single.offsetMs, 300);
  assert.equal(single.driftPpm, 0);
});

test("compactPauses: 区間跨ぎの前詰め", () => {
  const samples = [
    { recTimeMs: 0 },
    { recTimeMs: 900 },
    { recTimeMs: 1000 }, // pause 開始と同時 → 落ちる
    { recTimeMs: 1500 }, // pause 内 → 落ちる
    { recTimeMs: 2000 }, // pause 終了直後 → 1000ms 前詰め
    { recTimeMs: 3000 },
  ];
  const pauses = [{ recTimeMs: 1000, durationMs: 1000 }];
  const result = compactPauses(samples, pauses);
  assert.deepEqual(
    result.map((s) => s.recTimeMs),
    [0, 900, 1000, 2000],
  );
});

test("compactPauses: 複数 pause の累積前詰め", () => {
  const samples = [
    { recTimeMs: 500 }, // pause1 前 → 不変
    { recTimeMs: 1200 }, // pause1 内 [1000,1500) → 落ちる
    { recTimeMs: 2000 }, // pause1 後・pause2 前 → 500 前詰め
    { recTimeMs: 3200 }, // pause2 内 [3000,3500) → 落ちる
    { recTimeMs: 4000 }, // pause2 後 → 500+500=1000 前詰め
  ];
  const pauses = [
    { recTimeMs: 1000, durationMs: 500 }, // [1000,1500)
    { recTimeMs: 3000, durationMs: 500 }, // [3000,3500)
  ];
  const result = compactPauses(samples, pauses);
  assert.deepEqual(
    result.map((s) => s.recTimeMs),
    [500, 1500, 3000],
  );
});

test("compactPauses: pause 外は不変", () => {
  const samples = [{ recTimeMs: 10 }, { recTimeMs: 20 }];
  const result = compactPauses(samples, [{ recTimeMs: 1000, durationMs: 500 }]);
  assert.deepEqual(result, samples);
});

test("compactPauses: pause が無ければコピーを返す", () => {
  const samples = [{ recTimeMs: 10 }];
  const result = compactPauses(samples, []);
  assert.deepEqual(result, samples);
  assert.notEqual(result, samples);
});
