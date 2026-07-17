import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EDGE_TRIM_FLOOR_OFFSET_DB,
  DEFAULT_EDGE_TRIM_MAX_TRIM_SEC,
  DEFAULT_EDGE_TRIM_PAD_SEC,
  resolveEdgeTrimCfg,
  trimKeepEdges,
} from "../src/lib/edgeTrim.ts";
import { BOUNDARY_SAMPLE_RATE_HZ } from "../src/stages/boundaryCheck.ts";
import type { Config } from "../src/lib/config.ts";

/** 合成 PCM: 全体を微小ノイズ(≈-70dB)で埋め、bursts 区間だけ発話級(≈-12dB)にする */
function makeSamples(durationSec: number, bursts: [number, number][]): Int16Array {
  const samples = new Int16Array(Math.round(durationSec * BOUNDARY_SAMPLE_RATE_HZ));
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? 10 : -10;
  for (const [start, end] of bursts) {
    const a = Math.round(start * BOUNDARY_SAMPLE_RATE_HZ);
    const b = Math.round(end * BOUNDARY_SAMPLE_RATE_HZ);
    for (let i = a; i < b && i < samples.length; i += 1) {
      samples[i] = i % 2 === 0 ? 8000 : -8000;
    }
  }
  return samples;
}

const CFG = { floorOffsetDb: 12, padSec: 0.05, maxTrimSec: 3, minKeepSec: 0.5 };

test("edgeTrim: 発話後の静かな尾と発話前の余白を発話エッジ+pad へ詰める", () => {
  const samples = makeSamples(5, [[0.5, 2.0]]);
  const result = trimKeepEdges([{ start: 0, end: 4 }], samples, CFG);
  const keep = result.keeps[0]!;
  assert.ok(keep.start >= 0.3 && keep.start <= 0.5, `start=${keep.start}`);
  assert.ok(keep.end >= 2.0 && keep.end <= 2.2, `end=${keep.end}`);
  assert.equal(result.trimmedEdges, 2);
  assert.ok(result.trimmedSec > 1.5, `trimmedSec=${result.trimmedSec}`);
  // 縮める方向にしか動かない
  assert.ok(keep.start >= 0 && keep.end <= 4);
});

test("edgeTrim: maxTrimSec が1辺のトリム量を頭打ちにする", () => {
  const samples = makeSamples(7, [[0.5, 2.0]]);
  const result = trimKeepEdges([{ start: 0, end: 6 }], samples, { ...CFG, maxTrimSec: 1.5 });
  const keep = result.keeps[0]!;
  // 末尾は [4.5, 6] に発話が無いので最大トリム位置 4.5 + pad
  assert.equal(keep.end, 4.55);
});

test("edgeTrim: トリム後に minKeepSec を割る keep は原状維持", () => {
  const samples = makeSamples(5, [[1.0, 1.5]]);
  const result = trimKeepEdges([{ start: 0, end: 4 }], samples, { ...CFG, minKeepSec: 3 });
  assert.deepEqual(result.keeps[0], { start: 0, end: 4 });
  assert.equal(result.trimmedSec, 0);
  assert.equal(result.trimmedEdges, 0);
});

test("edgeTrim: 端が既に発話エッジにある keep は動かない", () => {
  const samples = makeSamples(5, [[0.5, 2.0]]);
  const result = trimKeepEdges([{ start: 0.5, end: 2.0 }], samples, CFG);
  assert.deepEqual(result.keeps[0], { start: 0.5, end: 2.0 });
  assert.equal(result.trimmedEdges, 0);
});

test("edgeTrim: 発話が全く無い keep は原状維持(退化区間を作らない)", () => {
  const samples = makeSamples(5, [[0.5, 2.0]]);
  const result = trimKeepEdges([{ start: 3, end: 4 }], samples, { ...CFG, maxTrimSec: 1.5 });
  assert.deepEqual(result.keeps[0], { start: 3, end: 4 });
});

test("edgeTrim: 複数 keep の時系列・非重なりが保たれる", () => {
  const samples = makeSamples(10, [[0.5, 2.0], [5.0, 7.0]]);
  const result = trimKeepEdges(
    [{ start: 0, end: 4 }, { start: 4.5, end: 9 }],
    samples,
    CFG,
  );
  const [a, b] = result.keeps;
  assert.ok(a!.end <= b!.start, `a.end=${a!.end} b.start=${b!.start}`);
  assert.ok(a!.start < a!.end && b!.start < b!.end);
});

test("resolveEdgeTrimCfg: 省略キーは既定値で解決し minKeepSec を引き継ぐ", () => {
  const detectCfg = { edgeTrim: { enabled: true } } as Config["detect"];
  const cfg = resolveEdgeTrimCfg(detectCfg, 0.5);
  assert.equal(cfg.floorOffsetDb, DEFAULT_EDGE_TRIM_FLOOR_OFFSET_DB);
  assert.equal(cfg.padSec, DEFAULT_EDGE_TRIM_PAD_SEC);
  assert.equal(cfg.maxTrimSec, DEFAULT_EDGE_TRIM_MAX_TRIM_SEC);
  assert.equal(cfg.minKeepSec, 0.5);
  const explicit = resolveEdgeTrimCfg(
    { edgeTrim: { enabled: true, floorOffsetDb: 15, padSec: 0.1, maxTrimSec: 2 } } as Config["detect"],
    0.3,
  );
  assert.deepEqual(explicit, { floorOffsetDb: 15, padSec: 0.1, maxTrimSec: 2, minKeepSec: 0.3 });
});
