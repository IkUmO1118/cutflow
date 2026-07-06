// lib/chunkCache.ts — carve→concat の可逆性(framemd5 バイト完全一致)と
// mux 後の検証を、合成素材(lavfi)で固定する。CI にベンチ収録は無いので
// ffmpeg で生成した小さな動画を使う(docs/render-chunk-cache.md §1-2/1-3 の
// 実測をここで自動化する)。統合寄りのテストのため実際に ffmpeg/ffprobe を
// 起動する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  carveFinalToChunks,
  concatChunks,
  extractAudio,
  muxVideoAudio,
  probeKeyframes,
  verifyAssembled,
} from "../src/lib/chunkCache.ts";
import { carveBoundaries } from "../src/lib/chunkPlan.ts";

const execFileAsync = promisify(execFile);

const FPS = 10;
const TOTAL_FRAMES = 30; // 3秒 @ 10fps

let dir: string;
let sourceMp4: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cutflow-chunkcache-"));
  sourceMp4 = join(dir, "source.mp4");
  // GOP=10(1秒毎)・B フレームなしの閉じ GOP(本番の Remotion 出力と同じ前提)。
  // sc_threshold 0 でシーンカット検出による余分な keyframe 挿入を止める
  await execFileAsync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc=size=64x64:rate=${FPS}:duration=3`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-bf", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    sourceMp4,
  ]);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function framemd5Of(file: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

test("probeKeyframes: GOP=10 の合成素材で keyframe が10フレーム毎に立つ", async () => {
  const keyframes = await probeKeyframes(sourceMp4);
  assert.deepEqual(keyframes, [0, 10, 20]);
});

test("carveBoundaries + carveFinalToChunks + concatChunks: 可逆(framemd5 バイト完全一致)", async () => {
  const keyframes = await probeKeyframes(sourceMp4);
  const boundaries = carveBoundaries(keyframes, TOTAL_FRAMES, 1, FPS); // 1秒チャンク狙い
  assert.deepEqual(boundaries, [0, 10, 20, 30]);

  const outDir = join(dir, "chunks");
  const chunkFiles = await carveFinalToChunks(sourceMp4, boundaries, outDir);
  assert.equal(chunkFiles.length, 3);
  for (const f of chunkFiles) assert.ok(existsSync(f), `${f} が生成されている`);

  const reassembled = join(dir, "reassembled.mp4");
  await concatChunks(chunkFiles, reassembled);

  const originalMd5 = await framemd5Of(sourceMp4);
  const reassembledMd5 = await framemd5Of(reassembled);
  assert.equal(reassembledMd5, originalMd5, "carve→concat は元動画と framemd5 バイト完全一致");
});

test("extractAudio + muxVideoAudio + verifyAssembled: 総フレーム数・duration が一致", async () => {
  const keyframes = await probeKeyframes(sourceMp4);
  const boundaries = carveBoundaries(keyframes, TOTAL_FRAMES, 1, FPS);
  const outDir = join(dir, "chunks2");
  const chunkFiles = await carveFinalToChunks(sourceMp4, boundaries, outDir);
  const videoOnly = join(dir, "video-only.mp4");
  await concatChunks(chunkFiles, videoOnly);

  const audioM4a = join(dir, "audio.m4a");
  await extractAudio(sourceMp4, audioM4a);
  assert.ok(existsSync(audioM4a));

  const finalMp4 = join(dir, "final.mp4");
  await muxVideoAudio(videoOnly, audioM4a, finalMp4);

  const result = await verifyAssembled(finalMp4, TOTAL_FRAMES, 3, FPS);
  assert.deepEqual(result, { ok: true });
});

test("verifyAssembled: 期待フレーム数と違えば NG", async () => {
  const result = await verifyAssembled(sourceMp4, TOTAL_FRAMES + 1, 3, FPS);
  assert.equal(result.ok, false);
});

test("verifyAssembled: 期待 duration と違えば NG", async () => {
  const result = await verifyAssembled(sourceMp4, TOTAL_FRAMES, 10, FPS);
  assert.equal(result.ok, false);
});
