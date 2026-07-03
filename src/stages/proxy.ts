import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest } from "../types.ts";

/**
 * エディタ用の軽量プロキシ(proxy.mp4)。元収録の全尺を縮小エンコード
 * したもので、収録ごとに1回だけ作る。preview.mp4 と違いカットを
 * 焼き込まず、エディタの Player が cutplan の keep 区間に従って
 * 飛び飛びに再生する(本物の NLE と同じ方式)。カット境界の編集が
 * ファイルの作り直しなしでプレビューへ即時反映されるのはこのため。
 *
 * 音声は全尺を実測してラウドネス正規化する。keep 区間のみを実測する
 * 最終出力(cut.mp4)とは理論上わずかに差が出るが、無音は BS.1770 の
 * ゲートでほぼ測定から外れるので実用上は同等。
 */
export async function buildProxy(dir: string, cfg: Config): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const input = join(dir, manifest.source);
  if (!existsSync(input)) {
    throw new Error(`元収録が見つかりません: ${input}`);
  }
  // 音声はマイク+システム音声のミックス(cut.mp4 / preview.mp4 と共通の構成)
  const source = audioSourceOf(manifest, cfg);
  const whole = [{ start: 0, end: manifest.durationSec }];
  const loudnorm = await measuredLoudnormFilter({
    input,
    source,
    keeps: whole,
    targetLufs: cfg.render.targetLufs,
  });
  const output = join(dir, "proxy.mp4");
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    "-filter_complex",
    [
      `[0:v]scale=${cfg.preview.width}:-2[vout]`,
      ...keepAudioParts(source, whole),
      `[a0]${loudnorm}[aout]`,
    ].join(";"),
    "-map", "[vout]", "-map", "[aout]",
    // -g 30: キーフレーム間隔を1秒に。カット境界ごとに Player がシークする
    // 方式なので、preview.mp4 以上にシークの軽さが効く
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "30",
    "-movflags", "+faststart",
    // loudnorm は内部で 192kHz にアップサンプルするため 48kHz に戻す
    "-c:a", "aac", "-ar", "48000",
    output,
  ]);
  return output;
}
