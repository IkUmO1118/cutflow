import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Region } from "../types.ts";

export interface Config {
  recordingsDir: string;
  ingest: {
    screenRegion: Region;
    cameraRegion: Region;
    micTrack: number;
    systemTrack: number;
  };
  whisper: { bin: string; model: string; language: string };
  detect: {
    silenceDb: number;
    minSilenceSec: number;
    padSec: number;
    minKeepSec: number;
  };
  llm: { backend: "claude-cli" | "api"; model: string };
  preview: { width: number };
  /** エディタ(GUI)設定。省略可(古い config.yaml との互換) */
  editor?: {
    /** 素材アップロード(/api/upload)の1ファイルの上限(MB)。省略時は既定値 */
    maxUploadMb?: number;
  };
  render: {
    wipeWidthPx: number;
    wipeMarginPx: number;
    captionFontSizePx: number;
    chapterCardSec: number;
    targetLufs: number;
    /** システム音声(ingest.systemTrack)のミックス設定。
     * 省略時はミックスしない(古い config.yaml との互換) */
    systemAudio?: { mix: boolean; volumeDb: number };
    bgm: {
      volumeDb: number;
      fadeOutSec: number;
      /** 発話中に BGM を下げるダッキング。省略か duckDb: 0 で無効 */
      ducking?: { duckDb: number; fadeSec: number };
    };
  };
}

/** "~/foo" をホームディレクトリに展開する */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * config.yaml を読み込む。探す順序:
 * 1. --config で明示されたパス
 * 2. カレントディレクトリの config.yaml
 * 3. リポジトリ直下の config.yaml(デフォルト設定)
 */
export function loadConfig(explicitPath?: string): Config {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = explicitPath
    ? [explicitPath]
    : [resolve("config.yaml"), join(repoRoot, "config.yaml")];

  for (const path of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const cfg = parse(raw) as Config;
    cfg.recordingsDir = expandHome(cfg.recordingsDir);
    cfg.whisper.model = expandHome(cfg.whisper.model);
    return cfg;
  }
  throw new Error(
    `config.yaml が見つかりません(探した場所: ${candidates.join(", ")})`,
  );
}
