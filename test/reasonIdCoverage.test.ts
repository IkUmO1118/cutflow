// describe --json の summary.reasonIds.coverage(sticky。§docs/plans/2026-07-20-
// cut-knowledge-p3-p5-design.md §7・P5-4)。分母は fillSilenceGaps の穴埋め cut
// を除く「意味カット」。I5: reasonId を持たず plan.first.json も無い収録は
// describeJson の出力が導入前と deepEqual(= summary.reasonIds キー自体が無い)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, describeJson } from "../src/stages/describe.ts";
import type { Config } from "../src/lib/config.ts";
import { CUT_REASON_IDS, REASON_ID_FAMILY } from "../src/lib/reasonIds.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "cutflow-reasonid-coverage-"));
}

function write(dir: string, file: string, data: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
}

const MANIFEST = {
  source: "raw.mkv",
  durationSec: 100,
  video: { width: 1080, height: 1920, fps: 30, screenRegion: { x: 0, y: 0, w: 1080, h: 1920 } },
  layout: "plain",
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-06T00:00:00Z",
};

const TRANSCRIPT = { language: "ja", model: "test", segments: [] };

test("I5: reasonId を1つも持たず plan.first.json も無い fixture は summary.reasonIds キー自体が無い(sticky)", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 40, action: "keep", reason: "本編" },
        { start: 40, end: 50, action: "cut", reason: "言い直し" },
        { start: 50, end: 100, action: "keep", reason: "本編" },
      ],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const proj = describeJson(dir);
    assert.equal("reasonIds" in proj.summary, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage: 分母は無音穴埋め cut を除き、reasonId 付き cut だけ labeled にカウントする", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 10, action: "keep", reason: "" },
        { start: 10, end: 12, action: "cut", reason: "無音" }, // 穴埋め(分母から除く)
        { start: 12, end: 20, action: "keep", reason: "" },
        { start: 20, end: 25, action: "cut", reason: "脱線", reasonId: "tangent" }, // labeled
        { start: 25, end: 30, action: "cut", reason: "言い淀み" }, // unlabeled(意味カットだが reasonId 無し)
        { start: 30, end: 40, action: "keep", reason: "" },
      ],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const proj = describeJson(dir);
    assert.deepEqual(proj.summary.reasonIds?.coverage.semanticCuts, 2);
    assert.deepEqual(proj.summary.reasonIds?.coverage.labeled, 1);
    assert.deepEqual(proj.summary.reasonIds?.coverage.ratio, 0.5);
    assert.equal(proj.summary.reasonIds?.coverage.byId.tangent, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage.byId: cut系7分類が固定鍵順で存在し、未使用は0", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "脱線", reasonId: "tangent" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const proj = describeJson(dir);
    const byId = proj.summary.reasonIds!.coverage.byId;
    const cutFamilyIds = CUT_REASON_IDS.filter((id) => REASON_ID_FAMILY[id] === "cut");
    assert.deepEqual(Object.keys(byId), [...cutFamilyIds]);
    for (const id of cutFamilyIds) {
      assert.equal(byId[id], id === "tangent" ? 1 : 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sticky: reasonId が無くても plan.first.json があれば summary.reasonIds キーが出る(coverage は 0 件)", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "脱線" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    write(dir, "plan.first.json", { schemaVersion: 1, cuts: [], keeps: [] });
    const proj = describeJson(dir);
    assert.ok(proj.summary.reasonIds);
    assert.equal(proj.summary.reasonIds!.coverage.semanticCuts, 1);
    assert.equal(proj.summary.reasonIds!.coverage.labeled, 0);
    assert.equal(proj.summary.reasonIds!.coverage.ratio, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage: cfg.detect.silenceCutReason のカスタム値でも穴埋め cut を正しく除外する", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 5, action: "cut", reason: "silence-fill" },
        { start: 5, end: 10, action: "cut", reason: "脱線", reasonId: "tangent" },
      ],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const cfg = { detect: { silenceCutReason: "silence-fill" } } as Config;
    const proj = describeJson(dir, cfg);
    assert.equal(proj.summary.reasonIds?.coverage.semanticCuts, 1);
    assert.equal(proj.summary.reasonIds?.coverage.labeled, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage: semanticCuts=0(意味カットなし)のとき ratio は 0(NaN にならない)", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "無音" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    write(dir, "plan.first.json", { schemaVersion: 1 });
    const proj = describeJson(dir);
    assert.equal(proj.summary.reasonIds?.coverage.semanticCuts, 0);
    assert.equal(proj.summary.reasonIds?.coverage.ratio, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 散文 describe(): 分類行(sticky)                                      */
/* ------------------------------------------------------------------ */

test("散文 describe(): reasonId 無し・plan.first.json 無しでは「分類:」行が1行も出ない", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "言い直し" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const out = describe(dir);
    assert.doesNotMatch(out, /分類:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("散文 describe(): reasonId があれば「分類: 意味カット N 件中 M 件に分類 id(P%)」が1行出る", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 5, action: "cut", reason: "脱線", reasonId: "tangent" },
        { start: 5, end: 10, action: "cut", reason: "言い淀み" },
      ],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const out = describe(dir);
    assert.match(out, /分類: 意味カット 2 件中 1 件に分類 id\(50%\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
