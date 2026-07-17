/** スクリプトタブの表示ブロック化と keep 重なり判定(editor/client/model.ts の
 * buildScriptBlocks / overlapWithKeeps)。
 *
 * - whisper segment(テロップ1枚程度)は細かすぎるので 15〜30 秒の「話の
 *   まとまり」へ束ね、発話の切れ目は選択できる「間チップ」として差し込む
 * - 取り消し線は中点判定ではなく実時間の重なりで判定する(無音詰めで端を
 *   削られた語尾・助詞が偽の取り消し線になる実測 87/1523 語の対策)。
 *   スクリプトからのカットは語境界ちょうどの cut なので重なり 0 → 正しく消える */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCRIPT_KEPT_MIN_OVERLAP,
  buildScriptBlocks,
  overlapWithKeeps,
} from "../editor/client/model.ts";
import type { ScriptSegment } from "../editor/client/apiTypes.ts";

const seg = (start: number, end: number, text = "テスト"): ScriptSegment => ({
  start,
  end,
  text,
  words: [{ text, start, end }],
});

test("overlapWithKeeps: 重なり秒の合計を返す(外は 0)", () => {
  const keeps = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ];
  assert.equal(overlapWithKeeps(15, 35, keeps), 10); // 5 + 5
  assert.equal(overlapWithKeeps(20.1, 29.9, keeps), 0); // カット区間の中
  assert.ok(Math.abs(overlapWithKeeps(19.9, 20.5, keeps) - 0.1) < 1e-9);
});

test("overlapWithKeeps: 端を削られた語尾は kept、語境界ちょうどのカットは cut になる", () => {
  const keeps = [{ start: 0, end: 12.3 }];
  // 語 [12.2, 12.6]: 無音詰めで尾側を削られたが 0.1s は鳴っている → kept
  assert.ok(overlapWithKeeps(12.2, 12.6, keeps) > SCRIPT_KEPT_MIN_OVERLAP);
  // スクリプトカットは語境界ちょうど([12.3, 13.0] を cut)なので重なり 0 → cut
  assert.ok(overlapWithKeeps(12.3, 13.0, keeps) <= SCRIPT_KEPT_MIN_OVERLAP);
});

test("buildScriptBlocks: 連続する短い文は 30 秒を超えない範囲で1ブロックへ束ねる", () => {
  const segments = Array.from({ length: 8 }, (_, i) => seg(i * 5, i * 5 + 5));
  const blocks = buildScriptBlocks(segments);
  assert.equal(blocks.length, 2);
  assert.deepEqual([blocks[0].start, blocks[0].end], [0, 30]);
  assert.deepEqual([blocks[1].start, blocks[1].end], [30, 40]);
  // 隙間なし → 間チップは入らない
  assert.ok(blocks.every((b) => b.items.every((it) => it.kind === "word")));
});

test("buildScriptBlocks: 大きな無音(hardGapSec)は尺に関係なく段落境界+先頭に間チップ", () => {
  const blocks = buildScriptBlocks([seg(0, 5), seg(8, 13)]);
  assert.equal(blocks.length, 2);
  const lead = blocks[1].items[0];
  assert.deepEqual(lead, { kind: "gap", start: 5, end: 8 });
  // ブロックの範囲は間チップも含む(メタ表示・カラオケの活性判定用)
  assert.deepEqual([blocks[1].start, blocks[1].end], [5, 13]);
});

test("buildScriptBlocks: 小さな間は 15 秒溜まるまでは区切らず、間チップとして差し込む", () => {
  const blocks = buildScriptBlocks([seg(0, 5), seg(6, 11), seg(12, 17), seg(18, 23)]);
  assert.equal(blocks.length, 2);
  // 1ブロック目: 3文 + 文間の間チップ2つ(17 秒溜まった後の間で区切り)
  assert.deepEqual([blocks[0].start, blocks[0].end], [0, 17]);
  assert.deepEqual(
    blocks[0].items.filter((it) => it.kind === "gap"),
    [
      { kind: "gap", start: 5, end: 6 },
      { kind: "gap", start: 11, end: 12 },
    ],
  );
  assert.deepEqual([blocks[1].start, blocks[1].end], [17, 23]);
});

test("buildScriptBlocks: words の無い文は文全体を1語として扱う", () => {
  const blocks = buildScriptBlocks([{ start: 0, end: 6, text: "こんにちは" }]);
  assert.deepEqual(blocks, [
    {
      start: 0,
      end: 6,
      items: [{ kind: "word", text: "こんにちは", start: 0, end: 6, utterance: 0 }],
    },
  ]);
});

