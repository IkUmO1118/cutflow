// 収録フォルダ内のファイル分類の単一の真実。
//
// EDITABLE_FILES(人間/AI が手編集する対象。plan/transcribe の再実行が
// backups/ へ退避してから上書きする)・GENERATED_FILES(中間生成物。
// CLAUDE.md の「中間生成物は編集しない」一覧と一致させる。手編集されても
// 次の実行で上書きされる/再生成できるので実害が薄い)・APPROVAL_FILE
// (承認レコード。編集ワークフローのどちらにも属さない第3カテゴリ。
// backup 退避の対象にはしない)の3分類を1箇所にまとめ、backup.ts・cli.ts・
// ドキュメント(§10 T8 の推奨 deny スニペット)がここから派生する。
import { APPROVALS_FILE } from "./approval.ts";

/** 人間(や AI)が手編集する対象で、plan / transcribe の再実行が上書きし得る
 * ファイル。上書き前の退避はこの一覧のうち存在するものを対象にする
 * (backup.ts の backupEditableFiles の既定値としても使う) */
export const EDITABLE_FILES = [
  "cutplan.json",
  "chapters.json",
  "meta.json",
  "transcript.json",
  "overlays.json",
] as const;

/** 中間生成物のうち、収録フォルダ直下で名前が固定のもの。CLAUDE.md の
 * 「中間生成物は編集しない」一覧(ショート名で可変にならない部分)と一致させる */
export const GENERATED_FILES = [
  "manifest.json",
  "cuts.auto.json",
  "plan.raw.txt",
  "plan-shorts.raw.txt",
  "render.props.json",
  "whisper-out.json",
  "whisper-out.srt",
  "transcript.system.json",
  "whisper-system-out.json",
  "cut.mp4",
  "cut.keeps.json",
  "render.key.json",
  "preview.mp4",
  "proxy.mp4",
  "proxy.key.json",
] as const;

/** 中間生成物のうち、ショート名(shorts.json の name)で可変になる
 * ファイル名パターン。GENERATED_FILES と合わせて一覧を成す
 * (cut.<name>.mp4 / cut.<name>.keeps.json / render.<name>.props.json /
 * render.<name>.key.json) */
const GENERATED_NAME_PATTERNS: readonly RegExp[] = [
  /^cut\.[^./]+\.mp4$/,
  /^cut\.[^./]+\.keeps\.json$/,
  /^render\.[^./]+\.props\.json$/,
  /^render\.[^./]+\.key\.json$/,
];

/** 中間生成物のディレクトリ(配下は丸ごと中間生成物扱い): frames/(PNG・
 * props.json・OCR サイドカー。frames 実行のたびに全消しされる)・
 * render.chunks/(チャンク差分レンダーのキャッシュ)・shorts/(render --short /
 * --shorts の出力先。final.mp4 相当の成果物だが CLAUDE.md は同じ
 * 「触らない」節で扱っているためここに含める)・materials.probe/(`materials
 * <dir>` が書く素材知覚の集約+キャッシュ。frames/ と違い実行のたびに
 * 全消しはされない差分更新型。`materials/` 自体(人間の素材置き場)とは
 * 別名の生成ディレクトリなので "other" にはならない) */
const GENERATED_DIRS: readonly string[] = ["frames", "render.chunks", "shorts", "materials.probe"];

/** 収録フォルダ直下の承認レコードファイル名(src/lib/approval.ts の再輸出。
 * files.ts をファイル分類の唯一の出所にするため、他コードはここから参照する) */
export const APPROVAL_FILE = APPROVALS_FILE;

export type FileRole = "editable" | "generated" | "approval" | "other";

/** 収録フォルダからの相対パス(例: "cutplan.json" / "frames/out10s.png") から
 * ファイルの分類を返す。EDITABLE_FILES / GENERATED_FILES(+パターン・
 * ディレクトリ) / APPROVAL_FILE のどれにも該当しなければ "other"
 * (final.mp4 / thumbnail.png / bgm.* / materials/ / rules*.md / backups/ /
 * .editor-draft.json など、人間の成果物やその他の特別扱いファイル) */
export function fileRole(relPath: string): FileRole {
  if (relPath === APPROVAL_FILE) return "approval";
  if ((EDITABLE_FILES as readonly string[]).includes(relPath)) return "editable";
  if ((GENERATED_FILES as readonly string[]).includes(relPath)) return "generated";
  if (GENERATED_NAME_PATTERNS.some((re) => re.test(relPath))) return "generated";
  const top = relPath.split("/")[0];
  if (GENERATED_DIRS.includes(top)) return "generated";
  return "other";
}
