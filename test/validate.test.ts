// stages/validate.ts の純粋検査(validateDocs)。CLI の validate と
// エディタの保存前チェックが共有する要。壊れ方を数ミリ秒で捕まえる網が
// 実際に張れているかを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, validateDocs } from "../src/stages/validate.ts";
import { hashContent } from "../src/lib/framesIndex.ts";
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

/* -------- transcript.json の segment.words[](語単位タイムスタンプ) -------- */

test("words: 無し(未指定)の既存 transcript は現状どおり問題ゼロ", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("words: 正常な words[] は問題ゼロ", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "こんにちは",
        words: [
          { text: "こんにち", start: 1, end: 2, confidence: 0.9 },
          { text: "は", start: 2, end: 3, confidence: 0.8 },
        ],
      }],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("words: 配列でないとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "x", words: "nope" }] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("words は配列です")));
});

test("words: word.text が非 string だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: 123, start: 1, end: 2 }] }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("text は文字列です")));
});

test("words: word.text が空文字だと警告(エラーではない)", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: "", start: 1, end: 2 }] }],
    },
  }));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.message.includes("text が空です")));
});

test("words: start>=end だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: "a", start: 2, end: 2 }] }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("start < end")));
});

test("words: 親 segment の範囲を EPS 超で逸脱すると警告(エラーではない)", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: "a", start: 0.5, end: 2 }] }],
    },
  }));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.message.includes("親セグメント") && w.message.includes("範囲外")));
});

test("words: 親 segment 範囲のわずかな逸脱(EPS 以内)は警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: "a", start: 0.999, end: 3.001 }] }],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("words: 時系列順が崩れていると警告", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "x",
        words: [
          { text: "b", start: 2, end: 2.5 },
          { text: "a", start: 1, end: 1.5 },
        ],
      }],
    },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("時系列順ではありません")));
});

test("words: confidence が範囲外だと警告", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "x", words: [{ text: "a", start: 1, end: 2, confidence: 1.5 }] }],
    },
  }));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.message.includes("confidence")));
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
  video: {
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    // obs-canvas の実 manifest は必ず cameraRegion を持つ(F1: hasCamera は
    // 欠落を「壊れたデータ」扱いにする)。この fixture は zoom の rect 検査用に
    // screenRegion だけを置いていたが、F5 のカメラ有無判定にも使うため揃える
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
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

/* -------- overlays.json の blurs -------- */

test("blurs: rect が出力の外にはみ出しているとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 1800, y: 0, w: 500, h: 200 } }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "blurs[0]" && e.message.includes("はみ出しています")));
});

test("blurs: rect.w <= 0 はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: -100, h: 100 } }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "blurs[0]" && e.message.includes("rect")));
});

test("blurs: type が不正な値だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 100, h: 100 }, type: "sepia" }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "blurs[0]" && e.message.includes("type")));
});

test("blurs: strength が範囲外(1.5)だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 100, h: 100 }, strength: 1.5 }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where === "blurs[0]" && e.message.includes("strength")));
});

test("blurs: 妥当な blur/mosaic はエラー・警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [
        { start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 200 }, type: "blur", strength: 0.6 },
        { start: 1, end: 5, rect: { x: 0, y: 300, w: 500, h: 200 }, type: "mosaic", strength: 0.6 },
      ],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("blurs: 重なっても許可(エラー・警告なし)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [
        { start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 200 } },
        { start: 2, end: 6, rect: { x: 100, y: 50, w: 500, h: 200 } },
      ],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("blurs: zoom と時間が重なると警告(判断4)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 48, end: 63, rect: { x: 480, y: 270, w: 960, h: 540 } }],
      blurs: [{ start: 50, end: 55, rect: { x: 0, y: 0, w: 500, h: 200 } }],
    },
  }));
  assert.ok(r.warnings.some((w) => w.where === "blurs[0]" && w.message.includes("zoom")));
});

test("blurs: zoom と時間が重ならなければ警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      zooms: [{ start: 48, end: 63, rect: { x: 480, y: 270, w: 960, h: 540 } }],
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 200 } }],
    },
  }));
  assert.ok(!r.warnings.some((w) => w.where === "blurs[0]" && w.message.includes("zoom")));
});

