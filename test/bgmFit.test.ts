// lib/bgmFit.ts(B2 無音/被り回避の音量・duck・切替調整 + B4 単調 fallback 検出)
// の純関数群を固定する。fs/ffmpeg/LLM には一切依存しない。
// §docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBgmFitPatch, detectBgmFit, detectMonotone } from "../src/lib/bgmFit.ts";
import type { BgmFitCfg, BgmFitFinding } from "../src/lib/bgmFit.ts";
import type { SoundReport } from "../src/stages/av.ts";
import type { Bgm } from "../src/types.ts";

const DEFAULT_CFG: BgmFitCfg = {
  speechHeadroomDb: 8,
  silenceDuckDb: 3,
  targetLufs: -14,
  minFadeSec: 1.0,
  monotoneCoverRatio: 0.9,
  minChaptersForVariety: 3,
  defaultVolumeDb: -22,
};

function makeSound(overrides: Partial<SoundReport> = {}): SoundReport {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-11T00:00:00.000Z",
    key: {},
    range: { startSec: 0, endSec: 20 },
    short: null,
    mix: { integratedLufs: -20, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
    silences: [],
    tracks: { windowSec: 1, samples: [] },
    bgm: { spans: [], duckSpans: [] },
    ...overrides,
  };
}

function makeBgm(tracks: Bgm["tracks"]): Bgm {
  return { tracks };
}

/* ---------------- detectBgmFit: speech-overlap ---------------- */

test("detectBgmFit: 発話被り(louder=system)は発話RMSをspeechHeadroomDb下回るvolumeDb減を提案", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    tracks: {
      windowSec: 1,
      samples: [
        { outSec: 5, sourceSec: 5, micRmsDb: -20, systemRmsDb: -15, louder: "system" },
        { outSec: 6, sourceSec: 6, micRmsDb: -20, systemRmsDb: -30, louder: "mic" },
      ],
    },
  });
  const bgm = makeBgm([{ id: "bg_aaaaaa", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const overlap = findings.find((f) => f.kind === "speech-overlap");
  assert.ok(overlap, "speech-overlap finding が無い");
  // excess = systemRmsDb - (micRmsDb - speechHeadroomDb) = -15 - (-20 - 8) = 13
  // newVolumeDb = currentVolumeDb(-22) - 13 = -35
  assert.equal(overlap!.currentVolumeDb, -22);
  assert.deepEqual(overlap!.suggestion, { op: "set", target: "@bg_aaaaaa", field: "volumeDb", value: -35 });
  assert.equal(overlap!.startOutSec, 5);
});

test("detectBgmFit: 発話被りが既にduckSpansで下がっている区間は二重に下げない", () => {
  const sound = makeSound({
    bgm: {
      spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }],
      duckSpans: [{ startOutSec: 0, endOutSec: 20, duckDb: -10 }],
    },
    tracks: {
      windowSec: 1,
      samples: [{ outSec: 5, sourceSec: 5, micRmsDb: -20, systemRmsDb: -15, louder: "system" }],
    },
  });
  const bgm = makeBgm([{ id: "bg_aaaaaa", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "speech-overlap"), undefined);
});

test("detectBgmFit: 発話が優勢(louder=mic)なサンプルだけなら speech-overlap は出ない", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    tracks: {
      windowSec: 1,
      samples: [{ outSec: 5, sourceSec: 5, micRmsDb: -10, systemRmsDb: -30, louder: "mic" }],
    },
  });
  const bgm = makeBgm([{ id: "bg_aaaaaa", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "speech-overlap"), undefined);
});

/* ---------------- detectBgmFit: silence-float ---------------- */

