// editor/server.ts の saveProject / src/lib/applyEdits.ts の mergeBodyOverDisk。
// T2: 「body をディスク現状へ重ねる」写像を共通ヘルパへ抽出したリファクタが
// saveProject の観測可能挙動(書き込むバイト列)を1バイトも変えていないことを
// 固定する。HTTP サーバは起動しない(saveProject を直接呼ぶ。エディタの
// コードはサーバー再起動まで反映されないため、HTTP 経由の実測は別途 GUI で行う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBodyOverDisk } from "../src/lib/applyEdits.ts";
import { hashesForBody, saveProject } from "../editor/server.ts";
import type { SaveRequest } from "../editor/client/apiTypes.ts";
import { fileContentHash } from "../src/lib/contentVersion.ts";

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-saveproject-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 10, action: "keep", reason: "本編" }],
    });
    write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
    write("chapters.json", { chapters: [{ start: 0, title: "導入" }] });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- mergeBodyOverDisk 単体テスト ---------------- */

test("mergeBodyOverDisk: body に無いキーはディスク現状にフォールバックする(cutplan/transcript/chapters)", () => {
  withTmpProject((dir) => {
    const docs = mergeBodyOverDisk(dir, {});
    assert.equal((docs.cutplan as { approved: boolean }).approved, false);
    assert.equal((docs.transcript as { segments: unknown[] }).segments.length, 1);
    assert.equal((docs.chapters as { chapters: unknown[] }).chapters.length, 1);
    assert.equal((docs.manifest as { durationSec: number }).durationSec, 100);
    assert.equal(docs.bgm, null);
    assert.equal(docs.shorts, null);
    assert.equal(docs.thumbnail, null);
  });
});

test("mergeBodyOverDisk: body にあるキーはそちらを優先する(ディスクは読まない扱い)", () => {
  withTmpProject((dir) => {
    const bodyCutplan = { approved: true, segments: [{ start: 0, end: 5, action: "keep" as const, reason: "上書き" }] };
    const docs = mergeBodyOverDisk(dir, { cutplan: bodyCutplan });
    assert.deepEqual(docs.cutplan, bodyCutplan);
  });
});

test("mergeBodyOverDisk: bgm/shorts は undefined(キー無し)= ディスク現状、null = 削除シグナルとして区別する", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] }));
    writeFileSync(
      join(dir, "shorts.json"),
      JSON.stringify({ shorts: [{ name: "s1", approved: false, ranges: [{ start: 0, end: 1 }] }] }),
    );
    // undefined(キー無し) → ディスク現状をそのまま返す
    const untouched = mergeBodyOverDisk(dir, {});
    assert.equal((untouched.bgm as { tracks: unknown[] }).tracks.length, 1);
    assert.equal((untouched.shorts as { shorts: unknown[] }).shorts.length, 1);
    // null(削除シグナル) → ディスクにファイルがあってもフォールバックせず null のまま
    const deleted = mergeBodyOverDisk(dir, { bgm: null, shorts: null });
    assert.equal(deleted.bgm, null);
    assert.equal(deleted.shorts, null);
  });
});

/* ---------------- saveProject バイト等価 ---------------- */

test("saveProject: cutplan.json を書く内容は body の JSON そのもの(バイト等価)", () => {
  withTmpProject((dir) => {
    const body: SaveRequest = {
      cutplan: {
        approved: false,
        segments: [{ start: 0, end: 10, action: "keep", reason: "変更後の理由" }],
      },
    };
    saveProject(dir, body);
    const written = readFileSync(join(dir, "cutplan.json"), "utf8");
    assert.equal(written, JSON.stringify(body.cutplan, null, 2));
  });
});

test("saveProject: overlays/transcript も body の内容そのままで書かれる", () => {
  withTmpProject((dir) => {
    const body: SaveRequest = {
      transcript: { segments: [{ start: 0, end: 2, text: "更新済み" }] },
      overlays: { overlays: [{ start: 0, end: 1, file: "a.png" }] },
    };
    writeFileSync(join(dir, "a.png"), "");
    saveProject(dir, body);
    assert.equal(readFileSync(join(dir, "transcript.json"), "utf8"), JSON.stringify(body.transcript, null, 2));
    assert.equal(readFileSync(join(dir, "overlays.json"), "utf8"), JSON.stringify(body.overlays, null, 2));
  });
});

