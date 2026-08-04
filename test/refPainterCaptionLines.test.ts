// テロップの手動改行("\n")を行へ分解する captionLines(src/engine/refPainter.ts)。
// 描画本体(drawCaption)は canvas が要るので、行分割とカラオケ語の行振り分けという
// 純粋な部分だけをここで固定する。行の連結が必ず元テキストへ戻ること(文字を
// 落とさない)と、words[] が行をまたいでも着色状態を失わないことが要。
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionLines } from "../src/engine/refPainter.ts";
import type { CaptionContent, CaptionWord } from "../src/engine/descriptor.ts";

const base: Omit<CaptionContent, "text"> = {
  kind: "caption",
  fontSizePx: 48,
  color: "#fff",
  outlineColor: "#000",
  outlineWidthPx: 12,
  fontFamily: "Noto Sans JP",
  fontWeight: 700,
};

const content = (text: string, words?: CaptionWord[]): CaptionContent => ({
  ...base,
  text,
  ...(words ? { words } : {}),
});

test("改行が無ければ 1 行(words 無しのときは words を付けない)", () => {
  const lines = captionLines(content("一行のテロップ"));
  assert.deepEqual(lines, [{ text: "一行のテロップ" }]);
});

test("\\n で複数行に分かれる(行の連結は元テキストに戻る)", () => {
  const text = "上の行\n下の行";
  const lines = captionLines(content(text));
  assert.deepEqual(lines, [{ text: "上の行" }, { text: "下の行" }]);
  assert.equal(lines.map((l) => l.text).join("\n"), text);
});

test("末尾の改行は空行として残す(書き手が入れた余白を消さない)", () => {
  const lines = captionLines(content("本文\n"));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, "");
});

test("3 行以上でも順序どおりに分かれる", () => {
  const lines = captionLines(content("あ\nい\nう"));
  assert.deepEqual(lines.map((l) => l.text), ["あ", "い", "う"]);
});

test("カラオケの words[] を各行へ振り分ける(改行文字は描画しない)", () => {
  const words: CaptionWord[] = [
    { text: "時間", active: true },
    { text: "も", active: true },
    { text: "\n", active: false },
    { text: "お金", active: false },
    { text: "も", active: false },
  ];
  const lines = captionLines(content("時間も\nお金も", words));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].words!.map((w) => w.text), ["時間", "も"]);
  assert.deepEqual(lines[1].words!.map((w) => w.text), ["お金", "も"]);
  // 各行の words を連結するとその行のテキストに一致する(改行文字は残らない)
  for (const l of lines) assert.equal(l.words!.map((w) => w.text).join(""), l.text);
});

test("語の途中に改行があれば行境界で割り、active/fillProgress を両方へ引き継ぐ", () => {
  const words: CaptionWord[] = [
    { text: "前", active: false },
    { text: "また\nがる", active: true, fillProgress: 0.5 },
    { text: "後", active: false },
  ];
  const lines = captionLines(content("前また\nがる後", words));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].words!.map((w) => w.text), ["前", "また"]);
  assert.deepEqual(lines[1].words!.map((w) => w.text), ["がる", "後"]);
  // 分割された両側が着色状態を保つ(片側だけ色が抜けない)
  const split = [lines[0].words![1], lines[1].words![0]];
  for (const w of split) {
    assert.equal(w.active, true);
    assert.equal(w.fillProgress, 0.5);
  }
});

test("カラオケでも行の連結は元テキストへ戻る(文字を落とさない)", () => {
  const words: CaptionWord[] = [
    { text: "設定", active: true },
    { text: "を", active: true },
    { text: "\n", active: false },
    { text: "開いて", active: false },
    { text: "ください", active: false },
  ];
  const text = "設定を\n開いてください";
  const lines = captionLines(content(text, words));
  assert.equal(lines.map((l) => l.text).join("\n"), text);
  assert.equal(lines.flatMap((l) => l.words ?? []).map((w) => w.text).join(""), text.replace(/\n/g, ""));
});

test("words[] が text とずれていても文字を落とさない(手編集で words が追随しない場合)", () => {
  // text を手編集して words より長くなった/短くなった状況
  const words: CaptionWord[] = [{ text: "古い語", active: true }];
  const lines = captionLines(content("新しい本文\n2行目", words));
  assert.equal(lines.length, 2);
  // 行テキスト自体は text 由来なので必ず保たれる(描画位置の破綻を防ぐ)
  assert.deepEqual(lines.map((l) => l.text), ["新しい本文", "2行目"]);
});
