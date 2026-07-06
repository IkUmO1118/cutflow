// lib/screenStill.ts — フル解像度 screenRegion still 抽出(OCR 専用)。
// 元収録(manifest.source)の指定秒を ffmpeg でクロップし PNG 1枚を書き出す。
// Remotion を一切通さない(論点1(B)の決定。合成なし・純粋に画面の生ピクセル)。
// 出力はカメラ領域・テロップ帯を含まない(screenRegion クロップなので構造的に
// 含まれない)。呼び出し側(frames.ts)が OCR 用の使い捨て中間ファイルとして
// 生成・使用後に削除する想定
import { join } from "node:path";
import { run } from "./exec.ts";
import type { Manifest, Region } from "../types.ts";

/** ffmpeg -vf の crop 引数を組み立てる(純関数) */
export function cropFilterArg(rect: Region): string {
  return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
}

/** ffmpeg -ss に渡す秒の文字列化(小数第3位まで) */
export function seekArg(sourceSec: number): string {
  return sourceSec.toFixed(3);
}

/** screenStill 抽出の ffmpeg 引数一式を組み立てる(純関数。実行はしない) */
export function screenStillArgs(
  input: string,
  screenRegion: Region,
  sourceSec: number,
  outPath: string,
): string[] {
  return [
    "-y", "-v", "error",
    "-ss", seekArg(sourceSec),
    "-i", input,
    "-vf", cropFilterArg(screenRegion),
    "-frames:v", "1",
    outPath,
  ];
}

/**
 * 元収録(raw)の sourceSec(元収録の秒)から screenRegion をフル解像度で
 * クロップし、outPath に PNG 1枚を書き出す。カメラ領域・テロップ帯は
 * screenRegion クロップの外なので含まれない
 */
export async function buildScreenStill(
  dir: string,
  manifest: Manifest,
  sourceSec: number,
  outPath: string,
): Promise<string> {
  const input = join(dir, manifest.source);
  await run(
    "ffmpeg",
    screenStillArgs(input, manifest.video.screenRegion, sourceSec, outPath),
  );
  return outPath;
}
