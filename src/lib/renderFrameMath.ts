export function compositionDurationInFrames(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

export function compositionDurationSec(durationSec: number, fps: number): number {
  return compositionDurationInFrames(durationSec, fps) / fps;
}
