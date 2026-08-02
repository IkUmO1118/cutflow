import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import { colorTagsOfProbe } from "../lib/colorTags.ts";
import { probe } from "../lib/ffmpeg.ts";
import {
  audioSourceOf,
  keepAudioParts,
  measuredLoudnormFilter,
} from "../lib/loudness.ts";
import { buildProxyCacheKey, proxyCacheKeyEquals, proxyFileName } from "../lib/proxyCache.ts";
import { proxyGopFrames, scaleFilter, videoEncodeArgs } from "../lib/videoEncode.ts";
import type { ProxyCacheKey } from "../lib/proxyCache.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest } from "../types.ts";

function probeSync(file: string) {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    file,
  ], { encoding: "utf8" }));
}

/**
 * エディタ用の軽量プロキシ(proxy.mp4 / proxy.m4a)。元収録の全尺を
 * エディタ向けにエンコードしたもので、収録ごとに1回だけ作る。preview.mp4 と違いカットを
 * 焼き込まない。エディタは mediabunny の VideoDecoder 経路で
 * keep 境界ごとに frameSource を reseek して繋ぐため、カット境界の
 * 編集がファイルの作り直しなしでプレビューへ即時反映される。
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
  const colorTags = manifest.layout === "stills" ? undefined : colorTagsOfProbe(await probe(input));
  const whole = [{ start: 0, end: manifest.durationSec, speed: 1 }];
  const loudnorm = await measuredLoudnormFilter({
    input,
    source,
    keeps: whole,
    targetLufs: cfg.render.targetLufs,
  });
  const sourceStat = statSync(input);
  const output = join(dir, proxyFileName(manifest));
  if (manifest.layout === "stills") {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-i", input,
      "-filter_complex",
      [
        ...keepAudioParts(source, whole),
        `[a0]${loudnorm}[aout]`,
      ].join(";"),
      "-map", "[aout]",
      // loudnorm は内部で 192kHz にアップサンプルするため 48kHz に戻す
      "-c:a", "aac", "-ar", "48000",
      output,
    ]);
  } else {
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-i", input,
      "-filter_complex",
      [
        `[0:v]${scaleFilter(cfg)}[vout]`,
        ...keepAudioParts(source, whole),
        `[a0]${loudnorm}[aout]`,
      ].join(";"),
      "-map", "[vout]", "-map", "[aout]",
      // GOP はカット境界ごとに Player が <video> をシークして繋ぐ方式の
      // デコード待ちを左右する。既定(proxyIntra:true)はオールイントラ(1)、
      // false なら従来の PROXY_GOP_FRAMES(0.2秒)。詳細は videoEncode.ts 参照
      ...videoEncodeArgs(cfg, { gopFrames: proxyGopFrames(cfg), colorTags }),
      // loudnorm は内部で 192kHz にアップサンプルするため 48kHz に戻す
      "-c:a", "aac", "-ar", "48000",
      output,
    ]);
  }
  // 陳腐化キー(proxy.key.json)。焼き込み済みの設定・元収録ファイルが
  // 次回と変わっていなければ proxy.* は古くない(削除すれば常に
  // 「陳腐化なし」判定に戻る=次回の frames/エディタは再生成しない)
  writeFileSync(
    join(dir, "proxy.key.json"),
    JSON.stringify(
      buildProxyCacheKey({
        cfg,
        sourceFile: manifest.source,
        sourceMtimeMs: sourceStat.mtimeMs,
        sourceSize: sourceStat.size,
        colorTags,
      }),
      null,
      2,
    ),
  );
  return output;
}

/**
 * proxy.* が焼き込み済みの設定・元収録ファイルと食い違っている(古い)か。
 * proxy.* か proxy.key.json が無ければ「陳腐化」ではなく「未生成」なので
 * false(呼び出し側は existsSync と併せて生成要否を判定する)
 */
export function isProxyStale(dir: string, cfg: Config): boolean {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;
  const proxyPath = join(dir, proxyFileName(manifest));
  const keyPath = join(dir, "proxy.key.json");
  if (!existsSync(proxyPath) || !existsSync(keyPath)) return false;
  const input = join(dir, manifest.source);
  if (!existsSync(input)) return false;
  const sourceStat = statSync(input);
  const colorTags = manifest.layout === "stills" ? undefined : colorTagsOfProbe(probeSync(input));
  const currentKey = buildProxyCacheKey({
    cfg,
    sourceFile: manifest.source,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
    colorTags,
  });
  const cachedKey = JSON.parse(readFileSync(keyPath, "utf8")) as ProxyCacheKey;
  return !proxyCacheKeyEquals(cachedKey, currentKey);
}
