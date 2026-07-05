// stages/validate.ts の純粋検査(validateDocs)。CLI の validate と
// エディタの保存前チェックが共有する要。壊れ方を数ミリ秒で捕まえる網が
// 実際に張れているかを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDocs } from "../src/stages/validate.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

// dir は overlays の素材存在チェックにしか使われない。素材参照を含まない
// docs を渡すのでディスクには触れない
const DIR = "/tmp/cutflow-test";

/** 妥当な最小構成(必要なものだけ上書きして使う) */
function baseDocs(over: Partial<LoadedDocs> = {}): LoadedDocs {
  return {
    manifest: { durationSec: 100 },
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 10, action: "keep", reason: "本編" },
        { start: 10, end: 20, action: "cut", reason: "言い直し" },
      ],
    },
    transcript: { segments: [{ start: 1, end: 3, text: "こんにちは" }] },
    overlays: {},
    bgm: null,
    chapters: null,
    meta: null,
    shorts: null,
    thumbnail: null,
    ...over,
  };
}

test("妥当な docs はエラーなし", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
});

test("approved が真偽値でないとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    cutplan: {
      approved: "yes",
      segments: [{ start: 0, end: 10, action: "keep", reason: "x" }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "approved"));
});

test("insert の startFrom が負だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: { inserts: [{ at: 5, file: "materials/x.mp4", durationSec: 3, startFrom: -1 }] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("startFrom")));
});

test("keep が時系列で重なるとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 10, action: "keep", reason: "a" },
        { start: 5, end: 15, action: "keep", reason: "b" },
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("重なって")));
});

test("keep が1つも無いとエラー(空動画)", () => {
  const r = validateDocs(DIR, baseDocs({
    cutplan: {
      approved: false,
      segments: [{ start: 0, end: 10, action: "cut", reason: "全部カット" }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("keep 区間が1つもありません")));
});

test("preErrors(読み込みエラー)は errors 先頭に引き継がれる", () => {
  const pre = [{ file: "cutplan.json", where: "-", message: "壊れた JSON" }];
  const r = validateDocs(DIR, baseDocs(), pre);
  assert.equal(r.errors[0].message, "壊れた JSON");
});

/* -------- chapters.json ⇔「章」トラックのテロップ の乖離検知 -------- */

// 概要欄チャプターと画面の章テロップ(track 2, name "章")が一致する構成
function chapterDocs(over: Partial<LoadedDocs> = {}): LoadedDocs {
  return baseDocs({
    transcript: {
      segments: [{ start: 0, end: 3, text: "導入", track: 2 }],
    },
    overlays: { captionTracks: [{ track: 2, name: "章", anchor: "topLeft" }] },
    chapters: { chapters: [{ start: 0, title: "導入" }] },
    ...over,
  });
}

test("章: 概要欄と画面テロップが一致していれば乖離警告なし", () => {
  const r = validateDocs(DIR, chapterDocs());
  assert.ok(!r.warnings.some((w) => w.message.includes("ずれ") || w.message.includes("ありません")));
});

test("章: タイトルが食い違うと両側から警告", () => {
  const r = validateDocs(DIR, chapterDocs({
    chapters: { chapters: [{ start: 0, title: "イントロ" }] },
  }));
  // 概要欄「イントロ」に対応する画面テロップが無い
  assert.ok(r.warnings.some((w) => w.message.includes("イントロ")));
  // 画面テロップ「導入」が概要欄に無い
  assert.ok(r.warnings.some((w) => w.message.includes("導入")));
});

test("章: 開始位置だけずれると位置ずれ警告", () => {
  const r = validateDocs(DIR, chapterDocs({
    chapters: { chapters: [{ start: 30, title: "導入" }] },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("開始位置")));
});

test("章: 概要欄はあるのに章トラックが無いと警告", () => {
  const r = validateDocs(DIR, chapterDocs({
    transcript: { segments: [] },
    overlays: {},
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("テロップトラックがありません")));
});

/* -------- overlays / inserts の再生系オプション(頭出し・音量・フェード・rect) -------- */

test("overlay: volume / opacity / rect の範囲外はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      overlays: [
        { start: 1, end: 5, file: "materials/x.mp4", volume: 3 },
        { start: 1, end: 5, file: "materials/x.mp4", opacity: 1.5 },
        { start: 1, end: 5, file: "materials/x.mp4", rect: { x: 0, y: 0, w: -100, h: 100 } },
        { start: 1, end: 5, file: "materials/x.mp4", rect: { x: 0, y: 0 } },
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "overlays[0]" && e.message.includes("volume")));
  assert.ok(r.errors.some((e) => e.where === "overlays[1]" && e.message.includes("opacity")));
  assert.ok(r.errors.some((e) => e.where === "overlays[2]" && e.message.includes("rect")));
  assert.ok(r.errors.some((e) => e.where === "overlays[3]" && e.message.includes("rect")));
});

test("overlay: 画像素材への volume・startFrom は警告(無視される)", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      overlays: [{ start: 1, end: 5, file: "materials/x.png", volume: 1, startFrom: 2 }],
    },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("音声はありません")));
  assert.ok(r.warnings.some((w) => w.message.includes("startFrom は動画素材のみ")));
});

