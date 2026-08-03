// run の共通本体(src/stages/runDraft.ts)で plan 後に idStamp を1回呼ぶ配線を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const cliSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"),
  "utf8",
);
const runDraftSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "stages", "runDraft.ts"),
  "utf8",
);

/** `program.command("run <dir>")` から次の `program.command(` までを抜く */
function runCommandBlock(src: string): string {
  const start = src.indexOf('.command("run <dir>")');
  assert.ok(start !== -1, "run <dir> コマンドが見つからない");
  const nextCommand = src.indexOf('program\n  .command(', start + 1);
  return nextCommand === -1 ? src.slice(start) : src.slice(start, nextCommand);
}

test("run コマンドは共通 runDraft を呼ぶ", () => {
  assert.match(cliSrc, /import\s*\{[^}]*\brunDraft\b[^}]*\}\s*from\s*"\.\/stages\/runDraft\.ts"/);
  assert.match(runCommandBlock(cliSrc), /await runDraft\(abs, cfg/);
});

test("runDraft は idStamp を配線している", () => {
  assert.match(runDraftSrc, /import\s*\{[^}]*\bidStamp\b[^}]*\}\s*from\s*"\.\/idStamp\.ts"/);
  assert.match(runDraftSrc, /deps\.idStamp\(dir\)/);
});

test("runDraft で idStamp は plan より後ろに呼ばれる(末尾配線)", () => {
  const planIdx = runDraftSrc.indexOf("deps.plan(dir, cfg)");
  const stampIdx = runDraftSrc.indexOf("deps.idStamp(dir)");
  assert.ok(planIdx !== -1, "deps.plan 呼び出しが見つからない");
  assert.ok(stampIdx !== -1, "deps.idStamp 呼び出しが見つからない");
  assert.ok(stampIdx > planIdx, "idStamp は plan より後ろで呼ばれる必要がある");
});
