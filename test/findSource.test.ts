import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSource, listSourceCandidates, resolveSource } from "../src/lib/findSource.ts";

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

test("findSource: 動画が無ければ音声を選び bgm fallback 名は除外する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-audio-"));
  try {
    writeFileSync(join(dir, "bgm.mp3"), "x");
    writeFileSync(join(dir, "narration.m4a"), "x");
    assert.equal(findSource(dir), "narration.m4a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSource: 動画が無く音声候補が複数あれば黙って選ばずエラーにする", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-audio-"));
  try {
    writeFileSync(join(dir, "narration.mp3"), "x");
    writeFileSync(join(dir, "second.m4a"), "x");
    assert.throws(
      () => findSource(dir),
      /音声ファイルが複数あります.*narration\.mp3.*second\.m4a.*materials\//s,
    );
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

test("findSource: 本物が複数で raw.* が無ければ人間の選択を促す", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-findsource-"));
  try {
    writeFileSync(join(dir, "b.mkv"), "x");
    writeFileSync(join(dir, "a.mp4"), "x");
    assert.equal(resolveSource(dir), null);
    assert.throws(() => findSource(dir), /動画ファイルが複数.*editor <dir>/s);
  } finally {
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

test("listSourceCandidates: 除外規則と kind/current を適用する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-source-candidates-"));
  try {
    for (const file of [".hidden.mp4", "x.tmp.mov", "proxy.mp4", "final.mp4", "bgm.wav", "clip.mov", "voice.flac"]) {
      writeFileSync(join(dir, file), "x");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "clip.mov" }));
    assert.deepEqual(listSourceCandidates(dir), [
      { file: "clip.mov", kind: "video", current: true },
      { file: "voice.flac", kind: "audio", current: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSourceCandidates: メディア拡張子に見えるディレクトリは候補にしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-source-file-only-"));
  try {
    mkdirSync(join(dir, "fake.mp4"));
    writeFileSync(join(dir, "real.wav"), "x");
    assert.deepEqual(listSourceCandidates(dir), [
      { file: "real.wav", kind: "audio", current: false },
    ]);
    assert.equal(resolveSource(dir), "real.wav");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSource: manifest.source がディレクトリなら sticky source として解決しない", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-source-manifest-dir-"));
  try {
    mkdirSync(join(dir, "fake.mp4"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "fake.mp4" }));
    assert.equal(resolveSource(dir), null);
    assert.deepEqual(listSourceCandidates(dir), []);
    assert.throws(() => findSource(dir), /動画ファイル.*ありません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSource: 0/1/複数/raw/manifest の決定規則", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-resolve-source-"));
  try {
    assert.equal(resolveSource(dir), null);
    writeFileSync(join(dir, "one.mp4"), "x");
    assert.equal(resolveSource(dir), "one.mp4");
    writeFileSync(join(dir, "two.mov"), "x");
    assert.equal(resolveSource(dir), null);
    writeFileSync(join(dir, "raw.mkv"), "x");
    assert.equal(resolveSource(dir), "raw.mkv");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: "two.mov" }));
    assert.equal(resolveSource(dir), "two.mov");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
