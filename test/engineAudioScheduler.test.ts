// src/engine/runtime/audioScheduler.ts の純関数部分を固定する。
// AudioScheduler 本体(AudioContext/mediabunny が要る)は実 movie で
// M3a Phase5 の開発ページで実測する(設計書どおり)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBgmGainAutomation,
  contextTimeForOutputSec,
  shouldScheduleEntry,
} from "../src/engine/runtime/audioScheduler.ts";

test("contextTimeForOutputSec: 開始マッピングからの相対時刻を絶対AudioContext時刻へ", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100 };
  assert.equal(contextTimeForOutputSec(mapping, 10), 100);
  assert.equal(contextTimeForOutputSec(mapping, 12.5), 102.5);
  assert.equal(contextTimeForOutputSec(mapping, 5), 95);
});

test("shouldScheduleEntry: 先読み窓に入っていればtrue", () => {
  assert.equal(shouldScheduleEntry({ outputStart: 3, outputEnd: 8 }, 0, 5), true);
});

test("shouldScheduleEntry: 既に終わった区間はfalse", () => {
  assert.equal(shouldScheduleEntry({ outputStart: 0, outputEnd: 5 }, 5, 7), false);
});

test("shouldScheduleEntry: 窓より先に始まる区間はfalse", () => {
  assert.equal(shouldScheduleEntry({ outputStart: 10, outputEnd: 15 }, 0, 5), false);
});

test("shouldScheduleEntry: 境界(outputStart===windowEnd)はtrue", () => {
  assert.equal(shouldScheduleEntry({ outputStart: 5, outputEnd: 10 }, 0, 5), true);
});

function track(overrides: Partial<Parameters<typeof buildBgmGainAutomation>[0]> = {}) {
  return {
    file: "bgm.mp3",
    volumeDb: 0,
    start: 10,
    end: 20,
    ...overrides,
  } as Parameters<typeof buildBgmGainAutomation>[0];
}

test("buildBgmGainAutomation: fade/duckが無ければstart/endの2点で一定音量", () => {
  const points = buildBgmGainAutomation(track(), 30);
  assert.equal(points.length, 2);
  assert.equal(points[0].atSec, 10);
  assert.equal(points[1].atSec, 20);
  assert.ok(Math.abs(points[0].gain - 1) < 1e-9);
  assert.ok(Math.abs(points[1].gain - 1) < 1e-9);
});

test("buildBgmGainAutomation: fadeInSecの終端でフル音量に達する折れ点が入る", () => {
  const points = buildBgmGainAutomation(track({ fadeInSec: 2 }), 30);
  const atFadeEnd = points.find((p) => Math.abs(p.atSec - 12) < 1e-9);
  assert.ok(atFadeEnd, "fadeIn終端(start+2)の折れ点が無い");
  assert.ok(Math.abs((atFadeEnd as { gain: number }).gain - 1) < 1e-9);
  const atStart = points.find((p) => p.atSec === 10);
  assert.ok(atStart);
  assert.ok((atStart as { gain: number }).gain < 0.01, "fadeIn開始直後はほぼ無音のはず");
});

test("buildBgmGainAutomation: duck spansの境界(前後fadeSec込み)で折れ点が入る", () => {
  const points = buildBgmGainAutomation(
    track({ duck: { spans: [{ start: 14, end: 16 }], duckDb: -20, fadeSec: 0.5 } }),
    30,
  );
  const atSecs = points.map((p) => Math.round(p.atSec * 100) / 100);
  assert.ok(atSecs.includes(13.5), "duck開始のfadeSec手前の折れ点が無い");
  assert.ok(atSecs.includes(14), "duck開始の折れ点が無い");
  assert.ok(atSecs.includes(16), "duck終了の折れ点が無い");
  assert.ok(atSecs.includes(16.5), "duck終了のfadeSec後の折れ点が無い");
  const inDuck = points.find((p) => p.atSec === 15) ?? points.find((p) => Math.abs(p.atSec - 15) < 0.6);
  // duck 区間内(14〜16)の折れ点は volumeDb=0 に duckDb=-20dB がかかり 0.1 倍程度
  const duckPoint = points.find((p) => p.atSec === 14);
  assert.ok(duckPoint && duckPoint.gain < 0.2, "duck開始直後は音量が下がっているはず");
});
