// lib/cliName.ts — ヒント文に埋める呼び出し名が、実際に使われた入口に
// 追随することを固定する。
//
// 同じコードに2つの入口がある(bin/cutflow.mjs 経由の `cutflow` と、リポジトリ
// 直叩きの `node src/cli.ts`)。ヒントを片方に決め打ちすると、もう一方で叩いた
// 人に「自分の打ち方と違うコマンド」を読ませてしまう。argv[1] から判定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliCmd } from "../src/lib/cliName.ts";

/** process.argv[1] を差し替えて cliCmd() を評価する(後始末込み) */
function withEntry<T>(entry: string | undefined, fn: () => T): T {
  const saved = process.argv[1];
  if (entry === undefined) process.argv.splice(1, 1);
  else process.argv[1] = entry;
  try {
    return fn();
  } finally {
    process.argv[1] = saved;
  }
}

test("bin/cutflow.mjs 経由なら cutflow と案内する", () => {
  assert.equal(withEntry("/Users/x/dev/cutflow/bin/cutflow.mjs", cliCmd), "cutflow");
  // npm link が張る symlink 側(拡張子なし)で起動されることもある
  assert.equal(withEntry("/opt/homebrew/bin/cutflow", cliCmd), "cutflow");
});

test("リポジトリ直叩きなら node src/cli.ts と案内する", () => {
  assert.equal(withEntry("/Users/x/dev/cutflow/src/cli.ts", cliCmd), "node src/cli.ts");
});

test("argv[1] が無い(埋め込み実行等)ときはリポジトリ直叩き扱いにする", () => {
  assert.equal(withEntry(undefined, cliCmd), "node src/cli.ts");
});
