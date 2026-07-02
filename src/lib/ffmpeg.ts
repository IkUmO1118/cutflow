import { run } from "./exec.ts";
import type { Interval } from "../types.ts";

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { duration: string };
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
