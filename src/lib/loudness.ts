import { run } from "./exec.ts";
import type { Config } from "./config.ts";
import type { Manifest } from "../types.ts";
import type { PlaybackSegment } from "./timeline.ts";

/** 出力に入れる音声の構成(マイク+任意でシステム音声) */
export interface AudioSource {
  /** マイク音声のストリーム番号(ffmpeg の a:N) */
  micStream: number;
  /** ミックスするシステム音声のストリーム番号。null ならマイクのみ */
  systemStream: number | null;
  /** システム音声をミックスするときの音量(dB)。0で原音量 */
  systemVolumeDb: number;
  /** マイク音声のノイズ除去(ffmpeg afftdn)。システム音声はデジタル由来で
   * ノイズが無く劣化するだけなので対象外 */
  denoiseMic: boolean;
  /** afftdn のノイズフロア(dB) */
  noiseFloorDb: number;
}

/** manifest と config から出力音声の構成を決める(render / preview / proxy 共通)。
 * システム音声は収録に存在し、config の systemAudio.mix が有効なときだけ入る */
export function audioSourceOf(manifest: Manifest, cfg: Config): AudioSource {
  const sys = cfg.render.systemAudio;
  const denoise = cfg.render.denoise;
  return {
    micStream: manifest.audio.micStream,
    systemStream: sys?.mix ? manifest.audio.systemStream : null,
    systemVolumeDb: sys?.volumeDb ?? 0,
    denoiseMic: denoise?.mic ?? false,
    noiseFloorDb: denoise?.noiseFloorDb ?? -25,
  };
}

/**
 * keep 区間ごとの音声チェーン(filter_complex の断片)を作る。各区間を
 * atrim で切り出し、システム音声があればマイクと合成して [a0]..[aN-1] へ
 * 出す。実測パスと render / preview / proxy で共有し、正規化の実測対象と
 * 実際に出力される音を常に一致させる。
 */
export function atempoFilters(speed: number): number[] {
  if (speed === 1) return [];
  const out: number[] = [];
  let remaining = speed;
  while (remaining < 0.5) {
    out.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2) {
    out.push(2);
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-9) out.push(remaining);
  return out;
}

export function keepAudioParts(source: AudioSource, keeps: PlaybackSegment[]): string[] {
  const { micStream, systemStream, systemVolumeDb, denoiseMic, noiseFloorDb } = source;
  return keeps.flatMap((k, i) => {
    const trim = `atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS`;
    const tempo = atempoFilters(k.speed).map((rate) => `atempo=${rate}`).join(",");
    // ノイズ除去はマイクのみ(システム音声はデジタル由来でノイズが無い)
    const micTrim = denoiseMic ? `${trim},afftdn=nf=${noiseFloorDb}` : trim;
    if (systemStream === null) {
      return [
        `[0:a:${micStream}]${micTrim}${tempo ? `,${tempo}` : ""}[a${i}]`,
      ];
    }
    const vol = systemVolumeDb !== 0 ? `,volume=${systemVolumeDb}dB` : "";
    return [
      `[0:a:${micStream}]${micTrim}[mic${i}]`,
      `[0:a:${systemStream}]${trim}${vol}[sys${i}]`,
      // normalize=0: 入力数で音量を割らない(片方が無音でも声量が変わらない)
      `[mic${i}][sys${i}]amix=inputs=2:duration=first:normalize=0${tempo ? `,${tempo}` : ""}[a${i}]`,
    ];
  });
}

/**
 * 出力音声(マイク+システム音声のミックス)のラウドネス正規化
 * (EBU R128)の共通処理。
 * ワンパスの loudnorm は流しながら調整するため、入力が目標から遠いと
 * 数dB届かない(実測で確認済み)。そこで1パス目に keep 区間を繋いだ
 * 音声のみを実測し、2パス目用の「実測値付き線形 loudnorm」フィルタ文字列を
 * 返す。cut.mp4(最終レンダー)と preview.mp4(エディタのプロキシ)で
 * 共有し、編集中に聞く音量と最終出力の音量を一致させる。
 * 実測パスは音声のみのデコードなので数秒で終わる。
 */
export async function measuredLoudnormFilter(args: {
  input: string;
  source: AudioSource;
  keeps: PlaybackSegment[];
  targetLufs: number;
}): Promise<string> {
  const { input, source, keeps, targetLufs } = args;
  const audioParts = keepAudioParts(source, keeps);
  const labels = keeps.map((_, i) => `[a${i}]`).join("");
  const base = `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
  const { stderr } = await run("ffmpeg", [
    "-i", input,
    "-filter_complex",
    [
      ...audioParts,
      `${labels}concat=n=${keeps.length}:v=0:a=1[ac]`,
      `[ac]${base}:print_format=json[aout]`,
    ].join(";"),
    "-map", "[aout]",
    "-f", "null", "-",
  ]);
  const m = parseLoudnormJson(stderr);
  return (
    `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`
  );
}

/** loudnorm が stderr に出す実測 JSON を取り出す */
function parseLoudnormJson(stderr: string): {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
} {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("loudnorm の実測結果が取得できませんでした");
  }
  return JSON.parse(stderr.slice(start, end + 1));
}
