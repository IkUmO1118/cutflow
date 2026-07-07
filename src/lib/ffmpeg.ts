import { run } from "./exec.ts";
import type { Interval } from "../types.ts";

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | string;
  /** ストリームのコーデック名(例: "h264" / "aac" / "png")。素材メタ要約
   * (summarizeProbe)向けの追加フィールド。既存呼び出し元は無視してよい */
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  /** ストリーム単位の尺(秒。文字列)。省略時が既存挙動(コンテナ尺
   * format.duration を使う呼び出し元には影響しない追加フィールド) */
  duration?: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration: string };
}

/** 素材(B-roll)の中身を AI が知る手段。ffprobe 結果から尺・寸法・fps・
 * 音声有無・codec を要約する(素材知覚 `materials` コマンドが使う純関数)。
 * video/audio ストリームが無い(壊れたファイル・非対応形式)場合は該当
 * フィールドを省略する(hasAudio だけは常に boolean で確定する) */
export interface MaterialProbe {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

/** format.duration(コンテナ尺)を秒数へ。欠落("N/A"・未設定。画像素材で
 * 起こりうる)は undefined を返す(呼び出し側は「尺不明」として扱う) */
function parseContainerDurationSec(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const n = Number(duration);
  return Number.isFinite(n) ? n : undefined;
}

/** ProbeResult から MaterialProbe を組み立てる純関数(実 ffprobe 非依存・
 * テスト対象)。video ストリームから width/height/fps/videoCodec、audio
 * ストリームから audioCodec・hasAudio、format.duration から durationSec を
 * 導く。複数の video/audio ストリームがある場合は先頭を代表として使う */
export function summarizeProbe(result: ProbeResult): MaterialProbe {
  const videoStream = result.streams.find((s) => s.codec_type === "video");
  const audioStream = result.streams.find((s) => s.codec_type === "audio");
  const probe: MaterialProbe = { hasAudio: audioStream !== undefined };

  const durationSec = parseContainerDurationSec(result.format?.duration);
  if (durationSec !== undefined) probe.durationSec = durationSec;
  if (videoStream?.width !== undefined) probe.width = videoStream.width;
  if (videoStream?.height !== undefined) probe.height = videoStream.height;
  if (videoStream?.avg_frame_rate !== undefined) {
    const fps = parseFps(videoStream.avg_frame_rate);
    if (fps > 0) probe.fps = fps;
  }
  if (videoStream?.codec_name !== undefined) probe.videoCodec = videoStream.codec_name;
  if (audioStream?.codec_name !== undefined) probe.audioCodec = audioStream.codec_name;
  return probe;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    file,
  ]);
  return JSON.parse(stdout) as ProbeResult;
}

/** 指定した音声ストリームを whisper 用の 16kHz mono wav に抽出する */
export async function extractAudio(
  input: string,
  audioStreamIndex: number,
  output: string,
): Promise<void> {
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    "-map", `0:a:${audioStreamIndex}`,
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    output,
  ]);
}

/**
 * 無音区間を検出する。ffmpeg silencedetect は結果を stderr にログとして
 * 出力するため、それをパースして返す。
 */
export async function detectSilence(
  audioFile: string,
  silenceDb: number,
  minSilenceSec: number,
): Promise<Interval[]> {
  const { stderr } = await run("ffmpeg", [
    "-v", "info",
    "-i", audioFile,
    "-af", `silencedetect=noise=${silenceDb}dB:d=${minSilenceSec}`,
    "-f", "null", "-",
  ]);

  const silences: Interval[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start: ([\d.]+)/);
    if (startMatch) pendingStart = parseFloat(startMatch[1]);
    const endMatch = line.match(/silence_end: ([\d.]+)/);
    if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

export function parseFps(avgFrameRate: string | undefined): number {
  if (!avgFrameRate) return 0;
  const [num, den] = avgFrameRate.split("/").map(Number);
  if (!den) return num || 0;
  return num / den;
}
