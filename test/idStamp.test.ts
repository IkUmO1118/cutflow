// src/stages/idStamp.ts — id-stamp コマンドの薄い fs ラッパ(冪等・
// 既存 id 保持・変わったファイルだけ書く)を tmpdir で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idStamp, readEditableDocs } from "../src/stages/idStamp.ts";
import { ID_RE } from "../src/lib/ids.ts";

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-idstamp-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [
        { start: 0, end: 10, action: "keep", reason: "本編" },
        { start: 10, end: 20, action: "cut", reason: "言い直し" },
      ],
    });
    write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
    writeFileSync(join(dir, "a.png"), "");
    write("overlays.json", {
      overlays: [{ start: 0, end: 1, file: "a.png" }],
      zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 10, h: 10 } }],
      annotations: [{ type: "box", start: 1, end: 2, rect: { x: 0, y: 0, w: 10, h: 10 } }],
    });
    write("chapters.json", { chapters: [{ start: 0, title: "導入" }] });
    write("shorts.json", {
      shorts: [{ name: "s1", approved: false, ranges: [{ start: 0, end: 1 }] }],
    });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("id-stamp: 全要素に ID_RE の id が付く", () => {
  withTmpProject((dir) => {
    const { changed } = idStamp(dir);
    assert.ok(changed.includes("cutplan.json"));
    assert.ok(changed.includes("transcript.json"));
    assert.ok(changed.includes("overlays.json"));
    assert.ok(changed.includes("chapters.json"));
    assert.ok(changed.includes("shorts.json"));
    // bgm.json / thumbnail.json は存在しないので書かれない
    assert.ok(!changed.includes("bgm.json"));
    assert.ok(!changed.includes("thumbnail.json"));

    const docs = readEditableDocs(dir);
    assert.match(docs.cutplan!.segments[0].id as string, ID_RE);
    assert.match(docs.cutplan!.segments[1].id as string, ID_RE);
    assert.match(docs.transcript!.segments[0].id as string, ID_RE);
    assert.match(docs.overlays!.overlays![0].id as string, ID_RE);
    assert.match(docs.overlays!.zooms![0].id as string, ID_RE);
    assert.match(docs.overlays!.annotations![0].id as string, ID_RE);
    assert.match(docs.chapters!.chapters[0].id as string, ID_RE);
    assert.match(docs.shorts!.shorts[0].ranges[0].id as string, ID_RE);
  });
});

test("id-stamp: 2回目は無変更(冪等・changed が空・ファイル内容も不変)", () => {
  withTmpProject((dir) => {
    idStamp(dir);
    const before = readFileSync(join(dir, "cutplan.json"), "utf8");
    const beforeMtime = statSync(join(dir, "cutplan.json")).mtimeMs;
    const { changed } = idStamp(dir);
    assert.deepEqual(changed, []);
    const after = readFileSync(join(dir, "cutplan.json"), "utf8");
    assert.equal(before, after);
    // 書いていないので mtime も動かない
    assert.equal(statSync(join(dir, "cutplan.json")).mtimeMs, beforeMtime);
  });
});

test("id-stamp: 既存 id は保持する", () => {
  withTmpProject((dir) => {
    writeFileSync(
      join(dir, "cutplan.json"),
      JSON.stringify({
        approved: false,
        segments: [
          { id: "seg_keep01", start: 0, end: 10, action: "keep", reason: "本編" },
          { start: 10, end: 20, action: "cut", reason: "言い直し" },
        ],
      }),
    );
    idStamp(dir);
    const docs = readEditableDocs(dir);
    assert.equal(docs.cutplan!.segments[0].id, "seg_keep01");
    assert.match(docs.cutplan!.segments[1].id as string, ID_RE);
  });
});

test("id-stamp: ファイルが存在しなければ書かない(bgm.json / thumbnail.json 等)", () => {
  withTmpProject((dir) => {
    const { changed } = idStamp(dir);
    assert.ok(!changed.includes("bgm.json"));
    assert.ok(!changed.includes("meta.json"));
    assert.ok(!changed.includes("thumbnail.json"));
  });
});

test("id-stamp: approvals.json には触れない", () => {
  withTmpProject((dir) => {
    idStamp(dir);
    assert.throws(() => statSync(join(dir, "approvals.json")));
  });
});

test("id-stamp: id が1つも無い docs の validate は警告ゼロ(初回 stamp 後は id 警告なし)", () => {
  withTmpProject((dir) => {
    const { validate: r } = idStamp(dir);
    assert.deepEqual(r.errors, []);
    const idWarnings = r.warnings.filter(
      (w) => w.message.includes("id") && (w.message.includes("重複") || w.message.includes("形式") || w.message.includes("ありません")),
    );
    assert.deepEqual(idWarnings, []);
  });
});
