import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probe } from "../src/lib/ffmpeg.ts";
import { inspectPreviewCutFreshness } from "../src/lib/previewCutCache.ts";
import {
  buildPreviewCut,
  evaluatePreviewCutProbe,
  previewCutDurationTolerance,
  previewCutFrameSegments,
} from "../src/stages/previewCut.ts";
import { run } from "../src/lib/exec.ts";
import { frameSpans } from "../src/lib/renderProps.ts";
import { buildTimeline, playbackSegmentsOf, timelineDuration } from "../src/lib/timeline.ts";
import type { Config } from "../src/lib/config.ts";
import type { CutPlan } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const CFG = {
  preview: { width: 1280, videoEncoder: "libx264" },
} as Config;
const PLAN: CutPlan = {
  approved: false,
  segments: [
    { start: 0.5, end: 1.5, action: "keep", reason: "normal" },
    { start: 1.5, end: 2, action: "cut", reason: "cut" },
    { start: 2, end: 4, action: "keep", reason: "fast", speed: 2 },
  ],
};

let dir: string;
let proxyPath: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cutflow-preview-cut-stage-"));
  proxyPath = join(dir, "proxy.mp4");
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=96x64:rate=10:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-shortest",
    proxyPath,
  ]);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("evaluatePreviewCutProbe: stream数・解像度・正の尺・fps由来許容差を検査する", () => {
  const good = {
    streams: [
      { index: 0, codec_type: "video", width: 96, height: 64, avg_frame_rate: "10/1", nb_frames: "20" },
      { index: 1, codec_type: "audio" },
    ],
    format: { duration: "2.05" },
  };
  assert.deepEqual(evaluatePreviewCutProbe(good, {
    width: 96, height: 64, fps: 10, durationSec: 2, videoFrames: 20,
  }), { ok: true });
  assert.equal(evaluatePreviewCutProbe({ ...good, streams: good.streams.slice(0, 1) }, {
    width: 96, height: 64, fps: 10, durationSec: 2, videoFrames: 20,
  }).ok, false);
  assert.equal(evaluatePreviewCutProbe({ ...good, format: { duration: "3" } }, {
    width: 96, height: 64, fps: 10, durationSec: 2, videoFrames: 20,
  }).ok, false);
});

test("previewCutFrameSegments: Playerと同じframe境界を使い、frame数とcontainer尺を別々に検査する", () => {
  const keeps = [
    { start: 0.016, end: 1.049, speed: 1 },
    { start: 2.001, end: 2.072, speed: 2 },
  ];
  const fps = 30;
  const frameSegments = previewCutFrameSegments(keeps, fps);
  assert.deepEqual(frameSegments, [
    { sourceStartFrame: 0, sourceEndFrame: 31, outputFrames: 31, speed: 1 },
    { sourceStartFrame: 60, sourceEndFrame: 62, outputFrames: 1, speed: 2 },
  ]);
  const timeline = buildTimeline(keeps);
  const playerSpans = frameSpans({
    baseSegments: timeline.map((entry) => ({
      start: entry.outputStart,
      durationSec: entry.outputEnd - entry.outputStart,
    })),
    inserts: [],
    fps,
    durationInFrames: Math.round(timelineDuration(timeline) * fps),
  });
  assert.deepEqual(
    frameSegments.map((segment) => segment.outputFrames),
    playerSpans.base.map((span) => span.durationInFrames),
  );

  const tolerance = previewCutDurationTolerance(30);
  assert.ok(tolerance >= 0.1);
  assert.ok(tolerance < 0.2);
  const expected = {
    width: 2560,
    height: 720,
    fps: 30,
    durationSec: 32 / 30,
    videoFrames: 32,
  };
  const probeResult = (duration: number, frames = 32) => ({
    streams: [
      { index: 0, codec_type: "video", width: 2560, height: 720, nb_frames: String(frames) },
      { index: 1, codec_type: "audio" },
    ],
    format: { duration: String(duration) },
  });
  assert.deepEqual(evaluatePreviewCutProbe(probeResult(32 / 30 + 0.05), expected), { ok: true });
  const wrongFrames = evaluatePreviewCutProbe(probeResult(32 / 30, 33), expected);
  assert.equal(wrongFrames.ok, false);
  assert.match("reason" in wrongFrames ? wrongFrames.reason : "", /video frame 数/);
  const wrongDuration = evaluatePreviewCutProbe(probeResult(32 / 30 + 1), expected);
  assert.equal(wrongDuration.ok, false);
  assert.match("reason" in wrongDuration ? wrongDuration.reason : "", /duration が期待値から外れています/);
});

