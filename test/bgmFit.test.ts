// lib/bgmFit.ts(B2 無音/被り回避の音量・duck・切替調整 + B4 単調 fallback 検出)
// の純関数群を固定する。fs/ffmpeg/LLM には一切依存しない。
// §docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBgmFitPatch, detectBgmFit, detectMonotone, idlessTracksNeedIdStamp } from "../src/lib/bgmFit.ts";
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
    bgmSpans: [],
    totalOutSec: 120,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, true);
  assert.match(result.message, /plan-bgm/);
});

test("detectMonotone: 単一fileが総尺のmonotoneCoverRatio超を覆っていれば単調", () => {
  const result = detectMonotone({
    fallbackActive: false,
    bgmSpans: [{ startOutSec: 0, endOutSec: 100, volumeDb: -22, file: "one.mp3" }],
    totalOutSec: 100,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, true);
});

test("detectMonotone: 複数fileで区切られていれば単調にしない", () => {
  const result = detectMonotone({
    fallbackActive: false,
    bgmSpans: [
      { startOutSec: 0, endOutSec: 40, volumeDb: -22, file: "a.mp3" },
      { startOutSec: 40, endOutSec: 100, volumeDb: -22, file: "b.mp3" },
    ],
    totalOutSec: 100,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
});

// FIX 1(単位バグの回帰テスト): カット多用の A/B/A 収録では bgm.json の
// tracks[].start/end(SOURCE 秒)は cut で縮み、sound.bgm.spans(OUTPUT 秒)と
// 大きく食い違う。detectMonotone は OUTPUT カバレッジで判定しなければならない。
// source 秒(0-400 の一トラック)で割ると 400/250=1.6 で誤って monotone に
// なるが、OUTPUT の spans では複数 file が均等に割れていて monotone ではない。
test("detectMonotone: カットで縮む収録では出力カバレッジで判定する(source秒ではない)", () => {
  // source では一見 a.mp3 が広い(0-400)が、cut 後の出力では a/b が均等。
  // detectMonotone は sound.bgm.spans(出力秒)だけを見るので monotone にしない
  const result = detectMonotone({
    fallbackActive: false,
    bgmSpans: [
      { startOutSec: 0, endOutSec: 120, volumeDb: -22, file: "a.mp3" },
      { startOutSec: 120, endOutSec: 250, volumeDb: -22, file: "b.mp3" },
    ],
    totalOutSec: 250,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
});

test("detectMonotone: 出力カバレッジが閾値超なら単調(source尺に依らず)", () => {
  // 出力秒で単一 file が 95% を覆う → monotone。source 尺は使わない
  const result = detectMonotone({
    fallbackActive: false,
    bgmSpans: [
      { startOutSec: 0, endOutSec: 95, volumeDb: -22, file: "one.mp3" },
      { startOutSec: 95, endOutSec: 100, volumeDb: -22, file: "sting.mp3" },
    ],
    totalOutSec: 100,
    chapterCount: 3,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, true);
});

test("detectMonotone: 章が少なければ単調と判定しない(fallbackActiveでも)", () => {
  const result = detectMonotone({
    fallbackActive: true,
    bgmSpans: [],
    totalOutSec: 120,
    chapterCount: 1,
    cfg: DEFAULT_CFG,
  });
  assert.equal(result.monotone, false);
  assert.equal(result.message, "");
});

test("detectMonotone: spansが無くfallbackActiveでもなければ単調にしない", () => {
  const result = detectMonotone({
    fallbackActive: false,
    bgmSpans: [],
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

/* ---------------- idlessTracksNeedIdStamp(FIX 2 のゲート判定) ---------------- */

test("idlessTracksNeedIdStamp: id無しトラックにB2補正が出るならtrue(exit1相当)", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
    // 動画終端まで続く+fadeOutSec無し → no-fade の補正が出る
  });
  const bgm = makeBgm([{ start: 0, end: 20, file: "bgm.mp3" }]);
  assert.equal(idlessTracksNeedIdStamp(sound, bgm, DEFAULT_CFG), true);
});

test("idlessTracksNeedIdStamp: id無しでもB2補正が出ないならfalse(B4だけ/検出なしは通す)", () => {
  const sound = makeSound({
    // spans 無し=補正の起点が無い。mix も目標以下
    bgm: { spans: [], duckSpans: [] },
    mix: { integratedLufs: -20, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
  });
  const bgm = makeBgm([{ start: 0, end: 20, file: "bgm.mp3" }]);
  assert.equal(idlessTracksNeedIdStamp(sound, bgm, DEFAULT_CFG), false);
});

test("idlessTracksNeedIdStamp: 全トラックにidがあればfalse(判定不要)", () => {
  const sound = makeSound({
    bgm: { spans: [{ startOutSec: 0, endOutSec: 20, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
  });
  const bgm = makeBgm([{ id: "bg_zzzzzz", start: 0, end: 20, file: "bgm.mp3" }]);
  assert.equal(idlessTracksNeedIdStamp(sound, bgm, DEFAULT_CFG), false);
});
