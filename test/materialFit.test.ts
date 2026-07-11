// lib/materialFit.ts(M2 尺整合 + M3 dangling/unused)の純関数群を固定する。
// fs/ffprobe/LLM には一切依存しない。§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFitPatch,
  classifyReferences,
  detectFit,
  nameSimilarity,
} from "../src/lib/materialFit.ts";
import type { MaterialFitCfg } from "../src/lib/materialFit.ts";
import type { MaterialEntry, MaterialsIndex } from "../src/lib/materials.ts";

const DEFAULT_CFG: MaterialFitCfg = {
  overrunEpsSec: 0.1,
  underrunRatio: 2.0,
  suggestUnderrunExtend: false,
  maxReplacements: 3,
};

function makeIndex(materials: MaterialEntry[]): MaterialsIndex {
  return { schemaVersion: 1, capturedAt: "2026-07-11T00:00:00.000Z", materials };
}

/* ---------------- detectFit ---------------- */

test("detectFit: insert の尺超過は durationSec を実尺いっぱいに詰める set を出す", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 5, hasAudio: true },
      references: [{ as: "insert", id: "ins_a1b2c3", at: 10, durationSec: 8 }],
      used: true,
    },
  ]);
  const findings = detectFit(index, DEFAULT_CFG);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "overrun");
  assert.deepEqual(findings[0].suggestion, {
    op: "set",
    target: "@ins_a1b2c3",
    field: "durationSec",
    value: 5,
  });
});

test("detectFit: overlay の尺超過は end を実尺いっぱいに詰める set を出す", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 5, hasAudio: false },
      references: [{ as: "overlay", id: "mat_a1b2c3", start: 20, end: 30 }],
      used: true,
    },
  ]);
  const findings = detectFit(index, DEFAULT_CFG);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "overrun");
  assert.deepEqual(findings[0].suggestion, {
    op: "set",
    target: "@mat_a1b2c3",
    field: "end",
    value: 25,
  });
});

test("detectFit: startFrom を考慮した overrun 判定(頭出し込みで実尺超過)", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 10, hasAudio: false },
      references: [{ as: "insert", id: "ins_x1x1x1", at: 0, durationSec: 6, startFrom: 8 }],
      used: true,
    },
  ]);
  const findings = detectFit(index, DEFAULT_CFG);
  assert.equal(findings.length, 1);
  // 8(startFrom) + 6(declared) = 14 > 10(実尺) → 実尺-startFrom = 2 に詰める
  assert.deepEqual(findings[0].suggestion, {
    op: "set",
    target: "@ins_x1x1x1",
    field: "durationSec",
    value: 2,
  });
});

test("detectFit: eps 内の差は不整合なし", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 5.05, hasAudio: false },
      references: [{ as: "insert", id: "ins_e1e1e1", at: 0, durationSec: 5 }],
      used: true,
    },
  ]);
  assert.deepEqual(detectFit(index, DEFAULT_CFG), []);
});

test("detectFit: underrun は既定で suggestion を出さず reason のみ", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 20, hasAudio: false },
      references: [{ as: "overlay", id: "mat_u1u1u1", start: 0, end: 2 }],
      used: true,
    },
  ]);
  const findings = detectFit(index, DEFAULT_CFG);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "underrun");
  assert.equal("suggestion" in findings[0], false);
  assert.ok(findings[0].reason.length > 0);
});

test("detectFit: suggestUnderrunExtend:true なら underrun にも延長 set を出す", () => {
  const cfg: MaterialFitCfg = { ...DEFAULT_CFG, suggestUnderrunExtend: true };
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 20, hasAudio: false },
      references: [{ as: "overlay", id: "mat_u2u2u2", start: 0, end: 2 }],
      used: true,
    },
  ]);
  const findings = detectFit(index, cfg);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].suggestion, {
    op: "set",
    target: "@mat_u2u2u2",
    field: "end",
    value: 20,
  });
});

test("detectFit: 画像素材(probe.durationSec 無し)は除外", () => {
  const index = makeIndex([
    {
      file: "materials/slide.png",
      present: true,
      kind: "image",
      probe: { hasAudio: false, width: 1920, height: 1080 },
      references: [{ as: "overlay", id: "mat_img0001", start: 0, end: 100 }],
      used: true,
    },
  ]);
  assert.deepEqual(detectFit(index, DEFAULT_CFG), []);
});

test("detectFit: @id の無い参照は除外(id-stamp 前提チェックは呼び出し側の責務)", () => {
  const index = makeIndex([
    {
      file: "materials/clip.mp4",
      present: true,
      kind: "video",
      probe: { durationSec: 5, hasAudio: false },
      references: [{ as: "insert", at: 10, durationSec: 8 }],
      used: true,
    },
  ]);
  assert.deepEqual(detectFit(index, DEFAULT_CFG), []);
});