test("overlay: フェード合計が表示時間より長いと警告", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      overlays: [{ start: 1, end: 3, file: "materials/x.mp4", fadeInSec: 1.5, fadeOutSec: 1.5 }],
    },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("フェード")));
});

/* -------- overlays.json の zooms -------- */

const manifestWithScreen = {
  durationSec: 100,
  video: { screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
};

test("zoom: rect 欠落・w/h 不正はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [
        { start: 1, end: 5, rect: { x: 0, y: 0, w: -100, h: 100 } },
        { start: 10, end: 15, rect: { x: 0, y: 0 } },
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "zooms[0]" && e.message.includes("rect")));
  assert.ok(r.errors.some((e) => e.where === "zooms[1]" && e.message.includes("rect")));
});

test("zoom: 収録尺を超える end はエラー(overlays/wipeFull と違い警告ではない)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 90, end: 150, rect: { x: 0, y: 0, w: 960, h: 1080 } }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "zooms[0]" && e.message.includes("収録の長さ")));
});

test("zoom: rect が出力の外にはみ出しているとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 1, end: 5, rect: { x: 1800, y: 0, w: 960, h: 1080 } }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "zooms[0]" && e.message.includes("はみ出しています")));
});

test("zoom: rect のアスペクト比が出力と1%超ずれると警告", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    // 出力は 16:9、rect は正方形(1:1)
    overlays: { zooms: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 500 } }] },
  }));
  assert.ok(r.warnings.some((w) => w.where === "zooms[0]" && w.message.includes("アスペクト比")));
});

test("zoom: 極端な拡大率(scale>8)は警告", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    // scale = 1920 / 200 = 9.6 倍
    overlays: { zooms: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 200, h: 112 } }] },
  }));
  assert.ok(r.warnings.some((w) => w.where === "zooms[0]" && w.message.includes("拡大率")));
});

test("zoom: easeSec が負だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 960, h: 1080 }, easeSec: -1 }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "zooms[0]" && e.message.includes("easeSec")));
});

test("zoom: 区間が重なるとエラー(書いた順序に関わらず検出)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [
        { start: 10, end: 20, rect: { x: 0, y: 0, w: 960, h: 1080 } },
        { start: 5, end: 15, rect: { x: 960, y: 0, w: 960, h: 1080 } },
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "zooms" && e.message.includes("重なって")));
});

test("zoom: 妥当なズームはエラー・警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 1, end: 5, rect: { x: 480, y: 270, w: 960, h: 540 }, easeSec: 0.4 }],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

/* -------- bgm.json -------- */

test("bgm: file 欠落・volumeDb 非数値・startFrom 負・時刻逆転はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    bgm: {
      tracks: [
        { start: 0, end: 5 }, // file なし
        { start: 0, end: 5, file: "bgm.mp3", volumeDb: "loud" },
        { start: 0, end: 5, file: "bgm.mp3", startFrom: -1 },
        { start: 5, end: 5, file: "bgm.mp3" }, // start >= end
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "tracks[0]" && e.message.includes("file")));
  assert.ok(r.errors.some((e) => e.where === "tracks[1]" && e.message.includes("volumeDb")));
  assert.ok(r.errors.some((e) => e.where === "tracks[2]" && e.message.includes("startFrom")));
  assert.ok(r.errors.some((e) => e.where === "tracks[3]"));
});

test("bgm: 実在しない素材はエラー、収録フォルダ外はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    bgm: {
      tracks: [
        { start: 0, end: 5, file: "bgm.mp3" }, // DIR に無い
        { start: 0, end: 5, file: "../secret.mp3" }, // フォルダ外
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "tracks[0]" && e.message.includes("BGM ファイルがありません")));
  assert.ok(r.errors.some((e) => e.where === "tracks[1]" && e.message.includes("外を指しています")));
});

test("bgm: 未知キーは警告、tracks 非配列はエラー", () => {
  const r1 = validateDocs(DIR, baseDocs({ bgm: { tracks: [], loop: true } }));
  assert.ok(r1.warnings.some((w) => w.message.includes("不明なキー")));
  const r2 = validateDocs(DIR, baseDocs({ bgm: { tracks: {} } }));
  assert.ok(r2.errors.some((e) => e.where === "tracks" && e.message.includes("配列")));
});

