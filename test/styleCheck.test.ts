// lib/styleCheck.ts(SD-T1 style-check の純関数群)を固定する。
// fs/ffmpeg/LLM には一切依存しない(IO ゼロ)。
// §docs/plans/2026-07-12-sd-t1-style-check-design.md §3.5
//
// ここで組み立てる StyleProfile は手組みの最小値(母艦
// [[precision-measurement-nondeterminism-wall]] 「D 次元は関数直叩きで測る」・
// test/styleProfile.test.ts と同じ流儀)。channel 実データ(2026-07-02 等)との
// 突き合わせは src/stages/styleCheck.ts の実走でコーディネータが行う。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCategorical,
  classifyNumeric,
  compareProfiles,
  numericBands,
  summarizeFindings,
  widen,
} from "../src/lib/styleCheck.ts";
import type { StyleFinding } from "../src/lib/styleCheck.ts";
import type { StyleProfile } from "../src/lib/styleProfile.ts";

/* ---------------- 手組み StyleProfile ヘルパ ---------------- */

function meta(confidence: number, sampleSize = 10): StyleProfile["cutDensity"]["meta"] {
  return { provenance: "own-project", confidence, sampleSize };
}

/** cutDensity conf=0.28 / captions conf=0.27 / audio conf=0.25(2026-07-02
 * profile の実測 confidence 帯に合わせた cold-start 典型値)。全 section が
 * 自己一致するベースライン(ケース1がこれを reference/candidate 両方に使う) */
function baseProfile(): StyleProfile {
  return {
    schemaVersion: 1,
    name: "default",
    provenance: "own-project",
    axis: "reference-output",
    generatedAt: "2026-07-12T00:00:00.000Z",
    sampleSize: { projects: 1, videos: 0, shots: 20, captions: 15 },
    sources: [],
    cutDensity: {
      meta: meta(0.28, 20),
      avgShotSec: 5.46,
      medianShotSec: 5.0,
      shotSecP10: 2.09,
      shotSecP90: 10,
      sceneChangesPerMin: 2.5,
      cutAggressiveness: "medium",
    },
    captions: {
      meta: meta(0.27, 15),
      coverageRatio: 0.5,
      avgDisplaySec: 3.0,
      density: "medium",
      positionHint: "bottom",
      positionHistogram: { top: 1, center: 1, bottom: 13 },
      styleNotes: [],
    },
    audio: {
      meta: meta(0.25, 1),
      integratedLufs: -14,
      truePeakDbtp: -3,
      silenceCount: 3,
      silenceRatio: 0.2,
      bgmLikely: true,
    },
    structure: {
      meta: meta(0.33, 3),
      segments: null,
      chapterCount: 3,
      hookSec: 8,
      ctaLikely: true,
    },
    correctionDelta: null,
  };
}

function clone(p: StyleProfile): StyleProfile {
  return structuredClone(p);
}

function findingFor(findings: StyleFinding[], metric: string): StyleFinding | undefined {
  return findings.find((f) => f.metric === metric);
}

/* ---------------- ケース1: 自己一致(距離0・warn/borderline 0) ---------------- */

test("compareProfiles: 自己一致(reference===candidate)は findings 0件(warn 0・borderline も 0)", () => {
  const ref = baseProfile();
  const cand = clone(ref);
  const findings = compareProfiles(ref, cand);
  assert.equal(findings.length, 0, `expected 0 findings, got ${JSON.stringify(findings)}`);
});

/* ---------------- ケース2〜4: pace(avgShotSec の learned-percentile 帯) ---------------- */

test("compareProfiles: pace 桁違い逸脱・高 conf(ref conf=0.7, cand avg=114) → deviation/warn", () => {
  const ref = baseProfile();
  ref.cutDensity.meta.confidence = 0.7;
  const cand = clone(ref);
  cand.cutDensity.avgShotSec = 114;

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "avgShotSec");
  assert.equal(f?.kind, "deviation");
  assert.equal(f?.severity, "warn");
});

test("compareProfiles: pace 帯内(cand avg=6.0, [p10,p90]=[2.09,10]) → finding なし", () => {
  const ref = baseProfile();
  const cand = clone(ref);
  cand.cutDensity.avgShotSec = 6.0;

  const findings = compareProfiles(ref, cand);
  assert.equal(findingFor(findings, "avgShotSec"), undefined);
});

