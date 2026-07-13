import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RenderProps } from "../../remotion/props.ts";
import { bgmTrackTiming, bgmVolumeAtFrame } from "./bgmEnvelope.ts";
import { extractAudio } from "./chunkCache.ts";
import { run } from "./exec.ts";
import { compositionDurationInFrames } from "./renderFrameMath.ts";

export const BGM_MIX_SAMPLE_RATE = 48000;
export const BGM_MIX_CHANNELS = 2;

export type DecodedBgmTrack = {
  track: RenderProps["bgm"][number];
  /** Interleaved f32 PCM. mixFastAudio always decodes this as stereo. */
  pcm: Float32Array;
};

export function bgmMixSampleCount(totalFrames: number, sampleRate: number, fps: number): number {
  return Math.round((totalFrames * sampleRate) / fps);
}

export function bgmMixEncodedAudioDurationSec(totalFrames: number, fps: number): number {
  return (totalFrames + 2) / fps;
}

export function frameSampleRange(
  frame: number,
  sampleRate: number,
  fps: number,
): { fromSample: number; toSample: number } {
  return {
    fromSample: Math.round((frame * sampleRate) / fps),
    toSample: Math.round(((frame + 1) * sampleRate) / fps),
  };
}

function assertMixFormat(sampleRate: number, channels: number, fps: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`sampleRate must be positive: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`channels must be a positive integer: ${channels}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`fps must be positive: ${fps}`);
  }
}

export function mixBgmPcm(args: {
  props: RenderProps;
  decodedTracks: DecodedBgmTrack[];
  sampleRate?: number;
  channels?: number;
}): Float32Array {
  const { props, decodedTracks } = args;
  const sampleRate = args.sampleRate ?? BGM_MIX_SAMPLE_RATE;
  const channels = args.channels ?? BGM_MIX_CHANNELS;
  assertMixFormat(sampleRate, channels, props.fps);

  const totalFrames = compositionDurationInFrames(props.durationSec, props.fps);
  const sampleCount = bgmMixSampleCount(totalFrames, sampleRate, props.fps);
  const mixed = new Float32Array(sampleCount * channels);

  for (const { track, pcm } of decodedTracks) {
    const sourceSampleCount = Math.floor(pcm.length / channels);
    const { fromFrame, durationInFrames, startFromFrame } = bgmTrackTiming(track, props.fps);
    const loopStartSample = frameSampleRange(startFromFrame, sampleRate, props.fps).fromSample;
    const loopSampleCount = sourceSampleCount - loopStartSample;
    if (loopSampleCount <= 0) continue;

    const firstFrame = Math.max(0, fromFrame);
    const lastFrame = Math.min(totalFrames, fromFrame + durationInFrames);
    const trackStartSample = frameSampleRange(fromFrame, sampleRate, props.fps).fromSample;
    for (let frame = firstFrame; frame < lastFrame; frame++) {
      const localFrame = frame - fromFrame;
      const volume = bgmVolumeAtFrame(track, localFrame, props.fps);
      const { fromSample, toSample } = frameSampleRange(frame, sampleRate, props.fps);
      for (let sample = Math.max(0, fromSample); sample < Math.min(sampleCount, toSample); sample++) {
        const sourceSample = loopStartSample + (sample - trackStartSample) % loopSampleCount;
        const outOffset = sample * channels;
        const sourceOffset = sourceSample * channels;
        for (let channel = 0; channel < channels; channel++) {
          mixed[outOffset + channel] += pcm[sourceOffset + channel] * volume;
        }
      }
    }
  }

  return mixed;
}

function readF32lePcm(path: string): Float32Array {
  const bytes = readFileSync(path);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`invalid f32le PCM byte length: ${bytes.byteLength}`);
  }
  const pcm = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return pcm;
}

