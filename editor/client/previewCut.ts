import type { CutPlan } from "../../src/types.ts";
import { previewCutKeepSignature } from "../../src/lib/previewCutSignature.ts";
import type { PreviewCutState } from "./apiTypes.ts";

export interface PreviewBaseVideo {
  videoFile: "media/proxy.mp4" | "media/preview-cut.mp4";
  videoIsSource: boolean;
}

export function previewBaseVideoMountKey(video: PreviewBaseVideo): string {
  return `${video.videoFile}:${video.videoIsSource}`;
}

const SOURCE_VIDEO: PreviewBaseVideo = {
  videoFile: "media/proxy.mp4",
  videoIsSource: true,
};

const BAKED_VIDEO: PreviewBaseVideo = {
  videoFile: "media/preview-cut.mp4",
  videoIsSource: false,
};

/**
 * 本編の現在 keep と一致するベイクだけを continuous 経路へ渡す。
 * ショートと、欠落・陳腐・生成待ちの本編は従来の source 経路を保つ。
 */
export function previewBaseVideoOf(args: {
  cutplan: CutPlan;
  previewCut: PreviewCutState;
  shortMode: boolean;
  proxyStale: boolean;
}): PreviewBaseVideo {
  if (args.shortMode || args.proxyStale || !args.previewCut.ready) return SOURCE_VIDEO;
  return previewCutKeepSignature(args.cutplan) === args.previewCut.keepSignature
    ? BAKED_VIDEO
    : SOURCE_VIDEO;
}
