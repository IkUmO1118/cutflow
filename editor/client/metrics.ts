/**
 * プレビュー(canvas エンジン)の体感を数値化する計測ハーネス。
 * PresentationClock の累積統計を1秒ごとに引き取る観測専用モジュールで、
 * エンジン側の挙動には一切手を入れない。
 * §docs/plans/2026-07-30-preview-cut-classification-and-clock-metrics-design.md B
 *
 * 収集する3指標:
 * - シーク応答: 一時停止中のスクラブ repaint 所要 ms
 * - ドロップ: PresentationClock の droppedFrames / presentedFrames の前回比差分
 * - 再生連続性: PresentationClock の提示間隔リングバッファ(ms)
 *
 * 5秒ごと、またはページ離脱時にサーバー(POST /metrics)へ送る。
 * バッチが空(何も溜まっていない)ときは送らない。
 */
import type { PresentationStats } from "../../src/engine/runtime/clock.ts";
import { projectPath } from "./route.ts";

const FLUSH_INTERVAL_MS = 5000;
const SAMPLE_INTERVAL_MS = 1000;

/** プレビュー(canvas エンジン)の体感を数値化するための観測ソース。
 * EnginePreview がこれを実装し、ハーネスは1秒ごとに引き取るだけ
 * (エンジン側の挙動は1バイトも変えない=観測専用)。 */
export interface PreviewMetricsSource {
  /** 現在の PresentationClock の累積統計。clock 未初期化なら null */
  getPresentationStats: () => PresentationStats | null;
  /** 溜まっている scrub seek 所要 ms を渡して空にする */
  takeSeekSamples: () => number[];
}

interface Batch {
  seekMs: number[];
  droppedDelta: number;
  totalDelta: number;
  forcedResetsDelta: number;
  lastStallMs: number | null;
  /** flush 時に載せる提示間隔のスナップショット(累積しない) */
  intervalsMs: number[];
}

function emptyBatch(): Batch {
  return {
    seekMs: [],
    droppedDelta: 0,
    totalDelta: 0,
    forcedResetsDelta: 0,
    lastStallMs: null,
    intervalsMs: [],
  };
}

