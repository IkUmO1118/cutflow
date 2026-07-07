import type { Config } from "./config.ts";
import type { AssertOutcome } from "../stages/assert.ts";
import type { DescribeProjection } from "../stages/describe.ts";
import type { AssertionsDoc } from "../types.ts";

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
  av?: unknown;
}

export interface ObservationProvider {
  observe(dir: string, cfg: Config): Promise<ObservationInput>;
}

export interface StopState {
  iteration: number;
  maxIterations: number;
  loopCfg: PlanLoopCfg;
  outcomes: readonly AssertOutcome[];
  prevCuts: readonly LoopCut[] | null;
  cuts: readonly LoopCut[];
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
  return lines.join("\n");
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
