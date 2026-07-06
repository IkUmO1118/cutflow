// lib/profile.ts — 出力プロファイル(サイズ+パネル配置+字幕既定)の組み込み定数。
// config には無い閉じたプリセットなので、名前解決とプレースホルダの
// screenRegion 差し替えだけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, resolveProfile } from "../src/lib/profile.ts";
import type { Config } from "../src/lib/config.ts";

const cfg = {
  ingest: {
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
} as Config;

test("resolveProfile: 省略時は default = screenRegion サイズ・layout なし", () => {
  const profile = resolveProfile(cfg);
  assert.deepEqual(profile, { width: 1920, height: 1080 });
  assert.equal(profile.layout, undefined);
});

test("resolveProfile: \"default\" 明示も screenRegion サイズ", () => {
  const otherCfg = {
    ingest: { screenRegion: { x: 0, y: 0, w: 2560, h: 1440 } },
  } as Config;
  assert.deepEqual(resolveProfile(otherCfg, "default"), { width: 2560, height: 1440 });
});

test("resolveProfile: vertical は 1080x1920 + camera上/screen下のパネル", () => {
  const profile = resolveProfile(cfg, "vertical");
  assert.equal(profile.width, 1080);
  assert.equal(profile.height, 1920);
  assert.ok(profile.layout);
  assert.equal(profile.layout?.panels.length, 2);
  assert.equal(profile.layout?.panels[0].source, "camera");
  assert.equal(profile.layout?.panels[1].source, "screen");
  assert.equal(profile.layout?.caption?.fontScale, 1.6);
});

test("resolveProfile: vertical-cover は 1080x1920 + camera 全画面1パネル", () => {
  const profile = resolveProfile(cfg, "vertical-cover");
  assert.equal(profile.width, 1080);
  assert.equal(profile.height, 1920);
  assert.equal(profile.layout?.panels.length, 1);
  assert.equal(profile.layout?.panels[0].source, "camera");
  assert.deepEqual(profile.layout?.panels[0].rect, { x: 0, y: 0, w: 1080, h: 1920 });
});

test("resolveProfile: 未知のプロファイル名は throw", () => {
  assert.throws(() => resolveProfile(cfg, "square"));
});

test("PROFILES: vertical/vertical-cover は組み込み定数として直接参照できる", () => {
  assert.ok(PROFILES.vertical);
  assert.ok(PROFILES["vertical-cover"]);
});
