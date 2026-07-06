// stages/describe.ts の読み込み規約を固定する。任意ファイル(bgm.json など)は
// 無くても describe が落ちてはいけない。旧実装は「fallback=null」を「必須
// ファイル」と解釈していたため、bgm.json の無いフォルダ(新規プロジェクト
// 全般)で describe がエラー終了する退行があった(B0 で修正)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "../src/stages/describe.ts";

let dir: string;

/** 必須ファイル(manifest/cutplan/transcript)だけを置いた最小フォルダ。
 * bgm.json / chapters.json / meta.json / overlays.json は置かない */
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cutflow-describe-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
  write("manifest.json", {
    dir,
    source: "raw.mkv",
    durationSec: 100,
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    },
    layout: "plain",
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-06T00:00:00Z",
  });
  write("cutplan.json", {
    approved: false,
    segments: [
      { start: 0, end: 40, action: "keep", reason: "本編" },
      { start: 40, end: 50, action: "cut", reason: "言い直し" },
      { start: 50, end: 100, action: "keep", reason: "本編" },
    ],
  });
  write("transcript.json", {
    language: "ja",
    model: "test",
    segments: [{ start: 1, end: 3, text: "こんにちは" }],
  });
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("bgm.json など任意ファイルが無いフォルダでも describe が落ちない", () => {
  let out = "";
  assert.doesNotThrow(() => {
    out = describe(dir);
  });
  assert.match(out, /収録:/);
  // bgm.json も収録フォルダ直下の bgm.* も無いので「なし」と表示される
  assert.match(out, /BGM なし/);
});

test("必須ファイルが欠けていれば従来どおりエラーになる", () => {
  const empty = mkdtempSync(join(tmpdir(), "cutflow-describe-empty-"));
  try {
    assert.throws(() => describe(empty), /manifest\.json がありません/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
