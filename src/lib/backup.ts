import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 人間(や AI)が手編集する対象で、plan / transcribe の再実行が上書きし得る
 * ファイル。上書き前の退避はこの一覧のうち存在するものを対象にする */
export const EDITABLE_FILES = [
  "cutplan.json",
  "chapters.json",
  "meta.json",
  "transcript.json",
  "overlays.json",
] as const;

/**
 * 上書き前の退避。存在するファイルを backups/<日時>/ へコピーし、退避先を
 * 返す(対象が1つも無ければ null)。plan / run の再実行や誤操作が手編集を
 * 消したときの復元手段で、戻すには退避先のファイルを収録フォルダ直下へ
 * コピーし直せばよい(中身は正のデータと同じただの JSON)
 */
export function backupEditableFiles(
  dir: string,
  files: readonly string[] = EDITABLE_FILES,
): string | null {
  const targets = files.filter((f) => existsSync(join(dir, f)));
  if (targets.length === 0) return null;
  // 例: backups/20260704-150405/(ローカル時刻。人間が「いつの編集か」で
  // 探すフォルダなので UTC にしない。コロンは macOS で紛れるので使わない)
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dest = join(dir, "backups", stamp);
  mkdirSync(dest, { recursive: true });
  for (const f of targets) copyFileSync(join(dir, f), join(dest, f));
  return dest;
}
