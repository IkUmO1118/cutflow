import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, extractAudio, parseFps } from "../lib/ffmpeg.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest } from "../types.ts";

/**
 * 実効レイアウトを決める。優先順: 明示引数(CLI --layout 等) > config
 * (ingest.layout) > 既定 plain。auto はキャンバス寸法が config の
 * screenRegion+cameraRegion と完全一致、または十分な超横長なら obs-canvas、
 * それ以外は plain。
 */
export function resolveLayout(
  explicit: "obs-canvas" | "plain" | "auto" | undefined,
  cfgLayout: "obs-canvas" | "plain" | "auto" | undefined,
  width: number,
  height: number,
  cfg: Config,
): "obs-canvas" | "plain" {
  const chosen = explicit ?? cfgLayout ?? "plain";
  if (chosen !== "auto") return chosen;
  const expectedW = cfg.ingest.screenRegion.w + cfg.ingest.cameraRegion.w;
  const expectedH = cfg.ingest.screenRegion.h;
  const exactObsCanvas = width === expectedW && height === expectedH;
  const wideObsLike = width >= 3000 && height >= 900 && width / height >= 3.2;
  return exactObsCanvas || wideObsLike ? "obs-canvas" : "plain";
}

/** 音声ストリーム 1 本ぶんの推定用記述子(全ストリーム中ではなく
 *  「音声のみ」で 0 始まりの index)。codec/channels/title/language は
 *  ffprobe が出せば埋め、無ければ省く(メタデータ無し環境でも動く) */
export interface AudioTrackDescriptor {
  index: number;
  codec?: string;
  channels?: number;
  title?: string;
  language?: string;
}

export interface AudioTrackResolution {
  micIndex: number;
  systemIndex: number | null;
  /** どう決めたか(診断用)。config=設定を尊重 / single=1本しか無い /
   *  inferred=範囲外設定をメタデータから推定 */
  source: "config" | "single" | "inferred";
  /** stderr に出す助言(空なら無し)。抽出結果は変えない参考情報 */
  warnings: string[];
}

export type AudioTrackOutcome =
  | { ok: true; resolution: AudioTrackResolution }
  | { ok: false; message: string };

const MIC_RE = /mic|マイク|voice|ボイス|音声入力|host/i;
const SYS_RE = /system|desktop|speaker|スピーカ|アプリ|デスクトップ|bgm|output/i;

function looksLikeMic(s: AudioTrackDescriptor): boolean {
  return s.title != null && MIC_RE.test(s.title);
}
function looksLikeSystem(s: AudioTrackDescriptor): boolean {
  return s.title != null && SYS_RE.test(s.title);
}
function describeTrack(s: AudioTrackDescriptor): string {
  const parts = [s.codec ?? "?"];
  if (s.channels != null) parts.push(`${s.channels}ch`);
  if (s.title != null) parts.push(`"${s.title}"`);
  if (s.language != null) parts.push(`[${s.language}]`);
  return parts.join(" ");
}

function trackGuidance(streams: AudioTrackDescriptor[], micTrack: number): string {
  const list = streams
    .map((s) => `  トラック ${s.index + 1}: ${describeTrack(s)}`)
    .join("\n");
  return (
    `マイクトラック(micTrack: ${micTrack})が見つかりません。` +
    `この収録には ${streams.length} 本の音声トラックがあります:\n${list}\n` +
    `どれがマイク音声かを config.yaml の ingest.micTrack で指定するか、` +
    `ingest / run に --mic-track <番号> を付けて再実行してください` +
    `(システム音声は --system-track <番号> または ingest.systemTrack)。`
  );
}

/**
 * mic/system の音声トラックを解決する。優先順:
 *  1) 設定(micTrack)が範囲内 → その設定を尊重(既定 1/2 とバイト等価)。
 *     メタデータが食い違うときだけ stderr 助言を足す(抽出は変えない)。
 *  2) 範囲外で音声が 1 本 → それを mic とみなす(single)。
 *  3) 範囲外だがメタデータで mic が一意に決まる → 推定(inferred)。
 *  4) それ以外(判別不能)→ ok:false で N トラックを提示する誘導文言を返す。
 */
