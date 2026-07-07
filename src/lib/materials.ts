// 素材(B-roll)の中身を AI が知る手段(`materials <dir>` コマンド)の下地。
// docs/plans/2026-07-07-material-introspection-design.md タスク2:
// 参照集合の構築・present/used 判定・slug 生成・フィンガープリント等値・
// MaterialsIndex 組み立て。**すべて純関数**(実 ffprobe/ffmpeg/fs には
// 一切依存しない。injected な probe 結果・present/fingerprint を受け取って
// 組み立てるだけ)。fs 走査・ffprobe 実行・キャッシュ再利用の判断は
// オーケストレータ(src/stages/materials.ts、タスク3)の責務。
//
// 型は src/types.ts を一切変えず、ここにローカル定義する(§波及)。
// MaterialProbe だけは summarizeProbe(src/lib/ffmpeg.ts)の戻り値型を
// そのまま再利用する(タスク1がタスク2に先行するため、そちらが「生成元」)。
import { extname } from "node:path";
import type { MaterialProbe } from "./ffmpeg.ts";
import type { Bgm, Overlays } from "../types.ts";

export type { MaterialProbe };

/** 素材の種別。既知の拡張子で判定する(§論点2「メディア判定」)。
 * `.DS_Store` 等の非メディアは "unknown"(一覧には出すが probe しない) */
export type MaterialKind = "video" | "image" | "audio" | "unknown";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"]);

/** ファイル名(相対パス)の拡張子から素材種別を判定する純関数。
 * 拡張子の大小文字は区別しない */
export function classifyKind(file: string): MaterialKind {
  const ext = extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "unknown";
}

/** どの overlay/insert/bgm が指すか(`describe --json` の MaterialEntry.id と
 * 同じ発想でアドレス可能に。`@id` があれば併記) */
export interface MaterialRef {
  as: "overlay" | "insert" | "bgm";
  id?: string;
  start?: number;
  end?: number;
  at?: number;
  durationSec?: number;
}

/** overlays.json(overlays[]/inserts[])・bgm.json(tracks[])から参照集合を
 * 構築する純関数(パース済みの JSON を受け取るだけ・fs アクセスなし)。
 * 同じファイルが複数箇所から参照されてもよい(1素材に複数 MaterialRef) */
export function buildReferences(
  overlays: Overlays | null,
  bgm: Bgm | null,
): { file: string; ref: MaterialRef }[] {
  const out: { file: string; ref: MaterialRef }[] = [];
  for (const o of overlays?.overlays ?? []) {
    out.push({
      file: o.file,
      ref: {
        as: "overlay",
        ...(o.id !== undefined ? { id: o.id } : {}),
        start: o.start,
        end: o.end,
      },
    });
  }
  for (const i of overlays?.inserts ?? []) {
    out.push({
      file: i.file,
      ref: {
        as: "insert",
        ...(i.id !== undefined ? { id: i.id } : {}),
        at: i.at,
        durationSec: i.durationSec,
      },
    });
  }
  for (const t of bgm?.tracks ?? []) {
    out.push({
      file: t.file,
      ref: {
        as: "bgm",
        ...(t.id !== undefined ? { id: t.id } : {}),
        start: t.start,
        end: t.end,
      },
    });
  }
  return out;
}

/** references(buildReferences の出力)をファイル名でグルーピングする純関数 */
export function groupReferencesByFile(
  references: { file: string; ref: MaterialRef }[],
): Map<string, MaterialRef[]> {
  const byFile = new Map<string, MaterialRef[]>();
  for (const { file, ref } of references) {
    const arr = byFile.get(file);
    if (arr) arr.push(ref);
    else byFile.set(file, [ref]);
  }
  return byFile;
}

/** 「`materials/` 実在ファイル」∪「参照集合の相対パス」の和集合を、
 * 重複排除・ソート済みで返す純関数(§論点2)。実際のディレクトリ走査
 * (readdirSync)はオーケストレータの責務で、ここは配列を受け取るだけ */
export function buildFileSet(presentFiles: string[], referencedFiles: string[]): string[] {
  return [...new Set([...presentFiles, ...referencedFiles])].sort();
}

/** 相対パスをファイル名として安全化する(slug)。パス区切りを `__` に
 * 置換するだけの単純な変換だが、`materials/slide-01.png` →
 * `materials__slide-01.png` のように衝突を避けつつ人間にも読める。
 * 元の拡張子は保持する(サイドカーは呼び出し側が `${slug}.png` 等で
 * さらに拡張子を足す) */