test("blurs: 全体がカット区間内だと警告", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    cutplan: {
      approved: false,
      segments: [
        { start: 0, end: 10, action: "keep", reason: "本編" },
        { start: 10, end: 20, action: "cut", reason: "言い直し" },
      ],
    },
    overlays: {
      blurs: [{ start: 12, end: 18, rect: { x: 0, y: 0, w: 500, h: 200 } }], // カット内([10,20))
    },
  }));
  assert.ok(r.warnings.some((w) => w.where === "blurs[0]" && w.message.includes("表示されません")));
});

test("blurs: shorts.json があると継承されない警告が出る", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 200 } }],
    },
    shorts: {
      shorts: [{ name: "s1", approved: false, ranges: [{ start: 0, end: 5 }] }],
    },
  }));
  assert.ok(r.warnings.some((w) => w.where === "blurs" && w.message.includes("継承されません")));
});

test("blurs: shorts.json が無ければ継承されない警告は出ない", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: {
      blurs: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 500, h: 200 } }],
    },
  }));
  assert.ok(!r.warnings.some((w) => w.where === "blurs" && w.message.includes("継承されません")));
});

/* -------- F5: plain(カメラ無し)の本編ルール -------- */

const manifestPlain = {
  durationSec: 100,
  layout: "plain",
  video: { screenRegion: { x: 0, y: 0, w: 1080, h: 1920 } },
};

test("plain: wipeFull が非空だとエラー(カメラ=crop 元が無い)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    overlays: { wipeFull: [{ start: 1, end: 5 }] },
  }));
  assert.ok(r.errors.some((e) => e.where === "wipeFull" && e.message.includes("plain")));
});

test("plain: wipeFull が空配列/未指定はエラーなし", () => {
  const empty = validateDocs(DIR, baseDocs({ manifest: manifestPlain, overlays: { wipeFull: [] } }));
  assert.ok(!empty.errors.some((e) => e.where === "wipeFull"));
  const none = validateDocs(DIR, baseDocs({ manifest: manifestPlain, overlays: {} }));
  assert.ok(!none.errors.some((e) => e.where === "wipeFull"));
});

test("plain: layerOrder に wipe が含まれると警告(無視される旨)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    overlays: { layerOrder: ["ov1", "wipe", "ov2", "caption"] },
  }));
  assert.ok(r.warnings.some((w) => w.where === "layerOrder" && w.message.includes("plain")));
});

test("plain: layerOrder に wipe が無くても(obs 側の「wipe がありません」警告は出ない)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    overlays: { layerOrder: ["ov1", "ov2", "caption"] },
  }));
  assert.ok(!r.warnings.some((w) => w.where === "layerOrder" && w.message.includes("wipe")));
});

test("plain: zooms(rect が出力解像度内)はエラー・警告なし(cameraRegion 欠落を壊れとみなさない)", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    overlays: { zooms: [{ start: 1, end: 5, rect: { x: 0, y: 0, w: 1080, h: 1920 } }] },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("obs-canvas(従来どおり): wipeFull はエラーにならず、layerOrder に wipe が無いと従来の警告が出る", () => {
  const wipeOk = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: { wipeFull: [{ start: 1, end: 5 }] },
  }));
  assert.ok(!wipeOk.errors.some((e) => e.where === "wipeFull"));
  const noWipe = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    overlays: { layerOrder: ["ov1", "ov2", "caption"] },
  }));
  assert.ok(noWipe.warnings.some((w) => w.where === "layerOrder" && w.message.includes("wipe がありません")));
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

/* -------- style.anim / style.karaoke(caption-anim フェーズ) -------- */

test("style.anim: 未指定・妥当な指定はエラー・警告なし(既存固定)", () => {
  const noAnim = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a" }] },
  }));
  assert.deepEqual(noAnim.errors, []);
  assert.deepEqual(noAnim.warnings, []);

  const withAnim = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "a", style: { anim: { in: "slide-up", out: "fade", durationSec: 0.5 } } }],
    },
  }));
  assert.deepEqual(withAnim.errors, []);
  assert.deepEqual(withAnim.warnings, []);
});

test("style.anim: 種別不正はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a", style: { anim: { in: "spin" } } }] },
  }));
  assert.ok(r.errors.some((e) => e.where.endsWith(".anim") && e.message.includes("in")));
});

test("style.anim: durationSec が負だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a", style: { anim: { durationSec: -0.1 } } }] },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("durationSec")));
});