export function resolveAudioTracks(
  streams: AudioTrackDescriptor[],
  micTrack: number, // 1 始まり(cfg.ingest.micTrack か --mic-track)
  systemTrack: number, // 1 始まり(cfg.ingest.systemTrack か --system-track)
): AudioTrackOutcome {
  const n = streams.length;
  const configMic = micTrack - 1;
  const configSys = systemTrack - 1;

  // Case A: 設定が範囲内 → 尊重(既定 1/2 の後方互換をここで担保)
  if (configMic >= 0 && configMic < n) {
    const micIndex = configMic;
    const systemIndex =
      configSys >= 0 && configSys < n && configSys !== configMic ? configSys : null;
    const warnings: string[] = [];
    if (looksLikeSystem(streams[micIndex])) {
      warnings.push(
        `マイクに設定したトラック ${micTrack}(${describeTrack(streams[micIndex])})は` +
          `システム音声の可能性があります。`,
      );
      const micCand = streams.find(looksLikeMic);
      if (micCand) {
        warnings.push(
          `トラック ${micCand.index + 1}(${describeTrack(micCand)})が` +
            `マイクの可能性があります。--mic-track ${micCand.index + 1} で上書きできます。`,
        );
      }
    }
    return {
      ok: true,
      resolution: { micIndex, systemIndex, source: n === 1 ? "single" : "config", warnings },
    };
  }

  // Case B: 設定が範囲外
  // B1: 音声が 1 本 → それが mic
  if (n === 1) {
    return {
      ok: true,
      resolution: {
        micIndex: 0,
        systemIndex: null,
        source: "single",
        warnings: [
          `config の micTrack=${micTrack} は範囲外(音声トラックは1本)。` +
            `トラック1をマイクとして使います。`,
        ],
      },
    };
  }
  // B2: メタデータで mic が一意
  const micCandidates = streams.filter(looksLikeMic);
  if (micCandidates.length === 1) {
    const micIndex = micCandidates[0].index;
    const sysByMeta = streams.filter((s) => s.index !== micIndex && looksLikeSystem(s));
    const systemIndex =
      sysByMeta.length === 1
        ? sysByMeta[0].index
        : n === 2
          ? streams.find((s) => s.index !== micIndex)!.index
          : null;
    return {
      ok: true,
      resolution: {
        micIndex,
        systemIndex,
        source: "inferred",
        warnings: [
          `config の micTrack=${micTrack} は範囲外。` +
            `メタデータからトラック ${micIndex + 1} をマイクと推定しました。`,
        ],
      },
    };
  }
  // B3: 判別不能 → 誘導文言(黙って停止しない)
  return { ok: false, message: trackGuidance(streams, micTrack) };
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
  tracks?: { micTrack?: number; systemTrack?: number },
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
  const micTrack = tracks?.micTrack ?? cfg.ingest.micTrack;
  const systemTrack = tracks?.systemTrack ?? cfg.ingest.systemTrack;
  const descriptors: AudioTrackDescriptor[] = audioStreams.map((s, i) => ({
    index: i,
    ...(s.codec_name != null ? { codec: s.codec_name } : {}),
    ...(s.channels != null ? { channels: s.channels } : {}),
    ...(s.tags?.title != null ? { title: s.tags.title } : {}),
    ...(s.tags?.language != null ? { language: s.tags.language } : {}),
  }));
  const outcome = resolveAudioTracks(descriptors, micTrack, systemTrack);
  if (!outcome.ok) throw new Error(outcome.message);
  const { micIndex, systemIndex, warnings } = outcome.resolution;
  for (const w of warnings) console.warn(`警告: ${w}`);
  const hasSystem = systemIndex !== null;

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
    await extractAudio(sourcePath, systemIndex!, join(dir, systemWav));
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
