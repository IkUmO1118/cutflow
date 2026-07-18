// lib/contentVersion.ts — エディタの並行制御(§8.3)専用の内容バージョン。
// ファイルの生バイト SHA-256 を不透明な ETag として扱う純関数群を固定する。
// 承認ハッシュ(src/lib/approval.ts)とは別物で混ぜないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBaseHashes,
  contentHashesOf,
  fileContentHash,
  hashOfString,
  isExternalChange,
} from "../src/lib/contentVersion.ts";

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-contentversion-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- fileContentHash ---------------- */

test("fileContentHash: sha256: 接頭辞の64桁hexを返す", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), '{"a":1}');
    const h = fileContentHash(dir, "cutplan.json");
    assert.match(h as string, /^sha256:[0-9a-f]{64}$/);
  });
});

test("fileContentHash: 同一バイト列は同一hash", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "a.json"), '{"x":1}');
    writeFileSync(join(dir, "b.json"), '{"x":1}');
    assert.equal(fileContentHash(dir, "a.json"), fileContentHash(dir, "b.json"));
  });
});

test("fileContentHash: バイト列が変わればhashも変わる", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), '{"a":1}');
    const before = fileContentHash(dir, "cutplan.json");
    writeFileSync(join(dir, "cutplan.json"), '{"a":2}');
    const after = fileContentHash(dir, "cutplan.json");
    assert.notEqual(before, after);
  });
});

test("fileContentHash: ファイルが無ければ null", () => {
  withTmpDir((dir) => {
    assert.equal(fileContentHash(dir, "nope.json"), null);
  });
});

/* ---------------- hashOfString ↔ fileContentHash 一致 ---------------- */

test("hashOfString: writeFileSync した内容と fileContentHash が一致する(自己エコー抑制の前提)", () => {
  withTmpDir((dir) => {
    const json = JSON.stringify({ segments: [] }, null, 2);
    writeFileSync(join(dir, "cutplan.json"), json);
    assert.equal(fileContentHash(dir, "cutplan.json"), hashOfString(json));
  });
});

/* ---------------- contentHashesOf ---------------- */

test("contentHashesOf: 存在する CONCURRENCY_FILES だけを含む", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    writeFileSync(join(dir, "overlays.json"), "{}");
    // bgm.json / transcript.json / shorts.json は無い
    const hashes = contentHashesOf(dir);
    assert.deepEqual(Object.keys(hashes).sort(), ["cutplan.json", "overlays.json"]);
  });
});

test("contentHashesOf: chapters.json / meta.json / thumbnail.json は存在しても含めない", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    writeFileSync(join(dir, "chapters.json"), "{}");
    writeFileSync(join(dir, "meta.json"), "{}");
    writeFileSync(join(dir, "thumbnail.json"), "{}");
    const hashes = contentHashesOf(dir);
    assert.deepEqual(Object.keys(hashes), ["cutplan.json"]);
  });
});

/* ---------------- isExternalChange 真理値表 ---------------- */

test("isExternalChange: 真理値表(docstring の全行)", () => {
  assert.equal(isExternalChange("h", "h"), false); // 自己エコー
  assert.equal(isExternalChange(null, null), false); // 自分で削除したまま
  assert.equal(isExternalChange(null, "h"), true); // 外部が削除
  assert.equal(isExternalChange("h", null), true); // 外部が作成/変更(自分は削除済み)
  assert.equal(isExternalChange("h", undefined), true); // 外部が作成/変更(未書込)
  assert.equal(isExternalChange(null, undefined), true); // 未書込への外部変更(削除方向)
});

/* ---------------- checkBaseHashes ---------------- */

test("checkBaseHashes: baseHashes 未指定なら常に無条件(stale なし)", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    const { stale } = checkBaseHashes(dir, { cutplan: { anything: true } });
    assert.deepEqual(stale, []);
  });
});

test("checkBaseHashes: base が現ディスクと一致すれば stale にならない", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    const h = fileContentHash(dir, "cutplan.json");
    const { stale } = checkBaseHashes(dir, {
      cutplan: { anything: true },
      baseHashes: { "cutplan.json": h },
    });
    assert.deepEqual(stale, []);
  });
});

test("checkBaseHashes: base が現ディスクと食い違えば stale に入る", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    const { stale } = checkBaseHashes(dir, {
      cutplan: { anything: true },
      baseHashes: { "cutplan.json": "sha256:" + "0".repeat(64) },
    });
    assert.deepEqual(stale, ["cutplan.json"]);
  });
});

