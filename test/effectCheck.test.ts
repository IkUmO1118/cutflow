// lib/effectCheck.ts(E3 座標視覚検証 + E4 zoom 相互作用 + E5 密度ガード)の
// 純関数群を固定する。fs/LLM/VLM には一切依存しない。
// §docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEffectFixPatch,
  checkDensity,
  checkVisualOverlap,
  checkZoomInteraction,
  rectOverlapRatio,
  timeOverlaps,
} from "../src/lib/effectCheck.ts";
import type { CaptionRectInput, EffectCheckCfg, EffectWarning } from "../src/lib/effectCheck.ts";
import type { Overlays } from "../src/types.ts";

const CFG: EffectCheckCfg = {
  densityWindowSec: 5,
  maxPerWindow: 3,
  maxAnnotationSec: 8,
  minRectOverlapRatio: 0.3,
  useVlm: true,
};

/* ---------------- rectOverlapRatio / timeOverlaps ---------------- */

test("rectOverlapRatio: 完全に重なる同一矩形は1", () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(rectOverlapRatio(r, r), 1);
});

test("rectOverlapRatio: 重ならない矩形は0", () => {
  assert.equal(rectOverlapRatio({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, w: 10, h: 10 }), 0);
});

test("rectOverlapRatio: 小さい矩形が大きい矩形に完全包含されると1(小さい方基準)", () => {
  const big = { x: 0, y: 0, w: 200, h: 200 };
  const small = { x: 50, y: 50, w: 50, h: 50 };
  assert.equal(rectOverlapRatio(big, small), 1);
  assert.equal(rectOverlapRatio(small, big), 1);
});

test("rectOverlapRatio: 半分だけ重なる矩形は0.5前後", () => {
  const ratio = rectOverlapRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 });
  assert.ok(Math.abs(ratio - 0.5) < 1e-9);
});

test("timeOverlaps: 交差する区間は true", () => {
  assert.equal(timeOverlaps(0, 10, 5, 15), true);
});

test("timeOverlaps: 境界が接するだけは false(重なり扱いしない)", () => {
  assert.equal(timeOverlaps(0, 10, 10, 20), false);
});

test("timeOverlaps: 離れた区間は false", () => {
  assert.equal(timeOverlaps(0, 10, 20, 30), false);
});

/* ---------------- checkZoomInteraction ---------------- */

test("checkZoomInteraction: zoom と重ならない blur/annotation は警告なし", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    blurs: [{ id: "bl_aaaaaa", start: 20, end: 25, rect: { x: 0, y: 0, w: 100, h: 100 } }],
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 30, end: 35, rect: { x: 0, y: 0, w: 100, h: 100 } }],
  };
  assert.deepEqual(checkZoomInteraction(overlays), []);
});

test("checkZoomInteraction: zoom.rect が blur.rect を包含すると widen(rect を zoom 領域へ)を提案", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    blurs: [{ id: "bl_aaaaaa", start: 2, end: 8, rect: { x: 100, y: 100, w: 100, h: 100 } }],
  };
  const warnings = checkZoomInteraction(overlays);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "blur-zoom-overlap");
  assert.equal(warnings[0].refId, "bl_aaaaaa");
  assert.deepEqual(warnings[0].suggestions, [
    { op: "set", target: "@bl_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 960, h: 540 } },
  ]);
});

test("checkZoomInteraction: zoom.rect が blur.rect を包含しないと zoom 終端の後ろへずらす提案", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 100, h: 100 } }],
    blurs: [{ id: "bl_aaaaaa", start: 2, end: 4, rect: { x: 500, y: 500, w: 50, h: 50 } }],
  };
  const warnings = checkZoomInteraction(overlays);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].suggestions, [
    { op: "set", target: "@bl_aaaaaa", field: "start", value: 10 },
    { op: "set", target: "@bl_aaaaaa", field: "end", value: 12 },
  ]);
});

test("checkZoomInteraction: annotation(box)も blur と同じ widen/shift 判定を受ける", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 2, end: 8, rect: { x: 10, y: 10, w: 50, h: 50 } }],
  };
  const warnings = checkZoomInteraction(overlays);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "annotation-zoom-overlap");
  assert.deepEqual(warnings[0].suggestions, [
    { op: "set", target: "@ann_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 960, h: 540 } },
  ]);
});

test("checkZoomInteraction: arrow(rect無し)は shift のみ提案する", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    annotations: [
      { id: "ann_aaaaaa", type: "arrow", start: 2, end: 8, from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
    ],
  };
  const warnings = checkZoomInteraction(overlays);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].suggestions, [
    { op: "set", target: "@ann_aaaaaa", field: "start", value: 10 },
    { op: "set", target: "@ann_aaaaaa", field: "end", value: 16 },
  ]);
});

test("checkZoomInteraction: id 未採番の要素は suggestions を出さない(警告のみ)", () => {
  const overlays: Overlays = {
    zooms: [{ start: 0, end: 10, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    blurs: [{ start: 2, end: 8, rect: { x: 100, y: 100, w: 100, h: 100 } }],
  };
  const warnings = checkZoomInteraction(overlays);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].suggestions, undefined);
});

/* ---------------- checkDensity ---------------- */

