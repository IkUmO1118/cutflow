// 素材(B-roll)の中身を AI が知る知覚コマンド(`materials <dir>`)の
// オーケストレータ。docs/plans/2026-07-07-material-introspection-design.md
// タスク3: `materials/` の実在ファイル ∪ overlays/inserts/bgm の参照集合を
// ffprobe し、`materials.probe/index.json`(機械可読な集約+キャッシュ)を
// 書いて stdout に要約を出す。純関数(src/lib/materials.ts・
// summarizeProbe)を束ねるだけで、判定ロジック自体はそちらに集約している。
//
// キャッシュ: 素材ごとに mtime+size フィンガープリントを前回の index.json と
// 突き合わせ、不変なら probe をスキップして前回の結果を再利用する
// (§論点5)。既定(フラグ無し)は probe 層だけを取得する。opt-in 層
// (--frames/--ocr/--transcribe)はタスク4〜6でここに追加する。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probe, summarizeProbe } from "../lib/ffmpeg.ts";
import {
  buildFileSet,
  buildMaterialsIndex,
  buildReferences,
  classifyKind,
  fingerprintEquals,
  groupReferencesByFile,
} from "../lib/materials.ts";
import type {
  MaterialFingerprint,
  MaterialInput,
  MaterialRef,
  MaterialsIndex,
} from "../lib/materials.ts";
import type { Bgm, Overlays } from "../types.ts";

/** `materials.probe/` の中身は他の生成ディレクトリ(frames/・render.chunks/)と
 * 同じ「手編集しない generated」だが、frames/ と違い**キャッシュ型**
 * (差分更新。ディレクトリごと削除すれば全再生成に戻る) */
export const MATERIALS_PROBE_DIR = "materials.probe";
export const MATERIALS_INDEX_FILE = "index.json";

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
 * 素材の中身を probe(既定層のみ)して `materials.probe/index.json` を
 * 書き出す。overlays.json/bgm.json は無くても動く(readOptional 相当)。
 * kind:"unknown"(非メディア。.DS_Store 等)は probe しない(一覧には出す)。
 * present:false(dangling 参照)も probe しない。
 */
export async function materials(dir: string): Promise<MaterialsResult> {
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
    const reusable = prev !== undefined && fingerprintEquals(prev.fingerprint, fingerprint) && prev.probe !== undefined;
    const probeResult = reusable ? prev!.probe : summarizeProbe(await probe(abs));
    inputs.push({ file, present, kind, fingerprint, probe: probeResult });
  }

  const index = buildMaterialsIndex(inputs, referencesByFile, new Date().toISOString());
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return { index, indexPath };
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
