// lib/cutCache.ts — render の cut.mp4 再利用可否を決めるキャッシュキー生成・
// 一致判定を固定する。keeps・音声設定・元収録ファイルのどれかが変われば
// キーが変わり、render は ffmpeg cut(loudnorm実測込み)を再実行すること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCutCacheKey, cutCacheKeyEquals } from "../src/lib/cutCache.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest } from "../src/types.ts";

const MANIFEST = {
  source: "raw.mkv",
  audio: { micStream: 0, systemStream: 1 },
} as Manifest;

const CFG = {
  render: {
    targetLufs: -14,
    systemAudio: { mix: true, volumeDb: 0 },
  },
} as Config;

const KEEPS = [{ start: 0, end: 10, speed: 1 }, { start: 20, end: 30, speed: 1 }];

function keyOf(overrides: {
  manifest?: Manifest;
  cfg?: Config;
  keeps?: { start: number; end: number; speed: number }[];
  sourceMtimeMs?: number;
  sourceSize?: number;
}) {
  return buildCutCacheKey({
    keeps: overrides.keeps ?? KEEPS,
    manifest: overrides.manifest ?? MANIFEST,
    cfg: overrides.cfg ?? CFG,
    sourceMtimeMs: overrides.sourceMtimeMs ?? 1000,
    sourceSize: overrides.sourceSize ?? 2000,
  });
}

test("cutCacheKeyEquals: 全く同じ入力からは一致するキー", () => {
  assert.ok(cutCacheKeyEquals(keyOf({}), keyOf({})));
});

test("cutCacheKeyEquals: keeps が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ keeps: [{ start: 0, end: 11, speed: 1 }, { start: 20, end: 30, speed: 1 }] });
  assert.ok(!cutCacheKeyEquals(a, b));
});

test("cutCacheKeyEquals: speed が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ keeps: [{ start: 0, end: 10, speed: 2 }, { start: 20, end: 30, speed: 1 }] });
  assert.ok(!cutCacheKeyEquals(a, b));
});

test("cutCacheKeyEquals: targetLufs が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({
    cfg: { render: { ...CFG.render, targetLufs: -16 } } as Config,
  });
  assert.ok(!cutCacheKeyEquals(a, b));
});

test("cutCacheKeyEquals: 元収録ファイルの mtime が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ sourceMtimeMs: 1001 });
  assert.ok(!cutCacheKeyEquals(a, b));
});

test("cutCacheKeyEquals: 元収録ファイルの size が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ sourceSize: 2001 });
  assert.ok(!cutCacheKeyEquals(a, b));
});

test("cutCacheKeyEquals: systemAudio.mix / volumeDb が変わると不一致", () => {
  const a = keyOf({});
  const mixOff = keyOf({
    cfg: {
      render: { ...CFG.render, systemAudio: { mix: false, volumeDb: 0 } },
    } as Config,
  });
  assert.ok(!cutCacheKeyEquals(a, mixOff));
  const volChanged = keyOf({
    cfg: {
      render: { ...CFG.render, systemAudio: { mix: true, volumeDb: -6 } },
    } as Config,
  });
  assert.ok(!cutCacheKeyEquals(a, volChanged));
});

test("cutCacheKeyEquals: manifest.audio の micStream / systemStream が変わると不一致", () => {
  const a = keyOf({});
  const micChanged = keyOf({
    manifest: { ...MANIFEST, audio: { micStream: 1, systemStream: 1 } } as Manifest,
  });
  assert.ok(!cutCacheKeyEquals(a, micChanged));
  const sysChanged = keyOf({
    manifest: { ...MANIFEST, audio: { micStream: 0, systemStream: null } } as Manifest,
  });
  assert.ok(!cutCacheKeyEquals(a, sysChanged));
});

test("buildCutCacheKey: systemAudio 省略時は mix:false/volumeDb:0 に落ちる(config の後方互換)", () => {
  const key = buildCutCacheKey({
    keeps: KEEPS,
    manifest: MANIFEST,
    cfg: { render: { targetLufs: -14 } } as Config,
    sourceMtimeMs: 1000,
    sourceSize: 2000,
  });
  assert.deepEqual(key.systemAudio, { mix: false, volumeDb: 0 });
});

test("buildCutCacheKey: denoise 省略時は mic:false/noiseFloorDb:-25 に落ちる(config の後方互換)", () => {
  const key = buildCutCacheKey({
    keeps: KEEPS,
    manifest: MANIFEST,
    cfg: { render: { targetLufs: -14 } } as Config,
    sourceMtimeMs: 1000,
    sourceSize: 2000,
  });
  assert.deepEqual(key.denoise, { mic: false, noiseFloorDb: -25 });
});

test("cutCacheKeyEquals: denoise.mic / noiseFloorDb が変わると不一致", () => {
  const a = keyOf({});
  const micOn = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, denoise: { mic: true, noiseFloorDb: -25 } } } as Config,
  });
  assert.ok(!cutCacheKeyEquals(a, micOn));
  const floorChanged = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, denoise: { mic: true, noiseFloorDb: -18 } } } as Config,
  });
  assert.ok(!cutCacheKeyEquals(micOn, floorChanged));
});
