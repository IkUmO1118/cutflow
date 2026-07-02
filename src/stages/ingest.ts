import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, extractAudio, parseFps } from "../lib/ffmpeg.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest } from "../types.ts";

/**
 * 収録フォルダの raw ファイルを解析し、manifest.json とマイク音声
 * (16kHz mono wav)を生成する。
 *
 * 映像はここでは再エンコードしない。画面/カメラの分離は manifest の
 * 領域情報(screenRegion/cameraRegion)として持ち、preview/render が
 * 必要時にクロップする。再エンコードを避けることで ingest は数秒で
 * 終わり、ディスク消費も増えない。
 */
export async function ingest(
  dir: string,
  sourceFile: string,
  cfg: Config,
): Promise<Manifest> {
  const sourcePath = join(dir, sourceFile);
  const info = await probe(sourcePath);

  const video = info.streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`${sourceFile} に映像ストリームがありません`);

  const audioStreams = info.streams.filter((s) => s.codec_type === "audio");
  if (audioStreams.length === 0) {
    throw new Error(`${sourceFile} に音声ストリームがありません`);
  }
  // OBS のトラック N は N 番目の音声ストリームとして記録される(1始まり)
  const micIndex = cfg.ingest.micTrack - 1;
  if (micIndex >= audioStreams.length) {
    throw new Error(
      `マイクトラック(micTrack: ${cfg.ingest.micTrack})が見つかりません。` +
        `音声ストリームは ${audioStreams.length} 本です。config.yaml を確認してください。`,
    );
  }
  const systemIndex = cfg.ingest.systemTrack - 1;
  const hasSystem = systemIndex < audioStreams.length && systemIndex !== micIndex;

  const audioDir = join(dir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const micWav = join("audio", "mic.wav");
  await extractAudio(sourcePath, micIndex, join(dir, micWav));

  const width = video.width ?? 0;
  const height = video.height ?? 0;
  const expected = cfg.ingest.screenRegion.w + cfg.ingest.cameraRegion.w;
  if (width !== 0 && width < expected) {
    // 拡張キャンバスでない素材(テスト素材や旧収録)でも止めずに警告に留める
    console.warn(
      `警告: 映像幅 ${width}px が想定レイアウト(${expected}px)より狭いため、` +
        `画面/カメラの分離が正しく動かない可能性があります。`,
    );
  }

  const manifest: Manifest = {
    dir,
    source: sourceFile,
    durationSec: parseFloat(info.format.duration),
    video: {
      width,
      height,
      fps: parseFps(video.avg_frame_rate),
      screenRegion: cfg.ingest.screenRegion,
      cameraRegion: cfg.ingest.cameraRegion,
    },
    audio: {
      micStream: micIndex,
      systemStream: hasSystem ? systemIndex : null,
      micWav,
    },
    createdAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