test("compareProfiles: 軽い逸脱+低conf(ref conf=0.28既定, cand avg=11) → borderline/info(outer に収まる)", () => {
  const ref = baseProfile(); // cutDensity.meta.confidence = 0.28(既定)
  const cand = clone(ref);
  cand.cutDensity.avgShotSec = 11;

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "avgShotSec");
  assert.equal(f?.kind, "borderline");
  assert.equal(f?.severity, "info");
});

test("compareProfiles: 桁違い逸脱+低conf(ref conf=0.28既定, cand avg=114) → deviation/warn(floor で潰れない)", () => {
  const ref = baseProfile(); // cutDensity.meta.confidence = 0.28(既定)
  const cand = clone(ref);
  cand.cutDensity.avgShotSec = 114;

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "avgShotSec");
  assert.equal(f?.kind, "deviation");
  assert.equal(f?.severity, "warn");
});

/* ---------------- ケース5〜7: カテゴリ(positionHint) ---------------- */

test("compareProfiles: カテゴリ一致(positionHint bottom==bottom) → finding なし", () => {
  const ref = baseProfile();
  const cand = clone(ref);
  const findings = compareProfiles(ref, cand);
  assert.equal(findingFor(findings, "positionHint"), undefined);
});

test("compareProfiles: カテゴリ不一致・高conf(bottom→top, ref conf=0.7) → mismatch/warn", () => {
  const ref = baseProfile();
  ref.captions.meta.confidence = 0.7;
  const cand = clone(ref);
  cand.captions.positionHint = "top";

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "positionHint");
  assert.equal(f?.kind, "mismatch");
  assert.equal(f?.severity, "warn");
});

test("compareProfiles: カテゴリ不一致・低conf(bottom→top, ref conf=0.27既定) → mismatch/info(CATEGORICAL_TRUST_CONF未満)", () => {
  const ref = baseProfile(); // captions.meta.confidence = 0.27(既定。CATEGORICAL_TRUST_CONF=0.35未満)
  const cand = clone(ref);
  cand.captions.positionHint = "top";

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "positionHint");
  assert.equal(f?.kind, "mismatch");
  assert.equal(f?.severity, "info");
});

test("compareProfiles: mixed 吸収(ref positionHint=mixed) → finding なし", () => {
  const ref = baseProfile();
  ref.captions.positionHint = "mixed";
  const cand = clone(ref);
  cand.captions.positionHint = "top";

  const findings = compareProfiles(ref, cand);
  assert.equal(findingFor(findings, "positionHint"), undefined);
});

/* ---------------- ケース8: 欠測(skipped) ---------------- */

test("compareProfiles: 欠測(ref.audio.integratedLufs=null) → skipped/info(先に av を案内)", () => {
  const ref = baseProfile();
  ref.audio.integratedLufs = null;
  const cand = clone(baseProfile());

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "integratedLufs");
  assert.equal(f?.kind, "skipped");
  assert.equal(f?.severity, "info");
  assert.match(f!.message, /av/);
});

/* ---------------- ケース9: percentile 帯(medianShotSec) ---------------- */

test("compareProfiles: percentile 帯([p10,p90]=[2.09,10])内=finding なし・外=deviation", () => {
  const ref = baseProfile();

  const inCand = clone(ref);
  inCand.cutDensity.medianShotSec = 6;
  const inFindings = compareProfiles(ref, inCand);
  assert.equal(findingFor(inFindings, "medianShotSec"), undefined);

  const outCand = clone(ref);
  outCand.cutDensity.medianShotSec = 30; // outer をはるかに超える(widen(0.28)込みでも外)
  const outFindings = compareProfiles(ref, outCand);
  const f = findingFor(outFindings, "medianShotSec");
  assert.equal(f?.kind, "deviation");
  assert.equal(f?.severity, "warn");
});

/* ---------------- ケース10: widen 単調性 ---------------- */

test("widen: 単調性(confidence が低いほど広い)・widen(1)=1", () => {
  assert.equal(widen(1), 1);
  assert.ok(widen(0.9) < widen(0.3), `widen(0.9)=${widen(0.9)} should be < widen(0.3)=${widen(0.3)}`);
  assert.ok(Math.abs(widen(0) - 3) < 1e-9);
});

/* ---------------- ケース11: dB 絶対帯(integratedLufs) ---------------- */

