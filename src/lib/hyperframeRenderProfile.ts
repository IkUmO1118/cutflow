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
  const requires = readHyperframeRequires(html).tokens;
  const requiresGpu = requires.includes("three") || requires.includes("webgpu");
  const usesHfSeek = /['"]hf-seek['"]/.test(html);
  return usesHfSeek || requiresGpu ? "gpu-angle" : "default";
}

export function isHyperframeRenderProfileWired(profile: HyperframeRenderProfile): boolean {
  return HYPERFRAME_RENDER_PROFILE_CONFIG[profile] !== null;
}
