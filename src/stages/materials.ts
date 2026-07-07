// 素材(B-roll)の中身を AI が知る知覚コマンド(`materials <dir>`)の
// オーケストレータ。docs/plans/2026-07-07-material-introspection-design.md
// タスク3: `materials/` の実在ファイル ∪ overlays/inserts/bgm の参照集合を
// ffprobe し、`materials.probe/index.json`(機械可読な集約+キャッシュ)を
// 書いて stdout に要約を出す。純関数(src/lib/materials.ts・
// summarizeProbe)を束ねるだけで、判定ロジック自体はそちらに集約している。
//
// キャッシュ: 素材ごとに mtime+size フィンガープリントを前回の index.json と
// 突き合わせ、不変なら probe/frame/ocr をスキップして前回の結果を再利用する
// (§論点5)。既定(フラグ無し)は probe 層だけを取得する。--transcribe は
// タスク6でここに追加する。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { probe, summarizeProbe } from "../lib/ffmpeg.ts";
import { runOcr } from "../lib/ocr.ts";
import { buildPlainStill } from "../lib/screenStill.ts";
import {
  buildFileSet,
  buildMaterialsIndex,
  buildReferences,
  classifyKind,
  fingerprintEquals,
  groupReferencesByFile,
  materialSlug,
  representativeFrameSec,
} from "../lib/materials.ts";
import type {
  MaterialFingerprint,
  MaterialFrame,
  MaterialInput,
  MaterialOcr,
  MaterialRef,
  MaterialsIndex,
} from "../lib/materials.ts";
import type { Bgm, Overlays, Region } from "../types.ts";

/** OCR プレビュー(index.json に載せる先頭行数)。frames --ocr の stdout
 * echo(formatOcrPreview 既定2行)より少し多め(index は後から読む用なので) */
const OCR_PREVIEW_LINES = 5;

/** 素材フレーム OCR の box 座標系ラベル(素材自身のピクセル座標。本編
 * screenRegion 出力px とは無関係。§論点4「OCR の座標系」) */
const MATERIAL_FRAME_COORD_SPACE = "material-frame-px";

/** `materials.probe/` の中身は他の生成ディレクトリ(frames/・render.chunks/)と
 * 同じ「手編集しない generated」だが、frames/ と違い**キャッシュ型**
 * (差分更新。ディレクトリごと削除すれば全再生成に戻る) */
export const MATERIALS_PROBE_DIR = "materials.probe";
export const MATERIALS_INDEX_FILE = "index.json";

export interface MaterialsOptions {
  /** 代表フレーム PNG を抽出する(動画は尺の中点1枚。画像は自身のパスを
   * frame.file に記録=複製しない)。省略時 false(probe 層のみ) */
  frames?: boolean;
  /** フレーム/画像を Apple Vision で OCR する(動画は --frames を含意)。
   * 非対応環境(macOS 以外等)では runOcr が null を返し警告のみに留める
   * (probe/frame の出力は成功のまま)。省略時 false */
  ocr?: boolean;
}

export interface MaterialsResult {
  index: MaterialsIndex;
  /** 書き出した index.json の絶対パス */
  indexPath: string;
}

function readJsonOrFallback<T>(dir: string, file: string, fallback: T): T {
  const p = join(dir, file);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** `materials/` 配下の実在ファイル一覧(収録フォルダ直下からの相対パス)。
 * ディレクトリが無ければ空配列(新規プロジェクトで普通に起こる) */
function listPresentMaterialFiles(dir: string): string[] {
  const materialsDir = join(dir, "materials");
  if (!existsSync(materialsDir)) return [];
  return readdirSync(materialsDir)
    .filter((f) => statSync(join(materialsDir, f)).isFile())
    .map((f) => join("materials", f));
}

/**
 * 素材を probe(既定層)し、opts.frames が真なら代表フレーム PNG も抽出して
 * `materials.probe/index.json` を書き出す。overlays.json/bgm.json は無くても
 * 動く(readOptional 相当)。kind:"unknown"(非メディア。.DS_Store 等)は
 * probe/frame いずれもしない(一覧には出す)。present:false(dangling 参照)も
 * 同様に何も取得しない。
 */
export async function materials(
  dir: string,
  opts: MaterialsOptions = {},
  cfg?: Config,
): Promise<MaterialsResult> {
  const overlays = readJsonOrFallback<Overlays>(dir, "overlays.json", {});
  const bgm = readJsonOrFallback<Bgm | null>(dir, "bgm.json", null);

  const references = buildReferences(overlays, bgm);
  const referencesByFile = groupReferencesByFile(references);

  const presentFiles = listPresentMaterialFiles(dir);
  const files = buildFileSet(presentFiles, [...referencesByFile.keys()]);

  const outDir = join(dir, MATERIALS_PROBE_DIR);
  mkdirSync(outDir, { recursive: true });
  const indexPath = join(outDir, MATERIALS_INDEX_FILE);

  const prevIndex = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as MaterialsIndex)
    : null;
  const prevByFile = new Map((prevIndex?.materials ?? []).map((m) => [m.file, m]));

  const inputs: MaterialInput[] = [];
  for (const file of files) {
    const abs = join(dir, file);
    const present = existsSync(abs);
    const kind = classifyKind(file);
    if (!present || kind === "unknown") {
      inputs.push({ file, present, kind });
      continue;
    }
    const stat = statSync(abs);
    const fingerprint: MaterialFingerprint = { mtimeMs: stat.mtimeMs, size: stat.size };
    const prev = prevByFile.get(file);
    const unchanged = prev !== undefined && fingerprintEquals(prev.fingerprint, fingerprint);
    const probeResult =
      unchanged && prev!.probe !== undefined ? prev!.probe : summarizeProbe(await probe(abs));

    const input: MaterialInput = { file, present, kind, fingerprint, probe: probeResult };

    // --ocr は動画に対して --frames を含意する(OCR には PNG が要るため)。
    // 画像は自身が代表フレームなので frame 解決は ffmpeg を呼ばない
    if ((opts.frames || opts.ocr) && (kind === "video" || kind === "image")) {
      input.frame = await resolveFrame({ dir, file, abs, kind, probe: probeResult, unchanged, prev });
    }
    if (opts.ocr && input.frame !== undefined) {
      const result = await resolveOcr({ dir, file, frame: input.frame, unchanged, prev, cfg });
      if (result !== undefined) input.ocr = result;
    }

    inputs.push(input);
  }

  const index = buildMaterialsIndex(inputs, referencesByFile, new Date().toISOString());
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return { index, indexPath };
}

