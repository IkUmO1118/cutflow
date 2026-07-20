export const HYPERFRAME_REQUIRE_TOKENS = ["gsap", "lottie", "anime", "three", "webgpu"] as const;

export type HyperframeRequireToken = (typeof HYPERFRAME_REQUIRE_TOKENS)[number];

export function readHyperframeRequires(html: string): {
  declared: boolean;
  tokens: string[];
} {
  const match = /data-hf-requires\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  if (!match) return { declared: false, tokens: [] };
  const raw = match[1] !== undefined ? match[1] : match[2];
  return {
    declared: true,
    tokens: raw.split(/[\s,]+/).filter((token) => token.length > 0),
  };
}
