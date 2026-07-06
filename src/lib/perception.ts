// lib/perception.ts — plan(カット判断 LLM)へ発話テキスト以外の知覚を添える
// (opt-in・既定オフ)。§docs/plans/2026-07-07-plan-eyes-ears-design.md
//
// 音特徴(§4): detect が既に持つ cuts.auto.json の情報(silences[] +
// numberSegments の出力する NumberedSegment[])だけから計算する純関数。
// 新規の音量計測はしない(LLM に「間」の手掛かりを与えるだけ)。
//
// 画面 OCR(§5)は別コミットで追加する(この時点では renderPerceptionBlock の
// ocr 引数は受け取るだけで未使用。「ocr 引数は用意だけ」§8 タスク2)。
import type { Interval } from "../types.ts";
import type { NumberedSegment } from "../stages/plan.ts";

/** 区間ごとの音の特徴(秒。丸め済み)。LLM に算術をさせないため、
 * こちらで計算し記述文として渡す(§4 D2) */
export interface SegmentAudioFeature {
  id: number;
  /** 区間の尺(end - start) */
  len: number;
  /** 直前の keep との間に落ちた素材秒(先頭区間は0) */
  gapBefore: number;
  /** 区間内に残った無音の合計秒(silences との overlap 積算) */
  silenceWithin: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 2つの区間の重なり秒(重ならなければ0) */
function overlapSec(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * numbered(残す候補区間に番号を振ったもの)+ silences(cuts.auto.json の
 * 無音区間)だけから区間ごとの音特徴を計算する純関数(detect への新規計測は
 * 要しない。§4)。
 */
export function computeAudioFeatures(
  numbered: NumberedSegment[],
  silences: Interval[],
): SegmentAudioFeature[] {
  return numbered.map((seg, i) => {
    const prev = numbered[i - 1];
    const gapBefore = i === 0 ? 0 : seg.start - prev.end;
    const silenceWithin = silences.reduce((sum, s) => sum + overlapSec(s, seg), 0);
    return {
      id: seg.id,
      len: round1(seg.end - seg.start),
      gapBefore: round1(gapBefore),
      silenceWithin: round1(silenceWithin),
    };
  });
}

/** 音特徴をプロンプト用の記述文に整形する(純関数)。番号の連続性のため
 * 全区間を含める(§4 の「省略しない」側の選択。バイト等価の不変条件には
 * 無関係=このブロック自体が opt-in なので影響しない) */
export function formatAudio(features: SegmentAudioFeature[]): string {
  const lines = features.map(
    (f) =>
      `#${f.id} 尺${f.len.toFixed(1)} / 直前カット${f.gapBefore.toFixed(1)} / 内無音${f.silenceWithin.toFixed(1)}`,
  );
  return ["## 各区間の音の特徴(秒)", ...lines].join("\n");
}

/**
 * 知覚ブロック({{perception}} に入る全文)を組み立てる純関数。
 * `renderRulesBlock`(stages/plan.ts)と完全に同じ契約: 両方 null/空 →
 * `""`、存在時のみ前後 `\n` を伴う1ブロック。呼び出し側はこの値をそのまま
 * `{{perception}}` に replaceAll するだけでよい(§6.1)。
 *
 * ocr は画面 OCR 接続(別コミット)までは常に null で呼ばれる(パラメータの
 * 型だけ用意。§8 タスク2)。
 */
export function renderPerceptionBlock(
  audio: SegmentAudioFeature[] | null,
  ocr: unknown[] | null,
): string {
  const aLines = audio && audio.length ? formatAudio(audio) : null;
  // OCR 合流は画面 OCR 接続コミットで追加(現時点では受け取るだけで未使用)
  void ocr;
  const oLines: string | null = null;
  if (!aLines && !oLines) return "";
  const parts = ["## AI 向け知覚情報(発話以外の手掛かり)"];
  if (aLines) parts.push(aLines);
  if (oLines) parts.push(oLines);
  return `\n${parts.join("\n\n")}\n`;
}
