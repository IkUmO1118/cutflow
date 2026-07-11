// lib/styleInjection.ts(SD-T4 profile→plan 注入の純関数群)を固定する。
// fs/ffmpeg/LLM には一切依存しない(IO ゼロ)。
// §docs/plans/2026-07-12-sd-t4-style-injection-design.md §3
//
// 最重要不変条件: plan.styleProfile 既定 off のとき renderPrompt(plan.md /
// plan-cuts.md)の出力は導入前と1バイトも変わらない(§2.6.5・§3.1)。
// test/perception.test.ts は無修正のまま(バイト等価の直接証明として温存)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStylePolicy,
  formatStyleProfileBlock,
  priorStrengthLabel,
  renderStyleProfileBlock,
} from "../src/lib/styleInjection.ts";
import type { StylePolicy } from "../src/lib/styleInjection.ts";
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import type { StyleProfile } from "../src/lib/styleProfile.ts";

/* ---------------- 手組み StyleProfile fixture(styleCheck.test.ts と同じ流儀) ---------------- */

function meta(confidence: number, sampleSize = 10): StyleProfile["cutDensity"]["meta"] {
  return { provenance: "own-project", confidence, sampleSize };
}

/** §3.3: 2026-07-02 profile 相当(avgShot 5.46 / coverage 0.78 / density high /
 *  position bottom / 4 章 / cta true)。confidence は cold-start N=1 帯
 *  (0.25〜0.33)に合わせる */
function realisticProfile(): StyleProfile {
  return {
    schemaVersion: 1,
    name: "default",
    provenance: "own-project",
    axis: "reference-output",
    generatedAt: "2026-07-02T00:00:00.000Z",
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
      coverageRatio: 0.78,
      avgDisplaySec: 3.0,
      density: "high",
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
      meta: meta(0.33, 4),
      segments: null,
      chapterCount: 4,
      hookSec: 8,
      ctaLikely: true,
    },
    correctionDelta: null,
  };
}

/** cutDensity/captions/structure が全て値なし(null)の profile。§3.4 の
 *  「全 section null に畳まれた profile」経路を確認する */
function emptyProfile(): StyleProfile {
  return {
    schemaVersion: 1,
    name: "default",
    provenance: "bare-video",
    axis: "reference-output",
    generatedAt: "2026-07-02T00:00:00.000Z",
    sampleSize: { projects: 0, videos: 1, shots: 0, captions: 0 },
    sources: [],
    cutDensity: {
      meta: { provenance: "bare-video", confidence: 0, sampleSize: 0 },
      avgShotSec: null,
      medianShotSec: null,
      shotSecP10: null,
      shotSecP90: null,
      sceneChangesPerMin: null,
      cutAggressiveness: null,
    },
    captions: {
      meta: { provenance: "bare-video", confidence: 0, sampleSize: 0 },
      coverageRatio: null,
      avgDisplaySec: null,
      density: null,
      positionHint: null,
      positionHistogram: null,
      styleNotes: [],
    },
    audio: {
      meta: { provenance: "bare-video", confidence: 0, sampleSize: 0 },
      integratedLufs: null,
      truePeakDbtp: null,
      silenceCount: null,
      silenceRatio: null,
      bgmLikely: null,
    },
    structure: {
      meta: { provenance: "bare-video", confidence: 0, sampleSize: 0 },
      segments: null,
      chapterCount: null,
      hookSec: null,
      ctaLikely: null,
    },
    correctionDelta: null,
  };
}

/* ---------------- priorStrengthLabel(§2.5.3) ---------------- */

test("priorStrengthLabel: 閾値境界(0.6=強め・0.4=中程度・それ未満は弱い)", () => {
  assert.equal(priorStrengthLabel(0.6), "強め");
  assert.equal(priorStrengthLabel(0.8), "強め");
  assert.equal(priorStrengthLabel(0.4), "中程度");
  assert.equal(priorStrengthLabel(0.59), "中程度");
  assert.equal(priorStrengthLabel(0.39), "弱い(cold-start・参考程度)");
  assert.equal(priorStrengthLabel(0), "弱い(cold-start・参考程度)");
});

