// lib/ocr.ts — 画面 OCR(Apple Vision)。「AI が画面内テキスト(コード/
// ターミナル/エラー)をテキストとして読む」知覚能力(frames --ocr)を支える。
//
// 呼び出し方式(docs/plans/2026-07-06-readable-eyes-ocr-design.md 論点2の決定):
// swiftc で `bin/ocr/vision-ocr.swift` を事前コンパイルしバイナリをキャッシュ
// (`bin/ocr/.build/vision-ocr`。.gitignore 対象)。以降は execFile でバイナリを
// 起動し、画像パス+言語 CSV を引数、JSON を stdout で受ける。
//
// 優雅な劣化(必須): 実行環境が macOS でない・swift/swiftc が無い・ビルド
// 失敗・実行失敗のいずれでも `runOcr` は例外を投げず null を返し、warn
// コールバックで警告するだけに留める(frames 本体の PNG 出力は成功で返す)。
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import type { Region } from "../types.ts";

/** ocr.languages(config.yaml)省略時の既定(認識言語の優先順) */
export const DEFAULT_OCR_LANGUAGES = ["en", "ja"];

/** Vision から返る1行(正規化座標のまま。原点左下・y上向き) */
export interface RawOcrLine {
  text: string;
  confidence: number;
  box: { x: number; y: number; w: number; h: number };
}

/** vision-ocr バイナリの stdout(JSON) */
export interface RawOcrOutput {
  lines: RawOcrLine[];
}

/** 出力px に変換済みの1行(frames --ocr の `.ocr.json` の1行) */
export interface OcrLine {
  text: string;
  confidence: number;
  /** box は本編 screenRegion 出力px 座標系(--short でも短編キャンバスへは
   * 写像しない。caption pos・blurs.rect と同じ座標系に揃える) */
  box: Region;
}

/** frames --ocr が書く `.ocr.json` の中身(出力秒・元秒は呼び出し側が付す) */
export interface OcrResult {
  /** 読み順で連結した全文(単に読む用) */
  text: string;
  lines: OcrLine[];
  /** OCR にかけたクロップの画素寸法(= screenRegion の寸法)。
   * box がどの座標系か(短編キャンバスではなく本編 screenRegion 出力px)を
   * 示すために必ず入れる */
  image: { w: number; h: number };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SWIFT_SRC = join(repoRoot, "bin", "ocr", "vision-ocr.swift");
const BUILD_DIR = join(repoRoot, "bin", "ocr", ".build");
const BINARY_PATH = join(BUILD_DIR, "vision-ocr");

/**
 * Vision の正規化 box(原点左下・y上向き)を出力px へ変換する(純関数)。
 * screenRegion はクロップの画素寸法そのもの(論点1(B)のフル解像度クロップは
 * 常に screenRegion サイズ)。out は変換先の座標空間(width/height)。
 * box は常に「本編 screenRegion 出力px」で表現するため(--short でも同じ)、
 * 呼び出し側は out に screenRegion 自身の寸法を渡す(= 恒等変換)。
 * 式:
 *   cropPx.x = nx * screenRegion.w
 *   cropPx.y = (1 - ny - nh) * screenRegion.h   // 左下原点→左上原点へ反転
 *   outPx.x  = cropPx.x * (out.width  / screenRegion.w)
 *   outPx.y  = cropPx.y * (out.height / screenRegion.h)
 */
export function normalizedBoxToOutputPx(
  box: { x: number; y: number; w: number; h: number },
  screenRegion: { w: number; h: number },
  out: { width: number; height: number },
): Region {
  const cropX = box.x * screenRegion.w;
  const cropY = (1 - box.y - box.h) * screenRegion.h;
  const cropW = box.w * screenRegion.w;
  const cropH = box.h * screenRegion.h;
  const sx = out.width / screenRegion.w;
  const sy = out.height / screenRegion.h;
  return {
    x: cropX * sx,
    y: cropY * sy,
    w: cropW * sx,
    h: cropH * sy,
  };
}

/**
 * vision-ocr の生 JSON(正規化 box)を `.ocr.json` の中身へ整形する(純関数)。
 * box は常に screenRegion 出力px(--short でも短編キャンバスへは写像しない。
 * ocr.ts の呼び出し側は out を常に screenRegion 自身にする)
 */
export function toOcrResult(raw: RawOcrOutput, screenRegion: Region): OcrResult {
  const out = { width: screenRegion.w, height: screenRegion.h };
  const lines: OcrLine[] = raw.lines.map((l) => ({
    text: l.text,
    confidence: l.confidence,
    box: normalizedBoxToOutputPx(l.box, screenRegion, out),
  }));
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    image: { w: screenRegion.w, h: screenRegion.h },
  };
}

/** frames の echo 用に OCR 結果の先頭数行を短く整形する(純関数) */
export function formatOcrPreview(result: OcrResult, maxLines = 2): string {
  if (result.lines.length === 0) return "(文字なし)";
  const head = result.lines
    .slice(0, maxLines)
    .map((l) => `"${l.text}"`)
    .join(" / ");
  const rest = result.lines.length - maxLines;
  return rest > 0 ? `${head} ほか${rest}行` : head;
}

/**
 * swiftc でビルド済みバイナリを用意する(初回のみビルド・以降はキャッシュ)。
 * ソース(vision-ocr.swift)の mtime がバイナリより新しければ再ビルドする
 * (ソース編集を拾う)。macOS でない・swiftc が無い・ビルド失敗は例外を投げる
 * (呼び出し側の runOcr が try/catch して優雅に劣化させる)
 */
export async function ensureOcrBinary(): Promise<string> {
  const needsBuild =
    !existsSync(BINARY_PATH) ||
    statSync(SWIFT_SRC).mtimeMs > statSync(BINARY_PATH).mtimeMs;
  if (needsBuild) {
    mkdirSync(BUILD_DIR, { recursive: true });
    await run("swiftc", ["-O", SWIFT_SRC, "-o", BINARY_PATH]);
  }
  return BINARY_PATH;
}

export interface RunOcrOptions {
  /** 認識言語の優先順(Vision の recognitionLanguages)。省略時 DEFAULT_OCR_LANGUAGES */
  languages?: string[];
  /** 非対応環境・失敗時の警告コールバック */
  warn: (msg: string) => void;
}

/**
 * 画像1枚を OCR して `.ocr.json` の中身を返す。macOS でない・swift 系が無い・
 * 実行失敗のいずれでも例外を投げず null を返し、opts.warn で警告するだけに
 * 留める(frames 本体の PNG 出力は成功で返す=優雅な劣化)
 */
export async function runOcr(
  imagePath: string,
  screenRegion: Region,
  opts: RunOcrOptions,
): Promise<OcrResult | null> {
  const languages = opts.languages ?? DEFAULT_OCR_LANGUAGES;
  try {
    const binPath = await ensureOcrBinary();
    const { stdout } = await run(binPath, [imagePath, languages.join(",")]);
    const raw = JSON.parse(stdout) as RawOcrOutput;
    return toOcrResult(raw, screenRegion);
  } catch (err) {
    opts.warn(
      "OCR は Apple Vision(macOS)が必要です。画面 OCR をスキップしました" +
        `(${(err as Error).message})`,
    );
    return null;
  }
}
