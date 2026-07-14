// stages/describe.ts の読み込み規約を固定する。任意ファイル(bgm.json など)は
// 無くても describe が落ちてはいけない。旧実装は「fallback=null」を「必須
// ファイル」と解釈していたため、bgm.json の無いフォルダ(新規プロジェクト
// 全般)で describe がエラー終了する退行があった(B0 で修正)。
//
// このファイルはさらに「全部入り」リッチ fixture(buildRichFixture)を持つ。
// 散文 describe() のバイト等価を golden(test/fixtures/describe.golden.txt)で
// 固定し、以後のリファクタ・JSON 射影追加でも散文が1バイトも変わらないことを
// 機械的に証明する(タスク1)。同じ fixture はタスク3の describeJson 単体
// テストでも再利用する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "../src/stages/describe.ts";
import { hashContent } from "../src/lib/framesIndex.ts";

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

/* ------------------------------------------------------------------ */
/* 「全部入り」リッチ fixture(タスク1〜3・5 で共用)                    */
/* ------------------------------------------------------------------ */

/** 36字を超える発話(quote() の 36字切り捨てを検証する用)。改行・連続空白は
 * describe() 側で正規化されるので気にせず長文にしてよい */
export const LONG_CAPTION_TEXT =
  "えーっと、今日は whisper のベンチマークを取り直そうと思っていて、" +
  "前回よりも精度が上がっているかどうかを確認したいと考えています";
export const LOST_CAPTION_TEXT =
  "ここは言い直し区間なので完全にカットされて消える発言です。" +
  "前回と条件を揃えて再計測しますという長めの独り言も含みます";

/** manifest/cutplan/transcript/overlays/bgm/chapters/meta/shorts を
 * すべて揃えたリッチ fixture を dir 直下に書く(obs-canvas・36字超発話・
 * track2+pos/style/words・存在/欠落素材・insert・wipeFull・zoom・blur・
 * colorFilter・5件のタイトル・カット内で消える発言・スナップする章、を含む) */
export function buildRichFixture(dir: string): void {
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
  mkdirSync(join(dir, "materials"), { recursive: true });
  writeFileSync(join(dir, "materials", "slide.png"), "fake-png");
  writeFileSync(join(dir, "materials", "insert.mp4"), "fake-mp4");
  // materials/missing.png はわざと作らない(overlays の「⚠ ファイルなし」検証用)

  write("manifest.json", {
    dir,
    source: "2026-07-02 17-26-36.mkv",
    durationSec: 200,
    layout: "obs-canvas",
    video: {
      width: 3840,
      height: 1080,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    },
    audio: { micStream: 0, systemStream: 1, micWav: "audio/mic.wav" },
    createdAt: "2026-07-06T00:00:00Z",
  });

  write("cutplan.json", {
    approved: false,
    segments: [
      { start: 0, end: 40, action: "keep", reason: "導入" },
      { start: 40, end: 50, action: "cut", reason: "言い直し" },
      { start: 50, end: 150, action: "keep", reason: "本編" },
      { start: 150, end: 160, action: "cut", reason: "雑談" },
      { start: 160, end: 200, action: "keep", reason: "まとめ" },
    ],
  });

  write("transcript.json", {
    language: "ja",
    model: "test",
    segments: [
      { start: 1, end: 3, text: "こんにちは" },
      {
        start: 10,
        end: 15,
        text: LONG_CAPTION_TEXT,
        track: 2,
        pos: { x: 960, y: 900 },
        style: { fontSizePx: 40, color: "#ffff00", outlineColor: "none" },
        words: [
          { text: "えーっと", start: 10, end: 10.5, confidence: 0.9 },
          { text: "今日は", start: 10.5, end: 11, confidence: 0.95 },
        ],
      },
      // カット内(40–50)で完全に消える発言
      { start: 42, end: 47, text: LOST_CAPTION_TEXT },
      // keep0 の終端(40)をまたぐ発言(部分的に見える)
      { start: 38, end: 43, text: "境界をまたぐ発言" },
    ],
  });

  write("overlays.json", {
    overlays: [
      {
        start: 5,
        end: 9,
        file: "materials/slide.png",
        track: 2,
        fit: "contain",
        opacity: 0.9,
        fadeInSec: 0.5,
      },
      { start: 60, end: 65, file: "materials/missing.png" },
    ],
    inserts: [
      {
        at: 100,
        file: "materials/insert.mp4",
        durationSec: 5,
        volume: 1,
        fadeInSec: 0.2,
      },
    ],
    wipeFull: [{ start: 20, end: 25 }],
    zooms: [
      { start: 70, end: 75, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: 0.3 },
    ],
    blurs: [
      {
        start: 80,
        end: 85,
        rect: { x: 100, y: 100, w: 200, h: 100 },
        strength: 0.7,
      },
    ],
    hideCaption: [{ start: 90, end: 92 }],
    colorFilter: { brightness: 1.1, contrast: 1.05, saturate: 0.95 },
    layerOrder: ["ov1", "wipe", "caption"],
    captionTracks: [
      { track: 1, name: "本文" },
      { track: 2, name: "補足", x: 960, y: 900, anchor: "center" },
    ],
  });

  write("bgm.json", {
    tracks: [
      { start: 0, end: 100, file: "materials/bgm1.mp3", volumeDb: -6 },
      {
        start: 100,
        end: 200,
        file: "materials/bgm2.mp3",
        volumeDb: -8,
        fadeOutSec: 2,
      },
    ],
  });

  write("chapters.json", {
    chapters: [
      { start: 0, title: "導入" },
      // 40–50 のカット内。直後の keep(50)へスナップする
      { start: 45, title: "スナップ章" },
    ],
  });

  write("meta.json", {
    titles: [
      "タイトル案1",
      "タイトル案2",
      "タイトル案3",
      "タイトル案4",
      "タイトル案5",
    ],
    description: "概要欄の下書き…全文がここに入る想定のテキストです…",
  });

  write("shorts.json", {
    shorts: [
      {
        name: "short-1",
        profile: "vertical",
        approved: true,
        ranges: [{ start: 35, end: 45 }],
        captionTracks: [{ track: 1, name: "短尺文字" }],
      },
      {
        name: "short-2",
        approved: false,
        // 隣接区間(mergeIntervals で1本にまとまる)
        ranges: [
          { start: 110, end: 115 },
          { start: 115, end: 120 },
        ],
      },
    ],
  });
}

