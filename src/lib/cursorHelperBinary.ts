// vendor した OpenScreen カーソルヘルパ(src/lib/vendor/openscreen/…/main.swift)を
// swiftc でオンデマンドビルドする(D1 の方針: SwiftPM のパッケージ解決は不要な
// 単一ファイルなので `swiftc main.swift -o <bin>` を直接叩く)。
// パターンは src/lib/ocr.ts の ensureOcrBinary と同じ(初回のみビルド・
// ソース mtime がバイナリより新しければ再ビルド。ビルド生成物は .gitignore 対象)。
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR_DIR = join(repoRoot, "src", "lib", "vendor", "openscreen", "OpenScreenMacOSCursorHelper");
const SWIFT_SRC = join(VENDOR_DIR, "main.swift");
const BUILD_DIR = join(VENDOR_DIR, ".build");
const BINARY_PATH = join(BUILD_DIR, "cutflow-cursor-helper");

/**
 * ビルド済みバイナリを用意する(初回のみビルド・以降はキャッシュ)。
 * macOS でない・swiftc が無い・ビルド失敗は例外を投げる(呼び出し側の
 * `record --watch` はこれを起動不能として doctor 相当のメッセージで扱う)
 */
export async function ensureCursorHelperBinary(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("カーソルヘルパは macOS 専用です(ScreenCaptureKit と同じ制約)");
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

export { BINARY_PATH as CURSOR_HELPER_BINARY_PATH, SWIFT_SRC as CURSOR_HELPER_SWIFT_SRC };
