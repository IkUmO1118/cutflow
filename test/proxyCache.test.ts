// lib/proxyCache.ts — proxy.mp4 の陳腐化を決めるキャッシュキー生成・
// 一致判定を固定する。焼き込まれる設定(ラウドネス・システム音声・
// プレビュー幅・エンコーダ)か元収録ファイルのどれかが変われば不一致になり、
// proxy.mp4 は古い(再生成が要る)と判定されること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProxyCacheKey, proxyCacheKeyEquals } from "../src/lib/proxyCache.ts";
import type { Config } from "../src/lib/config.ts";

const CFG = {
  preview: { width: 1280 },
  render: {
    targetLufs: -14,
    systemAudio: { mix: true, volumeDb: 0 },
  },
} as Config;

function keyOf(overrides: {
  cfg?: Config;
  sourceFile?: string;
  sourceMtimeMs?: number;
  sourceSize?: number;
}) {
  return buildProxyCacheKey({
    cfg: overrides.cfg ?? CFG,
    sourceFile: overrides.sourceFile ?? "raw.mkv",
    sourceMtimeMs: overrides.sourceMtimeMs ?? 1000,
    sourceSize: overrides.sourceSize ?? 2000,
  });
}

test("proxyCacheKeyEquals: 全く同じ入力からは一致するキー", () => {
  assert.ok(proxyCacheKeyEquals(keyOf({}), keyOf({})));
});

test("proxyCacheKeyEquals: targetLufs が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ cfg: { ...CFG, render: { ...CFG.render, targetLufs: -16 } } as Config });
  assert.ok(!proxyCacheKeyEquals(a, b));
});

test("proxyCacheKeyEquals: systemAudio.mix / volumeDb が変わると不一致", () => {
  const a = keyOf({});
  const mixOff = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, systemAudio: { mix: false, volumeDb: 0 } } } as Config,
  });
  assert.ok(!proxyCacheKeyEquals(a, mixOff));
  const volChanged = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, systemAudio: { mix: true, volumeDb: -6 } } } as Config,
  });
  assert.ok(!proxyCacheKeyEquals(a, volChanged));
});

test("proxyCacheKeyEquals: preview.width が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ cfg: { ...CFG, preview: { width: 1920 } } as Config });
  assert.ok(!proxyCacheKeyEquals(a, b));
});

test("proxyCacheKeyEquals: preview.videoEncoder が変わると不一致(省略時は videotoolbox に落ちる)", () => {
  const a = keyOf({});
  const b = keyOf({ cfg: { ...CFG, preview: { width: 1280, videoEncoder: "libx264" } } as Config });
  assert.ok(!proxyCacheKeyEquals(a, b));
  assert.equal(keyOf({}).videoEncoder, "videotoolbox");
});

test("proxyCacheKeyEquals: 元収録ファイルの mtime/size/file 名が変わると不一致", () => {
  const a = keyOf({});
  assert.ok(!proxyCacheKeyEquals(a, keyOf({ sourceMtimeMs: 1001 })));
  assert.ok(!proxyCacheKeyEquals(a, keyOf({ sourceSize: 2001 })));
  assert.ok(!proxyCacheKeyEquals(a, keyOf({ sourceFile: "raw2.mkv" })));
});

test("buildProxyCacheKey: systemAudio 省略時は mix:false/volumeDb:0 に落ちる(config の後方互換)", () => {
  const key = buildProxyCacheKey({
    cfg: { preview: { width: 1280 }, render: { targetLufs: -14 } } as Config,
    sourceFile: "raw.mkv",
    sourceMtimeMs: 1000,
    sourceSize: 2000,
  });
  assert.deepEqual(key.systemAudio, { mix: false, volumeDb: 0 });
});

test("buildProxyCacheKey: denoise 省略時は mic:false/noiseFloorDb:-25 に落ちる(config の後方互換)", () => {
  const key = buildProxyCacheKey({
    cfg: { preview: { width: 1280 }, render: { targetLufs: -14 } } as Config,
    sourceFile: "raw.mkv",
    sourceMtimeMs: 1000,
    sourceSize: 2000,
  });
  assert.deepEqual(key.denoise, { mic: false, noiseFloorDb: -25 });
});

test("proxyCacheKeyEquals: denoise.mic / noiseFloorDb が変わると不一致", () => {
  const a = keyOf({});
  const micOn = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, denoise: { mic: true, noiseFloorDb: -25 } } } as Config,
  });
  assert.ok(!proxyCacheKeyEquals(a, micOn));
  const floorChanged = keyOf({
    cfg: { ...CFG, render: { ...CFG.render, denoise: { mic: true, noiseFloorDb: -18 } } } as Config,
  });
  assert.ok(!proxyCacheKeyEquals(micOn, floorChanged));
});
