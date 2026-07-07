import { keepAudioParts, type AudioSource } from "./loudness.ts";
import type { Interval } from "../types.ts";

export function buildConcatVideoFilter(segments: Interval[]): { filter: string; outLabel: string } {
  const trims = segments.map(
    (seg, i) => `[0:v:0]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
  );
  const labels = segments.map((_, i) => `[v${i}]`).join("");
  return {
    filter: [...trims, `${labels}concat=n=${segments.length}:v=1:a=0[vcat]`].join(";"),
    outLabel: "vcat",
  };
}

export function buildMotionStripFilter(args: {
  segments: Interval[];
  everySec: number;
  cols: number;
  rows: number;
  stripWidthPx: number;
}): string {
  const { filter, outLabel } = buildConcatVideoFilter(args.segments);
  return [
    filter,
    `[${outLabel}]fps=${1 / args.everySec},scale=${args.stripWidthPx}:-1:force_original_aspect_ratio=decrease,tile=${args.cols}x${args.rows}[out]`,
  ].join(";");
}

export function buildMotionMetricFilter(args: {
  segments: Interval[];
  scdetThreshold: number;
  freezeNoiseDb: number;
  freezeDurationSec: number;
}): { scdet: string; freeze: string } {
  const { filter, outLabel } = buildConcatVideoFilter(args.segments);
  return {
    scdet: `${filter};[${outLabel}]scdet=threshold=${args.scdetThreshold}[out]`,
    freeze: `${filter};[${outLabel}]freezedetect=n=${args.freezeNoiseDb}dB:d=${args.freezeDurationSec}[out]`,
  };
}

export function buildConcatAudioFilter(
  source: AudioSource,
  keeps: Interval[],
  inputLabel = "mix",
): string {
  const parts = keepAudioParts(source, keeps);
  const labels = keeps.map((_, i) => `[a${i}]`).join("");
  return [...parts, `${labels}concat=n=${keeps.length}:v=0:a=1[${inputLabel}]`].join(";");
}

export function buildSingleTrackConcatFilter(
  streamIndex: number,
  keeps: Interval[],
  postChain: string,
  label = "aout",
): string {
  const trims = keeps.map(
    (seg, i) => `[0:a:${streamIndex}]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`,
  );
  const labels = keeps.map((_, i) => `[a${i}]`).join("");
  return [...trims, `${labels}concat=n=${keeps.length}:v=0:a=1[ac]`, `[ac]${postChain}[${label}]`].join(";");
}