test("compareProfiles: dB 絶対帯(ref=-14, tol=3)。内=finding なし / 外=deviation/warn", () => {
  const ref = baseProfile();
  ref.audio.integratedLufs = -14;

  const inCand = clone(ref);
  inCand.audio.integratedLufs = -15;
  assert.equal(findingFor(compareProfiles(ref, inCand), "integratedLufs"), undefined);

  const outCand = clone(ref);
  outCand.audio.integratedLufs = -22;
  const f = findingFor(compareProfiles(ref, outCand), "integratedLufs");
  assert.equal(f?.kind, "deviation");
  assert.equal(f?.severity, "warn");
});

/* ---------------- ケース12: coverageRatio 絶対帯 ---------------- */

test("compareProfiles: coverageRatio 絶対帯(ref=0.8, tol=0.15)。内=finding なし / 外=deviation", () => {
  const ref = baseProfile();
  ref.captions.coverageRatio = 0.8;

  const inCand = clone(ref);
  inCand.captions.coverageRatio = 0.7;
  assert.equal(findingFor(compareProfiles(ref, inCand), "coverageRatio"), undefined);

  const outCand = clone(ref);
  outCand.captions.coverageRatio = 0.4;
  const f = findingFor(compareProfiles(ref, outCand), "coverageRatio");
  assert.equal(f?.kind, "deviation");
  assert.equal(f?.severity, "warn");
});

/* ---------------- ケース13: severity は常に warn|info(fail は無い) ---------------- */

test("compareProfiles: 全 finding が severity ∈ {warn,info} のみ(fail は絶対出ない)", () => {
  const ref = baseProfile();
  ref.audio.integratedLufs = null; // skipped を混ぜる
  const cand = clone(baseProfile());
  cand.cutDensity.avgShotSec = 114; // deviation/warn
  cand.captions.positionHint = "top"; // mismatch(conf 0.27 既定→info)

  const findings = compareProfiles(ref, cand);
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(f.severity === "warn" || f.severity === "info", `unexpected severity: ${f.severity}`);
  }

  const counts = summarizeFindings(findings);
  assert.equal(counts.warn + counts.info + counts.skipped, findings.length);
});

/* ---------------- 追加ケース: relative モードの expected≈0 ガード ---------------- */

test("numericBands: relative モードで expected=0 → {inner:null, outer:null}(0基準では相対距離を測れない)", () => {
  const { inner, outer } = numericBands({
    expected: 0,
    spec: { section: "cutDensity", metric: "sceneChangesPerMin", mode: "relative", tol: 0.3 },
    confidence: 0.28,
    pctLo: null,
    pctHi: null,
  });
  assert.equal(inner, null);
  assert.equal(outer, null);
});

test("compareProfiles: sceneChangesPerMin(relative)で ref=0(実データ2026-07-02相当)・cand=0.53(2026-07-10相当) → skipped/info(偽 deviation にならない)", () => {
  const ref = baseProfile();
  ref.cutDensity.sceneChangesPerMin = 0;
  const cand = clone(ref);
  cand.cutDensity.sceneChangesPerMin = 0.53;

  const findings = compareProfiles(ref, cand);
  const f = findingFor(findings, "sceneChangesPerMin");
  assert.equal(f?.kind, "skipped");
  assert.equal(f?.severity, "info");
  // 偽 warn/deviation になっていないことを明示的に固定する
  assert.notEqual(f?.kind, "deviation");
  assert.notEqual(f?.severity, "warn");
});

/* ---------------- classifyNumeric / classifyCategorical の直叩き ---------------- */

test("classifyNumeric: inner内=null・inner外outer内=borderline・outer外=deviation", () => {
  const inner = { lo: 2, hi: 10 };
  const outer = { lo: -3, hi: 15 };
  assert.equal(classifyNumeric(6, inner, outer, 0.5), null);
  assert.equal(classifyNumeric(12, inner, outer, 0.5), "borderline");
  assert.equal(classifyNumeric(20, inner, outer, 0.5), "deviation");
});

test("classifyCategorical: 一致/mixed=null・不一致は confidence で warn|info", () => {
  assert.equal(classifyCategorical("bottom", "bottom", 0.9), null);
  assert.equal(classifyCategorical("top", "mixed", 0.9), null);
  assert.equal(classifyCategorical("top", "bottom", 0.9), "warn");
  assert.equal(classifyCategorical("top", "bottom", 0.1), "info");
});
