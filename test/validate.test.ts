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
    chapters: null,
    meta: null,
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
