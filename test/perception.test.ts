// lib/perception.ts — plan(カット判断LLM)へ音特徴(§4)を添える純関数群。
// 最重要不変条件: 既定オフ(audio/ocr 未使用)のとき renderPrompt の出力は
// perception 導入前と1バイトも変わらない(golden。test/rules.test.ts の
// 既存回帰ガードと合わせて二重に固定する)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAudioFeatures,
  computeSystemSpeech,
  formatAudio,
  formatOcr,
  pausesWithinKeeps,
  renderPerceptionBlock,
  representativeSourceTime,
  selectOcrTargets,
} from "../src/lib/perception.ts";
import type { SegmentOcr } from "../src/lib/perception.ts";
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import type { Interval } from "../src/types.ts";

/* ---------------- computeAudioFeatures ---------------- */

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 5, text: "導入" },
  { id: 2, start: 7, end: 13, text: "本編" },
  { id: 3, start: 13, end: 20, text: "まとめ" },
];

test("computeAudioFeatures: 先頭区間の gapBefore は常に0", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].gapBefore, 0);
});

test("computeAudioFeatures: len は end-start", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].len, 5);
  assert.equal(features[1].len, 6);
  assert.equal(features[2].len, 7);
});

test("computeAudioFeatures: gapBefore は直前 keep との間の落ちた秒数", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[1].gapBefore, 2); // 5 → 7 の間に2秒落ちている
  assert.equal(features[2].gapBefore, 0); // 13 → 13 は連続(間なし)
});

test("computeAudioFeatures: silenceWithin は区間内の無音の overlap 積算(部分重なり含む)", () => {
  const silences: Interval[] = [
    { start: 4, end: 6 }, // #1(0-5)と1秒重なる、#2(7-13)とは重ならない
    { start: 10, end: 11 }, // #2 に完全に内包(1秒)
    { start: 19, end: 25 }, // #3(13-20)と1秒重なる(末尾が区間外)
  ];
  const features = computeAudioFeatures(numbered, silences);
  assert.equal(features[0].silenceWithin, 1);
  assert.equal(features[1].silenceWithin, 1);
  assert.equal(features[2].silenceWithin, 1);
});

test("computeAudioFeatures: 秒は小数第1位に丸める", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 1.23456, text: "" }];
  const features = computeAudioFeatures(seg, []);
  assert.equal(features[0].len, 1.2);
});

/* ---------------- formatAudio / renderPerceptionBlock ---------------- */