test("detectBgmFit: 無音区間にBGMが原音量で乗っているとsilenceDuckDb減を提案", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    silences: [{ outSec: 8, endOutSec: 12, lenSec: 4 }],
  });
  const bgm = makeBgm([{ id: "bg_bbbbbb", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const float = findings.find((f) => f.kind === "silence-float");
  assert.ok(float, "silence-float finding が無い");
  assert.deepEqual(float!.suggestion, { op: "set", target: "@bg_bbbbbb", field: "volumeDb", value: -25 });
  assert.equal(float!.startOutSec, 8);
  assert.equal(float!.endOutSec, 12);
});

test("detectBgmFit: 無音区間が既にduckSpansで下がっていればsilence-floatを出さない", () => {
  const sound = makeSound({
    bgm: {
      spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }],
      duckSpans: [{ startOutSec: 8, endOutSec: 12, duckDb: -10 }],
    },
    silences: [{ outSec: 8, endOutSec: 12, lenSec: 4 }],
  });
  const bgm = makeBgm([{ id: "bg_bbbbbb", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "silence-float"), undefined);
});

/* ---------------- detectBgmFit: loud ---------------- */

test("detectBgmFit: integratedLufsがtargetLufsを超過していれば全体volumeDb減を提案", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    mix: { integratedLufs: -10, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
  });
  const bgm = makeBgm([{ id: "bg_cccccc", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const loud = findings.find((f) => f.kind === "loud");
  assert.ok(loud, "loud finding が無い");
  // excess = -10 - (-14) = 4 → newVolumeDb = -22 - 4 = -26
  assert.deepEqual(loud!.suggestion, { op: "set", target: "@bg_cccccc", field: "volumeDb", value: -26 });
});

test("detectBgmFit: integratedLufsがtargetLufs以下ならloudを出さない", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    mix: { integratedLufs: -18, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
  });
  const bgm = makeBgm([{ id: "bg_cccccc", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "loud"), undefined);
});

/* ---------------- detectBgmFit: no-fade ---------------- */

test("detectBgmFit: 動画終端まで続くのにfadeOutSecが無ければ付与を提案", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
  });
  const bgm = makeBgm([{ id: "bg_dddddd", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const noFade = findings.find((f) => f.kind === "no-fade");
  assert.ok(noFade, "no-fade finding が無い");
  assert.deepEqual(noFade!.suggestion, { op: "set", target: "@bg_dddddd", field: "fadeOutSec", value: 1.0 });
});

test("detectBgmFit: fadeOutSecが既に設定されていればno-fadeを出さない", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
  });
  const bgm = makeBgm([{ id: "bg_dddddd", start: 0, end: 20, file: "bgm.mp3", fadeOutSec: 2 }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "no-fade"), undefined);
});

test("detectBgmFit: 動画終端に届かないトラックはno-fadeを出さない", () => {
  const sound = makeSound({
    bgm: {
      spans: [
        { startOutSec: 0, endOutSec: 10, volumeDb: -22, file: "intro.mp3" },
        { startOutSec: 10, endOutSec: 20, volumeDb: -22, file: "outro.mp3" },
      ],
      duckSpans: [],
    },
  });
  const bgm = makeBgm([{ id: "bg_eeeeee", start: 0, end: 10, file: "intro.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.find((f) => f.kind === "no-fade"), undefined);
});

/* ---------------- detectBgmFit: id 未採番は除外 ---------------- */

test("detectBgmFit: id未採番のトラックは除外する", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    mix: { integratedLufs: -10, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
  });
  const bgm = makeBgm([{ start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.equal(findings.length, 0);
});

/* ---------------- detectBgmFit: 決定論(同入力同出力) ---------------- */

test("detectBgmFit: 同一入力は同一出力(決定論)", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    tracks: {
      windowSec: 1,
      samples: [{ outSec: 5, sourceSec: 5, micRmsDb: -20, systemRmsDb: -15, louder: "system" }],
    },
    silences: [{ outSec: 8, endOutSec: 12, lenSec: 4 }],
  });
  const bgm = makeBgm([{ id: "bg_ffffff", start: 0, end: 20, file: "bgm.mp3" }]);
  const a = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const b = detectBgmFit(sound, bgm, DEFAULT_CFG);
  assert.deepEqual(a, b);
});

/* ---------------- 1トラックにつきvolumeDb補正は高々1本 ---------------- */

test("detectBgmFit: 同一トラックでspeech-overlapとsilence-floatが両方該当してもvolumeDbのsuggestionは1本だけ", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    tracks: {
      windowSec: 1,
      samples: [{ outSec: 5, sourceSec: 5, micRmsDb: -20, systemRmsDb: -15, louder: "system" }],
    },
    silences: [{ outSec: 8, endOutSec: 12, lenSec: 4 }],
  });
  const bgm = makeBgm([{ id: "bg_gggggg", start: 0, end: 20, file: "bgm.mp3" }]);
  const findings = detectBgmFit(sound, bgm, DEFAULT_CFG);
  const volumeDbSuggestions = findings.filter((f) => f.suggestion?.field === "volumeDb" || (f.suggestion && "field" in f.suggestion && f.suggestion.field === "volumeDb"));
  assert.equal(volumeDbSuggestions.length, 1);
  // speech-overlap が優先(silence-float は reason のみ)
  assert.equal(findings.find((f) => f.kind === "speech-overlap")?.suggestion !== undefined, true);
  assert.equal(findings.find((f) => f.kind === "silence-float")?.suggestion, undefined);
});

