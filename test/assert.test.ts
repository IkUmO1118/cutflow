// src/stages/assert.ts の純評価コア(evaluateStructural・Tier 1)を、手組みの
// DescribeProjection で固定する。fs には一切触れない(describe/validate を
// 経由しない)。fs ラッパー(assert(dir))の実データ検証(タスク2)は
// ファイル末尾のブロックにまとめてある。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStructural, evaluateVisual, assert as assertProject } from "../src/stages/assert.ts";
import { buildRichFixture } from "./describe.test.ts";
import type {
  AssertionsDoc,
  Assertion,
} from "../src/types.ts";
import type {
  BlurEntry,
  CaptionEntry,
  DescribeProjection,
  MaterialEntry,
} from "../src/stages/describe.ts";
import type { OcrResult } from "../src/lib/ocr.ts";

/** 最小の DescribeProjection(必要なフィールドだけ上書きして使う) */
function baseProj(overrides: Partial<DescribeProjection> = {}): DescribeProjection {
  return {
    schemaVersion: 1,
    source: {
      file: "rec.mp4",
      durationSec: 100,
      layout: "plain",
      video: { width: 1280, height: 720, fps: 30, screenRegion: { x: 0, y: 0, w: 1280, h: 720 } },
      audio: { micWav: "mic.wav", systemStream: null },
    },
    summary: {
      approved: false,
      outDurationSec: 40,
      keptSec: 40,
      cutSec: 60,
      keepCount: 1,
      captionCount: 0,
    },
    keeps: [{ index: 0, start: 0, end: 40, durationSec: 40, outStart: 0, outEnd: 40 }],
    cuts: [],
    captions: [],
    overlays: {
      materials: [],
      inserts: [],
      wipeFull: [],
      zooms: [],
      blurs: [],
      hideCaption: [],
      colorFilter: null,
      layerOrder: null,
      captionTracks: [],
    },
    chapters: [],
    meta: { titles: [], description: "" },
    bgm: { source: "none" },
    shorts: [],
    ...overrides,
  };
}

function mkCaption(overrides: Partial<CaptionEntry>): CaptionEntry {
  return {
    index: 0,
    start: 0,
    end: 1,
    text: "テスト",
    track: 1,
    out: [{ start: 0, end: 1 }],
    keepIndex: 0,
    visible: true,
    ...overrides,
  };
}

function mkMaterial(overrides: Partial<MaterialEntry>): MaterialEntry {
  return {
    start: 0,
    end: 1,
    file: "materials/x.png",
    track: 1,
    exists: true,
    out: [{ start: 0, end: 1 }],
    ...overrides,
  };
}

function mkBlur(overrides: Partial<BlurEntry>): BlurEntry {
  return {
    start: 0,
    end: 1,
    out: [{ start: 0, end: 1 }],
    rect: { x: 100, y: 100, w: 200, h: 100 },
    ...overrides,
  };
}

function mkOcr(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    text: "",
    lines: [],
    image: { w: 1280, h: 720 },
    ...overrides,
  };
}

function spec(assertions: Assertion[]): AssertionsDoc {
  return { schemaVersion: 1, assertions };
}

function outcomeOf(proj: DescribeProjection, a: Assertion) {
  const outcomes = evaluateStructural(proj, spec([a]));
  assert.equal(outcomes.length, 1);
  return outcomes[0];
}

/* ---------------- outDuration ---------------- */

test("outDuration: 各 op が summary.outDurationSec と比較される", () => {
  const proj = baseProj({ summary: { ...baseProj().summary, outDurationSec: 40 } });
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "<=", value: 60 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "<=", value: 40 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "<=", value: 30 }).status, "fail");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: ">=", value: 40 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: ">=", value: 41 }).status, "fail");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "<", value: 41 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "<", value: 40 }).status, "fail");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: ">", value: 39 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: ">", value: 40 }).status, "fail");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "==", value: 40 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "==", value: 41 }).status, "fail");
});

test("outDuration: == は許容誤差(±0.05s)内なら pass(算出尺の float 誤差対策)", () => {
  // 出力尺は timeline から算出された float なので、厳密一致 === では実質通らない。
  // 微小なズレ(誤差内)は一致とみなし、誤差を超えたら fail する
  const proj = baseProj({ summary: { ...baseProj().summary, outDurationSec: 40.02 } });
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "==", value: 40 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "==", value: 40.05 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "outDuration", op: "==", value: 40.2 }).status, "fail");
});

