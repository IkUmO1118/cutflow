import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_CUT_ALGORITHM_VERSION,
  PREVIEW_CUT_AUDIO_ARGS,
  PREVIEW_CUT_CACHE_SCHEMA_VERSION,
  buildPreviewCutCacheKey,
  evaluatePreviewCutFreshness,
  inspectPreviewCutFreshness,
  previewCutCacheKeyEquals,
  previewCutKeepSignature,
} from "../src/lib/previewCutCache.ts";
import { videoEncodeArgs } from "../src/lib/videoEncode.ts";
import type { Config } from "../src/lib/config.ts";
import type { CutPlan } from "../src/types.ts";

const CFG = {
  preview: { width: 1280, videoEncoder: "libx264" },
} as Config;

const PLAN: CutPlan = {
  approved: false,
  segments: [
    { start: 2, end: 4, action: "keep", reason: "b", speed: 2 },
    { start: 0, end: 1, action: "keep", reason: "a" },
    { start: 1, end: 2, action: "cut", reason: "cut" },
  ],
};

function keyOf(overrides: {
  cutplan?: CutPlan;
  proxyMtimeMs?: number;
  proxySize?: number;
  compositionFps?: number;
  algorithmVersion?: string;
  videoArgs?: string[];
  audioArgs?: string[];
} = {}) {
  return buildPreviewCutCacheKey({
    cfg: CFG,
    cutplan: overrides.cutplan ?? PLAN,
    proxyMtimeMs: overrides.proxyMtimeMs ?? 1000,
    proxySize: overrides.proxySize ?? 2000,
    compositionFps: overrides.compositionFps ?? 30,
    algorithmVersion: overrides.algorithmVersion,
    videoArgs: overrides.videoArgs,
    audioArgs: overrides.audioArgs,
  });
}

test("buildPreviewCutCacheKey: keep を時系列で正規化し schema/codec/audio/algorithm を束縛する", () => {
  const key = keyOf();
  assert.equal(key.schemaVersion, PREVIEW_CUT_CACHE_SCHEMA_VERSION);
  assert.equal(key.algorithmVersion, PREVIEW_CUT_ALGORITHM_VERSION);
  assert.equal(key.compositionFps, 30);
  assert.deepEqual(key.keeps, [
    { start: 0, end: 1 },
    { start: 2, end: 4, speed: 2 },
  ]);
  assert.deepEqual(key.proxy, { file: "proxy.mp4", mtimeMs: 1000, size: 2000 });
  assert.deepEqual(key.videoArgs, videoEncodeArgs(CFG));
  assert.deepEqual(key.audioArgs, PREVIEW_CUT_AUDIO_ARGS);
});

test("cache key: composition fps/keep/speed/proxy/codec/audio/algorithm の変化を全て失効させる", () => {
  const base = keyOf();
  const changedPlan = structuredClone(PLAN);
  changedPlan.segments[1].end = 0.9;
  const changedSpeed = structuredClone(PLAN);
  changedSpeed.segments[0].speed = 1.5;
  for (const changed of [
    keyOf({ cutplan: changedPlan }),
    keyOf({ cutplan: changedSpeed }),
    keyOf({ proxyMtimeMs: 1001 }),
    keyOf({ proxySize: 2001 }),
    keyOf({ compositionFps: 60 }),
    keyOf({ videoArgs: ["-c:v", "another-codec"] }),
    keyOf({ audioArgs: ["-c:a", "another-codec"] }),
    keyOf({ algorithmVersion: "proxy-keeps-trim-concat-v2" }),
  ]) {
    assert.equal(previewCutCacheKeyEquals(base, changed), false);
  }
});

test("previewCutKeepSignature: reason/approved は無視し keep+speed のみを見る", () => {
  const metadataOnly = structuredClone(PLAN);
  metadataOnly.approved = true;
  metadataOnly.segments[0].reason = "changed";
  assert.equal(previewCutKeepSignature(metadataOnly), previewCutKeepSignature(PLAN));
  metadataOnly.segments[0].speed = 1.25;
  assert.notEqual(previewCutKeepSignature(metadataOnly), previewCutKeepSignature(PLAN));
});

test("evaluatePreviewCutFreshness: key と sidecar output stat が一致すると fresh", () => {
  const key = keyOf();
  assert.deepEqual(evaluatePreviewCutFreshness({
    proxyFresh: true,
    currentKey: key,
    sidecar: { key, output: { mtimeMs: 3000, size: 4000 } },
    outputStat: { mtimeMs: 3000, size: 4000 },
  }), { fresh: true });
});

test("evaluatePreviewCutFreshness: proxy stale/key不一致/output stat不一致/malformed は安全に stale", () => {
  const key = keyOf();
  const valid = { key, output: { mtimeMs: 3000, size: 4000 } };
  assert.deepEqual(evaluatePreviewCutFreshness({
    proxyFresh: false, currentKey: key, sidecar: valid,
    outputStat: { mtimeMs: 3000, size: 4000 },
  }), { fresh: false, reason: "proxy-stale" });
  assert.deepEqual(evaluatePreviewCutFreshness({
    proxyFresh: true, currentKey: keyOf({ proxySize: 9 }), sidecar: valid,
    outputStat: { mtimeMs: 3000, size: 4000 },
  }), { fresh: false, reason: "key-mismatch" });
  assert.deepEqual(evaluatePreviewCutFreshness({
    proxyFresh: true, currentKey: key, sidecar: valid,
    outputStat: { mtimeMs: 3001, size: 4000 },
  }), { fresh: false, reason: "output-stat-mismatch" });
  for (const malformed of [null, {}, { key }, { key: "x", output: {} }, { ...valid, output: { size: "4000" } }]) {
    assert.deepEqual(evaluatePreviewCutFreshness({
      proxyFresh: true, currentKey: key, sidecar: malformed,
      outputStat: { mtimeMs: 3000, size: 4000 },
    }), { fresh: false, reason: "sidecar-malformed" });
  }
});

test("inspectPreviewCutFreshness: 壊れた sidecar JSON を throw せず fallback する", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-preview-cut-cache-"));
  try {
    writeFileSync(join(dir, "preview-cut.mp4"), "old");
    writeFileSync(join(dir, "preview-cut.key.json"), "{not json");
    assert.deepEqual(inspectPreviewCutFreshness({
      dir,
      currentKey: keyOf(),
      proxyFresh: true,
    }), { fresh: false, reason: "sidecar-malformed" });

    const output = statSync(join(dir, "preview-cut.mp4"));
    writeFileSync(join(dir, "preview-cut.key.json"), JSON.stringify({
      key: keyOf(),
      output: { mtimeMs: output.mtimeMs, size: output.size },
    }));
    assert.deepEqual(inspectPreviewCutFreshness({
      dir,
      currentKey: keyOf(),
      proxyFresh: true,
    }), { fresh: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
