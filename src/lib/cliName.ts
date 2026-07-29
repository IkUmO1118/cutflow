// CLI が自分自身を案内するときの呼び出し名。
//
// 同じコードに2つの入口がある:
//   - `framewright <cmd>`      … bin/framewright.mjs 経由(npm link 済み。人間の既定)
//   - `node src/cli.ts <cmd>` … リポジトリ直叩き(リンク不要。ドキュメント/エージェントの既定)
// エラーや次手順のヒントを常にどちらか一方で書くと、もう一方の入口で叩いた人に
// 「そのコマンド、私の打ち方と違う」と読ませてしまう。実際に使われた入口を
// argv[1] から見て、同じ入口で書き返す。

import { basename } from "node:path";

/** bin/framewright.mjs 経由で起動されたか(= PATH に通った framewright で叩かれたか) */
function launchedViaBin(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return basename(entry) === "framewright.mjs" || basename(entry) === "framewright";
}

/**
 * ヒント文に埋める呼び出し名。`${cliCmd()} validate <dir>` のように使う。
 * 戻り値は "framewright" か "node src/cli.ts"。
 */
export function cliCmd(): string {
  return launchedViaBin() ? "framewright" : "node src/cli.ts";
}