/* ---------------- detectMonotone ---------------- */

test("detectMonotone: fallbackActiveかつ章が十分あれば単調と警告", () => {
  const result = detectMonotone({
    fallbackActive: true,
    bgm: null,
    totalOutSec: 120,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, true);
  assert.match(result.message, /plan-bgm/);
});

test("detectMonotone: 単一fileが総尺のmonotoneCoverRatio超を覆っていれば単調", () => {
  const bgm = makeBgm([
    { id: "bg_hhhhhh", start: 0, end: 100, file: "one.mp3" },
  ]);
  const result = detectMonotone({
    fallbackActive: false,
    bgm,
    totalOutSec: 100,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, true);
});

test("detectMonotone: 複数fileで区切られていれば単調にしない", () => {
  const bgm = makeBgm([
    { id: "bg_iiiiii", start: 0, end: 40, file: "a.mp3" },
    { id: "bg_jjjjjj", start: 40, end: 100, file: "b.mp3" },
  ]);
  const result = detectMonotone({
    fallbackActive: false,
    bgm,
    totalOutSec: 100,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
});

test("detectMonotone: 章が少なければ単調と判定しない(fallbackActiveでも)", () => {
  const result = detectMonotone({
    fallbackActive: true,
    bgm: null,
    totalOutSec: 120,
    chapterCount: 1,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
  assert.equal(result.message, "");
});

test("detectMonotone: bgm.jsonが無くfallbackActiveでもなければ単調にしない", () => {
  const result = detectMonotone({
    fallbackActive: false,
    bgm: null,
    totalOutSec: 100,
    chapterCount: 5,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
});

/* ---------------- buildBgmFitPatch ---------------- */

test("buildBgmFitPatch: suggestionを持つfindingだけをopsへ束ねる", () => {
  const findings: BgmFitFinding[] = [
    {
      refId: "bg_a",
      kind: "speech-overlap",
      startOutSec: 1,
      endOutSec: 2,
      currentVolumeDb: -22,
      suggestion: { op: "set", target: "@bg_a", field: "volumeDb", value: -30 },
      reason: "test",
    },
    {
      refId: "bg_a",
      kind: "silence-float",
      startOutSec: 3,
      endOutSec: 4,
      currentVolumeDb: -22,
      reason: "suggestion無し(既にvolumeDb補正済み)",
    },
    {
      refId: "bg_b",
      kind: "no-fade",
      startOutSec: 10,
      endOutSec: 11,
      currentVolumeDb: -22,
      suggestion: { op: "set", target: "@bg_b", field: "fadeOutSec", value: 1.0 },
      reason: "test2",
    },
  ];
  const patch = buildBgmFitPatch(findings);
  assert.equal(patch.ops.length, 2);
  assert.deepEqual(patch.ops[0], { op: "set", target: "@bg_a", field: "volumeDb", value: -30 });
  assert.deepEqual(patch.ops[1], { op: "set", target: "@bg_b", field: "fadeOutSec", value: 1.0 });
});

test("buildBgmFitPatch: findingsが空ならopsも空", () => {
  const patch = buildBgmFitPatch([]);
  assert.deepEqual(patch.ops, []);
});