test("keepCount: == は整数の厳密一致(許容誤差の影響を受けない)", () => {
  const proj = baseProj({ summary: { ...baseProj().summary, keepCount: 3 } });
  assert.equal(outcomeOf(proj, { type: "keepCount", op: "==", value: 3 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "keepCount", op: "==", value: 4 }).status, "fail");
});

test("outDuration: short 指定でそのショートの outDurationSec を見る(本編は無視)", () => {
  const proj = baseProj({
    summary: { ...baseProj().summary, outDurationSec: 999 },
    shorts: [
      {
        name: "intro",
        profile: "vertical",
        approved: false,
        ranges: [{ start: 0, end: 30 }],
        mergedRanges: [],
        outDurationSec: 30,
      },
    ],
  });
  assert.equal(
    outcomeOf(proj, { type: "outDuration", op: "<=", value: 60, short: "intro" }).status,
    "pass",
  );
  assert.equal(
    outcomeOf(proj, { type: "outDuration", op: "<=", value: 10, short: "intro" }).status,
    "fail",
  );
});

test("outDuration: 存在しない short 名は error", () => {
  const proj = baseProj();
  const o = outcomeOf(proj, { type: "outDuration", op: "<=", value: 60, short: "nope" });
  assert.equal(o.status, "error");
  assert.match(o.message, /nope/);
});

/* ---------------- keepCount ---------------- */

test("keepCount: summary.keepCount と比較される", () => {
  const proj = baseProj({ summary: { ...baseProj().summary, keepCount: 3 } });
  assert.equal(outcomeOf(proj, { type: "keepCount", op: ">=", value: 3 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "keepCount", op: ">=", value: 4 }).status, "fail");
});

/* ---------------- captionVisible / captionText(ref 解決) ---------------- */

test("captionVisible: ref 解決成功で visible の一致を見る", () => {
  const proj = baseProj({
    captions: [mkCaption({ id: "cap_aaaaaa", visible: true }), mkCaption({ id: "cap_bbbbbb", visible: false })],
  });
  assert.equal(outcomeOf(proj, { type: "captionVisible", ref: "@cap_aaaaaa" }).status, "pass");
  assert.equal(
    outcomeOf(proj, { type: "captionVisible", ref: "@cap_aaaaaa", visible: false }).status,
    "fail",
  );
  assert.equal(outcomeOf(proj, { type: "captionVisible", ref: "cap_bbbbbb", visible: false }).status, "pass");
});

test("captionVisible: ref 未解決(id 採番済みプロジェクトで存在しない id)は error", () => {
  const proj = baseProj({ captions: [mkCaption({ id: "cap_aaaaaa" })] });
  const o = outcomeOf(proj, { type: "captionVisible", ref: "@cap_zzzzzz" });
  assert.equal(o.status, "error");
  assert.match(o.message, /見つかりません/);
});

test("captionVisible: id が1つも採番されていないプロジェクトは id-stamp を促す error", () => {
  const proj = baseProj({ captions: [mkCaption({})] }); // id 無し
  const o = outcomeOf(proj, { type: "captionVisible", ref: "@cap_zzzzzz" });
  assert.equal(o.status, "error");
  assert.match(o.message, /id-stamp/);
});

test("captionText: contains / equals の部分一致・完全一致", () => {
  const proj = baseProj({ captions: [mkCaption({ id: "cap_aaaaaa", text: "これはテストです" })] });
  assert.equal(
    outcomeOf(proj, { type: "captionText", ref: "@cap_aaaaaa", contains: "テスト" }).status,
    "pass",
  );
  assert.equal(
    outcomeOf(proj, { type: "captionText", ref: "@cap_aaaaaa", contains: "存在しない" }).status,
    "fail",
  );
  assert.equal(
    outcomeOf(proj, { type: "captionText", ref: "@cap_aaaaaa", equals: "これはテストです" }).status,
    "pass",
  );
  assert.equal(
    outcomeOf(proj, { type: "captionText", ref: "@cap_aaaaaa", equals: "違う" }).status,
    "fail",
  );
});

test("captionText: contains も equals も無いと error", () => {
  const proj = baseProj({ captions: [mkCaption({ id: "cap_aaaaaa" })] });
  const o = outcomeOf(proj, { type: "captionText", ref: "@cap_aaaaaa" });
  assert.equal(o.status, "error");
});

