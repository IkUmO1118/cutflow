// lib/editorServe.ts — GUI エディタのデタッチ起動が使う portfile の
// 置き場所(収録フォルダの外)・slug・パース規約を固定する。
//
// portfile を収録フォルダの中に置かないことは意図的な設計判断(files.ts の
// ファイル分類に属さない実行時状態であり、clean <dir> に消されると起動中の
// エディタを stop できなくなる)。ここで場所を固定しておく。
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  editorLogFilePath,
  editorPortFilePath,
  editorStateDir,
  parseEditorServeFile,
  slugForDir,
} from "../src/lib/editorServe.ts";

const DIR = "/Users/x/Movies/cutflow/2026-07-02-demo";

test("portfile とログは収録フォルダの外(~/.cutflow/editor/)に置く", () => {
  assert.equal(editorStateDir(), resolve(homedir(), ".cutflow", "editor"));
  for (const p of [editorPortFilePath(DIR), editorLogFilePath(DIR)]) {
    assert.ok(p.startsWith(editorStateDir()), `${p} は状態ディレクトリ配下であること`);
    assert.ok(!p.startsWith(DIR), `${p} は収録フォルダ配下でないこと`);
  }
  assert.ok(editorPortFilePath(DIR).endsWith(".json"));
  assert.ok(editorLogFilePath(DIR).endsWith(".log"));
});

test("slug は収録フォルダごとに一意で、末尾スラッシュ等の表記揺れを吸収する", () => {
  assert.equal(slugForDir(DIR), slugForDir(`${DIR}/`));
  assert.equal(slugForDir(DIR), slugForDir(`${DIR}/./`));
  assert.notEqual(slugForDir(DIR), slugForDir("/Users/x/Movies/cutflow/2026-07-03-other"));
  assert.match(slugForDir(DIR), /^[0-9a-f]{12}$/);
});

test("parseEditorServeFile は壊れた/欠けた portfile を null にする", () => {
  const ok = { dir: DIR, port: 4310, pid: 123, startedAt: "2026-07-02T00:00:00.000Z" };
  assert.deepEqual(parseEditorServeFile(JSON.stringify(ok)), ok);

  assert.equal(parseEditorServeFile("{壊れた JSON"), null);
  assert.equal(parseEditorServeFile("{}"), null);
  // pid だけ欠けている等の部分的な欠損も丸ごと null(= 起動していない扱い)
  assert.equal(parseEditorServeFile(JSON.stringify({ ...ok, pid: undefined })), null);
  assert.equal(parseEditorServeFile(JSON.stringify({ ...ok, port: "4310" })), null);
  assert.equal(parseEditorServeFile(JSON.stringify({ ...ok, dir: 1 })), null);
});