/**
 * 1素材ぶんの代表フレームを解決する。画像は自身のパスを frame.file に記録
 * するだけ(複製しない・ffmpeg を呼ばない)。動画は尺の中点1枚を
 * `materials.probe/<slug>.png` に抽出する(不変素材かつ前回の frame が
 * 実在すれば再抽出せず前回の記録を再利用する)
 */
async function resolveFrame(args: {
  dir: string;
  file: string;
  abs: string;
  kind: MaterialInput["kind"];
  probe: MaterialInput["probe"];
  unchanged: boolean;
  prev: MaterialsIndex["materials"][number] | undefined;
}): Promise<MaterialFrame> {
  const { dir, file, abs, kind, probe: p, unchanged, prev } = args;
  const width = p?.width ?? 0;
  const height = p?.height ?? 0;

  if (kind === "image") {
    // 画像は自身が代表フレーム(PNG を複製しない)。atSec は概念が無いので 0
    return { file, atSec: 0, width, height };
  }

  // video(kind === "audio"/"unknown" はここに来ない。呼び出し側が opts.frames
  // でも present/kind を見て呼ぶかどうかを決める)
  const atSec = representativeFrameSec(p?.durationSec);
  const pngRelPath = join(MATERIALS_PROBE_DIR, `${materialSlug(file)}.png`);
  const pngAbsPath = join(dir, pngRelPath);
  const reusable = unchanged && prev?.frame !== undefined && existsSync(pngAbsPath);
  if (reusable) return prev!.frame!;

  await buildPlainStill(abs, atSec, pngAbsPath);
  return { file: pngRelPath, atSec, width, height };
}

/**
 * 1素材ぶんのフレーム/画像 OCR を解決する。region は frame の画素寸法
 * そのもの(素材フレームのピクセル座標。§論点4)。非対応環境・失敗時は
 * runOcr が null を返し警告のみ(呼び出し側は input.ocr を付けないだけで、
 * probe/frame の出力は成功のまま = 優雅な劣化)
 */
async function resolveOcr(args: {
  dir: string;
  file: string;
  frame: MaterialFrame;
  unchanged: boolean;
  prev: MaterialsIndex["materials"][number] | undefined;
  cfg?: Config;
}): Promise<MaterialOcr | undefined> {
  const { dir, file, frame, unchanged, prev, cfg } = args;
  const ocrRelPath = join(MATERIALS_PROBE_DIR, `${materialSlug(file)}.ocr.json`);
  const ocrAbsPath = join(dir, ocrRelPath);
  const reusable = unchanged && prev?.ocr !== undefined && existsSync(ocrAbsPath);
  if (reusable) return prev!.ocr;

  const imagePath = join(dir, frame.file);
  const region: Region = { x: 0, y: 0, w: frame.width, h: frame.height };
  const result = await runOcr(imagePath, region, {
    languages: cfg?.ocr?.languages,
    warn: (msg) => console.warn(`警告: ${msg}`),
  });
  if (result === null) return undefined; // 非対応環境等(warn 済み)

  writeFileSync(ocrAbsPath, JSON.stringify(result, null, 2));
  return {
    file: ocrRelPath,
    coordSpace: MATERIAL_FRAME_COORD_SPACE,
    lineCount: result.lines.length,
    preview: result.lines.slice(0, OCR_PREVIEW_LINES).map((l) => l.text),
  };
}

function refLabel(ref: MaterialRef): string {
  return ref.id ? `${ref.as} ${ref.id}` : ref.as;
}

/** stdout 用の1行要約(frames の 1 行 echo と同じノリ)。素材ごとに
 * 種別・尺・解像度・fps・音声有無・参照先 or 未使用/dangling 印を出す */
export function formatMaterialsSummary(index: MaterialsIndex): string[] {
  return index.materials.map((m) => {
    if (!m.present) {
      const refs = m.references.map(refLabel).join(", ");
      return `${m.file}\t(⚠ 参照されているが materials/ に無い${refs ? `: ${refs}` : ""})`;
    }
    const bits: string[] = [m.kind];
    if (m.probe?.durationSec !== undefined) bits.push(`${m.probe.durationSec.toFixed(1)}s`);
    if (m.probe?.width !== undefined && m.probe?.height !== undefined) {
      bits.push(`${m.probe.width}x${m.probe.height}`);
    }
    if (m.probe?.fps !== undefined) bits.push(`${Math.round(m.probe.fps)}fps`);
    if (m.probe) bits.push(m.probe.hasAudio ? "音声あり" : "音声なし");
    const tail =
      m.references.length > 0 ? `[${m.references.map(refLabel).join(", ")}]` : "未使用 ⚠";
    return `${m.file}\t${bits.join(" ")}\t${tail}`;
  });
}
