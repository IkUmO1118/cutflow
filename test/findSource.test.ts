import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSource } from "../src/lib/findSource.ts";

// R4 Phase7: findSource が一時ファイル・生成物・ドットファイルを元収録として
// 掴まないことを固定する(2026-07-28の実害: .preview-cut.mp4.publish-*.tmp.mp4
// がドット始まりで readdirSync の先頭に来て元収録として ingest され、
// manifest.source/audio/mic.wav が壊れた事故の再発防止)

test("findSource: 一時ファイル(.tmp.を含む)と本物があれば本物を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, ".preview-cut.mp4.publish-1.tmp.mp4"), "x");
    writeFileSync(join(dir, "2026-07-28.mp4"), "x");
    assert.equal(findSource(dir), "2026-07-28.mp4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: proxy.mp4(生成物)だけならエラーで除外候補を列挙する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "proxy.mp4"), "x");
    assert.throws(() => findSource(dir), /除外した候補.*proxy\.mp4/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: final.mp4(成果物)だけならエラーで除外候補を列挙する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "final.mp4"), "x");
    assert.throws(() => findSource(dir), /除外した候補.*final\.mp4/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: 動画ファイルが1つも無ければ従来どおりのエラー", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.throws(() => findSource(dir), /動画ファイル.*ありません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: manifest.source が実在すればそれを最優先する(除外ルールより優先)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    // manifest.source が指す実体は普通なら除外されるはずの一時ファイル的な
    // 名前でも、manifest が明示している以上はそれを信頼する
    writeFileSync(join(dir, "2026-07-12 19-06-16.mkv"), "x");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "2026-07-12 19-06-16.mkv" }));
    writeFileSync(join(dir, "decoy.mp4"), "x");
    assert.equal(findSource(dir), "2026-07-12 19-06-16.mkv");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: manifest.source が指すファイルが消えていれば通常の探索に落ちる", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "gone.mkv" }));
    writeFileSync(join(dir, "2026-07-12.mp4"), "x");
    assert.equal(findSource(dir), "2026-07-12.mp4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: 本物が複数(.mkvと.mp4のremux複製)ならraw.*優先、無ければ先頭+警告(現行挙動を維持)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  const originalWarn = console.warn;
  try {
    writeFileSync(join(dir, "b.mkv"), "x");
    writeFileSync(join(dir, "a.mp4"), "x");
    let warned = false;
    console.warn = () => { warned = true; };
    const result = findSource(dir);
    assert.equal(result, "a.mp4");
    assert.equal(warned, true);
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: raw.* があれば複数候補の中から優先して返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "raw.mp4"), "x");
    writeFileSync(join(dir, "other.mkv"), "x");
    assert.equal(findSource(dir), "raw.mp4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
