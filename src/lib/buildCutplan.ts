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

/** LLM 応答からカット判断を反映した cutplan を組み立てる(存在しない id は無視)。
 * idCtx があれば、span(start:end)一致で旧 segments.id を運び(carryIds)、
 * 残りを採番する(ensureIds)。span が変わった segment は新 id になる(要件どおり) */
export function buildCutplan(
  numbered: NumberedSegment[],
  cuts: { id: number; reason: string }[],
  idCtx?: CutplanIdContext,
): CutPlan {
  const cutIds = new Map(cuts.map((c) => [c.id, c.reason]));
  for (const c of cuts) {
    if (!numbered.some((n) => n.id === c.id)) {
      console.warn(`警告: LLM が存在しない区間 id=${c.id} を指定(無視します)`);
      cutIds.delete(c.id);
    }
  }

  let segments: PlanSegment[] = numbered.map((n) => ({
    start: n.start,
    end: n.end,
    action: cutIds.has(n.id) ? "cut" : "keep",
    reason: cutIds.get(n.id) ?? "",
  }));

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