/* ---------------- timeKept ---------------- */

test("timeKept: keep 内は pass(既定 kept=true)", () => {
  const proj = baseProj({ keeps: [{ index: 0, start: 10, end: 20, durationSec: 10, outStart: 0, outEnd: 10 }] });
  assert.equal(outcomeOf(proj, { type: "timeKept", at: 15 }).status, "pass");
});

test("timeKept: カット内(keeps のどれにも含まれない)は既定 kept=true に反するので fail", () => {
  const proj = baseProj({ keeps: [{ index: 0, start: 10, end: 20, durationSec: 10, outStart: 0, outEnd: 10 }] });
  assert.equal(outcomeOf(proj, { type: "timeKept", at: 5 }).status, "fail");
  // kept:false を明示すればカット内が期待どおりで pass
  assert.equal(outcomeOf(proj, { type: "timeKept", at: 5, kept: false }).status, "pass");
});

test("timeKept: at が収録尺外は error", () => {
  const proj = baseProj({ source: { ...baseProj().source, durationSec: 50 } });
  assert.equal(outcomeOf(proj, { type: "timeKept", at: 999 }).status, "error");
  assert.equal(outcomeOf(proj, { type: "timeKept", at: -1 }).status, "error");
});

/* ---------------- materialExists ---------------- */

test("materialExists: exists true/false をそのまま pass/fail に写す", () => {
  const proj = baseProj({
    overlays: {
      ...baseProj().overlays,
      materials: [mkMaterial({ id: "mat_aaaaaa", exists: true }), mkMaterial({ id: "mat_bbbbbb", exists: false })],
    },
  });
  assert.equal(outcomeOf(proj, { type: "materialExists", ref: "@mat_aaaaaa" }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "materialExists", ref: "@mat_bbbbbb" }).status, "fail");
});

test("materialExists: ref 未解決は error", () => {
  const proj = baseProj({
    overlays: { ...baseProj().overlays, materials: [mkMaterial({ id: "mat_aaaaaa" })] },
  });
  assert.equal(outcomeOf(proj, { type: "materialExists", ref: "@mat_zzzzzz" }).status, "error");
});

/* ---------------- noCaptionOverlap ---------------- */

test("noCaptionOverlap: 同一トラックで重なりがあれば fail", () => {
  const proj = baseProj({
    captions: [
      mkCaption({ track: 1, out: [{ start: 0, end: 5 }] }),
      mkCaption({ track: 1, out: [{ start: 3, end: 8 }] }),
    ],
  });
  const o = outcomeOf(proj, { type: "noCaptionOverlap" });
  assert.equal(o.status, "fail");
});

test("noCaptionOverlap: 重なりが無ければ pass", () => {
  const proj = baseProj({
    captions: [
      mkCaption({ track: 1, out: [{ start: 0, end: 5 }] }),
      mkCaption({ track: 1, out: [{ start: 5, end: 8 }] }),
    ],
  });
  assert.equal(outcomeOf(proj, { type: "noCaptionOverlap" }).status, "pass");
});

test("noCaptionOverlap: track 指定でその他トラックの重なりは無視される", () => {
  const proj = baseProj({
    captions: [
      mkCaption({ track: 1, out: [{ start: 0, end: 5 }] }),
      mkCaption({ track: 2, out: [{ start: 0, end: 5 }] }),
      mkCaption({ track: 2, out: [{ start: 3, end: 8 }] }),
    ],
  });
  assert.equal(outcomeOf(proj, { type: "noCaptionOverlap", track: 1 }).status, "pass");
  assert.equal(outcomeOf(proj, { type: "noCaptionOverlap", track: 2 }).status, "fail");
  // track 省略時は全トラックを見るので track2 の重なりを拾って fail
  assert.equal(outcomeOf(proj, { type: "noCaptionOverlap" }).status, "fail");
});

/* ---------------- Tier 2(screenText/regionClear)は常に skip ---------------- */

test("screenText / regionClear は evaluateStructural では常に skip(--visual が必要)", () => {
  const proj = baseProj();
  assert.equal(
    outcomeOf(proj, { type: "screenText", at: 10, contains: "npm run build" }).status,
    "skip",
  );
  assert.equal(outcomeOf(proj, { type: "regionClear", ref: "@bl_aaaaaa" }).status, "skip");
});

/* ---------------- index / label の一貫性 ---------------- */