test("formatAudio: 見出しと #id 行を含む", () => {
  const text = formatAudio(computeAudioFeatures(numbered, []));
  assert.match(text, /^## 各区間の音の特徴/);
  assert.match(text, /#1 尺5\.0 \/ 直前カット0\.0 \/ 内無音0\.0/);
  assert.match(text, /#2 尺6\.0 \/ 直前カット2\.0 \/ 内無音0\.0/);
});

test("renderPerceptionBlock: audio も system も ocr も null → 空文字(不変条件の核)", () => {
  assert.equal(renderPerceptionBlock(null, null, null), "");
});

test("renderPerceptionBlock: audio が空配列でも空文字", () => {
  assert.equal(renderPerceptionBlock([], null, null), "");
});

test("renderPerceptionBlock: audio ありで先頭/末尾が改行、見出しと#idを含む", () => {
  const block = renderPerceptionBlock(computeAudioFeatures(numbered, []), null, null);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /#1 尺5\.0/);
});

test("renderPerceptionBlock: ocr が空配列(全区間 text 空)なら OCR ブロックを出さない(audio も無ければ空文字)", () => {
  assert.equal(renderPerceptionBlock(null, null, []), "");
});

test("renderPerceptionBlock: ocr ありで #id 画面: 行を含む", () => {
  const ocr: SegmentOcr[] = [{ id: 3, lines: ["npm test", "FAIL"], text: "npm test / FAIL" }];
  const block = renderPerceptionBlock(null, null, ocr);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /#3 画面: "npm test" \/ "FAIL"/);
});

test("renderPerceptionBlock: audio と ocr の両方があれば見出し1つの下に両ブロックが並ぶ", () => {
  const audio = computeAudioFeatures(numbered, []);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const block = renderPerceptionBlock(audio, null, ocr);
  const iAudio = block.indexOf("各区間の音の特徴");
  const iOcr = block.indexOf("各区間の画面テキスト");
  assert.ok(iAudio >= 0 && iOcr >= 0);
  assert.ok(iAudio < iOcr, "audio ブロックが ocr ブロックより前");
  assert.match(block, /^\n## AI 向け知覚情報/);
});

/* ---------------- computeSystemSpeech / systemSpeech ブロック ---------------- */

test("computeSystemSpeech: 区間に overlap するシステム発話だけを集める", () => {
  // numbered[0] は §67 付近で start=0,end=5 / [1] は 10..15(このファイルの numbered)
  const sys = [
    { start: 1, end: 3, text: "デモ再生中" },   // #1 に overlap
    { start: 4.5, end: 6, text: "ピロン" },       // #1 に overlap(部分)
    { start: 100, end: 101, text: "圏外" },       // どの区間にも overlap しない
  ];
  const result = computeSystemSpeech(numbered, sys);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.deepEqual(result[0].lines, ["デモ再生中", "ピロン"]);
  assert.equal(result[0].text, "デモ再生中 / ピロン");
});

test("computeSystemSpeech: overlap ゼロなら空配列", () => {
  assert.deepEqual(computeSystemSpeech(numbered, [{ start: 99, end: 100, text: "x" }]), []);
});

test("pausesWithinKeeps: silence ∩ keep を minSec 以上・offset 付きで返す", () => {
  const keeps: Interval[] = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  const silences: Interval[] = [
    { start: 2, end: 3.5 },   // keep0 内・1.5秒
    { start: 9.5, end: 10.5 }, // keep0 と 0.5秒だけ重なる(minSec=0.6 で落ちる)
    { start: 22, end: 24 },   // keep1 内・2秒・offset 2
    { start: 100, end: 101 }, // どの keep にも入らない
  ];
  const pauses = pausesWithinKeeps(keeps, silences, 0.6);
  assert.equal(pauses.length, 2);
  assert.deepEqual(pauses[0], { keepIndex: 0, start: 2, end: 3.5, len: 1.5, offset: 2 });
  assert.deepEqual(pauses[1], { keepIndex: 1, start: 22, end: 24, len: 2, offset: 2 });
});

test("pausesWithinKeeps: minSec 未満は全て落ちる", () => {
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const silences: Interval[] = [{ start: 1, end: 1.3 }];
  assert.deepEqual(pausesWithinKeeps(keeps, silences, 0.6), []);
});

test("renderPerceptionBlock: system=null は audio/ocr のみの出力とバイト等価(回帰)", () => {
  const audio = computeAudioFeatures(numbered, []);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  // system 引数に null を渡した3引数呼び出しが、systemSpeech 導入前の
  // audio/ocr のみの出力と1文字も変わらないことを固定する
  const withNull = renderPerceptionBlock(audio, null, ocr);
  const withEmpty = renderPerceptionBlock(audio, [], ocr);
  assert.equal(withNull, withEmpty);
  assert.equal(withNull.includes("システム音声"), false);
});

test("renderPerceptionBlock: systemSpeech ありで見出し行を含み audio と ocr の間に入る", () => {
  const audio = computeAudioFeatures(numbered, []);
  const system = computeSystemSpeech(numbered, [{ start: 1, end: 3, text: "デモ音" }]);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const block = renderPerceptionBlock(audio, system, ocr);
  const iAudio = block.indexOf("各区間の音の特徴");
  const iSys = block.indexOf("各区間のシステム音声");
  const iOcr = block.indexOf("各区間の画面テキスト");
  assert.ok(iAudio < iSys && iSys < iOcr, "audio → systemSpeech → ocr の順");
  assert.match(block, /#1 音声: "デモ音"/);
});

/* ---------------- representativeSourceTime / selectOcrTargets / formatOcr ---------------- */

test("representativeSourceTime: 区間の中点を返す", () => {
  assert.equal(representativeSourceTime({ start: 10, end: 20 }), 15);
  assert.equal(representativeSourceTime({ start: 0, end: 5 }), 2.5);
});

test("selectOcrTargets: 上限以下なら全件そのまま(順序も不変)", () => {
  assert.deepEqual(selectOcrTargets(numbered, 10), numbered);
  assert.deepEqual(selectOcrTargets(numbered, 3), numbered);
});

test("selectOcrTargets: 上限超過時は尺の長い順に選び、返りは id 昇順", () => {
  // 尺: #1=5, #2=6, #3=7 → 上限2なら #3,#2 が選ばれ、id 昇順で #2,#3 の順に返る
  const picked = selectOcrTargets(numbered, 2);
  assert.deepEqual(
    picked.map((s) => s.id),
    [2, 3],
  );
});

test("formatOcr: text が空の区間は行に出ない(全区間空なら本文行なし)", () => {
  const ocr: SegmentOcr[] = [
    { id: 1, lines: [], text: "" },
    { id: 2, lines: ["hello"], text: "hello" },
  ];
  const text = formatOcr(ocr);
  assert.doesNotMatch(text, /#1 画面:/);
  assert.match(text, /#2 画面: "hello"/);
  assert.match(text, /記載のない区間は画面テキストなし/);
});

/* ---------------- バイト等価 golden(§9 不変条件1) ---------------- */

let recDir: string;
let channelDir: string;

before(() => {
  channelDir = mkdtempSync(join(tmpdir(), "cutflow-perception-"));
  recDir = join(channelDir, "2026-07-07-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

const numberedForPrompt: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "こんにちは" },
];
const BRIEF_DEFAULT = "(見せ場リストなし。カット判断基準に従って判断してください)";

test("renderPrompt: perception 省略時(既定オフ)は3テンプレとも brief 既定文の直後に見出しが隣接する(バイト等価 golden)", () => {
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42);
  assert.doesNotMatch(planPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planPrompt, /\{\{/); // プレースホルダの残骸が無い
  assert.match(
    planPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const planCutsPrompt = renderPrompt(recDir, "plan-cuts.md", numberedForPrompt, 42);
  assert.doesNotMatch(planCutsPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planCutsPrompt, /\{\{/);
  assert.match(
    planCutsPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const metaPrompt = renderPrompt(recDir, "meta.md", numberedForPrompt, 42);
  assert.doesNotMatch(metaPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(metaPrompt, /\{\{/);
  assert.match(metaPrompt, new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## 出力形式`));
});

test("renderPrompt: perception を渡すと {{rules}} の直後(区切りなし)に挿入される", () => {
  const perception = "\n## AI 向け知覚情報(発話以外の手掛かり)\n\nダミー\n";
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42, perception);
  assert.match(planPrompt, /ダミー\n\n## カットの判断基準/);
});

test("renderPrompt: 4引数呼び出し(plan-shorts 相当)は perception 省略でバイト等価", () => {
  const withDefault = renderPrompt(recDir, "plan-shorts.md", numberedForPrompt, 42);
  const withEmpty = renderPrompt(recDir, "plan-shorts.md", numberedForPrompt, 42, "");
  assert.equal(withDefault, withEmpty);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
