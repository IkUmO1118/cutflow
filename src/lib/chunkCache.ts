import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "./exec.ts";

/**
 * render チャンク差分レンダー(docs/render-chunk-cache.md)の ffmpeg/ffprobe
 * 実行部分。境界の決定・キー計算(純関数)は chunkPlan.ts、結線は
 * stages/render.ts。ここは薄いラッパのみで判断はしない。
 */

/** チャンク映像ファイル名(0始まり連番、3桁ゼロ埋め) */
export function chunkFileName(index: number): string {
  return `v${String(index).padStart(3, "0")}.mp4`;
}

/**
 * final.mp4 を keyframe 境界(boundaries、carveBoundaries が返すもの)で
 * video-only のチャンクに carve する。`-segment_frames`(フレーム指定)で
 * 割るので `-segment_time` のような時間ベースの丸め誤差が出ない。
 * 戻り値は生成した各チャンクファイルの絶対パス(boundaries.length - 1 件)。
 */
export async function carveFinalToChunks(
  finalMp4: string,
  boundaries: number[],
  outDir: string,
): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const segmentFrames = boundaries.slice(1, -1).join(",");
  const pattern = join(outDir, "v%03d.mp4");
  const args = [
    "-y", "-v", "error",
    "-i", finalMp4,
    "-map", "0:v",
    "-c", "copy",
    "-f", "segment",
    "-reset_timestamps", "1",
  ];
  if (segmentFrames) args.push("-segment_frames", segmentFrames);
  args.push(pattern);
  await run("ffmpeg", args);
  const count = boundaries.length - 1;
  return Array.from({ length: count }, (_, i) => join(outDir, chunkFileName(i)));
}

/** final.mp4 の連続音声を `-c copy` で1本抜き出す(全チャンク共通で再利用) */
export async function extractAudio(finalMp4: string, outM4a: string): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", finalMp4,
    "-map", "0:a",
    "-c", "copy",
    outM4a,
  ]);
}

/** チャンク映像ファイル群を concat demuxer で `-c copy` 連結する。
 * 各チャンクの先頭が keyframe(閉じ GOP)である前提(docs §1 で確認済み)。 */
export async function concatChunks(chunkFiles: string[], outMp4: string): Promise<void> {
  const listPath = join(dirname(outMp4), `.concat-${process.pid}-${chunkFiles.length}.txt`);
  const body = chunkFiles
    .map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(listPath, `${body}\n`);
  try {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outMp4,
    ]);
  } finally {
    rmSync(listPath, { force: true });
  }
}

/** 連結済み映像(video only)と連続音声を `-c copy` で mux する */
export async function muxVideoAudio(
  video: string,
  audioM4a: string,
  outMp4: string,
): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", video,
    "-i", audioM4a,
    "-map", "0:v",
    "-map", "1:a",
    "-c", "copy",
    "-shortest",
    outMp4,
  ]);
}

/** 動画の keyframe 位置(フレーム番号、0始まり)を全件返す。
 * B フレームを使わない(decode順=表示順)閉じ GOP 前提(docs §1 で確認済み)。 */
export async function probeKeyframes(mp4: string): Promise<number[]> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "frame=key_frame",
    "-of", "csv=p=0",
    mp4,
  ]);
  // ffprobe の csv=p=0 出力は行によって末尾にカンマが付く(例: "1,")ことが
  // あるため、行全体ではなく先頭フィールドだけを見る
  const keyframes: number[] = [];
  stdout.split("\n").forEach((line, i) => {
    if (line.split(",")[0].trim() === "1") keyframes.push(i);
  });
  return keyframes;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * concat+mux した成果物を検証する(§5)。総フレーム数・コンテナ/音声
 * duration・フレームレート・先頭 keyframe をチェックし、少しでも不審なら
 * NG を返す(呼び出し側はフルレンダーへフォールバックすること)。
 */
export async function verifyAssembled(
  mp4: string,
  expectedFrames: number,
  durationSec: number,
  fps: number,
): Promise<VerifyResult> {
  let probe: {
    streams?: { codec_type: string; nb_read_frames?: string; duration?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_type,nb_read_frames,duration,r_frame_rate:format=duration",
      "-of", "json",
      mp4,
    ]);
    probe = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(err as Error).message}` };
  }
  const video = probe.streams?.find((s) => s.codec_type === "video");
  if (!video) return { ok: false, reason: "映像ストリームが見つかりません" };

  const frameCount = Number(video.nb_read_frames);
  if (frameCount !== expectedFrames) {
    return {
      ok: false,
      reason: `総フレーム数が不一致です(期待 ${expectedFrames}、実測 ${frameCount})`,
    };
  }

  const [num, den] = String(video.r_frame_rate ?? "").split("/").map(Number);
  const actualFps = den ? num / den : num;
  if (!Number.isFinite(actualFps) || Math.round(actualFps) !== Math.round(fps)) {
    return {
      ok: false,
      reason: `フレームレートが不一致です(期待 ${fps}、実測 ${actualFps})`,
    };
  }

  const tolerance = 1 / fps;
  const containerDuration = Number(probe.format?.duration);
  if (!Number.isFinite(containerDuration) || Math.abs(containerDuration - durationSec) > tolerance) {
    return {
      ok: false,
      reason: `コンテナ duration が不一致です(期待 ${durationSec}秒、実測 ${containerDuration}秒)`,
    };
  }

  const audio = probe.streams?.find((s) => s.codec_type === "audio");
  if (audio) {
    const audioDuration = Number(audio.duration);
    if (!Number.isFinite(audioDuration) || Math.abs(audioDuration - durationSec) > tolerance) {
      return {
        ok: false,
        reason: `音声 duration が不一致です(期待 ${durationSec}秒、実測 ${audioDuration}秒)`,
      };
    }
  }

  const keyframes = await probeKeyframes(mp4);
  if (keyframes[0] !== 0) {
    return { ok: false, reason: "先頭フレームが keyframe ではありません" };
  }

  return { ok: true };
}
