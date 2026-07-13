// lib/captionSplit.ts — whisper セグメント(transcript.json の 1 発話 = 1 テロップ)を
// 「約 maxChars 文字」の粒度へ割り直す純関数(fs 非依存・決定論・LLM 不使用)。
//
// 現状の transcribe は whisper の transcription セグメントを 1:1 でテロップにするため、
// 粒度は whisper 内部のチャンク幅そのまま(長い区間は 40〜50 字にもなる)。ここは
// それを「読みやすい 1 行」へ分割する。日本語 whisper は句読点をほぼ出さないので、
// 句読点ではなく **文節末(助詞・句末表現)+ 無音ギャップ + 文字数上限** で折る。
//
// 語タイムスタンプ(words[])があれば分割後の各断片の start/end は語境界そのもの
// (時刻を捏造しない)。無ければ文字位置で線形補間する。maxChars 以下のセグメントは
// 一切改変しない(text/start/end/words/id をそのまま返す=導入前とバイト等価)。

import { round2 } from "./candidates.ts";
import type { TranscriptSegment, WordTiming } from "../types.ts";

export interface CaptionSplitCfg {
  /** この文字数(code point 数)を超える segment だけを分割する。
   *  0 以下 / 未設定なら分割しない(呼び出し側で opt-in を判定) */
  maxChars: number;
  /** 分割後の各断片がこれ未満にならないよう soft-break(文節末・ギャップ)を選ぶ下限。
   *  省略時 floor(maxChars * 0.4)。ハード上限(maxChars)は常にこれより優先される */
  minChars?: number;
  /** 語間ギャップ(秒)がこれ以上なら「間」= soft-break 候補として扱う。
   *  省略時 0.3(plan の minSplitGapSec と同じ既定)。words[] がある segment にだけ効く */
  gapSec?: number;
}

/** 文字数は code point 数で数える([...s].length)。日本語 1 字も ASCII 1 字も 1。
 *  2026-07-12 の手編集粒度("Claude Code" を 11 字と数える)と同じ規約 */
const clen = (s: string): number => [...s].length;

/** ある断片(ピース)の末尾がここで終わっていたら文節の切れ目とみなす語群。
 *  末尾一致(endsWith)で判定するので長いものを先に置く必要はない(全部試す)。
 *  日本語字幕の慣習(文節=名詞/動詞+助詞 の直後で改行)に沿う最小セット。 */
const BREAK_SUFFIXES: readonly string[] = [
  // 句読点(whisper が稀に出したとき)
  "。", "、", "！", "？", "!", "?", ".", ",",
  // 句末・接続の語尾
  "です", "ます", "ました", "でした", "ません", "だ", "である", "ない",
  "って", "けど", "けれど", "けれども", "から", "ので", "のに", "し", "て", "で",
  "たり", "たら", "なら", "ても", "ば", "が",
  // 文節末になりやすい格助詞・係助詞・終助詞
  "は", "も", "を", "に", "へ", "と", "や", "の", "ね", "よ", "な", "わ", "か", "さ",
];

const endsWithBreak = (s: string): boolean =>
  BREAK_SUFFIXES.some((suf) => s.endsWith(suf));

/** 分割計算に使う最小単位。words[] があればそれ、無ければ 1 文字ずつ(時刻は線形補間) */
interface Atom {
  text: string;
  start: number;
  end: number;
  /** この atom が元の words[] 由来か(true のとき出力 segment に words を残せる) */
  word?: WordTiming;
}

/** segment を Atom 列へ。words[] が text を過不足なく覆うならそれを使い(時刻正確)、
 *  そうでなければ 1 文字ずつに割って [start,end] を文字数で線形補間する。 */
function atomsOf(seg: TranscriptSegment): Atom[] {
  const words = seg.words;
  if (words && words.length > 0 && words.map((w) => w.text).join("") === seg.text) {
    return words.map((w) => ({ text: w.text, start: w.start, end: w.end, word: w }));
  }
  const chars = [...seg.text];
  const total = chars.length;
  const dur = seg.end - seg.start;
  return chars.map((ch, i) => ({
    text: ch,
    start: round2(seg.start + (dur * i) / total),
    end: round2(seg.start + (dur * (i + 1)) / total),
  }));
}