test("複数件のアサーションで index が assertions[] の添字と一致する", () => {
  const proj = baseProj({ summary: { ...baseProj().summary, keepCount: 3 } });
  const outcomes = evaluateStructural(
    proj,
    spec([
      { type: "keepCount", op: ">=", value: 3 },
      { label: "本編は5分以内", type: "outDuration", op: "<=", value: 300 },
    ]),
  );
  assert.equal(outcomes[0].index, 0);
  assert.equal(outcomes[1].index, 1);
  assert.equal(outcomes[1].label, "本編は5分以内");
});

/* ==================================================================== */
/* evaluateVisual(Tier 2・タスク4)。OcrResult を手組みで固定する。          */
/* ocrByTime のキーは assertions[] の添字(index)。                        */
/* ==================================================================== */

test("screenText: present(既定 true)× 含む/含まないの4通り", () => {
  const found = mkOcr({ text: "$ npm run build\nDone" });
  const notFound = mkOcr({ text: "$ ls -la" });

  // 含まれる & present:true(既定) → pass
  assert.equal(
    evaluateVisual(
      spec([{ type: "screenText", at: 10, contains: "npm run build" }]),
      new Map([[0, found]]),
      [],
    )[0].status,
    "pass",
  );
  // 含まれない & present:true(既定) → fail
  assert.equal(
    evaluateVisual(
      spec([{ type: "screenText", at: 10, contains: "npm run build" }]),
      new Map([[0, notFound]]),
      [],
    )[0].status,
    "fail",
  );
  // 含まれる & present:false → fail(見つかってはいけない)
  assert.equal(
    evaluateVisual(
      spec([{ type: "screenText", at: 10, contains: "npm run build", present: false }]),
      new Map([[0, found]]),
      [],
    )[0].status,
    "fail",
  );
  // 含まれない & present:false → pass
  assert.equal(
    evaluateVisual(
      spec([{ type: "screenText", at: 10, contains: "npm run build", present: false }]),
      new Map([[0, notFound]]),
      [],
    )[0].status,
    "pass",
  );
});

test("regionClear: blur の rect に OCR の box が交差すれば fail(目隠しできていない)", () => {
  const blurs = [mkBlur({ id: "bl_aaaaaa", rect: { x: 100, y: 100, w: 200, h: 100 } })];
  const ocr = mkOcr({
    text: "sk-secret",
    lines: [{ text: "sk-secret", confidence: 0.9, box: { x: 150, y: 120, w: 80, h: 20 } }],
  });
  const outcomes = evaluateVisual(
    spec([{ type: "regionClear", ref: "@bl_aaaaaa" }]),
    new Map([[0, ocr]]),
    blurs,
  );
  assert.equal(outcomes[0].status, "fail");
});

test("regionClear: 交差しなければ pass(目隠しできている)", () => {
  const blurs = [mkBlur({ id: "bl_aaaaaa", rect: { x: 100, y: 100, w: 200, h: 100 } })];
  const ocr = mkOcr({
    text: "hello",
    lines: [{ text: "hello", confidence: 0.9, box: { x: 500, y: 500, w: 80, h: 20 } }],
  });
  const outcomes = evaluateVisual(
    spec([{ type: "regionClear", ref: "@bl_aaaaaa" }]),
    new Map([[0, ocr]]),
    blurs,
  );
  assert.equal(outcomes[0].status, "pass");
});

test("regionClear: ref が blurs[] に無ければ error", () => {
  const blurs = [mkBlur({ id: "bl_aaaaaa" })];
  const outcomes = evaluateVisual(
    spec([{ type: "regionClear", ref: "@bl_zzzzzz" }]),
    new Map([[0, mkOcr()]]),
    blurs,
  );
  assert.equal(outcomes[0].status, "error");
});

test("evaluateVisual: ocrByTime に null(非対応環境)が入っていれば skip", () => {
  const outcomes = evaluateVisual(
    spec([{ type: "screenText", at: 10, contains: "x" }]),
    new Map([[0, null]]),
    [],
  );
  assert.equal(outcomes[0].status, "skip");
});

test("evaluateVisual: ocrByTime に該当 index が無ければ error(内部矛盾)", () => {
  const outcomes = evaluateVisual(
    spec([{ type: "screenText", at: 10, contains: "x" }]),
    new Map(),
    [],
  );
  assert.equal(outcomes[0].status, "error");
});