test("insert: volume の範囲外・負のフェードはエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      inserts: [
        { at: 5, file: "materials/x.mp4", durationSec: 3, volume: -0.5 },
        { at: 6, file: "materials/x.mp4", durationSec: 3, fadeOutSec: -1 },
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "inserts[0]" && e.message.includes("volume")));
  assert.ok(r.errors.some((e) => e.where === "inserts[1]" && e.message.includes("fadeOutSec")));
});

test("overlay: 画像拡張子以外(.mkv 等)は動画扱いで volume / startFrom の誤警告を出さない", () => {
  // レンダラー(remotion/Main.tsx の isImageFile)は画像リスト外をすべて
  // OffthreadVideo で再生する。validate が逆の警告を出すと AI 編集者を欺く
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      overlays: [
        { start: 1, end: 5, file: "materials/x.mkv", volume: 1, startFrom: 2 },
      ],
    },
  }));
  assert.ok(!r.warnings.some((w) => w.message.includes("画像素材に音声はありません")));
  assert.ok(!r.warnings.some((w) => w.message.includes("startFrom は動画素材のみ")));
});

test("overlay: opacity 0 は「表示されない」警告", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: { overlays: [{ start: 1, end: 5, file: "materials/x.png", opacity: 0 }] },
  }));
  assert.ok(
    r.warnings.some((w) => w.where === "overlays[0]" && w.message.includes("opacity が 0")),
  );
});

test("overlay: フェード長すぎ警告は元区間長ではなくカット後の実表示秒で判定する", () => {
  const r = validateDocs(DIR, baseDocs({
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 2, action: "keep", reason: "a" },
        { start: 2, end: 9, action: "cut", reason: "b" },
        { start: 9, end: 10, action: "keep", reason: "c" },
      ],
    },
    overlays: {
      // 区間は 9 秒あるが実表示は 2 秒。フェード計 3 秒は長すぎ
      overlays: [
        { start: 1, end: 10, file: "materials/x.mp4", fadeInSec: 1.5, fadeOutSec: 1.5 },
      ],
    },
  }));
  assert.ok(
    r.warnings.some((w) => w.where === "overlays[0]" && w.message.includes("フェード")),
  );
});

test("style.fontWeight は 100〜900 の範囲外をエラーにする(文書と同じ範囲)", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a", style: { fontWeight: 50 } }] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("fontWeight")));
});


/* -------- shorts.json -------- */

function validShort(over: Record<string, unknown> = {}) {
  return {
    name: "hook-mistake",
    profile: "vertical",
    approved: false,
    ranges: [{ start: 10, end: 20 }],
    ...over,
  };
}

test("shorts.json が無い収録では validate の出力が現状と完全一致する", () => {
  const withoutFile = validateDocs(DIR, baseDocs({ shorts: null }));
  const withDefaultKey = validateDocs(DIR, baseDocs());
  assert.deepEqual(withoutFile, withDefaultKey);
  assert.deepEqual(withoutFile.errors, []);
});

test("shorts: 妥当な構成はエラーなし", () => {
  const r = validateDocs(DIR, baseDocs({ shorts: { shorts: [validShort()] } }));
  assert.deepEqual(r.errors, []);
});

test("shorts: 未知の profile 名はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: { shorts: [validShort({ profile: "square" })] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("profile")));
});

test("shorts: name の重複・不正文字はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: {
      shorts: [
        validShort({ name: "Hook Mistake!" }), // 不正文字
        validShort({ name: "dup" }),
        validShort({ name: "dup" }), // 重複
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "shorts[0]" && e.message.includes("name")));
  assert.ok(r.errors.some((e) => e.where === "shorts[2]" && e.message.includes("重複")));
});

test("shorts: approved が真偽値でないとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: { shorts: [validShort({ approved: "yes" })] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("approved")));
});

test("shorts: ranges が空・逆転はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: {
      shorts: [
        validShort({ name: "empty-ranges", ranges: [] }),
        validShort({ name: "reversed", ranges: [{ start: 20, end: 10 }] }),
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "shorts[0].ranges" && e.message.includes("1件以上")));
  assert.ok(r.errors.some((e) => e.where === "shorts[1].ranges[0]"));
});

test("shorts: captionTracks は overlays.captionTracks と同じ検査(不正 anchor・track 重複)", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: {
      shorts: [
        validShort({
          captionTracks: [
            { track: 1, anchor: "middle" },
            { track: 1, x: 10, y: 10 },
          ],
        }),
      ],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("anchor")));
  assert.ok(r.errors.some((e) => e.message.includes("重複")));
});

test("shorts: captionTracks の座標が profile 範囲外だと警告", () => {
  const r = validateDocs(DIR, baseDocs({
    shorts: {
      shorts: [
        // vertical は 1080x1920。x が幅を超える
        validShort({ captionTracks: [{ track: 1, x: 5000, y: 100 }] }),
      ],
    },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("幅") && w.message.includes("外です")));
});