test("checkDensity: 窓内の演出本数が上限以下なら警告なし", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 } }],
    blurs: [{ id: "bl_aaaaaa", start: 3, end: 4, rect: { x: 0, y: 0, w: 10, h: 10 } }],
  };
  const warnings = checkDensity(overlays, [], CFG);
  assert.deepEqual(warnings, []);
});

test("checkDensity: 5秒窓に演出4本(上限3)が詰まると density 警告", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 1, rect: { x: 0, y: 0, w: 100, h: 100 } }],
    blurs: [
      { id: "bl_aaaaaa", start: 1, end: 2, rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "bl_bbbbbb", start: 2, end: 3, rect: { x: 0, y: 0, w: 10, h: 10 } },
    ],
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 3, end: 4, rect: { x: 0, y: 0, w: 10, h: 10 } }],
  };
  const warnings = checkDensity(overlays, [], CFG);
  assert.ok(warnings.some((w) => w.kind === "density"));
});

test("checkDensity: 見せ場(highlightSpans)内は同本数でも警告が抑制される", () => {
  const overlays: Overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 0, end: 1, rect: { x: 0, y: 0, w: 100, h: 100 } }],
    blurs: [
      { id: "bl_aaaaaa", start: 1, end: 2, rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "bl_bbbbbb", start: 2, end: 3, rect: { x: 0, y: 0, w: 10, h: 10 } },
    ],
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 3, end: 4, rect: { x: 0, y: 0, w: 10, h: 10 } }],
  };
  const warnings = checkDensity(overlays, [{ start: 0, end: 10 }], CFG);
  assert.ok(!warnings.some((w) => w.kind === "density"));
});

test("checkDensity: annotation の表示尺が上限を超えると annotation-too-long 警告+補正候補", () => {
  const overlays: Overlays = {
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 0, end: 20, rect: { x: 0, y: 0, w: 10, h: 10 } }],
  };
  const warnings = checkDensity(overlays, [], CFG);
  const w = warnings.find((x) => x.kind === "annotation-too-long");
  assert.ok(w);
  assert.deepEqual(w?.suggestions, [{ op: "set", target: "@ann_aaaaaa", field: "end", value: 8 }]);
});

test("checkDensity: annotation の表示尺が上限以下なら annotation-too-long は出ない", () => {
  const overlays: Overlays = {
    annotations: [{ id: "ann_aaaaaa", type: "box", start: 0, end: 5, rect: { x: 0, y: 0, w: 10, h: 10 } }],
  };
  const warnings = checkDensity(overlays, [], CFG);
  assert.ok(!warnings.some((w) => w.kind === "annotation-too-long"));
});

/* ---------------- checkVisualOverlap ---------------- */

test("checkVisualOverlap: caption pos の矩形が blur と時間・座標の両方で重なると caption-overlap 警告", () => {
  const overlays: Overlays = {
    blurs: [{ id: "bl_aaaaaa", start: 0, end: 10, rect: { x: 100, y: 100, w: 200, h: 100 } }],
  };
  const captionRects: CaptionRectInput[] = [
    { refId: "cap_aaaaaa", start: 2, end: 5, rect: { x: 150, y: 120, w: 100, h: 50 } },
  ];
  const warnings = checkVisualOverlap(overlays, captionRects, CFG);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "caption-overlap");
  assert.equal(warnings[0].refId, "cap_aaaaaa");
});

test("checkVisualOverlap: 時間が重ならなければ座標が重なっても警告なし", () => {
  const overlays: Overlays = {
    blurs: [{ id: "bl_aaaaaa", start: 0, end: 10, rect: { x: 100, y: 100, w: 200, h: 100 } }],
  };
  const captionRects: CaptionRectInput[] = [
    { refId: "cap_aaaaaa", start: 20, end: 25, rect: { x: 150, y: 120, w: 100, h: 50 } },
  ];
  assert.deepEqual(checkVisualOverlap(overlays, captionRects, CFG), []);
});

test("checkVisualOverlap: 重なり率が minRectOverlapRatio 未満なら警告なし", () => {
  const overlays: Overlays = {
    blurs: [{ id: "bl_aaaaaa", start: 0, end: 10, rect: { x: 0, y: 0, w: 1000, h: 1000 } }],
  };
  const captionRects: CaptionRectInput[] = [
    { refId: "cap_aaaaaa", start: 2, end: 5, rect: { x: 990, y: 990, w: 20, h: 20 } },
  ];
  assert.deepEqual(checkVisualOverlap(overlays, captionRects, CFG), []);
});

/* ---------------- buildEffectFixPatch ---------------- */

test("buildEffectFixPatch: suggestions を持つ警告だけが ops へ束ねられる", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 0,
      endSec: 1,
      message: "x",
      suggestions: [{ op: "set", target: "@bl_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 10, h: 10 } }],
    },
    { kind: "density", startSec: 0, endSec: 5, message: "y" },
  ];
  const patch = buildEffectFixPatch(warnings);
  assert.deepEqual(patch, {
    ops: [{ op: "set", target: "@bl_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 10, h: 10 } }],
  });
});

test("buildEffectFixPatch: suggestions が無ければ ops は空", () => {
  const warnings: EffectWarning[] = [{ kind: "density", startSec: 0, endSec: 5, message: "y" }];
  assert.deepEqual(buildEffectFixPatch(warnings), { ops: [] });
});
