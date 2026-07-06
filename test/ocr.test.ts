// lib/ocr.ts — Vision の正規化 box(原点左下・y上向き)→出力px 変換と
// 行整形を固定する。実バイナリ/swift は呼ばない(macOS 依存をテストに
// 持ち込まない)。Vision の JSON 相当のオブジェクトを直接入力にする。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OCR_LANGUAGES,
  formatOcrPreview,
  normalizedBoxToOutputPx,
  toOcrResult,
} from "../src/lib/ocr.ts";
import type { RawOcrOutput } from "../src/lib/ocr.ts";

test("normalizedBoxToOutputPx: 恒等変換(out == screenRegion)は y 反転のみ", () => {
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  const out = { width: 1920, height: 1080 };
  // Vision box: 幅10%・高さ10%、原点左下で y=0.4(下から40%の位置に下端)
  const box = { x: 0.1, y: 0.4, w: 0.1, h: 0.1 };
  const result = normalizedBoxToOutputPx(box, screenRegion, out);
  // cropX = 0.1*1920 = 192
  // cropY = (1 - 0.4 - 0.1) * 1080 = 0.5 * 1080 = 540
  // w = 0.1*1920 = 192, h = 0.1*1080 = 108
  assert.deepEqual(result, { x: 192, y: 540, w: 192, h: 108 });
});

test("normalizedBoxToOutputPx: 画面下端(y=0)の box は出力の下端に来る", () => {
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  const out = { width: 1920, height: 1080 };
  const box = { x: 0, y: 0, w: 0.2, h: 0.05 };
  const result = normalizedBoxToOutputPx(box, screenRegion, out);
  // cropY = (1 - 0 - 0.05) * 1080 = 0.95 * 1080 = 1026
  assert.deepEqual(result, { x: 0, y: 1026, w: 384, h: 54 });
});

test("normalizedBoxToOutputPx: 画面上端(y+h=1)の box は出力の上端(y=0)に来る", () => {
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  const out = { width: 1920, height: 1080 };
  const box = { x: 0, y: 0.9, w: 0.2, h: 0.1 };
  const result = normalizedBoxToOutputPx(box, screenRegion, out);
  // cropY = (1 - 0.9 - 0.1) * 1080 = 0(浮動小数の誤差ぶんだけ許容)
  assert.ok(Math.abs(result.y) < 1e-9);
});

test("normalizedBoxToOutputPx: out が screenRegion と異なる寸法ならスケールがかかる", () => {
  // screenRegion(クロップ)960x540、out(縦プロファイル等)が半分の解像度480x270
  const screenRegion = { x: 0, y: 0, w: 960, h: 540 };
  const out = { width: 480, height: 270 };
  const box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
  const result = normalizedBoxToOutputPx(box, screenRegion, out);
  // cropX = 0.5*960=480, cropY=(1-0.5-0.1)*540=216, cropW=96, cropH=54
  // sx = 480/960 = 0.5, sy = 270/540 = 0.5
  assert.deepEqual(result, { x: 240, y: 108, w: 48, h: 27 });
});

test("toOcrResult: 行の text を読み順に連結し、box を screenRegion 出力px へ変換する", () => {
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  const raw: RawOcrOutput = {
    lines: [
      { text: "const foo = bar", confidence: 0.98, box: { x: 0.1, y: 0.8, w: 0.2, h: 0.05 } },
      { text: "npm run build", confidence: 0.9, box: { x: 0.1, y: 0.7, w: 0.15, h: 0.05 } },
    ],
  };
  const result = toOcrResult(raw, screenRegion);
  assert.equal(result.text, "const foo = bar\nnpm run build");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].text, "const foo = bar");
  assert.equal(result.lines[0].confidence, 0.98);
  assert.deepEqual(result.image, { w: 1920, h: 1080 });
  // box は本編 screenRegion 出力px(恒等変換。y 反転済み)
  const expectedY = (1 - 0.8 - 0.05) * 1080;
  assert.equal(result.lines[0].box.y, expectedY);
});

test("toOcrResult: 行が0件でも例外を投げず空の結果を返す", () => {
  const screenRegion = { x: 0, y: 0, w: 1920, h: 1080 };
  const result = toOcrResult({ lines: [] }, screenRegion);
  assert.equal(result.text, "");
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.image, { w: 1920, h: 1080 });
});

test("formatOcrPreview: 2行以下はそのまま連結", () => {
  const result = {
    text: "a\nb",
    lines: [
      { text: "a", confidence: 1, box: { x: 0, y: 0, w: 1, h: 1 } },
      { text: "b", confidence: 1, box: { x: 0, y: 0, w: 1, h: 1 } },
    ],
    image: { w: 1920, h: 1080 },
  };
  assert.equal(formatOcrPreview(result), `"a" / "b"`);
});

test("formatOcrPreview: 3行以上は先頭2行+残り件数", () => {
  const result = {
    text: "a\nb\nc\nd",
    lines: ["a", "b", "c", "d"].map((text) => ({
      text,
      confidence: 1,
      box: { x: 0, y: 0, w: 1, h: 1 },
    })),
    image: { w: 1920, h: 1080 },
  };
  assert.equal(formatOcrPreview(result), `"a" / "b" ほか2行`);
});

test("formatOcrPreview: 行が0件は「(文字なし)」", () => {
  assert.equal(
    formatOcrPreview({ text: "", lines: [], image: { w: 1920, h: 1080 } }),
    "(文字なし)",
  );
});

test("DEFAULT_OCR_LANGUAGES: 既定は en,ja の優先順", () => {
  assert.deepEqual(DEFAULT_OCR_LANGUAGES, ["en", "ja"]);
});
