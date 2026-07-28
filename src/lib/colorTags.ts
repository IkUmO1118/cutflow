import type { ProbeResult } from "./ffmpeg.ts";

export interface ColorTags {
  matrix: string;
  range: "tv" | "pc";
}

function specified(value: string | undefined): string | undefined {
  if (!value || value === "unknown" || value === "reserved") return undefined;
  return value;
}

function resolveRange(value: string | undefined): "tv" | "pc" {
  const range = specified(value);
  return range === "pc" ? "pc" : "tv";
}

/** ffprobe の色フィールド + 高さから、出力に焼くべきタグを決める純関数。 */
export function resolveColorTags(
  probed: { colorSpace?: string; colorRange?: string; height?: number },
): ColorTags {
  const matrix = specified(probed.colorSpace) ??
    (probed.height !== undefined && probed.height <= 576 ? "smpte170m" : "bt709");
  return {
    matrix,
    range: resolveRange(probed.colorRange),
  };
}

/** ffmpeg の出力オプションへ。matrix と range だけを焼く。 */
export function colorTagArgs(tags: ColorTags): string[] {
  return ["-colorspace", tags.matrix, "-color_range", tags.range];
}

/** ProbeResult から先頭 video ストリームを見て resolveColorTags する薄い橋。 */
export function colorTagsOfProbe(result: ProbeResult): ColorTags {
  const video = result.streams.find((stream) => stream.codec_type === "video");
  return resolveColorTags({
    colorSpace: video?.color_space,
    colorRange: video?.color_range,
    height: video?.height,
  });
}
