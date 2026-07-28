// src/engine/runtime/audioScheduler.ts の純関数部分を固定する。
// AudioScheduler 本体(AudioContext/mediabunny が要る)は実 movie で
// M3a Phase5 の開発ページで実測する(設計書どおり)。M3b の setVolume/dispose
// だけは masterGain の配線のみで mediabunny(ネットワークfetch)を要さないため、
// 最小モック AudioContext で単体テストする。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AudioScheduler,
  buildBgmGainAutomation,
  concatAudioBuffers,
  contextTimeForOutputSec,
  shouldScheduleEntry,
  splitEntryIntoWindows,
} from "../src/engine/runtime/audioScheduler.ts";

/** AudioScheduler が constructor で使う分(createGain/destination)だけを
 * 備えた最小モック。setVolume/dispose の配線確認にはこれで足りる */
function mockAudioContext() {
  const gainNodes: Array<{ gain: { value: number }; connect: () => void; disconnect: () => void }> = [];
  const audioContext = {
    destination: {},
    createGain: () => {
      const node = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
      gainNodes.push(node);
      return node;
    },
  };
  return { audioContext: audioContext as unknown as AudioContext, gainNodes };
}

test("contextTimeForOutputSec: 開始マッピングからの相対時刻を絶対AudioContext時刻へ", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100 };
  assert.equal(contextTimeForOutputSec(mapping, 10), 100);
  assert.equal(contextTimeForOutputSec(mapping, 12.5), 102.5);
  assert.equal(contextTimeForOutputSec(mapping, 5), 95);
});

test("contextTimeForOutputSec: rate:2(倍速)は半分の経過時間で到達する", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100, rate: 2 };
  assert.equal(contextTimeForOutputSec(mapping, 20), 105);
});

test("contextTimeForOutputSec: rate:0.5(半速)は倍の経過時間がかかる", () => {
  const mapping = { startOutputSec: 10, startContextTime: 100, rate: 0.5 };
  assert.equal(contextTimeForOutputSec(mapping, 15), 110);
});

test("AudioScheduler.setVolume: masterGain.gain.value へ即時反映する", () => {
  const { audioContext, gainNodes } = mockAudioContext();
  const scheduler = new AudioScheduler({
    audioContext,
    baseAudioUrl: "/media/proxy.mp4",
    timeline: [],
    bgm: [],
    fps: 30,
  });
  scheduler.setVolume(0.25);
  assert.equal(gainNodes[0].gain.value, 0.25);
});

test("AudioScheduler.dispose: masterGain を disconnect し、2重呼び出しでも例外を投げない", () => {
  const { audioContext } = mockAudioContext();
  const scheduler = new AudioScheduler({
    audioContext,
    baseAudioUrl: "/media/proxy.mp4",
    timeline: [],
    bgm: [],
    fps: 30,
  });
  scheduler.dispose();
  assert.doesNotThrow(() => scheduler.dispose());
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

import type { TimelineEntry } from "../src/lib/timeline.ts";

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    outputStart: 0,
    outputEnd: 4,
    sourceStart: 0,
    sourceEnd: 4,
    speed: 1,
    ...overrides,
  };
}

test("splitEntryIntoWindows: 窓長以下の区間は1個だけ返す", () => {
  const e = entry({ outputStart: 0, outputEnd: 0.5, sourceStart: 10, sourceEnd: 10.5 });
  const w = splitEntryIntoWindows(e, 1);
  assert.equal(w.length, 1);
  assert.equal(w[0].outputStart, 0);
  assert.equal(w[0].outputEnd, 0.5);
  assert.equal(w[0].sourceStart, 10);
  assert.equal(w[0].sourceEnd, 10.5);
});

test("splitEntryIntoWindows: 4秒区間を1秒窓で4等分", () => {
  const e = entry({ outputStart: 0, outputEnd: 4, sourceStart: 0, sourceEnd: 4, speed: 1 });
  const w = splitEntryIntoWindows(e, 1);
  assert.equal(w.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(w[i].outputStart, i);
    assert.equal(w[i].outputEnd, i + 1);
    assert.equal(w[i].sourceStart, i);
    assert.equal(w[i].sourceEnd, i + 1);
    assert.equal(w[i].speed, 1);
  }
});