test("saveProject: bgm を null で渡すと bgm.json を削除する(既存挙動)", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] }));
    saveProject(dir, { bgm: null });
    assert.throws(() => statSync(join(dir, "bgm.json")));
  });
});

test("saveProject: body に無いキーは対応ファイルを一切書かない(chapters.json は不可侵)", () => {
  withTmpProject((dir) => {
    const before = readFileSync(join(dir, "chapters.json"), "utf8");
    const beforeMtime = statSync(join(dir, "chapters.json")).mtimeMs;
    saveProject(dir, { transcript: { segments: [{ start: 0, end: 1, text: "x" }] } });
    assert.equal(readFileSync(join(dir, "chapters.json"), "utf8"), before);
    assert.equal(statSync(join(dir, "chapters.json")).mtimeMs, beforeMtime);
  });
});

test("saveProject: 整合性エラーがあれば HttpError を投げ何も書かない", () => {
  withTmpProject((dir) => {
    const beforeCutplan = readFileSync(join(dir, "cutplan.json"), "utf8");
    assert.throws(() => {
      saveProject(dir, {
        cutplan: { approved: false, segments: [{ start: 0, end: 10, action: "invalid" as never, reason: "x" }] },
      });
    });
    assert.equal(readFileSync(join(dir, "cutplan.json"), "utf8"), beforeCutplan);
  });
});

/* ---------------- §8.3: gating は saveProject の中には無い(baseHashes は無視される) ---------------- */

test("saveProject: baseHashes が無くても/矛盾していても書き込むバイト列は変わらない(ゲートは handler 側の責務)", () => {
  withTmpProject((dir) => {
    const body: SaveRequest = {
      cutplan: {
        approved: false,
        segments: [{ start: 0, end: 10, action: "keep", reason: "gate対象外" }],
      },
    };
    // baseHashes 無し
    saveProject(dir, body);
    const withoutBaseHashes = readFileSync(join(dir, "cutplan.json"), "utf8");

    // 同じ body に、明らかに矛盾する baseHashes を足しても saveProject は無視する
    const bodyWithStaleBaseHashes: SaveRequest = {
      ...body,
      baseHashes: { "cutplan.json": "sha256:" + "0".repeat(64) },
    };
    saveProject(dir, bodyWithStaleBaseHashes);
    const withStaleBaseHashes = readFileSync(join(dir, "cutplan.json"), "utf8");

    assert.equal(withoutBaseHashes, JSON.stringify(body.cutplan, null, 2));
    assert.equal(withStaleBaseHashes, withoutBaseHashes);
  });
});

/* ---------------- §8.3: hashesForBody の新鮮ハッシュ契約 ---------------- */

test("hashesForBody: cutplan を書いた後、その内容ハッシュを返す", () => {
  withTmpProject((dir) => {
    const body: SaveRequest = {
      cutplan: {
        approved: false,
        segments: [{ start: 0, end: 10, action: "keep", reason: "x" }],
      },
    };
    saveProject(dir, body);
    const hashes = hashesForBody(dir, body);
    assert.equal(hashes["cutplan.json"], fileContentHash(dir, "cutplan.json"));
  });
});

test("hashesForBody: bgm を削除した後、bgm.json は null を返す", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 1, file: "bgm.mp3" }] }));
    const body: SaveRequest = { bgm: null };
    saveProject(dir, body);
    const hashes = hashesForBody(dir, body);
    assert.equal(hashes["bgm.json"], null);
  });
});

test("hashesForBody: body に無いキーのファイルは結果に含まない", () => {
  withTmpProject((dir) => {
    const body: SaveRequest = {
      transcript: { segments: [{ start: 0, end: 1, text: "x" }] },
    };
    saveProject(dir, body);
    const hashes = hashesForBody(dir, body);
    assert.deepEqual(Object.keys(hashes), ["transcript.json"]);
  });
});