export interface MetricsSnapshot {
  seekMsP50: number | null;
  seekMsP95: number | null;
  frameIntervalP95: number | null;
  dropRatePct: number | null;
  /** この窓で観測した強制復帰(描画の詰まり)回数。0 が正常 */
  forcedResets: number;
  /** 直近の強制復帰までの詰まり時間(ms)。無ければ null */
  lastStallMs: number | null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** 累積カウンタのスナップショット(差分計算用) */
export interface CounterSample {
  presentedFrames: number;
  droppedFrames: number;
  forcedResets: number;
}

export interface CounterDelta {
  presented: number;
  dropped: number;
  forcedResets: number;
  /** true = 差分を取らずベースラインだけ更新した(初回、または clock 再生成) */
  baselineOnly: boolean;
}

/**
 * 前回サンプルと今回サンプルから増分を出す。PresentationClock は
 * EnginePreview の remount ごとに作り直され、そのとき累積カウンタが 0 に
 * 戻る。カウンタが減っていたら「別の clock」と判定し、負の増分を
 * 計上せずベースラインだけ張り替える(baselineOnly: true)。
 */
export function diffCounters(prev: CounterSample | null, cur: CounterSample): CounterDelta {
  if (prev === null || cur.presentedFrames < prev.presentedFrames) {
    return { presented: 0, dropped: 0, forcedResets: 0, baselineOnly: true };
  }
  return {
    presented: cur.presentedFrames - prev.presentedFrames,
    dropped: Math.max(0, cur.droppedFrames - prev.droppedFrames),
    forcedResets: Math.max(0, cur.forcedResets - prev.forcedResets),
    baselineOnly: false,
  };
}

export interface MetricsHandle {
  /** proj.dir 確定/変更時に呼ぶ(収録フォルダ名をログ行に載せるため) */
  setRecording: (name: string) => void;
  /** HUD が最新値を読むための現況スナップショット(直近フラッシュ分の集計) */
  getSnapshot: () => MetricsSnapshot;
  dispose: () => void;
}

export function startMetricsHarness(source: PreviewMetricsSource): MetricsHandle {
  let recording = "";
  let batch = emptyBatch();
  let prevSample: CounterSample | null = null;
  let lastSnapshot: MetricsSnapshot = {
    seekMsP50: null,
    seekMsP95: null,
    frameIntervalP95: null,
    dropRatePct: null,
    forcedResets: 0,
    lastStallMs: null,
  };

  const sampleTimer = setInterval(() => {
    batch.seekMs.push(...source.takeSeekSamples());
    const stats = source.getPresentationStats();
    if (!stats) return;
    const cur: CounterSample = {
      presentedFrames: stats.presentedFrames,
      droppedFrames: stats.droppedFrames,
      forcedResets: stats.forcedResets,
    };
    const delta = diffCounters(prevSample, cur);
    prevSample = cur;
    if (delta.baselineOnly) return;
    batch.droppedDelta += delta.dropped;
    batch.totalDelta += delta.presented;
    batch.forcedResetsDelta += delta.forcedResets;
    if (delta.forcedResets > 0) batch.lastStallMs = stats.lastStallMs;
    // 提示間隔は「その窓で実際に再生された」ときだけリングを写す
    // (一時停止中に前回再生の古い p95 を出さないため)
    if (delta.presented > 0) batch.intervalsMs = [...stats.intervalsMs];
  }, SAMPLE_INTERVAL_MS);

  function flush(useBeacon: boolean): void {
    if (
      batch.seekMs.length === 0 &&
      batch.intervalsMs.length === 0 &&
      batch.totalDelta === 0 &&
      batch.forcedResetsDelta === 0
    ) {
      return;
    }
    lastSnapshot = {
      seekMsP50: percentile(batch.seekMs, 50),
      seekMsP95: percentile(batch.seekMs, 95),
      frameIntervalP95: percentile(batch.intervalsMs, 95),
      dropRatePct: batch.totalDelta > 0 ? (100 * batch.droppedDelta) / batch.totalDelta : null,
      forcedResets: batch.forcedResetsDelta,
      lastStallMs: batch.lastStallMs,
    };
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      recording,
      seekMs: batch.seekMs,
      frameIntervalMs: batch.intervalsMs,
      droppedDelta: batch.droppedDelta,
      totalDelta: batch.totalDelta,
      forcedResetsDelta: batch.forcedResetsDelta,
      lastStallMs: batch.lastStallMs,
    });
    batch = emptyBatch();
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(projectPath("/metrics"), new Blob([payload], { type: "application/json" }));
      return;
    }
    fetch(projectPath("/metrics"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // 計測は観測専用なので送信失敗を UI に伝播しない(次のフラッシュで良い)
    });
  }

  const flushTimer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush(true);
  };
  const onPageHide = () => flush(true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);

  return {
    setRecording: (name: string) => {
      recording = name;
    },
    getSnapshot: () => lastSnapshot,
    dispose: () => {
      clearInterval(sampleTimer);
      clearInterval(flushTimer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}

/** URL に ?metrics=1 のときだけ呼ぶ。画面隅に現在値を出す opt-in HUD
 *  (DOM を直接操作するだけの独立要素で、既存の React ツリーには一切触れない)。
 *  返り値の関数で HUD 自体を消せる */
export function mountMetricsHud(handle: MetricsHandle): () => void {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:99999;" +
    "font:11px/1.4 monospace;color:#0f0;background:rgba(0,0,0,0.7);" +
    "padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre;";
  document.body.appendChild(el);
  const timer = setInterval(() => {
    const s = handle.getSnapshot();
    const fmt = (v: number | null, unit: string) => (v === null ? "-" : `${v.toFixed(1)}${unit}`);
    el.textContent =
      `seek p50/p95: ${fmt(s.seekMsP50, "ms")} / ${fmt(s.seekMsP95, "ms")}\n` +
      `frame Δ p95: ${fmt(s.frameIntervalP95, "ms")}\n` +
      `drop: ${fmt(s.dropRatePct, "%")}\n` +
      `stall: ${s.forcedResets} (last ${s.lastStallMs === null ? "-" : `${s.lastStallMs.toFixed(0)}ms`})`;
  }, 1000);
  return () => {
    clearInterval(timer);
    el.remove();
  };
}