test("splitEntryIntoWindows: 端数が最後の窓で短くなる", () => {
  const e = entry({ outputStart: 0, outputEnd: 3.7, sourceStart: 5, sourceEnd: 8.7, speed: 1 });
  const w = splitEntryIntoWindows(e, 1);
  assert.equal(w.length, 4);
  assert.equal(w[0].outputEnd, 1);
  assert.equal(w[1].outputEnd, 2);
  assert.equal(w[2].outputEnd, 3);
  assert.equal(w[3].outputStart, 3);
  assert.equal(w[3].outputEnd, 3.7);
  assert.equal(w[3].sourceStart, 8);
  assert.equal(w[3].sourceEnd, 8.7);
});

test("splitEntryIntoWindows: speed 2 で source が output の倍速で進む", () => {
  const e = entry({ outputStart: 0, outputEnd: 3, sourceStart: 0, sourceEnd: 6, speed: 2 });
  const w = splitEntryIntoWindows(e, 1);
  assert.equal(w.length, 3);
  assert.equal(w[0].outputStart, 0);
  assert.equal(w[0].outputEnd, 1);
  assert.equal(w[0].sourceStart, 0);
  assert.equal(w[0].sourceEnd, 2);
  assert.equal(w[1].outputStart, 1);
  assert.equal(w[1].outputEnd, 2);
  assert.equal(w[1].sourceStart, 2);
  assert.equal(w[1].sourceEnd, 4);
  assert.equal(w[2].outputStart, 2);
  assert.equal(w[2].outputEnd, 3);
  assert.equal(w[2].sourceStart, 4);
  assert.equal(w[2].sourceEnd, 6);
});

test("splitEntryIntoWindows: 窓の連結が元の区間と厳密に一致する(境界の連続性)", () => {
  const e = entry({ outputStart: 2, outputEnd: 9, sourceStart: 100, sourceEnd: 114, speed: 2 });
  const w = splitEntryIntoWindows(e, 1.5);
  assert.equal(w[0].outputStart, e.outputStart);
  assert.equal(w[w.length - 1].outputEnd, e.outputEnd);
  assert.equal(w[0].sourceStart, e.sourceStart);
  assert.equal(w[w.length - 1].sourceEnd, e.sourceEnd);
  // 隣接窓の境界が一致する
  for (let i = 0; i < w.length - 1; i++) {
    assert.equal(w[i].outputEnd, w[i + 1].outputStart);
    assert.equal(w[i].sourceEnd, w[i + 1].sourceStart);
    assert.equal(w[i].speed, w[i + 1].speed);
  }
});

test("splitEntryIntoWindows: 窓長が区間と一致すると1個", () => {
  const e = entry({ outputStart: 0, outputEnd: 1, sourceStart: 0, sourceEnd: 1 });
  const w = splitEntryIntoWindows(e, 1);
  assert.equal(w.length, 1);
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

function fakeCreateBuffer() {
  return (channels: number, length: number, sampleRate: number): AudioBuffer => {
    const data: Float32Array[] = [];
    for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
    return {
      sampleRate,
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      getChannelData: (c: number) => data[c],
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  };
}

test("concatAudioBuffers: 3枚の連結で長さと値が連続する", () => {
  const ctx = { createBuffer: fakeCreateBuffer() };
  const b1 = ctx.createBuffer(1, 3, 48000);
  b1.getChannelData(0).set([1, 2, 3]);
  const b2 = ctx.createBuffer(1, 2, 48000);
  b2.getChannelData(0).set([4, 5]);
  const b3 = ctx.createBuffer(1, 4, 48000);
  b3.getChannelData(0).set([6, 7, 8, 9]);
  const out = concatAudioBuffers([b1, b2, b3], ctx);
  assert.ok(out);
  assert.equal(out!.length, 9);
  assert.deepEqual(Array.from(out!.getChannelData(0)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("concatAudioBuffers: 空配列はnull", () => {
  const ctx = { createBuffer: fakeCreateBuffer() };
  assert.equal(concatAudioBuffers([], ctx), null);
});

test("concatAudioBuffers: sampleRate不一致は例外", () => {
  const ctx = { createBuffer: fakeCreateBuffer() };
  const b1 = ctx.createBuffer(1, 1, 48000);
  const b2 = ctx.createBuffer(1, 1, 44100);
  assert.throws(() => concatAudioBuffers([b1, b2], ctx), /mismatched sampleRate/);
});

test("concatAudioBuffers: channel数不一致は例外", () => {
  const ctx = { createBuffer: fakeCreateBuffer() };
  const b1 = ctx.createBuffer(1, 1, 48000);
  const b2 = ctx.createBuffer(2, 1, 48000);
  assert.throws(() => concatAudioBuffers([b1, b2], ctx), /mismatched numberOfChannels/);
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
