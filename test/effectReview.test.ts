import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectWarningsToObservation,
  effectWarningsToReviewPatches,
} from "../src/lib/effectReview.ts";
import type { EffectWarning } from "../src/lib/effectCheck.ts";

test("effectWarningsToReviewPatches: blur-zoom-overlap は blur bucket へ", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 10,
      endSec: 12,
      message: "blur(bl_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
    },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].kind, "blur");
  assert.equal(patches[0].startSec, 10);
  assert.equal(patches[0].endSec, 12);
  assert.deepEqual(patches[0].warnings, [warnings[0].message]);
  assert.deepEqual(patches[0].checkPoints, ["覆えているか"]);
  assert.equal(patches[0].fixRef, undefined);
});

test("effectWarningsToReviewPatches: annotation-zoom-overlap は annotation bucket へ", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "annotation-zoom-overlap",
      refId: "ann_aaaaaa",
      startSec: 5,
      endSec: 7,
      message: "annotation(ann_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
    },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches[0].kind, "annotation");
  assert.deepEqual(patches[0].checkPoints, ["指す先が合うか"]);
});

test("effectWarningsToReviewPatches: annotation-too-long は annotation bucket へ", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "annotation-too-long",
      refId: "ann_cccccc",
      startSec: 0,
      endSec: 9,
      message: "annotation(ann_cccccc)の表示尺(9.0s)が上限(8s)を超えています",
    },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches[0].kind, "annotation");
});

test("effectWarningsToReviewPatches: vlm-mismatch は message の VLM(kind) から bucket を決める", () => {
  const warnings: EffectWarning[] = [
    { kind: "vlm-mismatch", refId: "zm_aaaaaa", startSec: 1, endSec: 1, message: "VLM(zoom zm_aaaaaa): 対象がズレている" },
    { kind: "vlm-mismatch", refId: "bl_aaaaaa", startSec: 1, endSec: 1, message: "VLM(blur bl_aaaaaa): 隠せていない" },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].kind, "zoom");
  assert.deepEqual(patches[0].checkPoints, ["見せたい所が中心か"]);
  assert.equal(patches[1].kind, "blur");
});

test("effectWarningsToReviewPatches: density(窓全体)は bucket が定まらず patch を作らない", () => {
  const warnings: EffectWarning[] = [
    { kind: "density", startSec: 0, endSec: 5, message: "5秒の窓に演出が4件詰まっています(上限3件)" },
  ];
  assert.deepEqual(effectWarningsToReviewPatches(warnings), []);
});

test("effectWarningsToReviewPatches: caption-overlap は相手が素材のとき patch を作らない", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "caption-overlap",
      refId: "cap_aaaaaa",
      startSec: 3,
      endSec: 4,
      message: "テロップ(cap_aaaaaa)が 素材(ov_aaaaaa) と重なっています(重なり率50%)",
    },
  ];
  assert.deepEqual(effectWarningsToReviewPatches(warnings), []);
});

test("effectWarningsToReviewPatches: caption-overlap で相手が blur/annotation ならそちらの bucket へ", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "caption-overlap",
      refId: "cap_aaaaaa",
      startSec: 3,
      endSec: 4,
      message: "テロップ(cap_aaaaaa)が blur(bl_aaaaaa) と重なっています(重なり率50%)",
    },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches[0].kind, "blur");
});

test("effectWarningsToReviewPatches: suggestions があるとき fixRef が立つ", () => {
  const warnings: EffectWarning[] = [
    {
      kind: "blur-zoom-overlap",
      refId: "bl_aaaaaa",
      startSec: 10,
      endSec: 12,
      message: "blur(bl_aaaaaa)が zoom(zm_bbbbbb)と時間が重なっています。",
      suggestions: [{ op: "set", target: "@bl_aaaaaa", field: "rect", value: { x: 0, y: 0, w: 10, h: 10 } }],
    },
  ];
  const patches = effectWarningsToReviewPatches(warnings);
  assert.equal(patches[0].fixRef, "effect-fix.suggested.json#@bl_aaaaaa");
});

test("effectWarningsToObservation: 警告0件は空文字(バイト等価)", () => {
  assert.equal(effectWarningsToObservation([]), "");
});

test("effectWarningsToObservation: 件数要約+観測調(命令調でない)", () => {
  const warnings: EffectWarning[] = [
    { kind: "blur-zoom-overlap", startSec: 0, endSec: 1, message: "a" },
    { kind: "blur-zoom-overlap", startSec: 0, endSec: 1, message: "b" },
    { kind: "density", startSec: 0, endSec: 5, message: "c" },
  ];
  const text = effectWarningsToObservation(warnings);
  assert.match(text, /3件/);
  assert.match(text, /ぼかし×ズーム重なり2件/);
  assert.match(text, /密度過多1件/);
  assert.match(text, /参考情報/);
  assert.doesNotMatch(text, /直せ/);
  assert.doesNotMatch(text, /修正してください/);
});