test("style.anim: 未知キーは警告", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a", style: { anim: { in: "fade", spin: true } } }] },
  }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.where.endsWith(".anim") && w.message.includes("不明なキー")));
});

test("style.karaoke: 妥当な指定(words あり)はエラー・警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "ab",
        style: { karaoke: { activeColor: "#f00", mode: "fill" } },
        words: [{ text: "a", start: 1, end: 2 }, { text: "b", start: 2, end: 3 }],
      }],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("style.karaoke: 色が非文字列だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "a",
        style: { karaoke: { activeColor: 123 as unknown as string } },
        words: [{ text: "a", start: 1, end: 3 }],
      }],
    },
  }));
  assert.ok(r.errors.some((e) => e.where.endsWith(".karaoke") && e.message.includes("activeColor")));
});

test("style.karaoke: inactiveOpacity が範囲外だとエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "a",
        style: { karaoke: { inactiveOpacity: 1.5 } },
        words: [{ text: "a", start: 1, end: 3 }],
      }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("inactiveOpacity")));
});

test("style.karaoke: mode 不正はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "a",
        style: { karaoke: { mode: "letter" as unknown as "word" } },
        words: [{ text: "a", start: 1, end: 3 }],
      }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("mode")));
});

test("style.karaoke: 未知キーは警告", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{
        start: 1, end: 3, text: "a",
        style: { karaoke: { mode: "word", speed: 2 } },
        words: [{ text: "a", start: 1, end: 3 }],
      }],
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.where.endsWith(".karaoke") && w.message.includes("不明なキー")));
});

test("karaoke 指定だが words 不在(省略/空配列)は警告(通常表示にフォールバックするだけで壊れない)", () => {
  const noWords = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "a", style: { karaoke: {} } }],
    },
  }));
  assert.deepEqual(noWords.errors, []);
  assert.ok(noWords.warnings.some((w) => w.message.includes("words[] がありません")));

  const emptyWords = validateDocs(DIR, baseDocs({
    transcript: {
      segments: [{ start: 1, end: 3, text: "a", style: { karaoke: {} }, words: [] }],
    },
  }));
  assert.ok(emptyWords.warnings.some((w) => w.message.includes("words[] がありません")));
});

test("karaoke 指定なしなら words 不在でも警告なし(既存固定)", () => {
  const r = validateDocs(DIR, baseDocs({
    transcript: { segments: [{ start: 1, end: 3, text: "a" }] },
  }));
  assert.deepEqual(r.warnings, []);
});

test("captionTracks(overlays.json)の karaoke/anim も checkStyle と同じ検査を共有する", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: {
      captionTracks: [{ track: 1, style: { anim: { in: "bogus" as unknown as "fade" } } }],
    },
  }));
  assert.ok(r.errors.some((e) => e.message.includes("in")));
});

/* -------- overlays.json の colorFilter -------- */

test("colorFilter: 範囲外・非数値はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: { colorFilter: { brightness: 0, contrast: 3.1, saturate: "x" as unknown as number } },
  }));
  assert.ok(r.errors.some((e) => e.where === "colorFilter.brightness"));
  assert.ok(r.errors.some((e) => e.where === "colorFilter.contrast"));
  assert.ok(r.errors.some((e) => e.where === "colorFilter.saturate"));
});

test("colorFilter: 全キー省略の空オブジェクトは警告", () => {
  const r = validateDocs(DIR, baseDocs({ overlays: { colorFilter: {} } }));
  assert.ok(r.warnings.some((w) => w.where === "colorFilter" && w.message.includes("いずれも指定")));
  assert.deepEqual(r.errors, []);
});

test("colorFilter: 妥当な指定はエラー・警告なし", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: { colorFilter: { brightness: 1.05, contrast: 1.1 } },
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("colorFilter: 未知のキーは警告", () => {
  const r = validateDocs(DIR, baseDocs({
    overlays: { colorFilter: { brightness: 1.1, gamma: 2 } as unknown as Record<string, number> },
  }));
  assert.ok(r.warnings.some((w) => w.message.includes("不明なキー")));
});

/* -------- thumbnail.json -------- */

test("thumbnail: 妥当な構成はエラーなし", () => {
  const r = validateDocs(DIR, baseDocs({
    thumbnail: { t: 50, texts: [{ text: "見出し", pos: { x: 640, y: 400 } }] },
  }));
  assert.deepEqual(r.errors, []);
});

test("thumbnail: t が範囲外・texts が空はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    thumbnail: { t: 150, texts: [] },
  }));
  assert.ok(r.errors.some((e) => e.where === "t" && e.message.includes("収録の長さ")));
  assert.ok(r.errors.some((e) => e.where === "texts" && e.message.includes("1件以上")));
});

