// lib/duck.ts — BGM 発話ダッキング係数の二分探索実装(remotion/Main.tsx の
// BgmTrack が毎フレーム呼ぶ)を、旧実装(duck.spans 全件の線形走査)との
// 完全一致で固定する。前提: spans はソート済み・非重複・隙間 > fadeSec×2
// (renderProps.ts の buildDuck が mergeClose(…, fadeSec*2) で保証する)。
// この前提が崩れると二分探索は旧実装と食い違いうる(下の専用テストで明記)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { duckFactorAt } from "../src/lib/duck.ts";
import type { Span } from "../remotion/props.ts";

/** 旧実装(Main.tsx にあった線形走査。移植前の挙動をそのまま複製) */
function duckFactorAtLinear(
  spans: Span[],
  sec: number,
  fade: number,
  duckGain: number,
): number {
  let g = 1;
  for (const s of spans) {
    let v = 1;
    if (sec >= s.start && sec < s.end) v = duckGain;
    else if (sec >= s.start - fade && sec < s.start)
      v = 1 - ((sec - (s.start - fade)) / fade) * (1 - duckGain);
    else if (sec >= s.end && sec < s.end + fade)
      v = duckGain + ((sec - s.end) / fade) * (1 - duckGain);
    if (v < g) g = v;
  }
  return g;
}

/** buildDuck の保証(隙間 > fadeSec×2)を満たすランダムな spans を生成する */
function randomCleanSpans(rng: () => number, fadeSec: number): Span[] {
  const n = Math.floor(rng() * 8); // 0〜7件
  const spans: Span[] = [];
  let cursor = rng() * 5;
  for (let i = 0; i < n; i++) {
    const start = cursor;
    const end = start + 0.2 + rng() * 5;
    spans.push({ start, end });
    // 次の span までの隙間を fadeSec*2 より確実に大きく取る
    cursor = end + fadeSec * 2 + 0.01 + rng() * 5;
  }
  return spans;
}

// 決定的な擬似乱数(テストの再現性のため Math.random は使わない)
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("duckFactorAt: 旧線形実装と完全一致(乱数1,000ケース。spans 0〜7件)", () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const fadeSec = 0.1 + rng() * 2;
    const duckGain = 0.1 + rng() * 0.8;
    const spans = randomCleanSpans(rng, fadeSec);
    const maxT = spans.length > 0 ? spans[spans.length - 1].end + fadeSec * 3 : 10;
    const sec = rng() * (maxT + 5);
    const fast = duckFactorAt(spans, sec, fadeSec, duckGain);
    const slow = duckFactorAtLinear(spans, sec, fadeSec, duckGain);
    assert.ok(
      Math.abs(fast - slow) < 1e-9,
      `sec=${sec} fadeSec=${fadeSec} spans=${JSON.stringify(spans)}: ${fast} !== ${slow}`,
    );
  }
});

test("duckFactorAt: spans 0件は常に1(ダッキングなし)", () => {
  assert.equal(duckFactorAt([], 5, 0.5, 0.3), 1);
});

test("duckFactorAt: spans 1件、区間内は duckGain 固定", () => {
  const spans: Span[] = [{ start: 2, end: 4 }];
  assert.equal(duckFactorAt(spans, 2, 0.5, 0.3), 0.3);
  assert.equal(duckFactorAt(spans, 3, 0.5, 0.3), 0.3);
  // end ちょうどはダッキング区間からは排他だが、フェードアウト窓
  // [end, end+fade) の開始点に一致するので duckGain のまま(復帰は end 超過後)
  assert.equal(duckFactorAt(spans, 4, 0.5, 0.3), 0.3);
});

test("duckFactorAt: フェード窓の端(境界)は旧実装と同じ半開区間で切り替わる", () => {
  const spans: Span[] = [{ start: 2, end: 4 }];
  const fade = 0.5;
  const duckGain = 0.3;
  // フェードイン窓の開始(含む)・区間開始の直前(含まない側との境界)
  for (const sec of [
    2 - fade, // フェードイン窓の開始(含む)
    2 - fade - 0.001, // フェードイン窓の外(通常音量)
    2 - 0.001, // フェードイン窓の終端直前(区間開始の直前)
    4, // 区間終了(排他。フェードアウト開始点)
    4 + fade - 0.001, // フェードアウト窓の終端直前
    4 + fade, // フェードアウト窓の外(通常音量に復帰)
  ]) {
    assert.equal(
      duckFactorAt(spans, sec, fade, duckGain),
      duckFactorAtLinear(spans, sec, fade, duckGain),
      `sec=${sec}`,
    );
  }
});

test("duckFactorAt: 隙間が fadeSec×2 ちょうど(前提の境界)でも隣接 span の窓とは重ならない", () => {
  const fade = 0.4;
  // 隙間 = fadeSec*2 ちょうど: 前提は「> fadeSec×2」だが、境界ちょうどでも
  // 窓は [end, end+fade) と [start-fade, start) で半開区間どうし接するだけ
  // (重ならない)なので二分探索は破綻しない
  const spans: Span[] = [{ start: 0, end: 2 }, { start: 2 + fade * 2, end: 5 }];
  for (let sec = -1; sec < 6; sec += 0.05) {
    assert.equal(
      duckFactorAt(spans, sec, fade, 0.25),
      duckFactorAtLinear(spans, sec, fade, 0.25),
      `sec=${sec}`,
    );
  }
});
