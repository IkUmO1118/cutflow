// src/cli.ts の `run <dir>` コマンドの配線を固定する。
// run は ingest→transcribe→detect→plan の重い統合(whisper/LLM 呼び出し)
// なので実行はしない。代わりに「plan の後に id-stamp を1回呼ぶ」という
// 配線(§docs/plans/2026-07-07-stable-ids-design.md タスク9)をソース上で
// 固定する: run コマンドのブロック内で idStamp(abs) の呼び出しが
// plan(abs, cfg) の呼び出しより後ろにあること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const cliSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"),
  "utf8",
);

/** `program.command("run <dir>")` から次の `program.command(` までを抜く */
function runCommandBlock(src: string): string {
  const start = src.indexOf('.command("run <dir>")');
  assert.ok(start !== -1, "run <dir> コマンドが見つからない");
  const nextCommand = src.indexOf('program\n  .command(', start + 1);
  return nextCommand === -1 ? src.slice(start) : src.slice(start, nextCommand);
}

test("run コマンドは idStamp を import している", () => {
  assert.match(cliSrc, /import\s*\{[^}]*\bidStamp\b[^}]*\}\s*from\s*"\.\/stages\/idStamp\.ts"/);
});

test("run コマンドのブロック内に idStamp(abs) 呼び出しがある", () => {
  const block = runCommandBlock(cliSrc);
  assert.match(block, /idStamp\(abs\)/);
});

test("run コマンド内で idStamp(abs) は plan(abs, cfg) より後ろに呼ばれる(末尾配線)", () => {
  const block = runCommandBlock(cliSrc);
  // plan は timed("plan", () => plan(abs, cfg)) でラップされているため
  // "await" 直後ではなく "plan(abs, cfg)" のリテラルで位置を取る
  const planIdx = block.indexOf("plan(abs, cfg)");
  const stampIdx = block.indexOf("idStamp(abs)");
  assert.ok(planIdx !== -1, "plan(abs, cfg) 呼び出しが見つからない");
  assert.ok(stampIdx !== -1, "idStamp(abs) 呼び出しが見つからない");
  assert.ok(stampIdx > planIdx, "idStamp は plan より後ろで呼ばれる必要がある");
});
