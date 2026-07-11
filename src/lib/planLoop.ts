import type { Config } from "./config.ts";
import type { AssertOutcome } from "../stages/assert.ts";
import type { DescribeProjection } from "../stages/describe.ts";
import type { AssertionsDoc } from "../types.ts";
import { summarizeSecondaryObservation } from "./vlmObservation.ts";
import type { SecondaryObservation } from "./vlmObservation.ts";

export interface PlanLoopCfg {
  maxIterations: number;
  targetOutDurationSec: number | null;
  stopWhenAssertionsPass: boolean;
}

export interface LoopCut {
  id: number;
  reason: string;
}

export interface ObservationInput {
  proj: DescribeProjection;
  outcomes: AssertOutcome[];
  secondary?: SecondaryObservation;
  warnings: string[];
}

export interface ObservationProvider {
  observe(dir: string, cfg: Config): Promise<ObservationInput>;
}

/** E7 opt-in フック: 演出検品(effect-check)の観測1行を、既存の観測
 *  warnings 配列へ追加する。observe=false(既定)/observation が空文字
 *  (effect-check.json 無し・警告0件)のときは元の配列をそのまま返す
 *  (バイト等価)。cut の plan ループ本体には自動配線しない(観測ソースが
 *  演出であって cut ではなくドメインが違うため。呼び出すかは呼び出し側の
 *  判断に委ねる。§docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md E7) */
export function withEffectObservation(
  warnings: string[],
  observation: string,
  observe: boolean,
): string[] {
  if (!observe || observation === "") return warnings;
  return [...warnings, observation];
}

export interface StopState {
  iteration: number;
  maxIterations: number;
  loopCfg: PlanLoopCfg;
  outcomes: readonly AssertOutcome[];
  prevCuts: readonly LoopCut[] | null;
  cuts: readonly LoopCut[];
}

export interface PlanSecondaryObservationCfg {
  enabled: boolean;
  maxCalls: number;
  maxImages: number;
}

/** assertions.json と config 由来の目標尺を1つの AssertionsDoc に合成する */
export function deriveLoopAssertions(
  loopCfg: Pick<PlanLoopCfg, "targetOutDurationSec">,
  diskAssertions: AssertionsDoc | null,
): AssertionsDoc {
  const assertions = [...(diskAssertions?.assertions ?? [])];
  if (loopCfg.targetOutDurationSec !== null) {
    assertions.push({
      label: "plan.loop.targetOutDurationSec",
      type: "outDuration",
      op: "<=",
      value: loopCfg.targetOutDurationSec,
    });
  }
  return { schemaVersion: diskAssertions?.schemaVersion ?? 1, assertions };
}

export function cutsSetEqual(
  a: readonly Pick<LoopCut, "id">[],
  b: readonly Pick<LoopCut, "id">[],
): boolean {
  if (a.length !== b.length) return false;
  const aa = a.map((c) => c.id).sort((x, y) => x - y);
  const bb = b.map((c) => c.id).sort((x, y) => x - y);
  return aa.every((id, i) => id === bb[i]);
}

function fmtSec(sec: number): string {
  return `${sec.toFixed(1)} 秒`;
}

function summarizeTarget(actual: number, target: number | null): string {
  if (target === null) return "";
  const delta = actual - target;
  if (delta > 0) return `(目標: ${fmtSec(target)}) -> ${fmtSec(delta)} 超過`;
  return `(目標: ${fmtSec(target)}) -> ${fmtSec(Math.abs(delta))} 以内`;
}

export function summarizeObservation(
  proj: DescribeProjection,
  outcomes: readonly AssertOutcome[],
  currentCuts: readonly LoopCut[],
  loopCfg: Pick<PlanLoopCfg, "targetOutDurationSec">,
  secondary?: SecondaryObservation,
): string {
  const lines: string[] = [];
  lines.push("## 直前の編集の観測結果(この編集が狙いを満たしているかの機械計測)");
  lines.push("");
  const target = summarizeTarget(proj.summary.outDurationSec, loopCfg.targetOutDurationSec);
  lines.push(`- 出力尺: ${fmtSec(proj.summary.outDurationSec)}${target ? ` ${target}` : ""}`);
  lines.push(`- keep 区間数: ${proj.summary.keepCount} / カット区間数: ${proj.cuts.length}`);
  if (outcomes.length > 0) {
    lines.push("- 期待値の照合(assertions.json + 目標尺):");
    for (const o of outcomes) {
      const label = o.label ? ` ${o.label}:` : "";
      lines.push(`  - [${o.status}]${label} ${o.message}`);
    }
  } else {
    lines.push("- 期待値の照合(assertions.json + 目標尺): なし");
  }
  lines.push("- 現在のカット選択(id / 理由):");
  if (currentCuts.length === 0) {
    lines.push("  - なし");
  } else {
    for (const c of currentCuts) lines.push(`  - #${c.id} ${c.reason}`);
  }
  if (secondary) {
    lines.push("");
    lines.push(summarizeSecondaryObservation(secondary));
  }
  return lines.join("\n");
}

export function selectPlanLoopReviewTimes(args: {
  projection: DescribeProjection;
  previousProjection: DescribeProjection | null;
  limit: number;
}): number[] {
  const duration =
    args.projection.source?.durationSec ??
    args.projection.summary.outDurationSec;
  const clamp = (sec: number) => Math.min(Math.max(sec, 0), Math.max(0, duration));
  const current = new Set<number>();
  const prev = new Set<number>();
  for (const cut of args.projection.cuts) {
    current.add(Number(cut.start.toFixed(2)));
    current.add(Number(cut.end.toFixed(2)));
  }
  if (args.previousProjection) {
    for (const cut of args.previousProjection.cuts) {
      prev.add(Number(cut.start.toFixed(2)));
      prev.add(Number(cut.end.toFixed(2)));
    }
  }
  const seeds =
    args.previousProjection
      ? [...current].filter((value) => !prev.has(value)).concat([...prev].filter((value) => !current.has(value)))
      : [...current];
  if (seeds.length === 0) return [];
  const times = seeds.flatMap((boundary) => [clamp(boundary + 0.1), clamp(boundary - 0.1)]);
  const deduped: number[] = [];
  for (const time of times) {
    if (deduped.some((existing) => Math.abs(existing - time) < 0.2)) continue;
    deduped.push(Number(time.toFixed(2)));
    if (deduped.length >= args.limit) break;
  }
  return deduped;
}

export function shouldStop(state: StopState): { stop: boolean; reason: string | null } {
  if (state.iteration + 1 >= state.maxIterations) {
    return { stop: true, reason: "max-iterations" };
  }
  const hasFailOrError = state.outcomes.some((o) => o.status === "fail" || o.status === "error");
  if (state.loopCfg.stopWhenAssertionsPass && !hasFailOrError) {
    return { stop: true, reason: "assertions-pass" };
  }
  if (state.prevCuts !== null && cutsSetEqual(state.prevCuts, state.cuts)) {
    return { stop: true, reason: "fixpoint" };
  }
  return { stop: false, reason: null };
}
