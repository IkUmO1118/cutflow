import { existsSync } from "node:fs";
import { join } from "node:path";
import { backupEditableFiles } from "./backup.ts";
import { EDITABLE_FILES } from "./files.ts";
import { isBootstrapArtifact } from "./bootstrapArtifact.ts";

export function rerunConflicts(dir: string, outputs: string[]): string[] {
  return outputs.filter((file) => {
    const path = join(dir, file);
    return existsSync(path) && !isBootstrapArtifact(path);
  });
}

export function guardRerun(dir: string, outputs: string[], force: boolean, cmd: string): void {
  const existing = rerunConflicts(dir, outputs);
  if (existing.length === 0) return;
  if (!force) {
    throw new Error(
      `${existing.join(" / ")} が既にあります。${cmd} の再実行はこれらを ` +
        "LLM の生成物で上書きし、手編集が消えます。\n" +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを " +
        "backups/ へ退避します)",
    );
  }
  const backupList = [...new Set([...EDITABLE_FILES, ...outputs])];
  const dest = backupEditableFiles(dir, backupList);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}
