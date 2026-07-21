// plan-effects.first.json — plan-effects が最初に生成した演出判断の write-once 記録。
// generated は番号選択を決定論変換した後の実体、none は変換で消える判断を
// 元秒付きで保存する。既存ファイルは壊れていても絶対に上書きしない。

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EffectAnchor, EffectDecision } from "./effectAnchors.ts";
import type { Overlays, Region } from "../types.ts";

export interface FirstEffectsNoneEntry {
  anchorId: number;
  start: number;
  end: number;
  rect?: Region;
  effectReasonId?: string;
  reason: string;
}

export interface FirstEffectsPlan {
  schemaVersion: 1;
  writtenAt: string;
  source: "plan-effects";
  effectReasonIdsEnabled: boolean;
  pattern: string;
  anchorCount: number;
  generated: {
    zooms: NonNullable<Overlays["zooms"]>;
    blurs: NonNullable<Overlays["blurs"]>;
    annotations: NonNullable<Overlays["annotations"]>;
  };
  none: FirstEffectsNoneEntry[];
}

function noneLimit(anchorCount: number): number {
  const count = Math.max(0, anchorCount);
  return Math.min(count, Math.max(12, Math.ceil(count * 0.1)));
}

/** fs非依存。noneは存在するanchorだけを採用し、入力が未制限でも必ず上限内にする。 */
export function buildFirstEffectsPlan(args: {
  effectReasonIdsEnabled: boolean;
  pattern: string;
  anchors: readonly EffectAnchor[];
  decisions: readonly EffectDecision[];
  generated: Pick<Overlays, "zooms" | "blurs" | "annotations">;
  now?: () => Date;
}): FirstEffectsPlan {
  const anchorsById = new Map(args.anchors.map((anchor) => [anchor.id, anchor]));
  const none: FirstEffectsNoneEntry[] = [];
  const maxNone = noneLimit(args.anchors.length);
  for (const decision of args.decisions) {
    if (decision.effect !== "none" || none.length >= maxNone) continue;
    const anchor = anchorsById.get(decision.anchorId);
    if (!anchor) continue;
    none.push({
      anchorId: decision.anchorId,
      start: anchor.start,
      end: anchor.end,
      ...(anchor.rect !== undefined ? { rect: anchor.rect } : {}),
      ...(decision.effectReasonId !== undefined ? { effectReasonId: decision.effectReasonId } : {}),
      reason: decision.reason,
    });
  }

  return {
    schemaVersion: 1,
    writtenAt: (args.now ?? (() => new Date()))().toISOString(),
    source: "plan-effects",
    effectReasonIdsEnabled: args.effectReasonIdsEnabled,
    pattern: args.pattern,
    anchorCount: args.anchors.length,
    generated: {
      zooms: args.generated.zooms ?? [],
      blurs: args.generated.blurs ?? [],
      annotations: args.generated.annotations ?? [],
    },
    none,
  };
}

/** write-once。--forceを含む呼び出し側の再実行意図より初版の事実を優先する。 */
export function writeFirstEffectsPlan(dir: string, payload: FirstEffectsPlan): void {
  const path = join(dir, "plan-effects.first.json");
  if (existsSync(path)) return;
  writeFileSync(path, JSON.stringify(payload, null, 2));
}