test("散文 describe() は golden とバイト等価(リファクタ・JSON 射影追加で崩れない錠)", () => {
  const rich = mkdtempSync(join(tmpdir(), "cutflow-describe-golden-"));
  try {
    buildRichFixture(rich);
    const out = describe(rich);
    const golden = readFileSync(
      join(import.meta.dirname, "fixtures", "describe.golden.txt"),
      "utf8",
    );
    assert.equal(out, golden);
  } finally {
    rmSync(rich, { recursive: true, force: true });
  }
});

/* ---------------- frames 鮮度(stale-PNG 対策)の追記 ---------------- */
// docs/plans/2026-07-07-frames-server-design.md 課題1。golden fixture 自体は
// frames/index.json を持たない(=none)ため上の golden テストは無出力のまま
// 不変(この錠が壊れていないことは golden テストの緑で担保済み)。ここでは
// index.json を足した別コピーで fresh/stale の追記行を確認する。

test("describe: frames/index.json が無ければ(none)何も追記しない", () => {
  const rich = mkdtempSync(join(tmpdir(), "cutflow-describe-frames-none-"));
  try {
    buildRichFixture(rich);
    const out = describe(rich);
    assert.ok(!out.includes("frames/"));
  } finally {
    rmSync(rich, { recursive: true, force: true });
  }
});

test("describe: frames/index.json が現在の JSON と一致(fresh)なら現況行を1行足す", () => {
  const rich = mkdtempSync(join(tmpdir(), "cutflow-describe-frames-fresh-"));
  try {
    buildRichFixture(rich);
    const cutplanContent = readFileSync(join(rich, "cutplan.json"), "utf8");
    const transcriptContent = readFileSync(join(rich, "transcript.json"), "utf8");
    const overlaysContent = readFileSync(join(rich, "overlays.json"), "utf8");
    mkdirSync(join(rich, "frames"), { recursive: true });
    writeFileSync(
      join(rich, "frames", "index.json"),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        shot: { mode: "every", short: null, ocr: false, fullRes: false, count: 5 },
        inputs: {
          "cutplan.json": hashContent(cutplanContent),
          "transcript.json": hashContent(transcriptContent),
          "overlays.json": hashContent(overlaysContent),
        },
      }),
    );
    const out = describe(rich);
    assert.ok(out.includes("frames/: --every 撮影・5枚(現在の JSON と一致)"));
    // fresh は「撮り直せ」の勧告(stale 用の文言)は出ない
    assert.ok(!out.includes("frames は撮影後に"));
  } finally {
    rmSync(rich, { recursive: true, force: true });
  }
});

test("describe: cutplan.json 編集後(stale)は撮り直し勧告を足す", () => {
  const rich = mkdtempSync(join(tmpdir(), "cutflow-describe-frames-stale-"));
  try {
    buildRichFixture(rich);
    mkdirSync(join(rich, "frames"), { recursive: true });
    writeFileSync(
      join(rich, "frames", "index.json"),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        shot: { mode: "times", short: null, ocr: false, fullRes: false, count: 1 },
        inputs: {
          "cutplan.json": hashContent(JSON.stringify({ approved: false, segments: [] })),
          "transcript.json": hashContent(JSON.stringify({ segments: [] })),
          "overlays.json": hashContent(JSON.stringify({})),
        },
      }),
    );
    const out = describe(rich);
    assert.match(out, /⚠ frames は撮影後に.*cutplan\.json.*変更/);
  } finally {
    rmSync(rich, { recursive: true, force: true });
  }
});
