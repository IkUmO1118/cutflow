import { readHyperframeRequires } from "./hyperframeRequirements.ts";

export type HyperframeRenderProfile = "default" | "gpu-angle";

export interface HyperframeRenderProfileConfig {
  chromiumGl: "angle" | null;
}

/**
 * F2 will make gpu-angle non-null and use this same table in the render/cache
 * path. Keeping it null in F0 records that the profile is not wired without
 * changing current rendering or cache keys.
 */
export const HYPERFRAME_RENDER_PROFILE_CONFIG: Readonly<
  Record<HyperframeRenderProfile, Readonly<HyperframeRenderProfileConfig> | null>
> = {
  default: { chromiumGl: null },
  "gpu-angle": null,
};

export function resolveHyperframeRenderProfile(html: string): HyperframeRenderProfile {
  const requiresThree = readHyperframeRequires(html).tokens.includes("three");
  const usesHfSeek = /['"]hf-seek['"]/.test(html);
  return usesHfSeek || requiresThree ? "gpu-angle" : "default";
}

export function isHyperframeRenderProfileWired(profile: HyperframeRenderProfile): boolean {
  return HYPERFRAME_RENDER_PROFILE_CONFIG[profile] !== null;
}