/* ---------------- buildStylePolicy(§2.5.4 導出式) ---------------- */

test("buildStylePolicy: 値が全く取れない profile は cut/caption/structure が全て null", () => {
  const policy = buildStylePolicy(emptyProfile());
  assert.equal(policy.cut, null);
  assert.equal(policy.caption, null);
  assert.equal(policy.structure, null);
  assert.equal(policy.provenance, "bare-video");
});

test("buildStylePolicy: realistic profile は3 section とも非 null で値を運ぶ", () => {
  const policy = buildStylePolicy(realisticProfile());
  assert.ok(policy.cut);
  assert.equal(policy.cut!.targetAvgShotSec, 5.46);
  assert.equal(policy.cut!.aggressiveness, "medium");
  assert.ok(policy.caption);
  assert.equal(policy.caption!.coverageRatio, 0.78);
  assert.equal(policy.caption!.density, "high");
  assert.equal(policy.caption!.positionHint, "bottom");
  assert.ok(policy.structure);
  assert.equal(policy.structure!.hookSec, 8);
  assert.equal(policy.structure!.ctaLikely, true);
});

/* ---------------- formatStyleProfileBlock / golden(§3.3) ---------------- */

test("formatStyleProfileBlock: realistic profile の golden 部分文字列(avgShot/積極度/密度/位置/CTA/弱いprior)", () => {
  const policy = buildStylePolicy(realisticProfile());
  const text = formatStyleProfileBlock(policy);
  assert.match(text, /約5\.5秒/);
  assert.match(text, /積極度=標準/);
  assert.match(text, /密度=多め/);
  assert.match(text, /位置=画面下部/);
  assert.match(text, /末尾にCTAあり/);
  assert.match(text, /弱い\(cold-start/);
  assert.match(text, /^## スタイル方針/);
  assert.match(text, /brief.md/);
});

test("formatStyleProfileBlock: 部分的に null な section はその部分だけ省く", () => {
  const policy: StylePolicy = {
    provenance: "own-project",
    cut: {
      targetAvgShotSec: null,
      aggressiveness: "high",
      shotSecP10: null,
      shotSecP90: null,
      confidence: 0.5,
    },
    caption: null,
    structure: null,
  };
  const text = formatStyleProfileBlock(policy);
  assert.doesNotMatch(text, /目標平均ショット長/);
  assert.doesNotMatch(text, /学習帯/);
  assert.match(text, /積極度=高/);
  assert.match(text, /\[prior:中程度\]/);
  assert.doesNotMatch(text, /字幕:/);
  assert.doesNotMatch(text, /構成:/);
});

/* ---------------- renderStyleProfileBlock(§2.5.5・§3.1/§3.4) ---------------- */

test("renderStyleProfileBlock: enabled=false は profile があっても空文字(バイト等価の核)", () => {
  assert.equal(renderStyleProfileBlock(realisticProfile(), false), "");
});

test("renderStyleProfileBlock: profile=null は enabled=true でも空文字(優雅な劣化)", () => {
  assert.equal(renderStyleProfileBlock(null, true), "");
});

test("renderStyleProfileBlock: 全 section null に畳まれる profile は enabled=true でも空文字", () => {
  assert.equal(renderStyleProfileBlock(emptyProfile(), true), "");
});

test("renderStyleProfileBlock: enabled=true かつ値ありは前後 \\n を伴う1ブロック", () => {
  const block = renderStyleProfileBlock(realisticProfile(), true);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /スタイル方針/);
});

/* ---------------- renderPrompt レベル注入(§3.1/§3.2) ---------------- */

let recDir: string;
let channelDir: string;

const numberedForPrompt: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "こんにちは" },
];

