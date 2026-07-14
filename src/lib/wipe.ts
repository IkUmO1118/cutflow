import type { Span } from "../../remotion/props.ts";

/**
 * 時刻 t(カット後の秒)における wipeFull の進行度。
 * 0 = 通常の右下ワイプ、1 = 全画面。複数区間が重なる場合は最も
 * 全画面に近い区間を採用する。
 */
export function wipeProgressAt(
  t: number,
  spans: Span[],
  defaultTransitionSec: number,
): number {
  const raw = spans.reduce((max, span) => {
    if (t < span.start || t >= span.end) return max;
    const half = (span.end - span.start) / 2;
    const inSec = Math.min(
      span.transitionInSec ?? span.transitionSec ?? defaultTransitionSec,
      half,
    );
    const outSec = Math.min(
      span.transitionOutSec ?? span.transitionSec ?? defaultTransitionSec,
      half,
    );
    const inProgress = inSec <= 0 ? 1 : (t - span.start) / inSec;
    const outProgress = outSec <= 0 ? 1 : (span.end - t) / outSec;
    return Math.max(max, Math.min(1, inProgress, outProgress));
  }, 0);
  return raw * raw * (3 - 2 * raw);
}
