// lib/framesClient.ts — frames CLI の常駐デーモン検出+リクエスト変換を固定する。
// ping/POST(ネットワーク依存)は bench での手動検証に回し(課題2 B3。
// docs/plans/2026-07-07-frames-server-design.md)、ここでは portfile の読み
// (readServePortFile)とリクエスト body への変換(toServeRequestBody)だけを
// 固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readServePortFile,
  toServeRequestBody,
} from "../src/lib/framesClient.ts";
import type { FrameRequest } from "../src/stages/frames.ts";

/* ---------------- readServePortFile ---------------- */

test("readServePortFile: portfile が無ければ null(existsSync 1回だけの opt-in 検出)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-serveport-"));
  try {
    assert.equal(readServePortFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readServePortFile: 妥当な portfile を読める", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-serveport-"));
  try {
    mkdirSync(join(dir, "frames"));
    writeFileSync(join(dir, "frames", ".serve.json"), JSON.stringify({ port: 4311, pid: 123 }));
    assert.deepEqual(readServePortFile(dir), { port: 4311, pid: 123 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readServePortFile: 壊れた JSON は null", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-serveport-"));
  try {
    mkdirSync(join(dir, "frames"));
    writeFileSync(join(dir, "frames", ".serve.json"), "{not json");
    assert.equal(readServePortFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readServePortFile: port/pid が数値でない中身は null", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-serveport-"));
  try {
    mkdirSync(join(dir, "frames"));
    writeFileSync(
      join(dir, "frames", ".serve.json"),
      JSON.stringify({ port: "4311", pid: 123 }),
    );
    assert.equal(readServePortFile(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- toServeRequestBody ---------------- */

test("toServeRequestBody: times モード(short/ocr/fullRes 省略時は既定)", () => {
  const req: FrameRequest = { mode: "times", times: [90], axis: "source" };
  assert.deepEqual(toServeRequestBody(req, {}), {
    mode: "times",
    times: [90],
    axis: "source",
    short: null,
    ocr: false,
    fullRes: false,
  });
});

test("toServeRequestBody: short/ocr/fullRes を渡すとそのまま乗る", () => {
  const req: FrameRequest = { mode: "every", stepSec: 10 };
  assert.deepEqual(toServeRequestBody(req, { short: "intro", ocr: true, fullRes: true }), {
    mode: "every",
    stepSec: 10,
    short: "intro",
    ocr: true,
    fullRes: true,
  });
});

test("toServeRequestBody: captions モード", () => {
  const req: FrameRequest = { mode: "captions" };
  assert.deepEqual(toServeRequestBody(req, {}), {
    mode: "captions",
    short: null,
    ocr: false,
    fullRes: false,
  });
});
