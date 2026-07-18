// エディタの並行制御(§8.3)専用の内容バージョン。承認ハッシュ(src/lib/approval.ts)
// とは別物: こちらは「ファイルの生バイトの SHA-256」で、client には不透明な
// ETag として渡り、client は再計算せず echo するだけ。承認ハッシュは keep 集合の
// 正規化射影の SHA で、用途も入力も異なる。両者は絶対に混ぜない。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 並行制御の対象ファイル = SaveRequest が書ける集合。
 *  chapters/meta/thumbnail はエディタが書かない(= 上書き競合が起きない)ので含めない。 */
export const CONCURRENCY_FILES = [
  "cutplan.json",
  "overlays.json",
  "transcript.json",
  "bgm.json",
  "shorts.json",
] as const;

/** SaveRequest のドキュメントキー → ファイル名。 */
export const DOC_FILE: Record<string, string> = {
  cutplan: "cutplan.json",
  overlays: "overlays.json",
  transcript: "transcript.json",
  bgm: "bgm.json",
  shorts: "shorts.json",
};

/** client が /api/project で受け取り save 時に echo する不透明バージョン token。
 *  値は "sha256:<hex>"。ファイルが読み込み時に存在しなかったら null。 */
export type BaseHashes = Record<string, string | null>;

/** 文字列の内容ハッシュ。saveProject が「今書いた内容」を記録するのに使う。 */
export function hashOfString(s: string): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

/** ファイルの生バイトの内容ハッシュ。存在しなければ null。 */
export function fileContentHash(dir: string, file: string): string | null {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  return "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 存在する CONCURRENCY_FILES の内容ハッシュ(存在しないものはキーごと省略)。 */
export function contentHashesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of CONCURRENCY_FILES) {
    const h = fileContentHash(dir, file);
    if (h !== null) out[file] = h;
  }
  return out;
}

/**
 * watch イベントを「外部変更か」に分類する純関数。
 * current = 現ディスク内容ハッシュ(存在しなければ null)
 * lastWritten = 自分が最後に書いた内容ハッシュ / null(自分で削除) / undefined(未書き込み)
 * 一致しなければ外部変更(SSE で流す)。
 *   - current===last(hash)          → 自己エコー、抑制
 *   - current=null & last=null       → 自分で削除したまま、抑制
 *   - current=null & last=hash        → 外部が削除、発火
 *   - current=hash & last=null|undef  → 外部が作成/変更、発火
 *   - last=undefined & current=hash   → 未書き込みへの外部変更、発火
 */
export function isExternalChange(
  current: string | null,
  lastWritten: string | null | undefined,
): boolean {
  return current !== lastWritten;
}

/**
 * save 前の内容バージョンゲート(純関数・fs 読み取りのみ)。
 * body が書く/削除する各ファイルについて、現ディスクハッシュが client の
 * baseHashes と一致するか調べる。baseHashes 自体が無ければ従来どおり無条件(空 stale)。
 * baseHashes にキーが無いファイルは「読み込み時に存在しなかった」= null 期待として扱う。
 */
export function checkBaseHashes(
  dir: string,
  body: { baseHashes?: BaseHashes } & Record<string, unknown>,
): { stale: string[] } {
  const base = body.baseHashes;
  if (base === undefined) return { stale: [] }; // 後方互換: 無ければゲートしない
  const stale: string[] = [];
  for (const [key, file] of Object.entries(DOC_FILE)) {
    if (body[key] === undefined) continue; // このファイルは触らない
    const expected = file in base ? base[file] : null; // キー無し=absent 期待
    const current = fileContentHash(dir, file);
    if (current !== expected) stale.push(file);
  }
  return { stale };
}
