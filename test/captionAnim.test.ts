// lib/captionAnim.ts — テロップの登場/退場アニメ(animStateAt)とカラオケ表示
// (alignKaraoke/karaokeActiveAt)の純関数を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignKaraoke,
  animStateAt,
  karaokeActiveAt,
  karaokeColorOf,
  karaokeFillProgress,
} from "../src/lib/captionAnim.ts";

// ---- animStateAt ----

test("animStateAt: anim 未指定は厳密に IDENTITY(不変の砦)", () => {
  const s = animStateAt(undefined, 0, 10, 5, 44);
  assert.deepEqual(s, { opacity: 1, translateX: 0, translateY: 0, scale: 1 });
});

test("animStateAt: fade の in が start/start+dur で 0→1", () => {
  const anim = { in: "fade" as const, durationSec: 1 };
  assert.equal(animStateAt(anim, 0, 10, 0, 44).opacity, 0);
  assert.equal(animStateAt(anim, 0, 10, 1, 44).opacity, 1);
  const mid = animStateAt(anim, 0, 10, 0.5, 44).opacity;
  assert.ok(mid > 0 && mid < 1);
});

test("animStateAt: fade の out が end-dur/end で 1→0", () => {
  const anim = { out: "fade" as const, durationSec: 1 };
  assert.equal(animStateAt(anim, 0, 10, 9, 44).opacity, 1);
  assert.equal(animStateAt(anim, 0, 10, 10, 44).opacity, 0);
});

test("animStateAt: 短区間(尺 < 2*dur)で in/out が尺の半分に縮む", () => {
  // 尺1秒・dur=1秒(尺の半分=0.5秒)。in だけ: t=0.5(半分経過)でちょうど完了(opacity=1)
  const anim = { in: "fade" as const, durationSec: 1 };
  assert.equal(animStateAt(anim, 0, 1, 0.5, 44).opacity, 1);
  assert.ok(animStateAt(anim, 0, 1, 0.25, 44).opacity < 1);
});

test("animStateAt: slide-* の translate 符号", () => {
  const fontSizePx = 40;
  const off = fontSizePx * 0.7;
  const t0 = (kind: "slide-up" | "slide-down" | "slide-left" | "slide-right") =>
    animStateAt({ in: kind, durationSec: 1 }, 0, 10, 0, fontSizePx);
  assert.equal(t0("slide-up").translateY, off);
  assert.equal(t0("slide-down").translateY, -off);
  assert.equal(t0("slide-left").translateX, off);
  assert.equal(t0("slide-right").translateX, -off);
  // 完了後(t=1)は translate 0 に収束
  const done = animStateAt({ in: "slide-up", durationSec: 1 }, 0, 10, 1, fontSizePx);
  assert.equal(done.translateY, 0);
});

test("animStateAt: pop の scale レンジ(0.6→1)", () => {
  const anim = { in: "pop" as const, durationSec: 1 };
  assert.equal(animStateAt(anim, 0, 10, 0, 44).scale, 0.6);
  assert.equal(animStateAt(anim, 0, 10, 1, 44).scale, 1);
});

test("animStateAt: durationSec 省略時は DEFAULT_CAPTION_ANIM_SEC(0.3)", () => {
  const anim = { in: "fade" as const };
  assert.equal(animStateAt(anim, 0, 10, 0, 44).opacity, 0);
  assert.equal(animStateAt(anim, 0, 10, 0.3, 44).opacity, 1);
});

// ---- alignKaraoke ----

test("alignKaraoke: 語が text の部分列として順に一致 → 全ピース連結 === text", () => {
  const text = "こんにちは世界";
  const words = [
    { text: "こんにちは", start: 0, end: 1 },
    { text: "世界", start: 1, end: 2 },
  ];
  const pieces = alignKaraoke(text, words);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  assert.deepEqual(pieces, [
    { text: "こんにちは", start: 0, end: 1 },
    { text: "世界", start: 1, end: 2 },
  ]);
});

test("alignKaraoke: 句読点が gap ピースになる", () => {
  const text = "こんにちは、世界。";
  const words = [
    { text: "こんにちは", start: 0, end: 1 },
    { text: "世界", start: 1, end: 2 },
  ];
  const pieces = alignKaraoke(text, words);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  assert.deepEqual(pieces.map((p) => p.start), [0, null, 1, null]);
  assert.equal(pieces[1].text, "、");
  assert.equal(pieces[3].text, "。");
});

test("alignKaraoke: 手編集で語が見つからない → その語を飛ばし連結はなお === text", () => {
  const text = "編集後のテキスト";
  const words = [
    { text: "元の語", start: 0, end: 1 }, // text に無い → 飛ばす
    { text: "テキスト", start: 1, end: 2 },
  ];
  const pieces = alignKaraoke(text, words);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  const matched = pieces.find((p) => p.text === "テキスト");
  assert.deepEqual(matched, { text: "テキスト", start: 1, end: 2 });
});

test("alignKaraoke: words=[] は1本の gap ピース(呼び出し側で分岐する前提だが単体でも壊れない)", () => {
  const pieces = alignKaraoke("そのまま", []);
  assert.deepEqual(pieces, [{ text: "そのまま", start: null, end: null }]);
});

// ---- karaokeActiveAt ----

test("karaokeActiveAt: t 進行で false→true が左から埋まる", () => {
  const pieces = alignKaraoke("AB", [
    { text: "A", start: 0, end: 1 },
    { text: "B", start: 1, end: 2 },
  ]);
  assert.deepEqual(karaokeActiveAt(pieces, -1), [false, false]);
  assert.deepEqual(karaokeActiveAt(pieces, 0.5), [true, false]);
  assert.deepEqual(karaokeActiveAt(pieces, 1.5), [true, true]);
});

test("karaokeActiveAt: gap が直前の語の active を引き継ぐ", () => {
  const pieces = alignKaraoke("A、B", [
    { text: "A", start: 0, end: 1 },
    { text: "B", start: 1, end: 2 },
  ]);
  // pieces: [A(word), 、(gap), B(word)]
  assert.deepEqual(karaokeActiveAt(pieces, 0.5), [true, true, false]);
});

test("karaokeActiveAt: 先頭 gap は inactive(直前が無いので prev=false から開始)", () => {
  const pieces: ReturnType<typeof alignKaraoke> = [
    { text: "「", start: null, end: null },
    { text: "A", start: 0, end: 1 },
  ];
  assert.deepEqual(karaokeActiveAt(pieces, 5), [false, true]);
});

// ---- 補助(fill モード用) ----

test("karaokeFillProgress: 語の途中で0〜1の割合を返す", () => {
  assert.equal(karaokeFillProgress(0, 2, 0), 0);
  assert.equal(karaokeFillProgress(0, 2, 1), 0.5);
  assert.equal(karaokeFillProgress(0, 2, 2), 1);
  assert.equal(karaokeFillProgress(0, 2, 5), 1); // 範囲外は端に丸まる
});

test("karaokeColorOf: active/inactive の既定・上書き", () => {
  assert.equal(karaokeColorOf(true, undefined, "#fff"), "#ffe14d");
  assert.equal(karaokeColorOf(false, undefined, "#fff"), "#fff");
  assert.equal(karaokeColorOf(true, { activeColor: "#f00" }, "#fff"), "#f00");
  assert.equal(karaokeColorOf(false, { inactiveColor: "#000" }, "#fff"), "#000");
});