test("buildScriptBlocks: 収録冒頭の無音も間チップになる(0 秒起点)", () => {
  const blocks = buildScriptBlocks([seg(2, 7)]);
  assert.deepEqual(blocks[0].items[0], { kind: "gap", start: 0, end: 2 });
  assert.equal(blocks[0].start, 0);
});

test("buildScriptBlocks: keep 後の実効尺で束ね、raw 上の長い cut では説明文を分断しない", () => {
  const segments = [seg(0, 10, "前半"), seg(40, 50, "後半")];
  const blocks = buildScriptBlocks(segments, [
    { start: 0, end: 10 },
    { start: 40, end: 50 },
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual([blocks[0].start, blocks[0].end], [0, 50]);
});

test("buildScriptBlocks: keep 後が短くても表示文字数上限で発話境界から折る", () => {
  const text = "あ".repeat(80);
  const blocks = buildScriptBlocks(
    [seg(0, 10, text), seg(40, 50, text)],
    [{ start: 0, end: 1 }],
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.items.filter((item) => item.kind === "word").length), [1, 1]);
});

test("buildScriptBlocks: 同じ塊の発話境界へ半角スペースを付ける", () => {
  const blocks = buildScriptBlocks([seg(0, 2, "一つ目"), seg(2, 4, "二つ目")]);
  const words = blocks[0].items.filter((item) => item.kind === "word");
  assert.equal(words[0].leadingSpace, undefined);
  assert.equal(words[1].leadingSpace, true);
  assert.equal(words.map((item) => `${item.leadingSpace ? " " : ""}${item.text}`).join(""), "一つ目 二つ目");
});

test("scriptKeptFlags: 既存 cut が発話途中を横切っても多数側へそろえ、セリフを細切れにしない", () => {
  const blocks = buildScriptBlocks([{
    start: 0,
    end: 4,
    text: "どこが残ってて何でカットされたのか",
    words: [
      { text: "どこが残ってて", start: 0, end: 1 },
      { text: "何でカットされたの", start: 1, end: 3 },
      { text: "か", start: 3, end: 4 },
    ],
  }]);
  const flags = scriptKeptFlags(blocks, [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
  ], [], [], true);
  assert.deepEqual(flags, [[true, true, true]]);
});

test("scriptKeptFlags: スクリプトから明示的に消した語は発話単位へ丸めない", () => {
  const blocks = buildScriptBlocks([{
    start: 0,
    end: 3,
    text: "ここだけ消す",
    words: [
      { text: "ここ", start: 0, end: 1 },
      { text: "だけ", start: 1, end: 2 },
      { text: "消す", start: 2, end: 3 },
    ],
  }]);
  const flags = scriptKeptFlags(
    blocks,
    [{ start: 0, end: 1 }, { start: 2, end: 3 }],
    [],
    [{ start: 1, end: 2 }],
    true,
  );
  assert.deepEqual(flags, [[true, false, true]]);
});

/* ---------------- scriptKeptFlags(取り消し線判定 v3) ---------------- */

import { bridgeKeeps, scriptKeptFlags, SCRIPT_BRIDGE_MAX_SEC } from "../editor/client/model.ts";
import type { ScriptBlock, ScriptItem } from "../editor/client/model.ts";

const word = (text: string, start: number, end: number): ScriptItem => ({
  kind: "word",
  text,
  start,
  end,
});
const oneBlock = (items: ScriptItem[]): ScriptBlock[] => [
  { start: items[0].start, end: items[items.length - 1].end, items },
];

test("bridgeKeeps: 微小穴は橋渡し、広い穴とスクリプトカットの穴は残す", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 10.2, end: 20 }, // 0.2s 穴 → 橋渡し
    { start: 25, end: 30 }, // 5s 穴 → 残す
    { start: 30.1, end: 35 }, // 0.1s 穴だがスクリプトカット → 残す
  ];
  const out = bridgeKeeps(keeps, [{ start: 30, end: 30.1 }], SCRIPT_BRIDGE_MAX_SEC);
  assert.deepEqual(out, [
    { start: 0, end: 20 },
    { start: 25, end: 30 },
    { start: 30.1, end: 35 },
  ]);
});

