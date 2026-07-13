// lib/insertMix.ts — 挿入クリップ込みの連続音声(design-T4.md §3)。
// ベース音声(cut.mp4)・挿入音声・BGM を PCM 領域で1本のベッドに組み立て、
// **最後に1回だけ AAC エンコードする**(設計原則4: 部分音声の encoded AAC
// concat は禁止。既存 bgmMix.ts と同じ流儀の延長)。
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.ts";
import {
  BGM_MIX_CHANNELS,
  BGM_MIX_SAMPLE_RATE,
  bgmMixEncodedAudioDurationSec,
  bgmMixSampleCount,
  decodeAudioToPcm,
  frameSampleRange,
  mixBgmPcm,
  writeF32lePcm,
} from "./bgmMix.ts";
import { fadeFactor, isImageFile } from "./overlayFade.ts";
import { baseLayoutOf } from "./fastBase.ts";
import { probe, summarizeProbe } from "./ffmpeg.ts";
import type { DecodedBgmTrack } from "./bgmMix.ts";
import type { BaseLayout } from "./fastBase.ts";
import type { RenderProps } from "../../remotion/props.ts";

/** 1素材ぶんのデコード済み PCM(48kHz stereo interleaved f32) */
export interface DecodedSource {
  pcm: Float32Array;
}

/**
 * 挿入素材の PCM デコードを省略すべきか(design-T4 §9-5 の無音3分岐: 画像 /
 * volume<=0 / 音声ストリーム無し)を判定する純関数。`hasAudioStream` は
 * 呼び出し側が ffprobe(`probe()` + `summarizeProbe()`)で判定した結果を渡す。
 *
 * **なぜ ffprobe の事前判定が要るか**: `decodeAudioToPcm` は
 * `ffmpeg -i <file> -vn -f f32le ...` で音声を吸い出すが、入力に音声
 * ストリームが無いと ffmpeg 自体が「マップするものが無い」でエラー終了する
 * (「長さ0の PCM を返す」という当初の設計前提は誤りだった。実 render で
 * 実測して判明。design-T4.md §9-5 の記述はこの関数を導入する形で訂正する)。
 * したがって「デコードしてから空を判定する」のでは間に合わず、**デコード
 * 前**に音声ストリームの有無を知る必要がある。
 */
export function insertHasNoAudio(
  ins: { file: string; volume?: number },
  hasAudioStream: boolean,
): boolean {
  return isImageFile(ins.file) || (ins.volume ?? 1) <= 0 || !hasAudioStream;
}

/**
 * 出力タイムライン全長のベース音声ベッド(base 区間 + 挿入 + BGM)を組み立てる
 * 純関数。cutPcm / insertPcms / bgmPcm はすべて 48kHz stereo interleaved f32。
 * insertPcms[i] は props.inserts[i] に対応(無音扱いなら null。画像・
 * volume<=0・音声ストリーム無しは呼び出し側 mixInsertAudio が null に正規化
 * 済みの前提)。
 *
 * Remotion(Main.tsx)側の式(design-T4.md §3-A から verbatim 移設):
 * - ベース: <CroppedVideo muted={muteBase}> はゲイン1(volume prop を持たない)
 * - 挿入: ゲイン = vol × fadeFactor(f, durFrames, fps, fadeInSec, fadeOutSec)。
 *   durFrames = max(1, round((ins.end-ins.start)*fps))(**frameSpans の
 *   durationInFrames ではない**。境界共有で ±1 ずれる。design-T4.md §9-1)
 * - BGM: 加算(bgmMix.ts の mixBgmPcm の出力をそのまま足す。P4 で共有済み)
 */
