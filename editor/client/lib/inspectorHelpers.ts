import type { CaptionAnim, CaptionAnimKind, CaptionStyle } from "../../../src/types.ts";

/** Build the nested caption animation patch without serializing inherited empty keys. */
export const buildCaptionAnimPatch = (full: {
  in: CaptionAnimKind | "";
  out: CaptionAnimKind | "";
  durationSec: number | undefined;
}): Partial<CaptionStyle> => {
  const anim: CaptionAnim = {};
  if (full.in !== "") anim.in = full.in;
  if (full.out !== "") anim.out = full.out;
  if (full.durationSec !== undefined) anim.durationSec = full.durationSec;
  return { anim: Object.keys(anim).length > 0 ? anim : undefined };
};
