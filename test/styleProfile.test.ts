// lib/styleProfile.ts(SD-T0 style-profile の純関数群)を固定する。
// fs/ffmpeg/LLM には一切依存しない(IO ゼロ)。
// §docs/plans/2026-07-12-sd-t0-style-profile-design.md §3.2
//
// ここで組み立てる DescribeProjection / ProjectObservation は describeJson()
// を経由しない手組みの最小値(母艦 [[precision-measurement-nondeterminism-wall]]
// 「D 次元は関数直叩きで測る」)。ケース1の shots 配列は§3.2 の純粋な数式
// テスト用の合成値であり、実収録(2026-07-02 等)の実測値と一致させる必要は無い
// (実測との突き合わせは stages/styleProfile.ts の実走でコーディネータが行う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captionDensityLabel,
  computeCorrectionDelta,
  cutAggressivenessLabel,
  mean,
  median,
  mergeObservations,
  observeBareVideo,
  parsePlanRaw,
  percentile,
  positionHintLabel,
  sectionConfidence,
  styleFlagsFrom,
  unionCoverageSec,
} from "../src/lib/styleProfile.ts";
import type { PlanRaw, ProjectObservation } from "../src/lib/styleProfile.ts";
import type { DescribeProjection } from "../src/stages/describe.ts";

/* ---------------- 手組み DescribeProjection ヘルパ ---------------- */

function makeOverlays(
  captionTracks: DescribeProjection["overlays"]["captionTracks"] = [],
): DescribeProjection["overlays"] {
  return {
    materials: [],
    inserts: [],
    wipeFull: [],
    zooms: [],
    blurs: [],
    annotations: [],
    hideCaption: [],
    colorFilter: null,
    layerOrder: null,
    captionTracks,
  };
}

function makeProj(overrides: Partial<DescribeProjection> = {}): DescribeProjection {
  const base: DescribeProjection = {
    schemaVersion: 1,
    source: {
      file: "rec.mkv",
      durationSec: 200,
      layout: "plain",
      video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
      audio: { micWav: "mic.wav", systemStream: null },
    },
    summary: { approved: false, outDurationSec: 100, keptSec: 100, cutSec: 100, keepCount: 0, captionCount: 0 },
    keeps: [],
    cuts: [],
    captions: [],
    overlays: makeOverlays(),
    chapters: [],
    meta: { titles: [], description: "" },
    bgm: { source: "none" },
    shorts: [],
  };
  return { ...base, ...overrides };
}

function makeCutEntries(n: number): DescribeProjection["cuts"] {
  return Array.from({ length: n }, () => ({ start: 0, end: 1, durationSec: 1, reasons: [], lostCaptions: [] }));
}

function makeObs(overrides: Partial<ProjectObservation> = {}): ProjectObservation {
  const base: ProjectObservation = {
    kind: "own-project",
    path: "/tmp/proj",
    durationSec: 100,
    shotDurations: [],
    outDurationSec: 100,
    sceneChangesPerMin: null,
    captionOutIntervals: [],
    captionDisplaySecs: [],
    captionYs: [],
    captionCount: 0,
    styleFlags: [],
    canvasHeight: null,
    integratedLufs: null,
    truePeakDbtp: null,
    silenceCount: null,
    silenceSec: null,
    bgmLikely: null,
    hasAv: false,
    chapters: null,
    hookSec: null,
    ctaLikely: null,
    delta: null,
    hasPlanRaw: false,
  };
  return { ...base, ...overrides };
}

/* ---------------- ケース1: mean/median/percentile ---------------- */

const SHOTS = [0.7, 1.7, 12.5, 7.5, 4.5, 4.6, 9.2, 5.2, 2.4, 10.6, 9.8, 1, 3.4, 7.5, 3.1, 4.6, 3, 5.6, 1.4];

