import type { Interval, Transcript, WordTiming } from "../types.ts";

/** plan の候補格子細分化(C1)+ 候補テキストの語ベース化(C8)の設定。
 * §docs/plans/2026-07-11-c1-word-candidate-grid-design.md */
export interface CandidatesCfg {
  /** 細分化+語ベーステキストの有効化。false=現状とバイト等価 */
  enabled: boolean;
  /** これ以上長い keep だけを分割対象にする(短い候補は割らない) */
  splitOnlyLongerThanSec: number;
  /** 語間ギャップがこの秒以上なら分割点候補にする(通常 detect の
   *  minSilenceSec 未満。無音検出が拾わない微小ポーズを拾う) */
  minSplitGapSec: number;
  /** 分割後の各 sub-candidate の最小尺。これ未満になる分割はしない/隣へ併合 */
  minCandidateSec: number;
  /** フィラー語(単独の候補として切り出せるようにする)。表記そのまま前方一致 */
  fillers: string[];
}

/** transcript の全 words を時系列で集める(発話 segment のみ。章テロップ等 words 無しは自然に除外)。 */
export function collectWords(transcript: Transcript): WordTiming[] {
  return transcript.segments
    .flatMap((s) => s.words ?? [])
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

/** 1つの keep [start,end] に対する内部分割点(昇順・両端は含まない)を返す純関数。
 *  規則:
 *   1. keep 内に落ちる words を拾う。
 *   2. 連続する語の間の gap(prev.end→next.start)が minSplitGapSec 以上なら
 *      その gap の中点を分割点候補にする(C7=語境界に置く)。
 *   3. フィラー語 w は、その前後(w.start と w.end)を分割点候補にして
 *      「フィラー単体の sub-candidate」を作れるようにする。
 *   4. すべての分割点で切ったときに、どの sub-candidate も minCandidateSec 以上に
 *      なるよう、近すぎる分割点は間引く(貪欲: 直前の確定境界から minCandidateSec
 *      未満の分割点は捨てる)。end 側も同様に、末尾片が minCandidateSec 未満なら
 *      最後の分割点を捨てる。 */
export function splitPointsForKeep(
  keep: Interval,
  words: WordTiming[],
  cfg: CandidatesCfg,
): number[] {
  const inKeep = words.filter(
    (w) => w.start >= keep.start - 1e-6 && w.end <= keep.end + 1e-6,
  );
  const raw: number[] = [];
  for (let i = 0; i + 1 < inKeep.length; i++) {
    const prev = inKeep[i];
    const next = inKeep[i + 1];
    if (next.start - prev.end >= cfg.minSplitGapSec) {
      raw.push((prev.end + next.start) / 2);
    }
  }
  for (const w of inKeep) {
    if (cfg.fillers.some((f) => w.text.trim().startsWith(f))) {
      raw.push(w.start);
      raw.push(w.end);
    }
  }
  const sorted = [...new Set(raw)]
    .filter((p) => p > keep.start && p < keep.end)
    .sort((a, b) => a - b);

  const kept: number[] = [];
  let lastBoundary = keep.start;
  for (const p of sorted) {
    if (p - lastBoundary >= cfg.minCandidateSec) {
      kept.push(p);
      lastBoundary = p;
    }
  }
  if (kept.length > 0 && keep.end - kept[kept.length - 1] < cfg.minCandidateSec) {
    kept.pop();
  }
  return kept;
}

/** keep 群を語境界で細分化して、タイル性を保った Interval[] を返す純関数。
 *  - cfg.enabled=false または words 皆無 → 入力をそのまま返す(恒等)。
 *  - 各 keep について、尺 <= splitOnlyLongerThanSec なら分割せずそのまま。
 *  - 分割点 p1<...<pk があれば [start,p1],[p1,p2],...,[pk,end] を出力(丸め済み)。 */
export function subdivideCandidates(
  keeps: Interval[],
  transcript: Transcript,
  cfg: CandidatesCfg,
): Interval[] {
  if (!cfg.enabled) return keeps;
  const words = collectWords(transcript);
  if (words.length === 0) return keeps;
  const out: Interval[] = [];
  for (const k of keeps) {
    if (k.end - k.start <= cfg.splitOnlyLongerThanSec) {
      out.push(k);
      continue;
    }
    const pts = splitPointsForKeep(k, words, cfg);
    let cursor = k.start;
    for (const p of pts) {
      out.push({ start: round2(cursor), end: round2(p) });
      cursor = p;
    }
    out.push({ start: round2(cursor), end: round2(k.end) });
  }
  return out;
}

/** 候補 [start,end] に「実際に残る語」だけを連結したテキストを返す(C8)。
 *  語の中点が候補区間に入るものを採用(境界の重複表示を防ぐ)。
 *  words が全く無ければ null を返し、呼び出し側は従来の numberSegments にフォールバック。 */
export function candidateText(seg: Interval, words: WordTiming[]): string | null {
  if (words.length === 0) return null;
  const mid = (w: WordTiming) => (w.start + w.end) / 2;
  const inside = words.filter((w) => mid(w) >= seg.start && mid(w) < seg.end);
  return inside
    .map((w) => w.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
