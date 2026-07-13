import type { RenderProps } from "../../remotion/props.ts";
import { duckFactorAt } from "./duck.ts";

type BgmTrack = RenderProps["bgm"][number];

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function bgmTrackTiming(
  track: BgmTrack,
  fps: number,
): { fromFrame: number; durationInFrames: number; startFromFrame: number } {
  return {
    fromFrame: Math.round(track.start * fps),
    durationInFrames: Math.max(1, Math.round((track.end - track.start) * fps)),
    startFromFrame: Math.round((track.startFrom ?? 0) * fps),
  };
}

export function bgmVolumeAtFrame(track: BgmTrack, localFrame: number, fps: number): number {
  const { fromFrame, durationInFrames } = bgmTrackTiming(track, fps);
  const gain = Math.pow(10, track.volumeDb / 20);
  const fadeInFrames = (track.fadeInSec ?? 0) * fps;
  const fadeOutFrames = (track.fadeOutSec ?? 0) * fps;
  const fadeIn = fadeInFrames > 0 ? clamp01(localFrame / fadeInFrames) : 1;
  const fadeOut = fadeOutFrames > 0
    ? clamp01((durationInFrames - localFrame) / fadeOutFrames)
    : 1;
  const duck = track.duck;
  const duckFade = duck ? Math.max(duck.fadeSec, 1 / fps) : 0;
  const duckGain = duck ? Math.pow(10, duck.duckDb / 20) : 1;
  const sec = (fromFrame + localFrame) / fps;
  const duckFactor = duck ? duckFactorAt(duck.spans, sec, duckFade, duckGain) : 1;
  return gain * duckFactor * fadeIn * fadeOut;
}