export function materialSlug(relPath: string): string {
  return relPath.replace(/[\\/]/g, "__");
}

/** 素材ファイルの陳腐化判定キー(mtime+size。`proxyCache.ts` の
 * `source:{file,mtimeMs,size}` に倣う。内容ハッシュではなく mtime+size なのは
 * 素材が大きな動画でありうるため) */
export interface MaterialFingerprint {
  mtimeMs: number;
  size: number;
}

/** 2つのフィンガープリントが一致するか(一致すれば取得済みの層を再利用できる)。
 * どちらか省略(未取得・present:false)なら不一致扱い */
export function fingerprintEquals(
  a: MaterialFingerprint | undefined,
  b: MaterialFingerprint | undefined,
): boolean {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** opt-in 層(frame/ocr/transcribe)の記録。撮ったときだけキーが出る
 * (MaterialEntry 側のオプショナルフィールドと同型) */
export interface MaterialFrame {
  file: string;
  atSec: number;
  width: number;
  height: number;
}

export interface MaterialOcr {
  file: string;
  coordSpace: string;
  lineCount: number;
  preview: string[];
}

export interface MaterialTranscribe {
  file: string;
  segmentCount: number;
  preview: string;
}

/** `materials.probe/index.json` の1素材ぶんの入力(オーケストレータが
 * fs走査・ffprobe・opt-in層の実行結果を注入する)。buildMaterialEntry は
 * これと参照集合から MaterialEntry を組み立てるだけの純関数 */
export interface MaterialInput {
  file: string;
  present: boolean;
  kind: MaterialKind;
  fingerprint?: MaterialFingerprint;
  probe?: MaterialProbe;
  frame?: MaterialFrame;
  ocr?: MaterialOcr;
  transcribe?: MaterialTranscribe;
}

/** `materials.probe/index.json` の1素材ぶん。`used`/`present` の組合せで
 * 未使用素材(used:false, present:true)と dangling 参照
 * (used:true, present:false)の両方を表現する(§論点2) */
export interface MaterialEntry {
  file: string;
  present: boolean;
  kind: MaterialKind;
  fingerprint?: MaterialFingerprint;
  probe?: MaterialProbe;
  references: MaterialRef[];
  used: boolean;
  frame?: MaterialFrame;
  ocr?: MaterialOcr;
  transcribe?: MaterialTranscribe;
}

/** MaterialInput + その参照集合から MaterialEntry を組み立てる純関数。
 * 任意フィールド(fingerprint/probe/frame/ocr/transcribe)は入力に在るときだけ
 * 載せる(present:false・kind:"unknown" のときは自然と省略される) */
export function buildMaterialEntry(
  input: MaterialInput,
  references: MaterialRef[],
): MaterialEntry {
  return {
    file: input.file,
    present: input.present,
    kind: input.kind,
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    ...(input.probe !== undefined ? { probe: input.probe } : {}),
    references,
    used: references.length > 0,
    ...(input.frame !== undefined ? { frame: input.frame } : {}),
    ...(input.ocr !== undefined ? { ocr: input.ocr } : {}),
    ...(input.transcribe !== undefined ? { transcribe: input.transcribe } : {}),
  };
}

/** `materials.probe/index.json` の中身 */
export interface MaterialsIndex {
  schemaVersion: number;
  capturedAt: string;
  materials: MaterialEntry[];
}

/** index.json のスキーマバージョン(将来の破壊的変更で上げる) */
export const MATERIALS_INDEX_SCHEMA_VERSION = 1;

/** 動画素材の代表フレーム抽出秒(尺の中点。§論点4)。durationSec が
 * 不明(probe 失敗・尺0以下)なら先頭フレーム(0秒)で代用する純関数 */
export function representativeFrameSec(durationSec: number | undefined): number {
  if (durationSec === undefined || !(durationSec > 0)) return 0;
  return durationSec / 2;
}

/** MaterialInput[] + 参照集合から MaterialsIndex を組み立てる純関数。
 * ファイル順は inputs の順(呼び出し側が buildFileSet でソート済みを渡す想定) */
export function buildMaterialsIndex(
  inputs: MaterialInput[],
  referencesByFile: Map<string, MaterialRef[]>,
  capturedAt: string,
): MaterialsIndex {
  return {
    schemaVersion: MATERIALS_INDEX_SCHEMA_VERSION,
    capturedAt,
    materials: inputs.map((inp) => buildMaterialEntry(inp, referencesByFile.get(inp.file) ?? [])),
  };
}
