import { lowerBound } from "./timeline.ts";
import type { Span } from "../../remotion/props.ts";

/**
 * BGM の発話ダッキング係数(1=通常音量、duckGain=下げ切り)を、指定秒 sec で
 * 求める。spans は renderProps.ts の buildDuck が mergeClose(…, fadeSec*2) で
 * 作るため「ソート済み・非重複・隙間 > fadeSec×2」が保証されており、
 * フェード窓([start-fadeSec, end+fadeSec))を含めても該当する span は
 * 高々1件(前後の span の窓が重ならないため)。この前提のもとで
 * lowerBound(lib/timeline.ts と同じ二分探索)を使い、Main.tsx の BgmTrack が
 * 毎フレーム duck.spans 全件を線形走査していたのを O(log n) に落とす。
 */
export function duckFactorAt(
  spans: Span[],
  sec: number,
  fadeSec: number,
  duckGain: number,
): number {
  // 窓の終端(end + fadeSec)が sec を越える最初の span。それより前の
  // span は「隙間 > fadeSec×2」の前提により窓が sec の手前で閉じている
  const i = lowerBound(spans.length, (j) => spans[j].end + fadeSec > sec);
  const s = spans[i];
  if (!s || sec < s.start - fadeSec) return 1;
  if (sec >= s.start && sec < s.end) return duckGain;
  if (sec < s.start) {
    return 1 - ((sec - (s.start - fadeSec)) / fadeSec) * (1 - duckGain);
  }
  return duckGain + ((sec - s.end) / fadeSec) * (1 - duckGain);
}