test("scriptKeptFlags: ポーズに塗り広げられた虚構語は隣の実在語の状態を継承する(実例: したい承認はApp)", () => {
  // keep [0,10] / 無音カット [10,13](実測無音)/ keep [13,20]。
  // whisper が [10,13] のポーズへ語を等幅で塗り広げたケース
  const blocks = oneBlock([
    word("ように", 9.5, 10.0), // keep 内 → kept アンカー
    word("した", 10.1, 10.6), // 虚構(全幅無音)→ 最寄り(前)を継承
    word("承認", 10.6, 11.1), // 虚構 → 継承
    word("は", 12.5, 13.0), // 虚構 → 最寄り(後)を継承
    word("App", 13.0, 13.5), // keep 内 → kept アンカー
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 10 },
      { start: 13, end: 20 },
    ],
    [{ start: 10, end: 13 }],
    [],
  );
  assert.deepEqual(flags, [[true, true, true, true, true]]);
});

test("scriptKeptFlags: リテイク(音のあるカット)は虚構ではないので取り消し線のまま", () => {
  // keep [0,5] / 内容カット [5,15](リテイク=音がある。無音は [10,11] だけ)/ keep [15,20]
  const blocks = oneBlock([
    word("これは", 4.0, 5.0), // kept アンカー
    word("失敗", 6.0, 8.0), // 音のあるカット → struck アンカー
    word("テイク", 8.0, 10.0), // struck アンカー
    word("えー", 10.1, 10.9), // 虚構(全幅無音)。リテイク末尾に密着 → 前(struck)を継承
    word("成功", 15.0, 16.0), // kept アンカー
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 5 },
      { start: 15, end: 20 },
    ],
    [{ start: 10, end: 11 }],
    [],
  );
  assert.deepEqual(flags, [[true, false, false, false, true]]);
});

test("scriptKeptFlags: 虚構語は距離で継承先を選ぶ(kept 文の直前へ後ろ倒しされた語は kept)", () => {
  // struck アンカー(リテイク末尾)と kept アンカー(次文頭)に挟まれた虚構語:
  // span が次文に密着しているなら次(kept)を継承する
  const blocks = oneBlock([
    word("失敗", 6.0, 7.0), // struck アンカー(音のあるカット)
    word("次の", 14.6, 15.0), // 虚構(無音内)だが次文に密着 → kept
    word("文", 15.0, 15.5), // kept アンカー
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 5 },
      { start: 15, end: 20 },
    ],
    [{ start: 13, end: 15 }],
    [],
  );
  assert.deepEqual(flags, [[false, true, true]]);
});

test("scriptKeptFlags: 微小穴(LLM の 0.2〜0.3s トリム)は橋渡しされ音節が生きる(実例: ハッシュ)", () => {
  // keep [0,548.4] / 微小カット [548.40,548.66](無音検出なし)/ keep [548.66,560]
  const blocks = oneBlock([
    word("と", 547.9, 548.4),
    word("ハ", 548.46, 548.57), // 穴の中だが橋渡しで kept
    word("ッ", 548.57, 548.67),
    word("シ", 548.69, 548.79),
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 540, end: 548.4 },
      { start: 548.66, end: 560 },
    ],
    [],
    [],
  );
  assert.deepEqual(flags, [[true, true, true, true]]);
});

test("scriptKeptFlags: スクリプトからのカットは微小でも橋渡しせず即取り消し線", () => {
  const blocks = oneBlock([
    word("いら", 10.0, 10.15),
    word("ない", 10.15, 10.3),
    word("です", 10.3, 10.8),
  ]);
  const keeps = [
    { start: 0, end: 10 },
    { start: 10.3, end: 20 }, // [10,10.3] をスクリプトでカットした直後の形
  ];
  const flags = scriptKeptFlags(blocks, keeps, [], [{ start: 10, end: 10.3 }]);
  assert.deepEqual(flags, [[false, false, true]]);
});

test("scriptKeptFlags: silences 無し(detect 未実行)でも幾何判定+橋渡しだけで動く", () => {
  const blocks = oneBlock([word("あ", 1, 2), word("い", 11, 12)]);
  const flags = scriptKeptFlags(blocks, [{ start: 0, end: 10 }], null, []);
  assert.deepEqual(flags, [[true, false]]);
});

test("scriptKeptFlags: 両側に密着した虚構かたまりの同着は「残っている」側へ倒す(実例: まだまだ発)", () => {
  // リテイク末尾(struck)とポーズを挟んで次文(kept)が始まる。whisper は
  // ポーズ全体へ次文の頭「まだまだ発」を隙間なく敷き詰めるので距離は同着になる
  const blocks = oneBlock([
    word("重複", 3.0, 4.0), // struck アンカー(音のあるリテイク)
    word("まだ", 4.0, 4.4), // 虚構(ポーズ内)
    word("まだ", 4.4, 4.8), // 虚構
    word("発", 4.8, 5.4), // 虚構(次文アンカーに密着)
    word("展", 5.4, 5.8), // kept アンカー
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 2.9 },
      { start: 5.4, end: 10 },
    ],
    [{ start: 4.0, end: 5.5 }],
    [],
  );
  assert.deepEqual(flags, [[false, true, true, true, true]]);
});

