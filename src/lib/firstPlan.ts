// plan.first.json(§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md §5・P5-1)。
// 「AI の最初の判断」を write-once(存在すれば絶対に上書きしない。--force でも
// 上書きしない)で保存する測定資産。中間生成物(GENERATED_FILES)の一員だが、
// --cache-only にも --logs-only にも含めない(再生成不可能なため)。
//
// 候補 id ではなく元秒(start/end)で最終 cutplan.json と join できるようにする
// (候補格子は detect の再実行や candidates 設定変更で番号が変わるため)。
//
// IO は writeFirstPlan だけに閉じる(buildFirstPlan は純関数・テスト対象)。

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NumberedSegment } from "../stages/plan.ts";

export interface FirstPlanEntry {
  id: number;
  /** 元収録の秒(その候補の numbered.start/end) */
  start: number;
  end: number;
  reasonId?: string;
  reason: string;
}

export interface FirstPlan {
  schemaVersion: 1;
  writtenAt: string;
  /** どの経路の初版か */
  source: "plan" | "plan --cuts-only";
  /** 注入が効いていたか(測定のアーム) */
  reasonIdsEnabled: boolean;
  /** §2 の宣言値(collections/cutPatterns.ts の CutPatternId) */
  pattern: string;
  /** 候補格子の規模 */
  candidateCount: number;
  cuts: FirstPlanEntry[];
  keeps: FirstPlanEntry[];
}

/** 存在しない候補 id は無視する(buildCutplan と同じ規約。id 一致しない
 *  エントリを元秒無しで記録すると join できず測定資産として無意味になる)。 */
function toEntries(
  items: readonly { id: number; reason: string; reasonId?: string }[],
  numbered: readonly NumberedSegment[],
): FirstPlanEntry[] {
  const entries: FirstPlanEntry[] = [];
  for (const item of items) {
    const seg = numbered.find((n) => n.id === item.id);
    if (!seg) continue;
    entries.push({
      id: item.id,
      start: seg.start,
      end: seg.end,
      ...(item.reasonId !== undefined ? { reasonId: item.reasonId } : {}),
      reason: item.reason,
    });
  }
  return entries;
}

/** FirstPlan を組み立てる純関数(fs 非依存・テスト対象)。 */
export function buildFirstPlan(args: {
  source: "plan" | "plan --cuts-only";
  reasonIdsEnabled: boolean;
  pattern: string;
  numbered: readonly NumberedSegment[];
  cuts: readonly { id: number; reason: string; reasonId?: string }[];
  keeps?: readonly { id: number; reason: string; reasonId: string }[];
  now?: () => Date;
}): FirstPlan {
  const now = (args.now ?? (() => new Date()))();
  return {
    schemaVersion: 1,
    writtenAt: now.toISOString(),
    source: args.source,
    reasonIdsEnabled: args.reasonIdsEnabled,
    pattern: args.pattern,
    candidateCount: args.numbered.length,
    cuts: toEntries(args.cuts, args.numbered),
    keeps: toEntries(args.keeps ?? [], args.numbered),
  };
}

/** write-once: 既に plan.first.json があれば(--force 実行時でも)絶対に
 *  上書きしない。「AI の最初の判断」という定義そのものを守るための不変条件。 */
export function writeFirstPlan(dir: string, payload: FirstPlan): void {
  const p = join(dir, "plan.first.json");
  if (existsSync(p)) return;
  writeFileSync(p, JSON.stringify(payload, null, 2));
}
