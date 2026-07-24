// bin/displays/list-displays.swift を swiftc でオンデマンドビルドし、
// アクティブなディスプレイ一覧を取得する(D4 の対象ディスプレイ自動一致が
// 3用途すべてに使う)。パターンは src/lib/ocr.ts の ensureOcrBinary /
// src/lib/cursorHelperBinary.ts の ensureCursorHelperBinary と同じ。
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import type { Region } from "../types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SWIFT_SRC = join(repoRoot, "bin", "displays", "list-displays.swift");
const BUILD_DIR = join(repoRoot, "bin", "displays", ".build");
const BINARY_PATH = join(BUILD_DIR, "list-displays");

export interface DisplayInfo {
  id: number;
  uuid: string;
  /** CGDisplayBounds(Quartz グローバル座標。左上原点・Y下向き) */
  bounds: Region;
  isMain: boolean;
}

/** ビルド済みバイナリを用意する(初回のみビルド・以降はキャッシュ) */
export async function ensureDisplayListBinary(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("ディスプレイ列挙は macOS 専用です");
  }
  const needsBuild =
    !existsSync(BINARY_PATH) ||
    statSync(SWIFT_SRC).mtimeMs > statSync(BINARY_PATH).mtimeMs;
  if (needsBuild) {
    mkdirSync(BUILD_DIR, { recursive: true });
    await run("swiftc", [SWIFT_SRC, "-o", BINARY_PATH]);
  }
  return BINARY_PATH;
}

interface ListDisplaysOutput {
  displays: DisplayInfo[];
  accessibilityTrusted: boolean;
}

async function runListDisplays(): Promise<ListDisplaysOutput> {
  const binPath = await ensureDisplayListBinary();
  const { stdout } = await run(binPath, []);
  return JSON.parse(stdout) as ListDisplaysOutput;
}

/** アクティブなディスプレイ一覧を返す(macOS でない・ビルド失敗時は例外) */
export async function listDisplays(): Promise<DisplayInfo[]> {
  return (await runListDisplays()).displays;
}

/** AXIsProcessTrusted()(プロンプトを出さない読み取り専用。`doctor` D9 用) */
export async function isAccessibilityTrusted(): Promise<boolean> {
  return (await runListDisplays()).accessibilityTrusted;
}
