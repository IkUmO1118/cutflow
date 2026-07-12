// stages/ingest.ts — 実効レイアウトの解決(明示 > config > 既定 plain、
// auto は寸法/縦横比による OBS 判定)を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLayout, resolveAudioTracks } from "../src/stages/ingest.ts";
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

const S = (
  index: number,
  extra: Partial<{ codec: string; channels: number; title: string; language: string }> = {},
) => ({ index, ...extra });

test("resolveAudioTracks: 既定 1/2・2本 → mic0/sys1(既存挙動と同一・警告なし)", () => {
  const r = resolveAudioTracks([S(0), S(1)], 1, 2);
  assert.deepEqual(r, {
    ok: true,
    resolution: { micIndex: 0, systemIndex: 1, source: "config", warnings: [] },
  });
});

test("resolveAudioTracks: 既定 1/2・1本 → mic0/sysnull(system 無し)", () => {
  const r = resolveAudioTracks([S(0)], 1, 2);
  assert.deepEqual(r, {
    ok: true,
    resolution: { micIndex: 0, systemIndex: null, source: "single", warnings: [] },
  });
});

test("resolveAudioTracks: 入れ替え設定 2/1・2本 → mic1/sys0 を尊重", () => {
  const r = resolveAudioTracks([S(0), S(1)], 2, 1);
  assert.equal(r.ok, true);
  assert.equal((r as any).resolution.micIndex, 1);
  assert.equal((r as any).resolution.systemIndex, 0);
});

test("resolveAudioTracks: 範囲外 micTrack・2本・メタ無し → 誘導(ok:false, N提示)", () => {
  const r = resolveAudioTracks([S(0), S(1)], 3, 2);
  assert.equal(r.ok, false);
  assert.match((r as any).message, /2 本の音声トラック/);
  assert.match((r as any).message, /--mic-track/);
});

test("resolveAudioTracks: 範囲外 micTrack・1本 → single 推定", () => {
  const r = resolveAudioTracks([S(0)], 3, 4);
  assert.equal(r.ok, true);
  assert.equal((r as any).resolution.micIndex, 0);
  assert.equal((r as any).resolution.source, "single");
});

test("resolveAudioTracks: 範囲外・メタで mic 一意 → inferred", () => {
  const r = resolveAudioTracks(
    [S(0, { title: "Desktop Audio" }), S(1, { title: "Microphone" })],
    5,
    6,
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).resolution.micIndex, 1);
  assert.equal((r as any).resolution.source, "inferred");
});

test("resolveAudioTracks: 範囲内だがメタ食い違い → 抽出は不変・警告のみ", () => {
  const r = resolveAudioTracks(
    [S(0, { title: "Desktop Audio" }), S(1, { title: "Mic/Aux" })],
    1,
    2,
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).resolution.micIndex, 0); // 抽出は変えない(バイト等価)
  assert.ok((r as any).resolution.warnings.length > 0); // stderr 助言だけ足す
});
