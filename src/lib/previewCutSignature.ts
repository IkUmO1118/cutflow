import { playbackSegmentsOf } from "./timeline.ts";
import type { CutPlan } from "../types.ts";

export interface PreviewCutKeep {
  start: number;
  end: number;
  speed?: number;
}

export function normalizePreviewCutKeeps(cutplan: CutPlan): PreviewCutKeep[] {
  return playbackSegmentsOf(cutplan).map((keep) => ({
    start: keep.start,
    end: keep.end,
    ...(keep.speed !== 1 ? { speed: keep.speed } : {}),
  }));
}

/** 未保存 cutplan と server 応答を照合するための、表示理由等を含まない署名。 */
export function previewCutKeepSignature(cutplan: CutPlan): string {
  return JSON.stringify(normalizePreviewCutKeeps(cutplan));
}
