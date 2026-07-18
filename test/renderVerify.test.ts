// lib/chunkCache.ts の §8.4 render transaction 用検証器2つ
// (evaluatePlayableProbe / evaluateExactFramesProbe)を、合成 ffprobe JSON で
// 固定する。ffmpeg 不要な純関数のみ対象(async ラッパ側は実 ffprobe 起動が
// 要るため既存 chunkCache.test.ts 側の統合テストに任せる)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateExactFramesProbe,
  evaluatePlayableProbe,
} from "../src/lib/chunkCache.ts";

test("evaluatePlayableProbe: 映像ストリーム+duration>0 なら ok", () => {
  const probe = {
    streams: [{ codec_type: "video" }],
    format: { duration: "3.5" },
  };
  const result = evaluatePlayableProbe(probe);
  assert.deepEqual(result, { ok: true, keyframeFrames: [] });
});

test("evaluatePlayableProbe: 映像ストリームが無ければ NG", () => {
  const probe = {
    streams: [{ codec_type: "audio" }],
    format: { duration: "3.5" },
  };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

test("evaluatePlayableProbe: streams が空なら NG", () => {
  const probe = { streams: [], format: { duration: "3.5" } };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

test("evaluatePlayableProbe: duration が 0 なら NG", () => {
  const probe = { streams: [{ codec_type: "video" }], format: { duration: "0" } };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

test("evaluatePlayableProbe: duration が NaN なら NG", () => {
  const probe = { streams: [{ codec_type: "video" }], format: { duration: "not-a-number" } };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

test("evaluatePlayableProbe: duration が欠落なら NG", () => {
  const probe = { streams: [{ codec_type: "video" }], format: {} };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

test("evaluatePlayableProbe: format 自体が欠落でも NG(例外を投げない)", () => {
  const probe = { streams: [{ codec_type: "video" }] };
  const result = evaluatePlayableProbe(probe);
  assert.equal(result.ok, false);
});

const FPS = 30;
const DURATION = 10; // 秒
const EXPECTED_FRAMES = 300;

function baseProbe(overrides: {
  nbReadFrames?: number;
  rFrameRate?: string;
  duration?: string;
  hasVideoStream?: boolean;
  /** false なら video stream に duration キー自体を付けない
   * (real remotion 出力で container の -shortest 非使用時に相当する、
   * 「video stream 自身の duration も無い」ケースの回帰テスト用) */
  hasDuration?: boolean;
} = {}) {
  const {
    nbReadFrames = EXPECTED_FRAMES,
    rFrameRate = "30/1",
    duration = String(DURATION),
    hasVideoStream = true,
    hasDuration = true,
  } = overrides;
  return {
    streams: hasVideoStream
      ? [
          {
            codec_type: "video",
            nb_read_frames: String(nbReadFrames),
            r_frame_rate: rFrameRate,
            ...(hasDuration ? { duration } : {}),
          },
        ]
      : [],
  };
}

test("evaluateExactFramesProbe: 完全一致なら ok", () => {
  const result = evaluateExactFramesProbe(baseProbe(), EXPECTED_FRAMES, DURATION, FPS);
  assert.deepEqual(result, { ok: true, keyframeFrames: [] });
});

test("evaluateExactFramesProbe: frame off-by-one で NG", () => {
  const probe = baseProbe({ nbReadFrames: EXPECTED_FRAMES + 1 });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.equal(result.ok, false);
});

test("evaluateExactFramesProbe: fps 不一致で NG", () => {
  const probe = baseProbe({ rFrameRate: "24/1" });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.equal(result.ok, false);
});

test("evaluateExactFramesProbe: duration が許容(1/fps)を超えて超過で NG", () => {
  const tolerance = 1 / FPS;
  const probe = baseProbe({ duration: String(DURATION + tolerance * 2) });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.equal(result.ok, false);
});

test("evaluateExactFramesProbe: duration が許容(1/fps)内なら ok", () => {
  const tolerance = 1 / FPS;
  const probe = baseProbe({ duration: String(DURATION + tolerance * 0.5) });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.deepEqual(result, { ok: true, keyframeFrames: [] });
});

test("evaluateExactFramesProbe: 映像ストリーム欠落で NG", () => {
  const probe = baseProbe({ hasVideoStream: false });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.equal(result.ok, false);
});

// 回帰テスト: 実測で判明したバグ(coordinator 報告)。フル remotion 出力は
// -shortest を使わないため BGM 等の audio tail が映像より長く container
// duration が伸びうる。評価関数は container ではなく video stream 自身の
// duration しか見ないため、この状況は起きない(video stream に container
// の影響は及ばない)。ここでは video stream 自身の duration が欠落した
// ケースを見て、フレーム数・fps が合っていれば lenient に ok を返すこと
// (false-negative でフルレンダーを止めない)を固定する
test("evaluateExactFramesProbe: video stream の duration が欠落してもフレーム数・fps が合えば ok(lenient skip)", () => {
  const probe = baseProbe({ hasDuration: false });
  const result = evaluateExactFramesProbe(probe, EXPECTED_FRAMES, DURATION, FPS);
  assert.deepEqual(result, { ok: true, keyframeFrames: [] });
});

// 実 remotion 出力を模した状況: video stream の duration(210.033s)は映像長と
// 一致するが、別途 audio(BGM tail)が長い(212.096s)せいで従来は container
// duration を見て false-negative だった。評価関数は選択済み video stream
// しか見ないため、streams に video 1本だけ入れて duration=210.033 で
// ok になることを確認すれば実測ケースの再現として十分
test("evaluateExactFramesProbe: 実測ケース(video=210.033s一致・audio tailは無視)は ok", () => {
  const probe = {
    streams: [
      {
        codec_type: "video",
        nb_read_frames: "6301",
        r_frame_rate: "30/1",
        duration: "210.033",
      },
    ],
  };
  const result = evaluateExactFramesProbe(probe, 6301, 210.033, 30);
  assert.deepEqual(result, { ok: true, keyframeFrames: [] });
});
