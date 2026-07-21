// describe --json の summary.reasonIds.coverage(sticky。§docs/plans/2026-07-20-
// cut-knowledge-p3-p5-design.md §7・P5-4)。分母は fillSilenceGaps の穴埋め cut
// を除く「意味カット」。I5: reasonId を持たず plan.first.json も無い収録は
// describeJson の出力が導入前と deepEqual(= summary.reasonIds キー自体が無い)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/* ------------------------------------------------------------------ */
/* P5-5: summary.reasonIds.firstVsFinal(plan.first.json を元秒で join)   */
/* ------------------------------------------------------------------ */

/** id は変わりうる想定であえて plan.first.json 側と cutplan.json 側で
 * 異なる番号を振り、join が start/end(元秒)だけで行われることを実証する */
function writeFirstVsFinalFixture(dir: string): void {
  write(dir, "manifest.json", MANIFEST);
  write(dir, "cutplan.json", {
    approved: false,
    segments: [
      // dead-air だった候補が2件→1件だけ keep に反転
      { start: 0, end: 5, action: "keep", reason: "無音のまま反転" }, // 反転(cut→keep)
      { start: 5, end: 10, action: "cut", reason: "無音" }, // 反転せず(cutのまま)
      // demo-wait(keeps 側)だった候補が1件→cut に反転
      { start: 10, end: 15, action: "cut", reason: "尺の都合でやっぱり切った" }, // 反転(keep→cut)
      { start: 15, end: 20, action: "keep", reason: "" }, // 反転せず(keepのまま)
    ],
  });
  write(dir, "transcript.json", TRANSCRIPT);
  write(dir, "plan.first.json", {
    schemaVersion: 1,
    writtenAt: "2026-07-20T00:00:00.000Z",
    source: "plan --cuts-only",
    reasonIdsEnabled: true,
    pattern: "tool-demo",
    candidateCount: 4,
    cuts: [
      { id: 101, start: 0, end: 5, reasonId: "dead-air", reason: "発言なしの間" },
      { id: 102, start: 5, end: 10, reasonId: "dead-air", reason: "発言なしの間" },
    ],
    keeps: [
      { id: 103, start: 10, end: 15, reasonId: "demo-wait", reason: "画面が動いている" },
      { id: 104, start: 15, end: 20, reasonId: "demo-wait", reason: "画面が動いている" },
    ],
  });
}

test("firstVsFinal: 元秒(start/end)で join し、id が食い違っていても反転を検出する", () => {
  const dir = makeDir();
  try {
    writeFirstVsFinalFixture(dir);
    const proj = describeJson(dir);
    const fvf = proj.summary.reasonIds?.firstVsFinal;
    assert.ok(fvf);
    assert.equal(fvf!.source, "plan --cuts-only");
    assert.equal(fvf!.reasonIdsEnabled, true);
    assert.deepEqual(fvf!.flippedToKeep, [{ reasonId: "dead-air", first: 2, flipped: 1, rate: 0.5 }]);
    assert.deepEqual(fvf!.flippedToCut, [{ reasonId: "demo-wait", first: 2, flipped: 1, rate: 0.5 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firstVsFinal: plan.first.json が無ければキー自体が無い", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "脱線", reasonId: "tangent" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    const proj = describeJson(dir);
    assert.equal("firstVsFinal" in (proj.summary.reasonIds ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firstVsFinal: 壊れた plan.first.json は firstVsFinal だけ省略し、coverage は出す(describe は落ちない)", () => {
  const dir = makeDir();
  try {
    write(dir, "manifest.json", MANIFEST);
    write(dir, "cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 5, action: "cut", reason: "脱線", reasonId: "tangent" }],
    });
    write(dir, "transcript.json", TRANSCRIPT);
    writeFileSync(join(dir, "plan.first.json"), "{not valid json");
    const proj = describeJson(dir);
    assert.ok(proj.summary.reasonIds);
    assert.equal(proj.summary.reasonIds!.coverage.semanticCuts, 1);
    assert.equal("firstVsFinal" in proj.summary.reasonIds!, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("firstVsFinal: describeJson は plan.first.json を読むだけで書き換えない", () => {
  const dir = makeDir();
  try {
    writeFirstVsFinalFixture(dir);
    const before = readFileSync(join(dir, "plan.first.json"), "utf8");
    describeJson(dir);
    const after = readFileSync(join(dir, "plan.first.json"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("散文 describe(): plan.first.json があれば「/ 初版から反転 N 件」が末尾に付く", () => {
  const dir = makeDir();
  try {
    writeFirstVsFinalFixture(dir);
    const out = describe(dir);
    assert.match(out, /分類: .+\/ 初版から反転 2 件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