/** 任意の入力(BGM 素材・cut.mp4・挿入素材のいずれでも)を 48kHz/stereo/f32le
 * PCM へデコードする汎用デコーダ。insertMix.ts と共有する(design-T4.md §3-C。
 * 旧 decodeBgmToPcm から改名。入力を選ばないので実装追加ゼロで共有できる)。
 * 音声ストリームの無い入力(無音動画素材)は ffmpeg がエラーにならず
 * 長さ0の PCM を返す。呼び出し側で pcm.length===0 → null に正規化すること */
export async function decodeAudioToPcm(inputPath: string, outPath: string): Promise<Float32Array> {
  mkdirSync(dirname(outPath), { recursive: true });
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vn",
    "-f", "f32le",
    "-ar", String(BGM_MIX_SAMPLE_RATE),
    "-ac", String(BGM_MIX_CHANNELS),
    outPath,
  ]);
  return readF32lePcm(outPath);
}

export function writeF32lePcm(path: string, pcm: Float32Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.allocUnsafe(pcm.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < pcm.length; i++) {
    view.setFloat32(i * Float32Array.BYTES_PER_ELEMENT, pcm[i], true);
  }
  writeFileSync(path, bytes);
}

export function buildBgmAmixArgs(args: {
  cutPath: string;
  bgmPcmPath: string;
  outM4a: string;
  durationSec: number;
}): string[] {
  const { cutPath, bgmPcmPath, outM4a, durationSec } = args;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`durationSec must be positive: ${durationSec}`);
  }
  const duration = String(durationSec);
  const filter = [
    `[0:a]aresample=${BGM_MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=N/SR/TB[base]`,
    `[1:a]aresample=${BGM_MIX_SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=duration=${duration},asetpts=N/SR/TB[bgm]`,
    "[base][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[audio]",
  ].join(";");
  return [
    "-y", "-v", "error",
    "-i", cutPath,
    "-f", "f32le",
    "-ar", String(BGM_MIX_SAMPLE_RATE),
    "-ac", String(BGM_MIX_CHANNELS),
    "-i", bgmPcmPath,
    "-filter_complex", filter,
    "-map", "[audio]",
    "-vn",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", String(BGM_MIX_SAMPLE_RATE),
    "-ac", String(BGM_MIX_CHANNELS),
    outM4a,
  ];
}

export async function mixFastAudio(args: {
  dir: string;
  props: RenderProps;
  cutPath: string;
  outM4a: string;
}): Promise<void> {
  const { dir, props, cutPath, outM4a } = args;
  if (props.bgm.length === 0) {
    await extractAudio(cutPath, outM4a);
    return;
  }

  const fastDir = join(dir, "render.fast");
  const bgmPcmPath = join(fastDir, "bgm.f32le");
  const decodedPaths: string[] = [];
  mkdirSync(fastDir, { recursive: true });
  try {
    const decodedTracks: DecodedBgmTrack[] = [];
    for (let index = 0; index < props.bgm.length; index++) {
      const track = props.bgm[index];
      const decodedPath = join(fastDir, `.bgm-decoded-${index}.f32le`);
      decodedPaths.push(decodedPath);
      decodedTracks.push({
        track,
        pcm: await decodeAudioToPcm(join(dir, track.file), decodedPath),
      });
    }

    writeF32lePcm(bgmPcmPath, mixBgmPcm({ props, decodedTracks }));
    const totalFrames = compositionDurationInFrames(props.durationSec, props.fps);
    // AAC packets are quantized to 1024-sample frames. Encoding exactly the
    // video duration can floor the audio stream slightly short, and the final
    // `muxVideoAudio -shortest` would then drop tail video frames. Two video
    // frames of padding keep the encoded audio at or just above video length
    // while staying inside verifyAssembled's 1-frame tolerance after AAC
    // packetization.
    const audioDurationSec = bgmMixEncodedAudioDurationSec(totalFrames, props.fps);
    await run("ffmpeg", buildBgmAmixArgs({
      cutPath,
      bgmPcmPath,
      outM4a,
      durationSec: audioDurationSec,
    }));
  } finally {
    for (const decodedPath of decodedPaths) rmSync(decodedPath, { force: true });
    rmSync(bgmPcmPath, { force: true });
  }
}