test("detectFit: bgm 参照は対象外", () => {
  const index = makeIndex([
    {
      file: "materials/theme.mp3",
      present: true,
      kind: "audio",
      probe: { durationSec: 5, hasAudio: true },
      references: [{ as: "bgm", id: "bg_b1b1b1", start: 0, end: 30 }],
      used: true,
    },
  ]);
  assert.deepEqual(detectFit(index, DEFAULT_CFG), []);
});

/* ---------------- classifyReferences ---------------- */

test("classifyReferences: dangling(used&&!present)と unused(!used&&present)を仕分ける", () => {
  const index = makeIndex([
    {
      file: "materials/ghost.mp4",
      present: false,
      kind: "video",
      references: [{ as: "overlay", id: "mat_g1g1g1", start: 0, end: 4 }],
      used: true,
    },
    {
      file: "materials/spare.mp4",
      present: true,
      kind: "video",
      references: [],
      used: false,
    },
  ]);
  const { dangling, unused } = classifyReferences(index, DEFAULT_CFG);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].file, "materials/ghost.mp4");
  assert.equal(unused.length, 1);
  assert.equal(unused[0].file, "materials/spare.mp4");
});

test("classifyReferences: kind unknown は unused から除外", () => {
  const index = makeIndex([
    { file: "materials/.DS_Store", present: true, kind: "unknown", references: [], used: false },
  ]);
  const { unused } = classifyReferences(index, DEFAULT_CFG);
  assert.deepEqual(unused, []);
});

test("classifyReferences: dangling の @id 付き参照は removeOps に、id 無しは含めない", () => {
  const index = makeIndex([
    {
      file: "materials/ghost.mp4",
      present: false,
      kind: "video",
      references: [
        { as: "overlay", id: "mat_r1r1r1", start: 0, end: 4 },
        { as: "insert", at: 10, durationSec: 3 },
      ],
      used: true,
    },
  ]);
  const { dangling } = classifyReferences(index, DEFAULT_CFG);
  assert.equal(dangling[0].refs.length, 2);
  assert.deepEqual(dangling[0].removeOps, [{ op: "remove", target: "@mat_r1r1r1" }]);
});

test("classifyReferences: replacements は present&!used から名前類似の上位 maxReplacements 件", () => {
  const index = makeIndex([
    {
      file: "materials/demo.mp4",
      present: false,
      kind: "video",
      references: [{ as: "overlay", id: "mat_d1d1d1", start: 0, end: 4 }],
      used: true,
    },
    { file: "materials/demo-v2.mp4", present: true, kind: "video", references: [], used: false },
    { file: "materials/intro.png", present: true, kind: "image", references: [], used: false },
  ]);
  const { dangling } = classifyReferences(index, { ...DEFAULT_CFG, maxReplacements: 1 });
  assert.deepEqual(dangling[0].replacements, ["materials/demo-v2.mp4"]);
});

/* ---------------- nameSimilarity ---------------- */

test("nameSimilarity: demo.mp4 は demo-v2.mp4 の方が intro.png より近い", () => {
  const closer = nameSimilarity("materials/demo.mp4", "materials/demo-v2.mp4");
  const farther = nameSimilarity("materials/demo.mp4", "materials/intro.png");
  assert.ok(closer > farther, `${closer} should be > ${farther}`);
});

test("nameSimilarity: 決定論(同じ入力は同じ出力)", () => {
  const a = nameSimilarity("materials/foo.mp4", "materials/bar.mp4");
  const b = nameSimilarity("materials/foo.mp4", "materials/bar.mp4");
  assert.equal(a, b);
});

test("nameSimilarity: 完全一致は1", () => {
  assert.equal(nameSimilarity("materials/a/demo.mp4", "materials/b/demo.mov"), 1);
});

/* ---------------- buildFitPatch ---------------- */

test("buildFitPatch: suggestion の無い underrun finding は ops に混ざらない", () => {
  const patch = buildFitPatch(
    [
      {
        refId: "mat_u1u1u1",
        as: "overlay",
        file: "materials/clip.mp4",
        kind: "underrun",
        materialDurationSec: 20,
        declaredSec: 2,
        startFrom: 0,
        reason: "大半が未使用です",
      },
    ],
    [],
  );
  assert.deepEqual(patch.ops, []);
});

test("buildFitPatch: overrun の suggestion(set)と dangling の removeOps(remove)を束ねる", () => {
  const patch = buildFitPatch(
    [
      {
        refId: "ins_a1b2c3",
        as: "insert",
        file: "materials/clip.mp4",
        kind: "overrun",
        materialDurationSec: 5,
        declaredSec: 8,
        startFrom: 0,
        suggestion: { op: "set", target: "@ins_a1b2c3", field: "durationSec", value: 5 },
        reason: "尺超過",
      },
    ],
    [
      {
        file: "materials/ghost.mp4",
        refs: [],
        replacements: [],
        removeOps: [{ op: "remove", target: "@mat_g1g1g1" }],
      },
    ],
  );
  assert.deepEqual(patch.ops, [
    { op: "set", target: "@ins_a1b2c3", field: "durationSec", value: 5 },
    { op: "remove", target: "@mat_g1g1g1" },
  ]);
});