test("scriptKeptFlags: 小さな音声つきカット(言い淀みトリム)へ落ちた語は吸収して打ち消さない", () => {
  // keep [0,13] / 音声つきカット [13,14](幅1.0s < 1.5s。無音検出なし)/ keep [14,20]。
  // whisper のドリフトで「時間」の区間が丸ごと穴に落ちたケース(実測 0.36〜1.04s の穴)
  const blocks = oneBlock([
    word("使って", 12.0, 13.0),
    word("時間", 13.2, 13.8), // 穴の中(音声つき・小)→ 吸収で kept
    word("も", 14.0, 14.3),
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 13 },
      { start: 14, end: 20 },
    ],
    [],
    [],
  );
  assert.deepEqual(flags, [[true, true, true]]);
});

test("scriptKeptFlags: 幅 1.5s 以上の音声つきカット(リテイク)は従来どおり打ち消す", () => {
  const blocks = oneBlock([
    word("前", 9.0, 10.0),
    word("失敗テイク", 10.5, 11.9), // 幅 2.0s の穴の中(音声つき)→ 本物のカット
    word("後", 12.0, 13.0), // keep と重なる → kept
  ]);
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 10 },
      { start: 12, end: 20 },
    ],
    [],
    [],
  );
  assert.deepEqual(flags, [[true, false, true]]);
});

test("scriptKeptFlags: スクリプトカットは小さくても吸収されない(明示カットの即時フィードバック)", () => {
  const blocks = oneBlock([
    word("ここ", 10.0, 10.4),
    word("いらない", 10.4, 11.0), // スクリプトで消した(幅 0.6s の穴)
    word("です", 11.0, 11.5),
  ]);
  const keeps = [
    { start: 0, end: 10.4 },
    { start: 11.0, end: 20 },
  ];
  const flags = scriptKeptFlags(blocks, keeps, [], [{ start: 10.4, end: 11.0 }]);
  assert.deepEqual(flags, [[true, false, true]]);
});

test("scriptKeptFlags: 間チップは吸収の対象外(小さな穴でも縮められた事実を見せる)", () => {
  const blocks: ScriptBlock[] = [
    {
      start: 9,
      end: 12,
      items: [
        word("前", 9.0, 10.0),
        { kind: "gap", start: 10.0, end: 11.0 }, // カットされた間(幅 1.0s)
        word("後", 11.0, 12.0),
      ],
    },
  ];
  const flags = scriptKeptFlags(
    blocks,
    [
      { start: 0, end: 10 },
      { start: 11, end: 20 },
    ],
    [],
    [],
  );
  assert.deepEqual(flags, [[true, false, true]]);
});

test("scriptKeptFlags: aligned(DTW 時刻)では吸収・虚構継承を使わない=幾何判定が正", () => {
  // 音声つき 1.0s の穴に語が落ちている: 注意ベース(aligned=false)ではズレの
  // 可能性が高く吸収するが、DTW 時刻(aligned=true)なら本当にカットされた語
  const blocks = oneBlock([
    word("前", 12.0, 13.0),
    word("消えた", 13.2, 13.8),
    word("後", 14.0, 14.3),
  ]);
  const keeps = [
    { start: 0, end: 13 },
    { start: 14, end: 20 },
  ];
  assert.deepEqual(scriptKeptFlags(blocks, keeps, [], [], false), [[true, true, true]]);
  assert.deepEqual(scriptKeptFlags(blocks, keeps, [], [], true), [[true, false, true]]);
});

test("scriptKeptFlags: aligned でも橋渡し(<0.35s)とスクリプトカット優先は残る", () => {
  const blocks = oneBlock([
    word("ハ", 10.0, 10.1), // 0.2s 穴の中 → 橋渡しで kept
    word("ッ", 10.1, 10.2),
    word("シュ", 10.25, 10.5),
  ]);
  const keeps = [
    { start: 0, end: 10.0 },
    { start: 10.2, end: 20 },
  ];
  assert.deepEqual(scriptKeptFlags(blocks, keeps, [], [], true), [[true, true, true]]);
  // 同じ形でもスクリプトカットなら橋渡しされず打ち消し
  assert.deepEqual(
    scriptKeptFlags(blocks, keeps, [], [{ start: 10.0, end: 10.2 }], true),
    [[false, false, true]],
  );
});