test("buildPreviewCut: proxyから keeps+speed を焼き、A/V各1本・AAC 48k・同寸法・期待尺・faststart で公開する", async () => {
  const result = await buildPreviewCut(dir, CFG, PLAN);
  assert.equal(result.reused, false);
  assert.equal(result.path, join(dir, "preview-cut.mp4"));
  assert.ok(existsSync(result.path));
  assert.ok(existsSync(join(dir, "preview-cut.key.json")));

  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-show_format",
    "-of", "json", result.path,
  ]);
  const measured = JSON.parse(stdout) as {
    streams: Array<{
      codec_type: string;
      codec_name?: string;
      sample_rate?: string;
      width?: number;
      height?: number;
      nb_read_frames?: string;
    }>;
    format: { duration: string };
  };
  const videos = measured.streams.filter((stream) => stream.codec_type === "video");
  const audios = measured.streams.filter((stream) => stream.codec_type === "audio");
  assert.equal(videos.length, 1);
  assert.equal(audios.length, 1);
  assert.equal(videos[0].width, 96);
  assert.equal(videos[0].height, 64);
  assert.ok(
    Math.abs(Number(measured.format.duration) - 2) <=
      previewCutDurationTolerance(10) + 1e-9,
  );
  assert.equal(Number(videos[0].nb_read_frames), 20);
  assert.equal(audios[0].codec_name, "aac");
  assert.equal(audios[0].sample_rate, "48000");
  const bytes = readFileSync(result.path);
  assert.ok(bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")), "moov atom が mdat より前(faststart)");
});

test("buildPreviewCut: 実ffmpegの多数短区間+speedをPlayer準拠の厳密frame数へ焼く", async (t) => {
  const manyDir = mkdtempSync(join(tmpdir(), "cutflow-preview-cut-many-segments-"));
  try {
    const manyProxy = join(manyDir, "proxy.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=96x64:rate=30:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-shortest",
      manyProxy,
    ]);
    const speeds = [0.5, 1, 2] as const;
    const manyPlan: CutPlan = {
      approved: false,
      segments: Array.from({ length: 60 }, (_, index) => {
        const start = index * 0.18 + 0.007;
        return {
          start,
          end: start + 0.071,
          action: "keep" as const,
          reason: "quantized short keep",
          speed: speeds[index % speeds.length],
        };
      }),
    };
    const frameSegments = previewCutFrameSegments(playbackSegmentsOf(manyPlan), 30);
    const expectedFrames = frameSegments.reduce((sum, segment) => sum + segment.outputFrames, 0);
    const expectedDuration = expectedFrames / 30;
    const result = await buildPreviewCut(manyDir, CFG, manyPlan);
    const measured = await probe(result.path);
    const video = measured.streams.find((stream) => stream.codec_type === "video");
    const measuredDuration = Number(measured.format?.duration);
    const drift = Math.abs(measuredDuration - expectedDuration);
    const tolerance = previewCutDurationTolerance(30);
    assert.equal(Number(video?.nb_frames), expectedFrames);
    assert.ok(drift <= tolerance, `drift=${drift}, tolerance=${tolerance}`);
    t.diagnostic(
      `60 keeps, speeds 0.5/1/2: frames=${expectedFrames}, expected=${expectedDuration.toFixed(3)}s, ` +
        `measured=${measuredDuration.toFixed(3)}s, drift=${drift.toFixed(3)}s, ` +
        `tolerance=${tolerance.toFixed(3)}s`,
    );
  } finally {
    rmSync(manyDir, { recursive: true, force: true });
  }
});

