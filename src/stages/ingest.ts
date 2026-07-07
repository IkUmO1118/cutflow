import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, extractAudio, parseFps } from "../lib/ffmpeg.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest } from "../types.ts";

/**
 * 実効レイアウトを決める。優先順: 明示引数(CLI --layout 等) > config
 * (ingest.layout) > 既定 obs-canvas。auto はキャンバス寸法が
 * config.ingest.screenRegion+cameraRegion と完全一致(W×H とも)すれば
 * obs-canvas、それ以外は plain(auto は既定にしない。呼び出し側が明示した
 * ときだけの opt-in)
 */
export function resolveLayout(
  explicit: "obs-canvas" | "plain" | "auto" | undefined,
  cfgLayout: "obs-canvas" | "plain" | "auto" | undefined,
  width: number,
  height: number,
  cfg: Config,
): "obs-canvas" | "plain" {
  const chosen = explicit ?? cfgLayout ?? "obs-canvas";
  if (chosen !== "auto") return chosen;
  const expectedW = cfg.ingest.screenRegion.w + cfg.ingest.cameraRegion.w;
  const expectedH = cfg.ingest.screenRegion.h;
  return width === expectedW && height === expectedH ? "obs-canvas" : "plain";
}

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
  layout?: "obs-canvas" | "plain" | "auto",
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

  // システム音声(デモ音・再生動画・TTS)を知覚用に第2トラックとして抽出する
  // (whisper.systemAudio 有効 かつ systemStream があるときだけ)。既定オフでは
  // 何も抽出せず manifest に systemWav キーを出さない=導入前とバイト等価。
  // 描画・mix には無関係で、transcribe が transcript.system.json を作るための入力
  let systemWav: string | undefined;
  if (hasSystem && cfg.whisper.systemAudio) {
    systemWav = join("audio", "system.wav");
    await extractAudio(sourcePath, systemIndex, join(dir, systemWav));
  }

  const width = video.width ?? 0;
  const height = video.height ?? 0;
  const fps = parseFps(video.avg_frame_rate);
  const effectiveLayout = resolveLayout(layout, cfg.ingest.layout, width, height, cfg);

  const videoInfo =
    effectiveLayout === "plain"
      ? { width, height, fps, screenRegion: { x: 0, y: 0, w: width, h: height } }
      : { width, height, fps, screenRegion: cfg.ingest.screenRegion, cameraRegion: cfg.ingest.cameraRegion };

  if (effectiveLayout === "obs-canvas") {
    const expected = cfg.ingest.screenRegion.w + cfg.ingest.cameraRegion.w;
    if (width !== 0 && width < expected) {
      // 拡張キャンバスでない素材(テスト素材や旧収録)でも止めずに警告に留める
      console.warn(
        `警告: 映像幅 ${width}px が想定レイアウト(${expected}px)より狭いため、` +
          `画面/カメラの分離が正しく動かない可能性があります。`,
      );
    }
  }

  const manifest: Manifest = {
    dir,
    source: sourceFile,
    durationSec: parseFloat(info.format.duration),
    layout: effectiveLayout,
    video: videoInfo,
    audio: {
      micStream: micIndex,
      systemStream: hasSystem ? systemIndex : null,
      micWav,
      // systemWav は抽出したときだけ載せる(未抽出時はキーごと省略=バイト等価)
      ...(systemWav !== undefined ? { systemWav } : {}),
    },
    createdAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