/** Atom 列を「約 maxChars」のピース(atom index の [a,b] 範囲・inclusive)へ貪欲分割。
 *  各ピースは maxChars を超えない範囲で最長まで伸ばし、その中の最後の soft-break
 *  (文節末 or 大きめの語間ギャップ)で折る。soft-break が無ければ文字数上限で折る。 */
function pieceRanges(atoms: Atom[], cfg: Required<Pick<CaptionSplitCfg, "maxChars" | "minChars" | "gapSec">>): Array<[number, number]> {
  const n = atoms.length;
  const cum = [0];
  for (const a of atoms) cum.push(cum[cum.length - 1] + clen(a.text));
  const lenOf = (a: number, b: number): number => cum[b + 1] - cum[a]; // inclusive a..b
  const textOf = (a: number, b: number): string => atoms.slice(a, b + 1).map((x) => x.text).join("");
  const gapAfter = (i: number): number =>
    i + 1 < n ? atoms[i + 1].start - atoms[i].end : Number.POSITIVE_INFINITY;

  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    let lastGood = -1;
    let j = i;
    while (j < n) {
      if (lenOf(i, j) > cfg.maxChars) break; // atom j で上限超過 → i..j-1 が有効
      const soft = endsWithBreak(textOf(i, j)) || gapAfter(j) >= cfg.gapSec;
      if (soft && lenOf(i, j) >= cfg.minChars) lastGood = j;
      j++;
    }
    if (j >= n) {
      ranges.push([i, n - 1]);
      break;
    }
    // atom j は入らない。i..j-1 の中の最後の soft-break、無ければ j-1(文字数上限)で折る。
    // 単一 atom が maxChars を超える病的ケースでも必ず前進するよう end >= i を保証
    const end = Math.max(i, lastGood >= i ? lastGood : j - 1);
    ranges.push([i, end]);
    i = end + 1;
  }
  return ranges;
}

/** 1 つの segment を分割し、分割後の segment 列を返す。maxChars 以下、または分割の
 *  必要が無ければ元 segment を **そのまま**(同一参照)返す=非改変を保証。 */
function splitOne(seg: TranscriptSegment, cfg: Required<Pick<CaptionSplitCfg, "maxChars" | "minChars" | "gapSec">>): TranscriptSegment[] {
  if (clen(seg.text) <= cfg.maxChars) return [seg];
  const atoms = atomsOf(seg);
  const ranges = pieceRanges(atoms, cfg);
  if (ranges.length <= 1) return [seg]; // 割れなかった(単一ピース)=非改変
  return ranges.map(([a, b]) => {
    const slice = atoms.slice(a, b + 1);
    const piece: TranscriptSegment = {
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((x) => x.text).join(""),
    };
    // track/pos/style は元 segment 属性を全ピースへ継承(whisper 直後は通常未設定)
    if (seg.track !== undefined) piece.track = seg.track;
    if (seg.pos !== undefined) piece.pos = seg.pos;
    if (seg.style !== undefined) piece.style = seg.style;
    // words[] は語 atom のときだけ残せる(カラオケ表示の維持)
    const words = slice.map((x) => x.word).filter((w): w is WordTiming => w !== undefined);
    if (words.length === slice.length && words.length > 0) piece.words = words;
    // id は付けない(分割後は新しい要素。呼び出し側の id 採番に委ねる)
    return piece;
  });
}

/**
 * transcript の segments を「約 maxChars 文字」の粒度へ割り直す。
 * cfg.maxChars <= 0 なら何もせず入力をそのまま返す(opt-in・バイト等価)。
 * 各 segment は独立に分割され、時系列順・件数増加のみ(並べ替えはしない)。
 */
export function splitLongCaptions(
  segments: TranscriptSegment[],
  cfg: CaptionSplitCfg,
): TranscriptSegment[] {
  if (!cfg || cfg.maxChars <= 0) return segments;
  const resolved = {
    maxChars: cfg.maxChars,
    minChars: cfg.minChars ?? Math.floor(cfg.maxChars * 0.4),
    gapSec: cfg.gapSec ?? 0.3,
  };
  const out: TranscriptSegment[] = [];
  for (const seg of segments) out.push(...splitOne(seg, resolved));
  return out;
}
