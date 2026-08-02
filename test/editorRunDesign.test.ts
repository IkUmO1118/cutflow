import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const server = readFileSync(join(root, "editor/server.ts"), "utf8");
const app = readFileSync(join(root, "editor/client/App.tsx"), "utf8");
const widgets = readFileSync(join(root, "editor/client/widgets.tsx"), "utf8");

test("editor run: POST /api/run は heavy job と共通 runDraft を使う", () => {
  assert.match(server, /path === "\/api\/run"/);
  assert.match(server, /runHeavyJob\("run", "run"/);
  assert.match(server, /runDraft\(dir, cfg, \{ force \}\)/);
  assert.match(widgets, /request\("\/api\/run", \{ force \}\)/);
});

test("editor run: 人間向け文言・上書き確認・進捗・多重抑止を持つ", () => {
  assert.match(app, /AI に初版を作らせる/);
  assert.match(app, /手編集した内容が AI の生成物で上書きされます。実行前に backups\/ へ退避します/);
  assert.match(app, /kind: "progress"[\s\S]*AI が初版を生成中/);
  assert.match(app, /if \(job\?\.status === "running" \|\| !proj\) return/);
  assert.match(app, /disabled=\{job\?\.status === "running" \|\| busy !== null\}/);
});