export function buildInsertBedPcm(args: {
  props: RenderProps;
  layout: Extract<BaseLayout, { ok: true }>;
  cutPcm: Float32Array;
  insertPcms: (Float32Array | null)[];
  bgmPcm?: Float32Array | null;
  sampleRate?: number;
  channels?: number;
}): Float32Array {
  const { props, layout, cutPcm, insertPcms, bgmPcm } = args;
  const sr = args.sampleRate ?? BGM_MIX_SAMPLE_RATE;
  const ch = args.channels ?? BGM_MIX_CHANNELS;
  const fps = props.fps;
  const n = bgmMixSampleCount(layout.totalFrames, sr, fps);
  const bed = new Float32Array(n * ch); // ゼロ = 無音

  // ---- (1) ベース区間: cut.mp4 音声を「連続ブロック」でコピーする ----
  // frame ごとに copy すると round() の量子化で境界サンプルが重複/欠落し
  // うるので、区間まるごと1ブロックでコピーする(出力側の境界は frame 格子
  // に一致する)
  const cutSampleLen = Math.floor(cutPcm.length / ch);
  for (const seg of layout.base) {
    const outFrom = frameSampleRange(seg.fromFrame, sr, fps).fromSample;
    const outTo = frameSampleRange(seg.toFrame, sr, fps).fromSample;
    const srcFrom = frameSampleRange(seg.videoStartFrame, sr, fps).fromSample;
    const len = Math.min(outTo - outFrom, cutSampleLen - srcFrom);
    for (let s = 0; s < len; s++) {
      const outOffset = (outFrom + s) * ch;
      const srcOffset = (srcFrom + s) * ch;
      for (let c = 0; c < ch; c++) {
        bed[outOffset + c] = cutPcm[srcOffset + c];
      }
    }
  }

  // ---- (2) 挿入区間: frame ごとのゲインで書き込む(上書き。ベースは元々ゼロ) ----
  for (const ins of layout.inserts) {
    const item = (props.inserts ?? [])[ins.index];
    const pcm = insertPcms[ins.index];
    if (!item || pcm == null) continue; // 画像 / volume<=0 / 音声ストリーム無し → 無音のまま
    const vol = item.volume ?? 1;
    const durFrames = Math.max(1, Math.round((item.end - item.start) * fps)); // ★ Remotion と同一式
    const srcBase = frameSampleRange(Math.round((item.startFrom ?? 0) * fps), sr, fps).fromSample;
    const insStart = frameSampleRange(ins.fromFrame, sr, fps).fromSample;
    const srcLen = Math.floor(pcm.length / ch);
    for (let f = 0; f < ins.toFrame - ins.fromFrame; f++) {
      const gain = vol * fadeFactor(f, durFrames, fps, item.fadeInSec, item.fadeOutSec);
      const { fromSample, toSample } = frameSampleRange(ins.fromFrame + f, sr, fps);
      const sFrom = Math.max(0, fromSample);
      const sTo = Math.min(n, toSample);
      for (let s = sFrom; s < sTo; s++) {
        const srcSample = srcBase + (s - insStart);
        if (srcSample < 0 || srcSample >= srcLen) continue; // 素材が尽きた → 無音(Remotion と同じ)
        const outOffset = s * ch;
        const srcOffset = srcSample * ch;
        for (let c = 0; c < ch; c++) {
          bed[outOffset + c] = pcm[srcOffset + c] * gain;
        }
      }
    }
  }

  // ---- (3) BGM を加算(既存の mixBgmPcm の出力をそのまま足す) ----
  if (bgmPcm) {
    for (let i = 0; i < bed.length; i++) bed[i] += bgmPcm[i];
  }

  return bed;
}

/** ffmpeg 引数(f32le の生 PCM を1回だけ AAC エンコードする)。
 * buildBgmAmixArgs の apad/atrim/asetpts の整形と同じ流儀(P4 の +2frame
 * パディングと合わせて AAC の 1024-sample フレーム床丸めを吸収する) */
export function buildPcmEncodeArgs(args: {
  pcmPath: string;
  outM4a: string;
  durationSec: number;
}): string[] {
  const { pcmPath, outM4a, durationSec } = args;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`durationSec must be positive: ${durationSec}`);
  }
  return [
    "-y", "-v", "error",
    "-f", "f32le",
    "-ar", String(BGM_MIX_SAMPLE_RATE),
    "-ac", String(BGM_MIX_CHANNELS),
    "-i", pcmPath,
    "-af", `apad,atrim=duration=${durationSec},asetpts=N/SR/TB`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", String(BGM_MIX_SAMPLE_RATE),
    "-ac", String(BGM_MIX_CHANNELS),
    outM4a,
  ];
}