test("evaluateVisual: Tier 1 のアサーションは無視される(混在 spec で Tier2 の分だけ返る)", () => {
  const outcomes = evaluateVisual(
    spec([
      { type: "keepCount", op: ">=", value: 1 },
      { type: "screenText", at: 10, contains: "x" },
    ]),
    new Map([[1, mkOcr({ text: "x" })]]),
    [],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].index, 1);
  assert.equal(outcomes[0].status, "pass");
});

/* ==================================================================== */
/* fs ラッパー assert(dir)(タスク2)。tmp フォルダに実データを書いて検証   */
/* ==================================================================== */

async function withTmpDir(
  build: (dir: string) => void,
  run: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-assert-fs-"));
  try {
    build(dir);
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fs版 assert: assertions.json が無ければ空レポート(counts 全ゼロ)", async () => {
  await withTmpDir(buildRichFixture, async (dir) => {
    const report = await assertProject(dir);
    assert.deepEqual(report.outcomes, []);
    assert.deepEqual(report.counts, { pass: 0, fail: 0, skip: 0, error: 0 });
  });
});

// buildRichFixture の keep 集合: 0–40 / 50–150 / 160–200(keepCount=3)。
// insert(材料あり)が1件(at:100, durationSec:5)あるため
// outDurationSec = (40+100+40) + 5 = 185
test("fs版 assert: 値ベースのアサーション(outDuration/keepCount)を describeJson 経由で評価する", async () => {
  await withTmpDir(buildRichFixture, async (dir) => {
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify({
        schemaVersion: 1,
        assertions: [
          { label: "185秒ちょうど", type: "outDuration", op: "==", value: 185 },
          { label: "60秒以内(意図的にfail)", type: "outDuration", op: "<=", value: 60 },
          { type: "keepCount", op: ">=", value: 3 },
        ],
      } satisfies AssertionsDoc),
    );
    const report = await assertProject(dir);
    assert.equal(report.outcomes.length, 3);
    assert.equal(report.outcomes[0].status, "pass");
    assert.equal(report.outcomes[1].status, "fail");
    assert.equal(report.outcomes[2].status, "pass");
    assert.deepEqual(report.counts, { pass: 2, fail: 1, skip: 0, error: 0 });
  });
});

test("fs版 assert: id-stamp 未実行のプロジェクトで ref 系アサーションは error(fail ではない)", async () => {
  await withTmpDir(buildRichFixture, async (dir) => {
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify({
        schemaVersion: 1,
        assertions: [{ type: "captionVisible", ref: "@cap_zzzzzz" }],
      } satisfies AssertionsDoc),
    );
    const report = await assertProject(dir);
    assert.equal(report.outcomes[0].status, "error");
    assert.match(report.outcomes[0].message, /id-stamp/);
    assert.deepEqual(report.counts, { pass: 0, fail: 0, skip: 0, error: 1 });
  });
});

test("fs版 assert: Tier 2(screenText/regionClear)は既定(--visual 無し)で skip", async () => {
  await withTmpDir(buildRichFixture, async (dir) => {
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify({
        schemaVersion: 1,
        assertions: [{ type: "screenText", at: 10, contains: "npm run build" }],
      } satisfies AssertionsDoc),
    );
    const report = await assertProject(dir);
    assert.equal(report.outcomes[0].status, "skip");
    assert.deepEqual(report.counts, { pass: 0, fail: 0, skip: 1, error: 0 });
  });
});

test("fs版 assert: --visual を付けなければ frames/OCR 経路を一切呼ばない(全環境で回る)", async () => {
  // buildRichFixture は実動画ファイルを置かない(materials/insert.mp4 は
  // fake 内容の placeholder)。--visual を付けた場合に screenStill(ffmpeg)を
  // 呼べば確実に失敗するはずの状況で、既定(--visual 無し)なら Tier 2 は
  // skip のまま例外も投げずに完走することを確認する
  await withTmpDir(buildRichFixture, async (dir) => {
    writeFileSync(
      join(dir, "assertions.json"),
      JSON.stringify({
        schemaVersion: 1,
        assertions: [{ type: "regionClear", ref: "@bl_zzzzzz" }],
      } satisfies AssertionsDoc),
    );
    const report = await assertProject(dir, { visual: false });
    assert.equal(report.outcomes[0].status, "skip");
    assert.deepEqual(report.counts, { pass: 0, fail: 0, skip: 1, error: 0 });
  });
});
