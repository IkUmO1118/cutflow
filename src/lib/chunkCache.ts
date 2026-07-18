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

interface DecodedVideoProbe {
  nbReadFrames: number;
  listedFrames: number;
  keyframeFrames: number[];
}

function parseDecodedVideoProbe(stdout: string): DecodedVideoProbe {
  const probe = JSON.parse(stdout) as {
    streams?: { nb_read_frames?: string }[];
    frames?: { key_frame?: number | string }[];
  };
  const frames = Array.isArray(probe.frames) ? probe.frames : [];
  return {
    nbReadFrames: Number(probe.streams?.[0]?.nb_read_frames),
    listedFrames: frames.length,
    keyframeFrames: frames.flatMap((frame, index) => Number(frame.key_frame) === 1 ? [index] : []),
  };
}

/** 選択映像streamを全frame decodeし、総数とkeyframeのdecoded ordinalを
 * 1回のffprobeで得る。チャンクcarveの契約は従来どおり閉じGOP前提。 */
async function probeDecodedVideo(mp4: string): Promise<DecodedVideoProbe> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=nb_read_frames:frame=key_frame",
    "-of", "json",
    mp4,
  ]);
  return parseDecodedVideoProbe(stdout);
}

/** 動画の keyframe 位置(decoded frame ordinal、0始まり)を全件返す。 */
export async function probeKeyframes(mp4: string): Promise<number[]> {
  return (await probeDecodedVideo(mp4)).keyframeFrames;
}

export type VerifyResult =
  | { ok: true; keyframeFrames: number[] }
  | { ok: false; reason: string };

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
  let decoded: DecodedVideoProbe;
  let metadata: {
    streams?: { codec_type: string; duration?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  try {
    decoded = await probeDecodedVideo(mp4);
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries",
      "stream=codec_type,duration,r_frame_rate:format=duration",
      "-of", "json",
      mp4,
    ]);
    metadata = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(err as Error).message}` };
  }
  const video = metadata.streams?.find((s) => s.codec_type === "video");
  if (!video) return { ok: false, reason: "映像ストリームが見つかりません" };

  if (decoded.nbReadFrames !== expectedFrames) {
    return {
      ok: false,
      reason: `総フレーム数が不一致です(期待 ${expectedFrames}、実測 ${decoded.nbReadFrames})`,
    };
  }
  if (decoded.listedFrames !== expectedFrames) {
    return {
      ok: false,
      reason: `列挙フレーム数が不一致です(期待 ${expectedFrames}、実測 ${decoded.listedFrames})`,
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
  const containerDuration = Number(metadata.format?.duration);
  if (!Number.isFinite(containerDuration) || Math.abs(containerDuration - durationSec) > tolerance) {
    return {
      ok: false,
      reason: `コンテナ duration が不一致です(期待 ${durationSec}秒、実測 ${containerDuration}秒)`,
    };
  }

  const audio = metadata.streams?.find((s) => s.codec_type === "audio");
  if (audio) {
    const audioDuration = Number(audio.duration);
    if (!Number.isFinite(audioDuration) || Math.abs(audioDuration - durationSec) > tolerance) {
      return {
        ok: false,
        reason: `音声 duration が不一致です(期待 ${durationSec}秒、実測 ${audioDuration}秒)`,
      };
    }
  }

  if (decoded.keyframeFrames[0] !== 0) {
    return { ok: false, reason: "先頭フレームが keyframe ではありません" };
  }

  return { ok: true, keyframeFrames: decoded.keyframeFrames };
}

/**
 * §8.4 render transaction 用の検証器2つ(publishAsTransaction の VerifyFn に
 * そのまま渡せる)。verifyAssembled(既存・チャンク再組立て専用)とは意図的に
 * 独立させる: 各々「async ffprobe ラッパ + 純評価関数(probeJson: unknown)」に
 * 分けて ffmpeg 無しでロジックをユニットテストできるようにする。
 */

/**
 * cut.mp4(VFR の中間ファイル。trim+concat の結果でフレーム数は事前に
 * 不明)向けの検証。厳密なフレーム数チェックはできない(そもそも期待値が
 * 無い)ので、「映像ストリームが1本以上あり、format.duration が有限かつ
 * 正」= 非空・可読であることだけを見る。
 */
export function evaluatePlayableProbe(probeJson: unknown): VerifyResult {
  const probe = probeJson as {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const hasVideo = streams.some((s) => s.codec_type === "video");
  if (!hasVideo) return { ok: false, reason: "映像ストリームが見つかりません" };

  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      ok: false,
      reason: `duration が不正です(実測 ${probe.format?.duration ?? "なし"})`,
    };
  }
  return { ok: true, keyframeFrames: [] };
}

/** cut.mp4 等の中間ファイルが再生可能か(空でない・壊れていない)を ffprobe で見る */
export async function verifyPlayableVideo(mp4: string): Promise<VerifyResult> {
  let probeJson: unknown;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type:format=duration",
      "-of", "json",
      mp4,
    ]);
    probeJson = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(err as Error).message}` };
  }
  return evaluatePlayableProbe(probeJson);
}