/** 不純ラッパ: cut.mp4 / 挿入素材 / BGM をデコード → buildInsertBedPcm →
 * 1回エンコード。一時 PCM は render.fast/ 配下に置き、finally で必ず消す
 * (bgmMix.ts の mixFastAudio と同じ流儀)。 */
export async function mixInsertAudio(args: {
  dir: string;
  props: RenderProps;
  cutPath: string;
  outM4a: string;
}): Promise<void> {
  const { dir, props, cutPath, outM4a } = args;
  const layout = baseLayoutOf(props);
  if (!layout.ok) {
    // runFastRender の try/catch がフルレンダーへ落とす(fastPlan が本来
    // ここへ来る前に全編フォールバックしているはず。破れたら実装バグ)
    throw new Error(`insert-mix に不正な baseSegments(${layout.reason})`);
  }
  const fastDir = join(dir, "render.fast");
  mkdirSync(fastDir, { recursive: true });
  const tempPaths: string[] = [];
  try {
    const cutAudioPath = join(fastDir, ".insert-mix-cut-audio.f32le");
    tempPaths.push(cutAudioPath);
    const cutPcm = await decodeAudioToPcm(cutPath, cutAudioPath);

    const inserts = props.inserts ?? [];
    const insertPcms: (Float32Array | null)[] = [];
    for (let i = 0; i < inserts.length; i++) {
      const ins = inserts[i];
      const filePath = join(dir, ins.file);
      // 画像 / volume<=0 は ffprobe すら要らずに判定できる(no-op を先に弾く)
      const needsProbe = !isImageFile(ins.file) && (ins.volume ?? 1) > 0;
      // 音声ストリームの無い素材(無音動画)へ decodeAudioToPcm を呼ぶと
      // ffmpeg が「マップする音声が無い」でエラー終了する(-vn -f f32le は
      // 出力ストリームが1本も無いと Invalid argument で失敗する)。
      // デコード**前**に ffprobe で有無を確認し、無ければ丸ごとスキップする
      const hasAudioStream = needsProbe ? summarizeProbe(await probe(filePath)).hasAudio : false;
      if (insertHasNoAudio(ins, hasAudioStream)) {
        insertPcms.push(null);
        continue;
      }
      const decodedPath = join(fastDir, `.insert-mix-ins-${i}.f32le`);
      tempPaths.push(decodedPath);
      const pcm = await decodeAudioToPcm(filePath, decodedPath);
      insertPcms.push(pcm.length > 0 ? pcm : null);
    }

    let bgmPcm: Float32Array | null = null;
    if (props.bgm.length > 0) {
      const decodedTracks: DecodedBgmTrack[] = [];
      for (let index = 0; index < props.bgm.length; index++) {
        const track = props.bgm[index];
        const decodedPath = join(fastDir, `.insert-mix-bgm-${index}.f32le`);
        tempPaths.push(decodedPath);
        decodedTracks.push({ track, pcm: await decodeAudioToPcm(join(dir, track.file), decodedPath) });
      }
      bgmPcm = mixBgmPcm({ props, decodedTracks });
    }

    const bed = buildInsertBedPcm({ props, layout, cutPcm, insertPcms, bgmPcm });
    const bedPath = join(fastDir, ".insert-mix-bed.f32le");
    tempPaths.push(bedPath);
    writeF32lePcm(bedPath, bed);

    const durationSec = bgmMixEncodedAudioDurationSec(layout.totalFrames, props.fps);
    await run("ffmpeg", buildPcmEncodeArgs({ pcmPath: bedPath, outM4a, durationSec }));
  } finally {
    for (const p of tempPaths) rmSync(p, { force: true });
  }
}
