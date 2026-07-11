// H6(apply ハイブリッドで候補内部を語境界分割・R0 突破)の純関数。
// §docs/plans/2026-07-11-h6-apply-hybrid-r0-breakthrough-design.md §2.3/§2.4
//
// LLM は候補内の語を index(1始まり)で選ぶだけで、時刻は一切生成しない。
// 境界時刻は必ず既存語境界(gap 中点)へスナップする(SD2 candidates.ts の
// splitPointsForKeep と同じ規約・同じ round2 を再利用。新しい時刻計算はしない)。
// fs は一切触らない(副作用なし)。書込み・validate/assert は呼び出し側(tool)が行う。

import { round2 } from "./candidates.ts";
import { ensureIds, ID_PREFIX } from "./ids.ts";
import type { CutPlan, Interval, PlanSegment, WordTiming } from "../types.ts";

export interface CandidateSplitCfg {
  /** 分割後の各 sub-segment(keep/cut 双方)がこれ未満になる分割は拒否する */
  minCandidateSec: number;
}

/** 確定済み分割1件(候補 id 単位・span で紐づく。ターンを跨いで蓄積される) */
export interface SplitOp {
  candidateId: number;
  segStart: number;
  segEnd: number;
  cutWordRanges: { i: number; j: number; reason: string }[];
}

/** 候補 seg 内に実際に残る語(語の中点が seg に入るもの)を時系列順で返す。
 *  list_words tool(表示 index の元)と splitSegmentAtWords(分割計算)が
 *  同じ index 番号付けを共有するための唯一の情報源。candidateText(C8)と
 *  同じ中点包含規則を使う */
export function wordsForCandidate(seg: Interval, words: WordTiming[]): WordTiming[] {
  const mid = (w: WordTiming) => (w.start + w.end) / 2;
  return words.filter((w) => mid(w) >= seg.start && mid(w) < seg.end);
}

/** 候補 seg を語 index 範囲 cutWordRanges で分割した PlanSegment[] を返す純関数。
 *  - words は候補内に落ちる語(wordsForCandidate 済み・時系列順)。1始まり index で
 *    cutWordRanges から参照される。
 *  - 返す segments は seg.[start,end] を隙間なく tile し、時系列順・非重なり
 *    (validate の不変条件を構造的に満たす)。
 *  - 拒否系(書込みに進まない): words 皆無 / index 範囲外(<1 or >語数)/ i>j /
 *    分割後の sub-segment が minCandidateSec 未満。 */
export function splitSegmentAtWords(
  seg: Interval,
  words: WordTiming[],
  cutWordRanges: { i: number; j: number; reason: string }[],
  cfg: CandidateSplitCfg,
): { segments: PlanSegment[] } | { error: string } {
  if (words.length === 0) {
    return { error: "この候補には語タイムスタンプがありません(分割できません)" };
  }
  if (cutWordRanges.length === 0) {
    return { error: "cutWordRanges が空です" };
  }
  for (const r of cutWordRanges) {
    if (!Number.isInteger(r.i) || !Number.isInteger(r.j) || r.i < 1 || r.j > words.length || r.i > r.j) {
      return { error: `語 index が不正です(i=${r.i}, j=${r.j}, 語数=${words.length})` };
    }
  }

  // 隣接/重複する range を併合(語 index の順に走査)
  const sorted = [...cutWordRanges].sort((a, b) => a.i - b.i);
  const merged: { i: number; j: number; reasons: string[] }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.i <= last.j + 1) {
      last.j = Math.max(last.j, r.j);
      last.reasons.push(r.reason);
    } else {
      merged.push({ i: r.i, j: r.j, reasons: [r.reason] });
    }
  }

  // 1始まり index i の「前境界」: 候補先頭語なら seg.start、そうでなければ
  // (1始まりで) 語 i-1 の end と 語 i の start の gap 中点(SD2 と同じ規約)
  const boundaryBefore = (i: number): number =>
    i <= 1 ? round2(seg.start) : round2((words[i - 2]!.end + words[i - 1]!.start) / 2);
  // 1始まり index j の「後境界」: 候補末尾語なら seg.end、そうでなければ
  // 語 j の end と 語 j+1 の start の gap 中点
  const boundaryAfter = (j: number): number =>
    j >= words.length ? round2(seg.end) : round2((words[j - 1]!.end + words[j]!.start) / 2);

  const segments: PlanSegment[] = [];
  let cursor = round2(seg.start);
  for (const m of merged) {
    const cutStart = boundaryBefore(m.i);
    const cutEnd = boundaryAfter(m.j);
    if (cutStart > cursor) {
      segments.push({ start: cursor, end: cutStart, action: "keep", reason: "" });
    }
    segments.push({ start: cutStart, end: cutEnd, action: "cut", reason: m.reasons.join(" / ") });
    cursor = cutEnd;
  }
  const segEnd = round2(seg.end);
  if (segEnd > cursor) {
    segments.push({ start: cursor, end: segEnd, action: "keep", reason: "" });
  }

  // ゼロ長 sub-span は落とす
  const nonZero = segments.filter((s) => s.end - s.start > 1e-6);
  for (const s of nonZero) {
    if (s.end - s.start < cfg.minCandidateSec - 1e-9) {
      return {
        error: `分割後の区間(${s.start}-${s.end})が短すぎます(minCandidateSec=${cfg.minCandidateSec}秒未満)`,
      };
    }
  }
  return { segments: nonZero };
}

/** base cutplan の segments を、span(start:end)一致する分割対象だけ
 *  splitSegmentAtWords の結果へ置換して新 CutPlan を返す純関数。
 *  - splits: [] なら base をそのまま返す(§1-1 バイト等価の要。applySplit off で恒等)。
 *  - span 不一致の split(対象候補が base に無い)は捨てる(再実行耐性)。
 *  - splitSegmentAtWords が失敗する split(通常は tool 側で既に検証済みだが、
 *    防御的に)も同様に捨てる(元の segment を維持)。
 *  - idCtx があれば置換後の id 無し sub-segment に新規採番する(span が変わるので
 *    carryIds は運ばない=既存 ensureIds 挙動)。
 *  - base.approved は必ず false のまま(承認は別行為)。 */
export function applyCandidateSplits(
  base: CutPlan,
  splits: SplitOp[],
  words: WordTiming[],
  cfg: CandidateSplitCfg,
  idCtx?: { used: Set<string> },
): CutPlan {
  if (splits.length === 0) return base;
  let segments = base.segments;
  let changed = false;
  for (const split of splits) {
    const idx = segments.findIndex((s) => s.start === split.segStart && s.end === split.segEnd);
    if (idx === -1) continue;
    const candWords = wordsForCandidate({ start: split.segStart, end: split.segEnd }, words);
    const result = splitSegmentAtWords(
      { start: split.segStart, end: split.segEnd },
      candWords,
      split.cutWordRanges,
      cfg,
    );
    if ("error" in result) continue;
    segments = [...segments.slice(0, idx), ...result.segments, ...segments.slice(idx + 1)];
    changed = true;
  }
  if (!changed) return base;
  const withIds = idCtx ? ensureIds(segments, ID_PREFIX.cutSegment, idCtx.used) : segments;
  return { approved: false, segments: withIds };
}
