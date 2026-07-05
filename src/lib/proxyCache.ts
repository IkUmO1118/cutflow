import type { Config } from "./config.ts";

/**
 * proxy.mp4 の陳腐化を決めるキャッシュキー(proxy.key.json の内容)。
 * proxy.mp4 に焼き込まれる設定(ラウドネス・システム音声・プレビュー幅・
 * エンコーダ)か元収録ファイルが前回の生成から変われば、proxy.mp4 は
 * 古い(陳腐化した)ことになる。cutCache.ts と同じ「JSON.stringify 一致」判定
 */
export interface ProxyCacheKey {
  targetLufs: number;
  systemAudio: { mix: boolean; volumeDb: number };
  previewWidth: number;
  videoEncoder: "libx264" | "videotoolbox";
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
    previewWidth: cfg.preview.width,
    videoEncoder: cfg.preview.videoEncoder ?? "videotoolbox",
    source: { file: sourceFile, mtimeMs: sourceMtimeMs, size: sourceSize },
  };
}

/** 2つのキャッシュキーが一致するか(一致すれば proxy.mp4 は古くない) */
export function proxyCacheKeyEquals(a: ProxyCacheKey, b: ProxyCacheKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
