// buildCutplan は stages/plan.ts(単発/pushループ)と lib/ai/agenticCut.ts
// (agentic ループの set_cuts tool)の両方から呼ばれる共有ロジックのため、
// 循環 import(plan.ts ⇔ agenticCut.ts)を避けて独立ファイルに置く。
// stages/plan.ts は互換のため re-export する(既存の import 元は変えない)。
import { carryIds, ensureIds, ID_PREFIX } from "./ids.ts";
import type { CutPlan, PlanSegment } from "../types.ts";
import type { NumberedSegment } from "../stages/plan.ts";

/** buildCutplan の id 引き継ぎ用コンテキスト(§buildIdContext 参照)。
 * 省略時(undefined)は id に一切触れない(=導入前とバイト等価) */
export interface CutplanIdContext {
  /** 直前の cutplan.json の segments(span 一致で id を運ぶ元) */
  existingSegments: PlanSegment[];
  /** project 全体で衝突しない used 集合(呼び出しごとに変異する) */
  used: Set<string>;
}

/** cutplan.segments を元収録の全時間 [0, duration] で連続被覆させるための
 * 穴埋め設定。省略時(undefined)は穴を埋めない(=導入前とバイト等価)。
 * detect が発話候補(auto.keepSegments)しか候補にしないため、無音区間は
 * どのセグメントにも属さない「穴」になっていた。この穴を action:"cut" として
 * 記録することで、エディタのタイムラインに「カットされた区間」の印が出て
 * 復元(この区間を動画に戻す)できるようになる(全ての映像を戻せる状態)。 */
export interface CutplanFill {
  /** 元収録の全長(秒)。manifest.durationSec / auto.originalDurationSec */
  duration: number;
  /** 穴(無音区間)を cut にするときの reason。省略時 DEFAULT_SILENCE_CUT_REASON */
  reason?: string;
}

/** config.detect.silenceCutReason 未設定時のフォールバック文言 */
export const DEFAULT_SILENCE_CUT_REASON = "無音";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 発話候補だけの segments(時系列・重なり無し前提)の隙間・先頭・末尾を
 * action:"cut" で埋め、[0, duration] を連続被覆する新しい配列を返す。
 * 0.01 秒未満の隙間は round2 の端数とみなして埋めない。入力は破壊しない。 */
export function fillSilenceGaps(
  segments: PlanSegment[],
  duration: number,
  reason: string = DEFAULT_SILENCE_CUT_REASON,
): PlanSegment[] {
  const EPS = 0.01;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const filled: PlanSegment[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start - cursor > EPS) {
      filled.push({ start: round2(cursor), end: round2(s.start), action: "cut", reason });
    }
    filled.push(s);
    cursor = Math.max(cursor, s.end);
  }
  if (duration - cursor > EPS) {
    filled.push({ start: round2(cursor), end: round2(duration), action: "cut", reason });
  }
  return filled;
}

/** LLM 応答からカット判断を反映した cutplan を組み立てる(存在しない id は無視)。
 * idCtx があれば、span(start:end)一致で旧 segments.id を運び(carryIds)、
 * 残りを採番する(ensureIds)。span が変わった segment は新 id になる(要件どおり)。
 *
 * `keeps`(省略時 undefined。§4.4)は「切る誘惑があったが残した区間」だけを
 * LLM に列挙させたもの。cutIds に無い(=keep になる)id にだけ reasonId/reason を
 * 載せる。存在しない id は cuts と同じく console.warn して無視する。
 * `reasonId` は値がある segment にだけキーを足す(undefined のキーは出さない。
 * sticky・§I1: 省略時は導入前と deepEqual) */
export function buildCutplan(
  numbered: NumberedSegment[],
  cuts: { id: number; reason: string; reasonId?: string }[],
  idCtx?: CutplanIdContext,
  fill?: CutplanFill,
  keeps?: { id: number; reason: string; reasonId: string }[],
): CutPlan {
  const cutIds = new Map(cuts.map((c) => [c.id, { reason: c.reason, reasonId: c.reasonId }]));
  for (const c of cuts) {
    if (!numbered.some((n) => n.id === c.id)) {
      console.warn(`警告: LLM が存在しない区間 id=${c.id} を指定(無視します)`);
      cutIds.delete(c.id);
    }
  }

  const keepIds = new Map((keeps ?? []).map((k) => [k.id, { reason: k.reason, reasonId: k.reasonId }]));
  for (const k of keeps ?? []) {
    if (!numbered.some((n) => n.id === k.id)) {
      console.warn(`警告: LLM が存在しない区間 id=${k.id} を keeps に指定(無視します)`);
      keepIds.delete(k.id);
    }
  }

  let segments: PlanSegment[] = numbered.map((n) => {
    const cut = cutIds.get(n.id);
    if (cut) {
      return {
        start: n.start,
        end: n.end,
        action: "cut" as const,
        reason: cut.reason,
        ...(cut.reasonId !== undefined ? { reasonId: cut.reasonId } : {}),
      };
    }
    const keep = keepIds.get(n.id);
    if (keep) {
      return { start: n.start, end: n.end, action: "keep" as const, reason: keep.reason, reasonId: keep.reasonId };
    }
    return { start: n.start, end: n.end, action: "keep" as const, reason: "" };
  });

  // 発話候補の隙間(無音)を cut として明示記録し、元収録の全時間を連続被覆
  // させる(穴を無くして全ての映像を戻せる状態にする)。id 採番より前に埋める
  // ことで、穴埋めした cut にも carryIds/ensureIds が id を運ぶ・採番する。
  if (fill) {
    segments = fillSilenceGaps(segments, fill.duration, fill.reason);
  }

  if (idCtx) {
    segments = carryIds(idCtx.existingSegments, segments, (s) => `${s.start}:${s.end}`);
    segments = ensureIds(segments, ID_PREFIX.cutSegment, idCtx.used);
  }

  return { approved: false, segments };
}

/** buildIdContext(stages/plan.ts)が返す「素の」idCtx を CutplanIdContext の
 * フィールド名(existingSegments)へ写す純関数。plan.ts の単発/pushループ経路と
 * lib/ai/agenticCut.ts の set_cuts tool の両方が同じ写像を必要とするため
 * ここに集約する */
export function toCutplanIdContext(
  idCtx?: { used: Set<string>; existingCutplanSegments: PlanSegment[] },
): CutplanIdContext | undefined {
  return idCtx && { existingSegments: idCtx.existingCutplanSegments, used: idCtx.used };
}
