// id-stamp: 既存プロジェクトに安定 id を一括採番する(冪等・opt-in)。
// 「id 無し → id 有効」への唯一の移行経路(§docs/plans/2026-07-07-stable-ids-design.md
// 論点3)。stampDocs(純関数・src/lib/ids.ts)を呼び、内容が実際に変わった
// ファイルだけ dir へ書く。approvals.json には一切触れない。
//
// 対象は「指せる要素」を持ちうる7ファイル: cutplan / transcript / overlays /
// chapters / bgm / shorts / thumbnail。meta.json は id を持つ要素が無いため
// 対象外(EDITABLE_FILES とは対象範囲が異なる=id-stamp 専用の一覧)。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stampDocs } from "../lib/ids.ts";
import type { EditableDocs } from "../lib/ids.ts";
import { validateDocs } from "./validate.ts";
import type { LoadedDocs, ValidateResult } from "./validate.ts";
import type {
  Bgm,
  Chapters,
  CutPlan,
  Overlays,
  Shorts,
  Thumbnail,
  Transcript,
} from "../types.ts";

/** id-stamp が読み書きする7ファイル(相対パス) */
const STAMP_FILE_OF: Record<keyof EditableDocs, string> = {
  cutplan: "cutplan.json",
  transcript: "transcript.json",
  overlays: "overlays.json",
  chapters: "chapters.json",
  bgm: "bgm.json",
  shorts: "shorts.json",
  thumbnail: "thumbnail.json",
};

function readJson<T>(dir: string, file: string): T | null {
  const p = join(dir, file);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

/** dir から id-stamp 対象の7ファイルを読み込む(無いファイルは null) */
export function readEditableDocs(dir: string): EditableDocs {
  return {
    cutplan: readJson<CutPlan>(dir, STAMP_FILE_OF.cutplan),
    transcript: readJson<Transcript>(dir, STAMP_FILE_OF.transcript),
    overlays: readJson<Overlays>(dir, STAMP_FILE_OF.overlays),
    chapters: readJson<Chapters>(dir, STAMP_FILE_OF.chapters),
    bgm: readJson<Bgm>(dir, STAMP_FILE_OF.bgm),
    shorts: readJson<Shorts>(dir, STAMP_FILE_OF.shorts),
    thumbnail: readJson<Thumbnail>(dir, STAMP_FILE_OF.thumbnail),
  };
}

export interface IdStampResult {
  /** 実際に書き換えたファイル名(相対パス)。冪等なので変化が無ければ空配列 */
  changed: string[];
  /** stamp 後の内容を validate に通した結果(参考情報。書き込みは止めない) */
  validate: ValidateResult;
}

/**
 * dir の編集ファイルを読み、stampDocs(純関数)を通し、内容が実際に変わった
 * ファイルだけを書く。2回目の呼び出しは changed が空になる(冪等)。
 * 既存 id は ensureIds/stampDocs の規約どおり不変。approvals.json は
 * 読み書きどちらも行わない。
 */
export function idStamp(dir: string): IdStampResult {
  const before = readEditableDocs(dir);
  const after = stampDocs(before);

  const changed: string[] = [];
  for (const key of Object.keys(STAMP_FILE_OF) as (keyof EditableDocs)[]) {
    const b = before[key];
    const a = after[key];
    // ファイルが無ければ何も書かない(id-stamp は新規ファイルを作らない)
    if (b === null || a === null) continue;
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    writeFileSync(join(dir, STAMP_FILE_OF[key]), JSON.stringify(a, null, 2));
    changed.push(STAMP_FILE_OF[key]);
  }

  // 参考情報として validate も通す(manifest/meta は id-stamp の対象外だが
  // validateDocs の入力形に合わせるため読むだけ読む。書き込みは止めない)
  const loaded: LoadedDocs = {
    manifest: readJson<unknown>(dir, "manifest.json"),
    cutplan: after.cutplan,
    transcript: after.transcript,
    overlays: after.overlays,
    bgm: after.bgm,
    chapters: after.chapters,
    meta: readJson<unknown>(dir, "meta.json"),
    shorts: after.shorts,
    thumbnail: after.thumbnail,
  };
  const validate = validateDocs(dir, loaded);

  return { changed, validate };
}