test("buildPreviewCut: 同一入力はsidecar/output statを確認して再利用する", async () => {
  const beforeBytes = readFileSync(join(dir, "preview-cut.mp4"));
  const result = await buildPreviewCut(dir, CFG, PLAN, {
    run: async () => {
      throw new Error("cache hit なら呼ばれない");
    },
  });
  assert.equal(result.reused, true);
  assert.deepEqual(readFileSync(result.path), beforeBytes);
});

test("buildPreviewCut: produce失敗は旧mp4/sidecarを保護する", async () => {
  const oldMp4 = readFileSync(join(dir, "preview-cut.mp4"));
  const oldKey = readFileSync(join(dir, "preview-cut.key.json"));
  const changed = structuredClone(PLAN);
  changed.segments[0].end = 1.4;
  await assert.rejects(
    buildPreviewCut(dir, CFG, changed, {
      run: async () => { throw new Error("synthetic encode failure"); },
    }),
    /synthetic encode failure/,
  );
  assert.deepEqual(readFileSync(join(dir, "preview-cut.mp4")), oldMp4);
  assert.deepEqual(readFileSync(join(dir, "preview-cut.key.json")), oldKey);
});

test("buildPreviewCut: ffprobe verify失敗は旧mp4/sidecarを保護する", async () => {
  const oldMp4 = readFileSync(join(dir, "preview-cut.mp4"));
  const oldKey = readFileSync(join(dir, "preview-cut.key.json"));
  const changed = structuredClone(PLAN);
  changed.segments[2].speed = 1.5;
  await assert.rejects(
    buildPreviewCut(dir, CFG, changed, {
      probe: async (path) => path === proxyPath
        ? probe(path)
        : { streams: [], format: { duration: "0" } },
    }),
    /成果物の検証に失敗/,
  );
  assert.deepEqual(readFileSync(join(dir, "preview-cut.mp4")), oldMp4);
  assert.deepEqual(readFileSync(join(dir, "preview-cut.key.json")), oldKey);
});

test("buildPreviewCut: proxy driftは公開を止め、旧mp4/sidecarを保護する", async () => {
  const oldMp4 = readFileSync(join(dir, "preview-cut.mp4"));
  const oldKey = readFileSync(join(dir, "preview-cut.key.json"));
  const changed = structuredClone(PLAN);
  changed.segments[0].start = 0.6;
  await assert.rejects(
    buildPreviewCut(dir, CFG, changed, {
      run: async (cmd, args, opts) => {
        const result = await run(cmd, args, opts);
        appendFileSync(proxyPath, Buffer.from([0]));
        return result;
      },
    }),
    /入力ファイルが変化しました/,
  );
  assert.deepEqual(readFileSync(join(dir, "preview-cut.mp4")), oldMp4);
  assert.deepEqual(readFileSync(join(dir, "preview-cut.key.json")), oldKey);
});

test("buildPreviewCut: stale proxy はエンコードせず拒否する", async () => {
  await assert.rejects(
    buildPreviewCut(dir, CFG, PLAN, {
      isProxyStale: () => true,
      run: async () => { throw new Error("呼ばれてはいけない"); },
    }),
    /proxy\.mp4 が古い/,
  );
});

test("sidecarは公開mp4 statを束縛し、mp4だけ変わればfreshにならない", () => {
  const sidecar = JSON.parse(readFileSync(join(dir, "preview-cut.key.json"), "utf8"));
  appendFileSync(join(dir, "preview-cut.mp4"), Buffer.from([0]));
  assert.deepEqual(inspectPreviewCutFreshness({
    dir,
    currentKey: sidecar.key,
    proxyFresh: true,
  }), { fresh: false, reason: "output-stat-mismatch" });
});