test("checkBaseHashes: 読み込み時に存在しなかった(create)のに今は存在する→stale(edge #4)", () => {
  withTmpDir((dir) => {
    // 外部が先に作成してしまった
    writeFileSync(join(dir, "bgm.json"), '{"tracks":[]}');
    const { stale } = checkBaseHashes(dir, {
      bgm: { tracks: [] },
      baseHashes: {}, // キー無し = 読み込み時absent期待
    });
    assert.deepEqual(stale, ["bgm.json"]);
  });
});

test("checkBaseHashes: 触っていないファイルが外部で変わっても stale に入らない(edge #14)", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "cutplan.json"), "{}");
    writeFileSync(join(dir, "transcript.json"), "{}");
    const cutplanHash = fileContentHash(dir, "cutplan.json");
    // transcript.json は body で触っていない。base にも入れない
    writeFileSync(join(dir, "transcript.json"), '{"changed":true}');
    const { stale } = checkBaseHashes(dir, {
      cutplan: { anything: true },
      baseHashes: { "cutplan.json": cutplanHash },
    });
    assert.deepEqual(stale, []);
  });
});

test("checkBaseHashes: 削除(bgm:null)で base 一致なら stale なし", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "bgm.json"), '{"tracks":[{"start":0,"end":1,"file":"x.mp3"}]}');
    const h = fileContentHash(dir, "bgm.json");
    const { stale } = checkBaseHashes(dir, {
      bgm: null,
      baseHashes: { "bgm.json": h },
    });
    assert.deepEqual(stale, []);
  });
});

test("checkBaseHashes: 削除(bgm:null)で base 不一致なら stale", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "bgm.json"), '{"tracks":[{"start":0,"end":1,"file":"x.mp3"}]}');
    const { stale } = checkBaseHashes(dir, {
      bgm: null,
      baseHashes: { "bgm.json": "sha256:" + "1".repeat(64) },
    });
    assert.deepEqual(stale, ["bgm.json"]);
  });
});

/* ---------------- watch のフラッシュ時 hash 分類(§2.4 の candidates.filter を模擬) ---------------- */

test("watch flush 分類: 自己書込と同じ内容は抑制される", () => {
  withTmpDir((dir) => {
    const json = JSON.stringify({ v: 1 }, null, 2);
    writeFileSync(join(dir, "cutplan.json"), json);
    const lastWrittenHash = new Map<string, string | null>();
    lastWrittenHash.set("cutplan.json", hashOfString(json));
    const candidates = ["cutplan.json"];
    const files = candidates.filter((f) =>
      isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
    );
    assert.deepEqual(files, []);
  });
});

test("watch flush 分類: 自分が書いた後に外部が上書きしたら発火する", () => {
  withTmpDir((dir) => {
    const json = JSON.stringify({ v: 1 }, null, 2);
    writeFileSync(join(dir, "cutplan.json"), json);
    const lastWrittenHash = new Map<string, string | null>();
    lastWrittenHash.set("cutplan.json", hashOfString(json));
    // 外部が別内容で上書き
    writeFileSync(join(dir, "cutplan.json"), JSON.stringify({ v: 2 }, null, 2));
    const candidates = ["cutplan.json"];
    const files = candidates.filter((f) =>
      isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
    );
    assert.deepEqual(files, ["cutplan.json"]);
  });
});

test("watch flush 分類: 一度も書いていないファイルの外部変更は発火する", () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, "transcript.json"), "{}");
    const lastWrittenHash = new Map<string, string | null>();
    const candidates = ["transcript.json"];
    const files = candidates.filter((f) =>
      isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
    );
    assert.deepEqual(files, ["transcript.json"]);
  });
});

test("watch flush 分類: 自分で削除した後、ファイルが無いままなら抑制される", () => {
  withTmpDir((dir) => {
    const lastWrittenHash = new Map<string, string | null>();
    lastWrittenHash.set("bgm.json", null); // 自分で削除
    const candidates = ["bgm.json"];
    const files = candidates.filter((f) =>
      isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
    );
    assert.deepEqual(files, []);
  });
});

test("watch flush 分類: 自分で削除した後、外部が作り直したら発火する", () => {
  withTmpDir((dir) => {
    const lastWrittenHash = new Map<string, string | null>();
    lastWrittenHash.set("bgm.json", null); // 自分で削除
    writeFileSync(join(dir, "bgm.json"), '{"tracks":[]}'); // 外部が作り直す
    const candidates = ["bgm.json"];
    const files = candidates.filter((f) =>
      isExternalChange(fileContentHash(dir, f), lastWrittenHash.get(f)),
    );
    assert.deepEqual(files, ["bgm.json"]);
  });
});