test("thumbnail: text 欠落・pos 欠落はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    thumbnail: { t: 10, texts: [{ text: "", pos: { x: 1 } }] },
  }));
  assert.ok(r.errors.some((e) => e.where === "texts[0]" && e.message.includes("text")));
  assert.ok(r.errors.some((e) => e.where === "texts[0]" && e.message.includes("pos")));
});

test("thumbnail: style は transcript と同じ検査を共有する(fontWeight 範囲外はエラー)", () => {
  const r = validateDocs(DIR, baseDocs({
    thumbnail: {
      t: 10,
      texts: [{ text: "見出し", pos: { x: 1, y: 1 }, style: { fontWeight: 50 } }],
    },
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

/* -------- B4: plain のショート profile ガード(panels の source 集合で判定) -------- */

test("plain: ショート profile vertical(画面+カメラ2段)はエラー", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    shorts: { shorts: [validShort({ profile: "vertical" })] },
  }));
  assert.ok(r.errors.some((e) => e.where === "shorts[0].profile" && e.message.includes("vertical-cover")));
});

test("plain: ショート profile vertical-cover(カメラ全面)・default はエラーなし", () => {
  const cover = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    shorts: { shorts: [validShort({ profile: "vertical-cover" })] },
  }));
  assert.ok(!cover.errors.some((e) => e.where === "shorts[0].profile"));
  const def = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    shorts: { shorts: [validShort({ profile: "default" })] },
  }));
  assert.ok(!def.errors.some((e) => e.where === "shorts[0].profile"));
});

test("plain: ショート profile vertical-screen(画面のみ)はエラーなし", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    shorts: { shorts: [validShort({ profile: "vertical-screen" })] },
  }));
  assert.ok(!r.errors.some((e) => e.where === "shorts[0].profile"));
});

test("plain: ショート profile 省略はエラーなし(既定が vertical-screen に解決される)", () => {
  const withoutProfile = validShort() as Record<string, unknown>;
  delete withoutProfile.profile;
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestPlain,
    shorts: { shorts: [withoutProfile] },
  }));
  assert.ok(!r.errors.some((e) => e.where === "shorts[0].profile"));
});

test("camera 案件: ショート profile 省略はエラーなし(既定 vertical のまま・退行なし)", () => {
  const withoutProfile = validShort() as Record<string, unknown>;
  delete withoutProfile.profile;
  const r = validateDocs(DIR, baseDocs({
    shorts: { shorts: [withoutProfile] },
  }));
  assert.ok(!r.errors.some((e) => e.where === "shorts[0].profile"));
});

test("obs-canvas: ショート profile vertical / vertical-cover はどちらも従来どおりエラーなし", () => {
  const r = validateDocs(DIR, baseDocs({
    manifest: manifestWithScreen,
    shorts: {
      shorts: [
        validShort({ name: "a", profile: "vertical" }),
        validShort({ name: "b", profile: "vertical-cover" }),
      ],
    },
  }));
  assert.ok(!r.errors.some((e) => e.where.endsWith(".profile")));
});

/* ---------------- fs 版 validate(dir): frames 鮮度警告(stale-PNG 対策) ---------------- */
// docs/plans/2026-07-07-frames-server-design.md 課題1。frames/index.json
// (撮影入力のフィンガープリント)と現在の JSON を突き合わせ、食い違えば
// 警告する。純粋コア validateDocs は無改造(既存テストは上のとおり不変)。

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-validate-fs-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 10, action: "keep", reason: "本編" }],
    });
    write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
    write("overlays.json", {});
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fs版 validate: frames/index.json が無ければ(none)警告は増えない", () => {
  withTmpProject((dir) => {
    const r = validate(dir);
    assert.ok(!r.warnings.some((w) => w.file === "frames/index.json"));
  });
});

