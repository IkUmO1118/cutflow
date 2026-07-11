// stages/ingest.ts — 実効レイアウトの解決(明示 > config > 既定 plain、
// auto は寸法/縦横比による OBS 判定)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLayout } from "../src/stages/ingest.ts";
import type { Config } from "../src/lib/config.ts";

const cfg = {
  ingest: {
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    micTrack: 1,
    systemTrack: 2,
  },
} as Config;

test("resolveLayout: 明示引数が最優先", () => {
  assert.equal(resolveLayout("plain", "obs-canvas", 1920, 1080, cfg), "plain");
  assert.equal(resolveLayout("obs-canvas", "plain", 1920, 1080, cfg), "obs-canvas");
});

test("resolveLayout: 明示引数が無ければ config", () => {
  assert.equal(resolveLayout(undefined, "plain", 1920, 1080, cfg), "plain");
  assert.equal(resolveLayout(undefined, "obs-canvas", 1920, 1080, cfg), "obs-canvas");
});

test("resolveLayout: どちらも無ければ既定 plain", () => {
  assert.equal(resolveLayout(undefined, undefined, 1920, 1080, cfg), "plain");
});

test("resolveLayout: auto はキャンバス寸法の完全一致で obs-canvas", () => {
  assert.equal(resolveLayout("auto", undefined, 3840, 1080, cfg), "obs-canvas");
});

test("resolveLayout: auto は十分な超横長なら obs-canvas", () => {
  assert.equal(resolveLayout("auto", undefined, 3440, 1000, cfg), "obs-canvas");
});

test("resolveLayout: auto は通常動画の解像度で plain", () => {
  assert.equal(resolveLayout("auto", undefined, 1920, 1080, cfg), "plain");
  // 4K通常動画は plain(OBS の 3840x1080 と区別する)
  assert.equal(resolveLayout("auto", undefined, 3840, 2160, cfg), "plain");
});

test("resolveLayout: config 側の auto も同様に解決される", () => {
  assert.equal(resolveLayout(undefined, "auto", 3840, 1080, cfg), "obs-canvas");
  assert.equal(resolveLayout(undefined, "auto", 1080, 1920, cfg), "plain");
});
