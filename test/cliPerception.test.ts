import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"),
  "utf8",
);

function commandBlock(name: string): string {
  const start = cliSrc.indexOf(`.command("${name}")`);
  assert.ok(start !== -1, `${name} コマンドが見つからない`);
  const nextCommand = cliSrc.indexOf('program\n  .command(', start + 1);
  return nextCommand === -1 ? cliSrc.slice(start) : cliSrc.slice(start, nextCommand);
}

test("cli: plan/remeta/run は知覚 status を実行前に表示する", () => {
  assert.match(commandBlock("plan <dir>"), /printPerceptionStatus\(cfg\);[\s\S]*await plan\(abs, cfg/);
  assert.match(commandBlock("remeta <dir>"), /printPerceptionStatus\(cfg\);[\s\S]*await remeta\(abs, cfg/);
  assert.match(commandBlock("run <dir>"), /printPerceptionStatus\(cfg\);[\s\S]*await plan\(abs, cfg/);
});