test("fs版 validate: frames/index.json のハッシュが現在の JSON と一致(fresh)なら警告なし", () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, "frames"), { recursive: true });
    const cutplanContent = JSON.stringify({
      approved: false,
      segments: [{ start: 0, end: 10, action: "keep", reason: "本編" }],
    });
    const transcriptContent = JSON.stringify({
      segments: [{ start: 1, end: 3, text: "こんにちは" }],
    });
    const overlaysContent = JSON.stringify({});
    writeFileSync(
      join(dir, "frames", "index.json"),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        shot: { mode: "every", short: null, ocr: false, fullRes: false, count: 3 },
        inputs: {
          "cutplan.json": hashContent(cutplanContent),
          "transcript.json": hashContent(transcriptContent),
          "overlays.json": hashContent(overlaysContent),
        },
      }),
    );
    const r = validate(dir);
    assert.ok(!r.warnings.some((w) => w.file === "frames/index.json"));
  });
});

test("fs版 validate: cutplan.json を編集後(stale)は frames 撮り直し警告が出る", () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, "frames"), { recursive: true });
    // index.json に記録したハッシュは撮影時点の(今と違う)内容のもの
    writeFileSync(
      join(dir, "frames", "index.json"),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        shot: { mode: "every", short: null, ocr: false, fullRes: false, count: 3 },
        inputs: {
          "cutplan.json": hashContent(JSON.stringify({ approved: false, segments: [] })),
          "transcript.json": hashContent(JSON.stringify({ segments: [] })),
          "overlays.json": hashContent(JSON.stringify({})),
        },
      }),
    );
    const r = validate(dir);
    const w = r.warnings.find((w) => w.file === "frames/index.json");
    assert.ok(w, "frames 鮮度警告が出ていない");
    assert.match(w!.message, /cutplan\.json/);
  });
});

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

test("id: id が1つも無ければ警告ゼロ(既存 validate.test の想定を1件も動かさない)", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("id: shorts.json だけがある(id フィールドは無い)プロジェクトでも id 警告ゼロ" +
  "(short の name は id 判定の対象外)", () => {
  const r = validateDocs(
    DIR,
    baseDocs({
      shorts: {
        shorts: [{ name: "s1", approved: false, ranges: [{ start: 0, end: 1 }] }],
      },
    }),
  );
  assert.deepEqual(
    r.warnings.filter((w) => w.message.includes("id")),
    [],
  );
});

test("id: 妥当な id が付いていれば追加警告ゼロ", () => {
  const r = validateDocs(
    DIR,
    baseDocs({
      cutplan: {
        approved: false,
        segments: [
          { id: "seg_a1a1a1", start: 0, end: 10, action: "keep", reason: "本編" },
          { id: "seg_b2b2b2", start: 10, end: 20, action: "cut", reason: "言い直し" },
        ],
      },
      transcript: { segments: [{ id: "cap_c3c3c3", start: 1, end: 3, text: "こんにちは" }] },
    }),
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("id: 重複 id は警告1件(既出の所在を含む)", () => {
  const r = validateDocs(
    DIR,
    baseDocs({
      cutplan: {
        approved: false,
        segments: [
          { id: "seg_dup0001", start: 0, end: 10, action: "keep", reason: "本編" },
          { id: "seg_dup0001", start: 10, end: 20, action: "keep", reason: "本編2" },
        ],
      },
    }),
  );
  const dupWarnings = r.warnings.filter((w) => w.message.includes("重複"));
  assert.equal(dupWarnings.length, 1);
  assert.match(dupWarnings[0].message, /segments\[0\]/);
});

test("id: 形式不正(接頭辞・桁数が合わない)は警告", () => {
  const r = validateDocs(
    DIR,
    baseDocs({
      cutplan: {
        approved: false,
        segments: [{ id: "not-an-id", start: 0, end: 10, action: "keep", reason: "本編" }],
      },
    }),
  );
  assert.ok(r.warnings.some((w) => w.message.includes("形式が不正")));
});

test("id: id 有効かつ一部欠落は集約警告1件(per-要素では出さない)", () => {
  const r = validateDocs(
    DIR,
    baseDocs({
      cutplan: {
        approved: false,
        segments: [
          { id: "seg_a1a1a1", start: 0, end: 10, action: "keep", reason: "本編" },
          { start: 10, end: 20, action: "cut", reason: "言い直し" },
        ],
      },
      transcript: { segments: [{ start: 1, end: 3, text: "こんにちは" }] },
    }),
  );
  const missingWarnings = r.warnings.filter((w) => w.message.includes("id がありません"));
  assert.equal(missingWarnings.length, 1);
  assert.match(missingWarnings[0].message, /2 個の要素/);
});