test("mean/median/percentile: 合成 shots(19要素・純粋な数式テスト用)で固定", () => {
  assert.ok(Math.abs(mean(SHOTS)! - 5.17) < 0.01);
  assert.equal(median(SHOTS), 4.6);
  assert.ok(Math.abs(percentile(SHOTS, 0.1)! - 1.32) < 0.01);
  assert.ok(Math.abs(percentile(SHOTS, 0.9)! - 9.96) < 0.01);
});

test("mean/median/percentile: 空配列は null", () => {
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
  assert.equal(percentile([], 0.5), null);
});

/* ---------------- ケース2: unionCoverageSec ---------------- */

test("unionCoverageSec: 重なる区間は二重計上しない", () => {
  assert.equal(unionCoverageSec([{ start: 0, end: 3 }, { start: 2, end: 5 }, { start: 7, end: 8 }]), 6);
  assert.equal(unionCoverageSec([]), 0);
});

/* ---------------- ケース3: cutAggressivenessLabel ---------------- */

test("cutAggressivenessLabel: 境界値", () => {
  assert.equal(cutAggressivenessLabel(2), "high");
  assert.equal(cutAggressivenessLabel(2.01), "medium-high");
  assert.equal(cutAggressivenessLabel(4), "medium-high");
  assert.equal(cutAggressivenessLabel(4.01), "medium");
  assert.equal(cutAggressivenessLabel(7), "medium");
  assert.equal(cutAggressivenessLabel(7.01), "low");
  assert.equal(cutAggressivenessLabel(null), null);
});

/* ---------------- ケース4: captionDensityLabel ---------------- */

test("captionDensityLabel: 境界値", () => {
  assert.equal(captionDensityLabel(0.29), "low");
  assert.equal(captionDensityLabel(0.3), "medium");
  assert.equal(captionDensityLabel(0.59), "medium");
  assert.equal(captionDensityLabel(0.6), "high");
  assert.equal(captionDensityLabel(null), null);
});

/* ---------------- ケース5: positionHintLabel ---------------- */

test("positionHintLabel: 多数決(60%以上)/ mixed / データなし", () => {
  assert.equal(positionHintLabel({ top: 1, center: 1, bottom: 8 }), "bottom");
  assert.equal(positionHintLabel({ top: 4, center: 3, bottom: 3 }), "mixed");
  assert.equal(positionHintLabel({ top: 0, center: 0, bottom: 0 }), null);
});

/* ---------------- ケース6: sectionConfidence ---------------- */

test("sectionConfidence: present=false は0、既知値は近似一致、projectCount増加で単調増加", () => {
  assert.equal(sectionConfidence({ present: false, sampleSize: 19, projectCount: 1, kSample: 8 }), 0);

  const c1 = sectionConfidence({ present: true, sampleSize: 19, projectCount: 1, kSample: 8, cv: 0.5 });
  assert.ok(Math.abs(c1 - 0.3) <= 0.02, `c1=${c1}`);

  const c3 = sectionConfidence({ present: true, sampleSize: 19, projectCount: 3, kSample: 8, cv: 0.5 });
  assert.ok(c3 > c1, `c3=${c3} should be > c1=${c1}`);
});

/* ---------------- ケース7: computeCorrectionDelta ---------------- */

test("computeCorrectionDelta: cuts件数比較・章/タイトルの verbatim 残存カウント", () => {
  const planRaw: PlanRaw = {
    cuts: Array.from({ length: 9 }, (_, i) => ({ id: i })),
    chapters: [
      { startId: 0, title: "導入" },
      { startId: 1, title: "本編1" },
      { startId: 2, title: "本編2" },
      { startId: 3, title: "まとめ" },
    ],
    titles: ["タイトルA", "タイトルB", "タイトルC"],
    description: "これは概要欄の下書きです",
  };
  const proj = makeProj({
    cuts: makeCutEntries(10),
    chapters: [
      { start: 0, out: 0, title: "導入" },
      { start: 10, out: 10, title: "本編1改" },
      { start: 20, out: 20, title: "本編2" },
      { start: 30, out: 30, title: "まとめ" },
    ],
    meta: { titles: ["タイトルA", "タイトルX", "タイトルC"], description: "これは概要欄の下書きです" },
  });

  const delta = computeCorrectionDelta(planRaw, proj);
  assert.deepEqual(delta.cuts, { proposed: 9, final: 10 });
  assert.equal(delta.chapters.proposed, 4);
  assert.equal(delta.chapters.final, 4);
  assert.equal(delta.chapters.titlesKeptVerbatim, 3); // 導入・本編2・まとめ
  assert.equal(delta.titles.proposed, 3);
  assert.equal(delta.titles.final, 3);
  assert.equal(delta.titles.keptVerbatim, 2); // タイトルA・タイトルC
  assert.equal(delta.description, "identical");
});

