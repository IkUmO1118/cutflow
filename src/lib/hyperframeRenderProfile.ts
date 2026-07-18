import { readHyperframeRequires } from "./hyperframeRequirements.ts";

export type HyperframeRenderProfile = "default" | "gpu-angle";

export interface HyperframeRenderProfileConfig {
  chromiumGl: "angle" | null;
}

export const HYPERFRAME_RENDER_PROFILE_CONFIG: Readonly<
  Record<HyperframeRenderProfile, Readonly<HyperframeRenderProfileConfig> | null>
> = {
  default: { chromiumGl: null },
  "gpu-angle": { chromiumGl: "angle" },
};

export function resolveHyperframeRenderProfile(html: string): HyperframeRenderProfile {
  const requiresThree = readHyperframeRequires(html).tokens.includes("three");
  const usesHfSeek = /['"]hf-seek['"]/.test(html);
  return usesHfSeek || requiresThree ? "gpu-angle" : "default";
}

export function isHyperframeRenderProfileWired(profile: HyperframeRenderProfile): boolean {
  return HYPERFRAME_RENDER_PROFILE_CONFIG[profile] !== null;
}
