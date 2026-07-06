// lib/loudness.ts — keepAudioParts の filter_complex 生成を固定する。
// マイクチェーン(atrim,asetpts の直後・amix より前)にのみ afftdn が入り、
// システム音声チェーンには入らないこと。denoise 無効時は既存挙動と完全一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { audioSourceOf, keepAudioParts } from "../src/lib/loudness.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest } from "../src/types.ts";

const KEEPS = [{ start: 0, end: 10 }, { start: 20, end: 30 }];

test("keepAudioParts: denoise 無効時はマイクのみで従来どおり(afftdn なし)", () => {
  const parts = keepAudioParts(
    { micStream: 0, systemStream: null, systemVolumeDb: 0, denoiseMic: false, noiseFloorDb: -25 },
    KEEPS,
  );
  assert.deepEqual(parts, [
    "[0:a:0]atrim=start=0:end=10,asetpts=PTS-STARTPTS[a0]",
    "[0:a:0]atrim=start=20:end=30,asetpts=PTS-STARTPTS[a1]",
  ]);
});

test("keepAudioParts: denoise 無効時はシステム音声ありでも従来どおり", () => {
  const parts = keepAudioParts(
    { micStream: 0, systemStream: 1, systemVolumeDb: 0, denoiseMic: false, noiseFloorDb: -25 },
    [{ start: 0, end: 10 }],
  );
  assert.deepEqual(parts, [
    "[0:a:0]atrim=start=0:end=10,asetpts=PTS-STARTPTS[mic0]",
    "[0:a:1]atrim=start=0:end=10,asetpts=PTS-STARTPTS[sys0]",
    "[mic0][sys0]amix=inputs=2:duration=first:normalize=0[a0]",
  ]);
});

test("keepAudioParts: denoise 有効時マイクのみに afftdn が入る(システム音声なし)", () => {
  const parts = keepAudioParts(
    { micStream: 0, systemStream: null, systemVolumeDb: 0, denoiseMic: true, noiseFloorDb: -25 },
    [{ start: 0, end: 10 }],
  );
  assert.deepEqual(parts, [
    "[0:a:0]atrim=start=0:end=10,asetpts=PTS-STARTPTS,afftdn=nf=-25[a0]",
  ]);
});

test("keepAudioParts: denoise 有効時マイクチェーンにのみ afftdn(システム音声チェーンには入らない)", () => {
  const parts = keepAudioParts(
    { micStream: 0, systemStream: 1, systemVolumeDb: 0, denoiseMic: true, noiseFloorDb: -25 },
    [{ start: 0, end: 10 }],
  );
  assert.deepEqual(parts, [
    "[0:a:0]atrim=start=0:end=10,asetpts=PTS-STARTPTS,afftdn=nf=-25[mic0]",
    "[0:a:1]atrim=start=0:end=10,asetpts=PTS-STARTPTS[sys0]",
    "[mic0][sys0]amix=inputs=2:duration=first:normalize=0[a0]",
  ]);
});

test("keepAudioParts: noiseFloorDb の値がフィルタ文字列に反映される", () => {
  const parts = keepAudioParts(
    { micStream: 0, systemStream: null, systemVolumeDb: 0, denoiseMic: true, noiseFloorDb: -30 },
    [{ start: 0, end: 10 }],
  );
  assert.ok(parts[0].includes("afftdn=nf=-30"));
});

test("audioSourceOf: denoise 省略時は mic:false/noiseFloorDb:-25 に落ちる(config の後方互換)", () => {
  const manifest = { source: "raw.mkv", audio: { micStream: 0, systemStream: 1 } } as Manifest;
  const cfg = { render: { targetLufs: -14 } } as Config;
  const source = audioSourceOf(manifest, cfg);
  assert.equal(source.denoiseMic, false);
  assert.equal(source.noiseFloorDb, -25);
});

test("audioSourceOf: denoise 設定が反映される", () => {
  const manifest = { source: "raw.mkv", audio: { micStream: 0, systemStream: 1 } } as Manifest;
  const cfg = {
    render: { targetLufs: -14, denoise: { mic: true, noiseFloorDb: -18 } },
  } as Config;
  const source = audioSourceOf(manifest, cfg);
  assert.equal(source.denoiseMic, true);
  assert.equal(source.noiseFloorDb, -18);
});
