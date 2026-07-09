import type { ResolvedKeyframe } from "../../remotion/props.ts";
import type { RemappedPiece } from "./timeline.ts";
import type { Keyframe, KeyframeEasing } from "../types.ts";

export type NumericValues = Record<string, number>;

export function easingProgress(kind: KeyframeEasing, p: number): number {
  const x = clamp01(p);
  switch (kind) {
    case "linear":
      return x;
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "ease-in-out":
      return x * x * (3 - 2 * x);
    case "hold":
      return 0;
  }
}

export function valueAt(
  property: string,
  baseline: number,
  keyframes: ResolvedKeyframe[] | undefined,
  t: number,
): number {
  if (!keyframes || keyframes.length === 0) return baseline;
  const channel = keyframes.filter((k) => k.values[property] !== undefined);
  if (channel.length === 0) return baseline;
  if (channel.length === 1) return channel[0].values[property]!;
  const first = channel[0];
  const last = channel[channel.length - 1];
  if (t <= first.at) return first.values[property]!;
  if (t >= last.at) return last.values[property]!;
  const rightIndex = lowerBound(channel.length, (i) => channel[i].at >= t);
  const right = channel[rightIndex];
  if (t === right.at) return right.values[property]!;
  const left = channel[rightIndex - 1];
  const raw = (t - left.at) / (right.at - left.at);
  const p = easingProgress(left.easing, raw);
  return left.values[property]! + (right.values[property]! - left.values[property]!) * p;
}

export function valuesAt<T extends NumericValues>(
  baseline: T,
  keyframes: ResolvedKeyframe[] | undefined,
  t: number,
): T {
  const out = { ...baseline };
  for (const property of Object.keys(baseline)) {
    out[property as keyof T] = valueAt(property, baseline[property], keyframes, t) as T[keyof T];
  }
  return out;
}

export function remapKeyframesForPiece(
  sourceKeyframes: Keyframe<NumericValues>[],
  piece: RemappedPiece,
  baseline: NumericValues,
): ResolvedKeyframe[] {
  const sourceStartValues = valuesAt(baseline, toResolved(sourceKeyframes), piece.sourceStart);
  const sourceEndValues = valuesAt(baseline, toResolved(sourceKeyframes), piece.sourceEnd);
  const startEasing = easingAt(sourceKeyframes, piece.sourceStart);
  const out: ResolvedKeyframe[] = [
    { at: piece.outputStart, easing: startEasing, values: sourceStartValues },
    ...sourceKeyframes
      .filter((k) => k.at > piece.sourceStart && k.at < piece.sourceEnd)
      .map((k) => ({
        at: round2(
          piece.outputStart +
            ((k.at - piece.sourceStart) / (piece.sourceEnd - piece.sourceStart)) *
              (piece.outputEnd - piece.outputStart),
        ),
        easing: k.easing ?? "linear",
        values: { ...k.values },
      })),
    { at: piece.outputEnd, easing: "linear", values: sourceEndValues },
  ];
  return dedupeResolvedKeyframes(out);
}

function toResolved(sourceKeyframes: Keyframe<NumericValues>[]): ResolvedKeyframe[] {
  return sourceKeyframes.map((k) => ({
    at: k.at,
    easing: k.easing ?? "linear",
    values: { ...k.values },
  }));
}

function dedupeResolvedKeyframes(items: ResolvedKeyframe[]): ResolvedKeyframe[] {
  const out: ResolvedKeyframe[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.at - item.at) < 1e-9) {
      last.values = { ...last.values, ...item.values };
      last.easing = item.easing;
    } else {
      out.push({
        at: item.at,
        easing: item.easing,
        values: { ...item.values },
      });
    }
  }
  return out;
}

function easingAt(
  sourceKeyframes: Keyframe<NumericValues>[],
  t: number,
): KeyframeEasing {
  const channel = sourceKeyframes.filter((k) => Object.keys(k.values).length > 0);
  if (channel.length === 0) return "linear";
  const i = lowerBound(channel.length, (idx) => channel[idx].at > t);
  const left = channel[Math.max(0, i - 1)] ?? channel[0];
  return left.easing ?? "linear";
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function lowerBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