test("computeCorrectionDelta: description ラベル(identical/edited/replaced/none)", () => {
  const base: PlanRaw = { cuts: [], chapters: [], titles: [], description: "これは 概要欄 の 下書き です" };

  const identical = computeCorrectionDelta(base, makeProj({ meta: { titles: [], description: "これは 概要欄 の 下書き です" } }));
  assert.equal(identical.description, "identical");

  // 語の大半(5/6)が重なる微修正 → edited
  const edited = computeCorrectionDelta(
    base,
    makeProj({ meta: { titles: [], description: "これは 概要欄 の 下書き です ました" } }),
  );
  assert.equal(edited.description, "edited");

  // 語がほぼ重ならない → replaced
  const replaced = computeCorrectionDelta(
    base,
    makeProj({ meta: { titles: [], description: "全く 別の 内容 です ここ" } }),
  );
  assert.equal(replaced.description, "replaced");

  const none = computeCorrectionDelta(base, makeProj({ meta: { titles: [], description: "" } }));
  assert.equal(none.description, "none");
});

/* ---------------- ケース8: parsePlanRaw ---------------- */

test("parsePlanRaw: 正常JSON / 前後注釈付き / 壊れたJSON / 期待キー欠落", () => {
  const shape: PlanRaw = { cuts: [{ id: 1 }], chapters: [{ startId: 0, title: "x" }], titles: ["t"], description: "d" };

  assert.deepEqual(parsePlanRaw(JSON.stringify(shape)), shape);

  const annotated = `ここに前置きの説明文があります。\n${JSON.stringify(shape)}\nここに後書きがあります。`;
  assert.deepEqual(parsePlanRaw(annotated), shape);

  assert.equal(parsePlanRaw("{not valid json,,,}"), null);
  assert.equal(parsePlanRaw(JSON.stringify({ foo: 1 })), null);
});

/* ---------------- ケース9: observeBareVideo ---------------- */

test("observeBareVideo: captions/structure/delta が全 null/空(§8 不変条件1)", () => {
  const obs = observeBareVideo({
    path: "/tmp/video.mp4",
    probe: { durationSec: 60, width: 1920, height: 1080, fps: 30, hasAudio: true },
    sound: null,
    motion: null,
  });
  assert.equal(obs.kind, "bare-video");
  assert.deepEqual(obs.captionOutIntervals, []);
  assert.deepEqual(obs.captionDisplaySecs, []);
  assert.deepEqual(obs.captionYs, []);
  assert.equal(obs.captionCount, 0);
  assert.equal(obs.chapters, null);
  assert.equal(obs.hookSec, null);
  assert.equal(obs.ctaLikely, null);
  assert.equal(obs.delta, null);
  assert.equal(obs.hasPlanRaw, false);
});

/* ---------------- ケース10: mergeObservations ---------------- */