/**
 * final.mp4 / shorts(composition から期待フレーム数が既知)向けの検証。
 * 映像ストリームの存在・decode フレーム数の完全一致・fps 一致を見る。
 * 先頭 keyframe assert は意図的に入れない(フルレンダーにはチャンク経路の
 * ようなフォールバックが無く、false-negative で正当な render を塞ぐと
 * 有害なため)。
 *
 * duration は **映像ストリーム自身の duration**(`streams[].duration`)とだけ
 * 突き合わせる(実測で判明: container の `format.duration` は BGM 等の
 * audio tail が映像より長いと正当に伸びる。フル remotion 出力は
 * `-shortest` を使わないため container ≠ 映像長になり得る。verifyAssembled
 * (チャンク経路)が container で見て問題ないのは `muxVideoAudio` が
 * `-shortest` で audio を映像長に切り詰めているため)。video duration が
 * 欠落/非数値のときは lenient にスキップする(フレーム数完全一致+fps一致が
 * 主要ガードで実測で確実。duration は補助的なクロスチェックに留め、
 * 欠落時の false-negative で正当な render を塞がないことを優先する)。
 */
export function evaluateExactFramesProbe(
  probeJson: unknown,
  expectedFrames: number,
  durationSec: number,
  fps: number,
): VerifyResult {
  const probe = probeJson as {
    streams?: {
      codec_type?: string;
      nb_read_frames?: string;
      r_frame_rate?: string;
      duration?: string;
    }[];
  };
  const video = probe.streams?.find((s) => s.codec_type === "video");
  if (!video) return { ok: false, reason: "映像ストリームが見つかりません" };

  const nbReadFrames = Number(video.nb_read_frames);
  if (nbReadFrames !== expectedFrames) {
    return {
      ok: false,
      reason: `総フレーム数が不一致です(期待 ${expectedFrames}、実測 ${nbReadFrames})`,
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

  const videoDuration = Number(video.duration);
  if (Number.isFinite(videoDuration)) {
    const tolerance = 1 / fps;
    if (Math.abs(videoDuration - durationSec) > tolerance) {
      return {
        ok: false,
        reason: `映像ストリームの duration が不一致です(期待 ${durationSec}秒、実測 ${videoDuration}秒)`,
      };
    }
  }

  return { ok: true, keyframeFrames: [] };
}

/** final.mp4 / shorts/<name>.mp4 が期待どおりのフレーム数・fps・durationか ffprobe で見る */
export async function verifyRenderedVideo(
  mp4: string,
  expectedFrames: number,
  durationSec: number,
  fps: number,
): Promise<VerifyResult> {
  let probeJson: unknown;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=codec_type,nb_read_frames,r_frame_rate,duration",
      "-of", "json",
      mp4,
    ]);
    probeJson = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(err as Error).message}` };
  }
  return evaluateExactFramesProbe(probeJson, expectedFrames, durationSec, fps);
}
