import type { Config } from "./config.ts";
import { PROXY_GOP_FRAMES, resolveVideoEncoder, videoEncodeArgs } from "./videoEncode.ts";

/**
 * proxy.mp4 の陳腐化を決めるキャッシュキー(proxy.key.json の内容)。
 * proxy.mp4 に焼き込まれる設定(ラウドネス・システム音声・ノイズ除去・
 * プレビュー幅・エンコード引数)か元収録ファイルが前回の生成から変われば、
 * proxy.mp4 は古い(陳腐化した)ことになる。cutCache.ts と同じ
 * 「JSON.stringify 一致」判定。videoArgs は解決済みの ffmpeg 引数の全体で、
 * コード側の品質・GOP 定数が変わったときも既存プロキシを自動再生成させる
 * (videoEncoder はその一部と重複するが、可読性のため残す)
 */
export interface ProxyCacheKey {
  targetLufs: number;
  systemAudio: { mix: boolean; volumeDb: number };
  denoise: { mic: boolean; noiseFloorDb: number };
  previewWidth: number;
  videoEncoder: "libx264" | "videotoolbox";
  videoArgs: string[];
  source: { file: string; mtimeMs: number; size: number };
}

export function buildProxyCacheKey(args: {
  cfg: Config;
  sourceFile: string;
  sourceMtimeMs: number;
  sourceSize: number;
}): ProxyCacheKey {
  const { cfg, sourceFile, sourceMtimeMs, sourceSize } = args;
  return {
    targetLufs: cfg.render.targetLufs,
    systemAudio: {
      mix: cfg.render.systemAudio?.mix ?? false,
      volumeDb: cfg.render.systemAudio?.volumeDb ?? 0,
    },
    denoise: {
      mic: cfg.render.denoise?.mic ?? false,
      noiseFloorDb: cfg.render.denoise?.noiseFloorDb ?? -25,
    },
    previewWidth: cfg.preview.width,
    videoEncoder: resolveVideoEncoder(cfg),
    videoArgs: videoEncodeArgs(cfg, { gopFrames: PROXY_GOP_FRAMES }),
    source: { file: sourceFile, mtimeMs: sourceMtimeMs, size: sourceSize },
  };
}

/** 2つのキャッシュキーが一致するか(一致すれば proxy.mp4 は古くない) */
export function proxyCacheKeyEquals(a: ProxyCacheKey, b: ProxyCacheKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