test("mergeObservations: own×2 は shots をプールした平均(平均の平均ではない)", () => {
  const obsA = makeObs({ path: "/a", shotDurations: [2, 4], outDurationSec: 40 });
  const obsB = makeObs({ path: "/b", shotDurations: [10], outDurationSec: 20 });
  const profile = mergeObservations("default", [obsA, obsB]);

  assert.equal(profile.provenance, "own-project");
  assert.equal(profile.sampleSize.projects, 2);
  assert.equal(profile.sampleSize.shots, 3);

  const naiveAvgOfAvgs = (3 + 10) / 2; // = 6.5(誤った計算)
  const pooledMean = (2 + 4 + 10) / 3; // ≈ 5.33(正しいプール平均)
  assert.notEqual(profile.cutDensity.avgShotSec, naiveAvgOfAvgs);
  assert.ok(Math.abs(profile.cutDensity.avgShotSec! - pooledMean) < 0.01);
});

test("mergeObservations: own×1 + bare×1 は merged provenance / correctionDelta は own のみ由来 / bare は captions/structure に寄与しない", () => {
  const own = makeObs({
    kind: "own-project",
    path: "/own",
    shotDurations: [4, 6],
    outDurationSec: 50,
    captionOutIntervals: [{ start: 0, end: 10 }],
    captionDisplaySecs: [10],
    captionYs: [50],
    captionCount: 1,
    canvasHeight: 1080,
    chapters: [{ name: "A", startOutSec: 0, endOutSec: 50 }],
    hookSec: 20,
    ctaLikely: true,
    delta: {
      cuts: { proposed: 5, final: 6 },
      chapters: { proposed: 1, final: 1, titlesKeptVerbatim: 1 },
      titles: { proposed: 2, final: 2, keptVerbatim: 1 },
      description: "edited",
    },
    hasPlanRaw: true,
    hasAv: true,
  });
  const bare = makeObs({
    kind: "bare-video",
    path: "/bare",
    outDurationSec: 30,
    sceneChangesPerMin: 12,
    hasAv: true,
  });

  const profile = mergeObservations("default", [own, bare]);

  assert.equal(profile.provenance, "merged");
  assert.equal(profile.sampleSize.projects, 1);
  assert.equal(profile.sampleSize.videos, 1);

  // correctionDelta は own の delta のみ由来(bare の存在で希釈されない)
  assert.ok(profile.correctionDelta);
  assert.deepEqual(profile.correctionDelta!.cuts, { proposed: 5, final: 6 });
  assert.equal(profile.correctionDelta!.description, "edited");

  // bare の captions/structure は集約に寄与しない(own 単独と同じ値になる)
  assert.equal(profile.captions.meta.sampleSize, 1);
  assert.ok(Math.abs(profile.captions.coverageRatio! - 10 / 50) < 0.01);
  assert.equal(profile.structure.chapterCount, 1);
  assert.equal(profile.structure.hookSec, 20);

  // cutDensity は own(shots)+bare(motion由来のsceneChangesPerMin)の両方が寄与
  assert.equal(profile.cutDensity.meta.provenance, "merged");
});

test("mergeObservations: bare のみは correctionDelta=null", () => {
  const bare = makeObs({ kind: "bare-video", path: "/bare", outDurationSec: 30 });
  const profile = mergeObservations("default", [bare]);
  assert.equal(profile.provenance, "bare-video");
  assert.equal(profile.correctionDelta, null);
});

/* ---------------- ケース11: styleFlagsFrom ---------------- */

test("styleFlagsFrom: bold/outlined(noneは除外)/boxed の distinct 収集", () => {
  const proj = makeProj({
    overlays: makeOverlays([{ track: 1, style: { fontWeight: 700 } }]),
    captions: [
      { index: 0, start: 0, end: 1, text: "a", track: 1, out: [], keepIndex: null, visible: false, style: { outlineColor: "none" } },
      { index: 1, start: 1, end: 2, text: "b", track: 1, out: [], keepIndex: null, visible: false, style: { background: { color: "#000" } } },
    ],
  });
  const flags = styleFlagsFrom(proj);
  assert.ok(flags.includes("bold"), "fontWeight>=700 は bold");
  assert.ok(!flags.includes("outlined"), "outlineColor:none は outlined フラグを立てない");
  assert.ok(flags.includes("boxed"), "background 有りは boxed");
});
