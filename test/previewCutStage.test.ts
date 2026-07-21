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
} from "../src/stages/previewCut.ts";
import { run } from "../src/lib/exec.ts";
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
      { index: 0, codec_type: "video", width: 96, height: 64, avg_frame_rate: "10/1" },
      { index: 1, codec_type: "audio" },
    ],
    format: { duration: "2.05" },
  };
  assert.deepEqual(evaluatePreviewCutProbe(good, {
    width: 96, height: 64, fps: 10, durationSec: 2,
  }), { ok: true });
  assert.equal(evaluatePreviewCutProbe({ ...good, streams: good.streams.slice(0, 1) }, {
    width: 96, height: 64, fps: 10, durationSec: 2,
  }).ok, false);
  assert.equal(evaluatePreviewCutProbe({ ...good, format: { duration: "3" } }, {
    width: 96, height: 64, fps: 10, durationSec: 2,
  }).ok, false);
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
  assert.ok(Math.abs(Number(measured.format.duration) - 2) <= 0.2 + 1e-9);
  assert.ok(Math.abs(Number(videos[0].nb_read_frames) - 20) <= 2);
  assert.equal(audios[0].codec_name, "aac");
  assert.equal(audios[0].sample_rate, "48000");
  const bytes = readFileSync(result.path);
  assert.ok(bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")), "moov atom が mdat より前(faststart)");
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
