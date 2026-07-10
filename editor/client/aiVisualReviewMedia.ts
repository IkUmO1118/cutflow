import type { ReviewBundle, ReviewStill } from "../../src/stages/review.ts";

export type PreviewMode = "after" | "before" | "side-by-side" | "overlay";
export type PreviewMedia =
  | { kind: "video-single"; side: "before" | "after"; file: string }
  | { kind: "video-pair"; beforeFile: string; afterFile: string }
  | { kind: "still"; still: ReviewStill };

export function selectPreviewMedia(
  previewMode: PreviewMode,
  selectedStill: ReviewStill | null,
  clips?: ReviewBundle["clips"],
): PreviewMedia | null {
  if (previewMode === "overlay") return selectedStill ? { kind: "still", still: selectedStill } : null;
  if (previewMode === "after" && clips?.afterFile) {
    return { kind: "video-single", side: "after", file: clips.afterFile };
  }
  if (previewMode === "before" && clips?.beforeFile) {
    return { kind: "video-single", side: "before", file: clips.beforeFile };
  }
  if (previewMode === "side-by-side" && clips?.beforeFile && clips?.afterFile) {
    return { kind: "video-pair", beforeFile: clips.beforeFile, afterFile: clips.afterFile };
  }
  return selectedStill ? { kind: "still", still: selectedStill } : null;
}
