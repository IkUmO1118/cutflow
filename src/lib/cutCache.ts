import type { Config } from "./config.ts";
import type { Manifest } from "../types.ts";
import type { PlaybackSegment } from "./timeline.ts";

/**
 * cut.mp4 の再利用可否を決めるキャッシュキー(cut.keeps.json の内容)。
 * keeps・音声設定・元収録ファイルのいずれかが前回の render と変われば
 * キーも変わり、render は cutFullRes(loudnorm実測込み)を再実行する。
 */
export interface CutCacheKey {
  keeps: { start: number; end: number; speed?: number }[];
  targetLufs: number;
  systemAudio: { mix: boolean; volumeDb: number };
  denoise: { mic: boolean; noiseFloorDb: number };
  micStream: number;
  systemStream: number | null;
  source: { file: string; mtimeMs: number; size: number };
}

export function buildCutCacheKey(args: {
  keeps: PlaybackSegment[];
  manifest: Manifest;
  cfg: Config;
  sourceMtimeMs: number;
  sourceSize: number;
}): CutCacheKey {
  const { keeps, manifest, cfg, sourceMtimeMs, sourceSize } = args;
  return {
    keeps: keeps.map((k) => ({
      start: k.start,
      end: k.end,
      ...(k.speed !== 1 ? { speed: k.speed } : {}),
    })),
    targetLufs: cfg.render.targetLufs,
    systemAudio: {
      mix: cfg.render.systemAudio?.mix ?? false,
      volumeDb: cfg.render.systemAudio?.volumeDb ?? 0,
    },
    denoise: {
      mic: cfg.render.denoise?.mic ?? false,
      noiseFloorDb: cfg.render.denoise?.noiseFloorDb ?? -25,
    },
    micStream: manifest.audio.micStream,
    systemStream: manifest.audio.systemStream,
    source: {
      file: manifest.source,
      mtimeMs: sourceMtimeMs,
      size: sourceSize,
    },
  };
}

/** 2つのキャッシュキーが一致するか(一致すれば cut.mp4 を再利用してよい) */
export function cutCacheKeyEquals(a: CutCacheKey, b: CutCacheKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
