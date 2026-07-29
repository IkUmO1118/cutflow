// stages/framesServe.ts — 常駐フレームサーバの純関数を固定する。
// HTTP/engine セッション依存(実サーバ往復)は unit しにくいので bench
// での手動検証に回し(docs/plans/2026-07-07-frames-server-design.md 課題2)、
// ここでは body → FrameRequest+opts のパース/検査だけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFramesServeBody,
} from "../src/stages/framesServe.ts";

/* ---------------- parseFramesServeBody ---------------- */

test("parseFramesServeBody: times モード(axis 省略時は source)", () => {
  const { req, opts } = parseFramesServeBody({ mode: "times", times: [90, 120] });
  assert.deepEqual(req, { mode: "times", times: [90, 120], axis: "source" });
  assert.deepEqual(opts, { short: undefined, ocr: false, fullRes: false });
});

test("parseFramesServeBody: times モード(axis: output・short/ocr/fullRes 込み)", () => {
  const { req, opts } = parseFramesServeBody({
    mode: "times",
    times: [10],
    axis: "output",
    short: "intro",
    ocr: true,
    fullRes: true,
  });
  assert.deepEqual(req, { mode: "times", times: [10], axis: "output" });
  assert.deepEqual(opts, { short: "intro", ocr: true, fullRes: true });
});

test("parseFramesServeBody: short: null は opts.short = undefined になる", () => {
  const { opts } = parseFramesServeBody({ mode: "times", times: [1], short: null });
  assert.equal(opts.short, undefined);
});

test("parseFramesServeBody: captions モードは times/axis を無視する", () => {
  const { req } = parseFramesServeBody({ mode: "captions" });
  assert.deepEqual(req, { mode: "captions" });
});

test("parseFramesServeBody: every モード(正の stepSec)", () => {
  const { req } = parseFramesServeBody({ mode: "every", stepSec: 10 });
  assert.deepEqual(req, { mode: "every", stepSec: 10 });
});

test("parseFramesServeBody: every モードで stepSec が0以下はエラー", () => {
  assert.throws(() => parseFramesServeBody({ mode: "every", stepSec: 0 }), /stepSec/);
  assert.throws(() => parseFramesServeBody({ mode: "every", stepSec: -1 }), /stepSec/);
  assert.throws(() => parseFramesServeBody({ mode: "every" }), /stepSec/);
});

test("parseFramesServeBody: times モードで times が配列でない/数値以外を含むとエラー", () => {
  assert.throws(() => parseFramesServeBody({ mode: "times" }), /times/);
  assert.throws(() => parseFramesServeBody({ mode: "times", times: "90" }), /times/);
  assert.throws(() => parseFramesServeBody({ mode: "times", times: [90, "x"] }), /times/);
});

test("parseFramesServeBody: axis が source/output 以外はエラー", () => {
  assert.throws(
    () => parseFramesServeBody({ mode: "times", times: [1], axis: "bogus" }),
    /axis/,
  );
});

test("parseFramesServeBody: mode が不正・欠落はエラー", () => {
  assert.throws(() => parseFramesServeBody({ mode: "bogus" }), /mode/);
  assert.throws(() => parseFramesServeBody({}), /mode/);
});

test("parseFramesServeBody: body が非オブジェクト(null/配列/プリミティブ)はエラー", () => {
  assert.throws(() => parseFramesServeBody(null), /オブジェクト/);
  assert.throws(() => parseFramesServeBody("hi"), /オブジェクト/);
  assert.throws(() => parseFramesServeBody(42), /オブジェクト/);
});