before(() => {
  channelDir = mkdtempSync(join(tmpdir(), "cutflow-styleinjection-"));
  recDir = join(channelDir, "2026-07-12-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

test("renderPrompt: styleProfile 省略時(既定 off)は plan.md/plan-cuts.md に残骸が一切無い(バイト等価)", () => {
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42);
  assert.doesNotMatch(planPrompt, /スタイル方針/);
  assert.doesNotMatch(planPrompt, /\{\{styleProfile\}\}/);
  assert.doesNotMatch(planPrompt, /styleProfile/);
  assert.doesNotMatch(planPrompt, /\{\{/);

  const planCutsPrompt = renderPrompt(recDir, "plan-cuts.md", numberedForPrompt, 42);
  assert.doesNotMatch(planCutsPrompt, /スタイル方針/);
  assert.doesNotMatch(planCutsPrompt, /\{\{styleProfile\}\}/);
  assert.doesNotMatch(planCutsPrompt, /styleProfile/);
  assert.doesNotMatch(planCutsPrompt, /\{\{/);
});

test("renderPrompt: styleProfile を明示的に空文字で渡してもバイト等価(7引数呼び出しの既定と一致)", () => {
  const withDefault = renderPrompt(recDir, "plan.md", numberedForPrompt, 42);
  const withEmpty = renderPrompt(recDir, "plan.md", numberedForPrompt, 42, "", undefined, "");
  assert.equal(withDefault, withEmpty);
});

test("renderPrompt: styleProfile を渡すと {{perception}} 直後(区切りなし)・## カットの判断基準の直前に挿入される(plan.md)", () => {
  const block = renderStyleProfileBlock(realisticProfile(), true);
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42, "", undefined, block);
  assert.match(planPrompt, /スタイル方針/);
  assert.ok(
    planPrompt.includes(`${block}\n## カットの判断基準`),
    "block の直後(区切りなし)に見出しが続く",
  );
});

test("renderPrompt: styleProfile を渡すと {{perception}} 直後(区切りなし)・## カットの判断基準の直前に挿入される(plan-cuts.md)", () => {
  const block = renderStyleProfileBlock(realisticProfile(), true);
  const planCutsPrompt = renderPrompt(
    recDir,
    "plan-cuts.md",
    numberedForPrompt,
    42,
    "",
    undefined,
    block,
  );
  assert.match(planCutsPrompt, /スタイル方針/);
  assert.ok(
    planCutsPrompt.includes(`${block}\n## カットの判断基準`),
    "block の直後(区切りなし)に見出しが続く",
  );
});

test("renderPrompt: perception と styleProfile を両方渡すと perception → styleProfile の順で連結される", () => {
  const perception = "\n## AI 向け知覚情報(発話以外の手掛かり)\n\nダミー\n";
  const block = renderStyleProfileBlock(realisticProfile(), true);
  const planPrompt = renderPrompt(
    recDir,
    "plan.md",
    numberedForPrompt,
    42,
    perception,
    undefined,
    block,
  );
  const iPerception = planPrompt.indexOf("AI 向け知覚情報");
  const iStyle = planPrompt.indexOf("スタイル方針");
  assert.ok(iPerception >= 0 && iStyle >= 0);
  assert.ok(iPerception < iStyle, "perception ブロックが styleProfile ブロックより前");
  assert.ok(
    planPrompt.includes(`ダミー\n${block}\n## カットの判断基準`),
    "perception 直後・区切りなしで styleProfile が続く",
  );
});

test("renderPrompt: meta.md / plan-shorts.md / plan-cuts-critique.md には {{styleProfile}} プレースホルダが無い(v1 defer・§1.5)", () => {
  const block = renderStyleProfileBlock(realisticProfile(), true);
  const metaWith = renderPrompt(recDir, "meta.md", numberedForPrompt, 42, "", undefined, block);
  const metaWithout = renderPrompt(recDir, "meta.md", numberedForPrompt, 42);
  assert.equal(metaWith, metaWithout, "meta.md は styleProfile 引数を渡しても無視される(no-op)");
  assert.doesNotMatch(metaWith, /スタイル方針/);
});
