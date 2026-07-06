// lib/framesIndex.ts — 撮影入力フィンガープリントの純関数を固定する。
// stale-PNG 対策(frames を経由せず古い PNG を Read してしまう事故)の核。
// fs 依存(framesFreshness/writeFramesIndex)は bench での手動検証に回し
// (docs/plans/2026-07-07-frames-server-design.md 課題1参照)、ここでは
// 純関数(relevantInputs/hashContent/diffFingerprint)だけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffFingerprint,
  hashContent,
  relevantInputs,
} from "../src/lib/framesIndex.ts";

/* ---------------- relevantInputs ---------------- */

test("relevantInputs: 本編経路(shortName省略)は cutplan/transcript/overlays", () => {
  assert.deepEqual(relevantInputs(), [
    "cutplan.json",
    "transcript.json",
    "overlays.json",
  ]);
});

test("relevantInputs: ショート経路(shortName指定)は shorts/transcript/overlays", () => {
  assert.deepEqual(relevantInputs("intro"), [
    "shorts.json",
    "transcript.json",
    "overlays.json",
  ]);
  // ショート名の中身自体はファイル集合に影響しない(shorts.json 全体を見る)
  assert.deepEqual(relevantInputs("outro"), relevantInputs("intro"));
});

/* ---------------- hashContent ---------------- */

test("hashContent: 決定論的(同じ内容→同じハッシュ)", () => {
  const a = hashContent('{"segments":[]}');
  const b = hashContent('{"segments":[]}');
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("hashContent: 内容が変われば別ハッシュ", () => {
  const a = hashContent('{"segments":[]}');
  const b = hashContent('{"segments":[1]}');
  assert.notEqual(a, b);
});

/* ---------------- diffFingerprint ---------------- */

test("diffFingerprint: 全一致なら changed は空", () => {
  const recorded = { "cutplan.json": "sha256:aaa", "transcript.json": "sha256:bbb" };
  const current = { "cutplan.json": "sha256:aaa", "transcript.json": "sha256:bbb" };
  assert.deepEqual(diffFingerprint(recorded, current), []);
});

test("diffFingerprint: 1件だけ内容が変わればそのファイル名だけ返る", () => {
  const recorded = { "cutplan.json": "sha256:aaa", "transcript.json": "sha256:bbb" };
  const current = { "cutplan.json": "sha256:aaa", "transcript.json": "sha256:ccc" };
  assert.deepEqual(diffFingerprint(recorded, current), ["transcript.json"]);
});

test("diffFingerprint: current 側にキーが無い(欠落)ファイルも変化に数える", () => {
  const recorded = { "cutplan.json": "sha256:aaa", "overlays.json": "sha256:ddd" };
  const current = { "cutplan.json": "sha256:aaa" }; // overlays.json が current に無い
  assert.deepEqual(diffFingerprint(recorded, current), ["overlays.json"]);
});

test("diffFingerprint: 複数変化はすべて列挙される", () => {
  const recorded = {
    "cutplan.json": "sha256:aaa",
    "transcript.json": "sha256:bbb",
    "overlays.json": "sha256:ccc",
  };
  const current = {
    "cutplan.json": "sha256:xxx",
    "transcript.json": "sha256:bbb",
    "overlays.json": "sha256:yyy",
  };
  assert.deepEqual(diffFingerprint(recorded, current), ["cutplan.json", "overlays.json"]);
});
