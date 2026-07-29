/**
 * プレビュー(proxy.mp4)の体感を数値化する計測ハーネス。M1(オールイントラ
 * proxy)の before/after 基準値採取のための観測専用モジュールで、Player /
 * <video> の挙動には一切手を入れない(挙動を1バイトも変えない)。
 * §docs/plans/2026-07-28-engine-m1-media-metrics-design.md Phase 2
 *
 * 収集する3指標:
 * - シーク応答: 'seeking' 発火 → 'seeked' 発火までの ms
 * - ドロップ: video.getVideoPlaybackQuality() の dropped/total の前回比差分
 * - 再生連続性: requestVideoFrameCallback の mediaTime 間隔(ms)
 *
 * 5秒ごと、またはページ離脱時にサーバー(POST /metrics)へ送る。
 * バッチが空(何も溜まっていない)ときは送らない。
 */

const FLUSH_INTERVAL_MS = 5000;

// 標準 DOM 型(lib.dom.d.ts)には requestVideoFrameCallback が無いため、
// remotion/Main.tsx の VideoWithVFC と同じ流儀でローカルに型を足す
interface VideoFrameCallbackMetadata {
  mediaTime: number;
}
type VideoWithVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
};

interface Batch {
  seekMs: number[];
  frameIntervalMs: number[];
  droppedDelta: number;
  totalDelta: number;
}

function emptyBatch(): Batch {
  return { seekMs: [], frameIntervalMs: [], droppedDelta: 0, totalDelta: 0 };
}

export interface MetricsSnapshot {
  seekMsP50: number | null;
  seekMsP95: number | null;
  frameIntervalP95: number | null;
  dropRatePct: number | null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface MetricsHandle {
  /** proj.dir 確定/変更時に呼ぶ(収録フォルダ名をログ行に載せるため) */
  setRecording: (name: string) => void;
  /** HUD が最新値を読むための現況スナップショット(直近フラッシュ分の集計) */
  getSnapshot: () => MetricsSnapshot;
  dispose: () => void;
}

/**
 * root 配下の <video> を MutationObserver で監視し、見つけ次第計測を
 * 仕込む(Player は videoVersion の変化で <video> ごと remount するため、
 * 動的検出が必須)。既に計測済みの要素は WeakSet で除外する。
 */
export function startMetricsHarness(root: HTMLElement): MetricsHandle {
  let recording = "";
  let batch = emptyBatch();
  let lastSnapshot: MetricsSnapshot = {
    seekMsP50: null,
    seekMsP95: null,
    frameIntervalP95: null,
    dropRatePct: null,
  };
  const instrumented = new WeakSet<HTMLVideoElement>();
  const seekStartedAt = new WeakMap<HTMLVideoElement, number>();
  const lastQuality = new WeakMap<HTMLVideoElement, { dropped: number; total: number }>();
  const rvfcCancel = new WeakMap<HTMLVideoElement, () => void>();

  function instrument(video: HTMLVideoElement): void {
    if (instrumented.has(video)) return;
    instrumented.add(video);

    video.addEventListener("seeking", () => {
      seekStartedAt.set(video, performance.now());
    });
    video.addEventListener("seeked", () => {
      const startedAt = seekStartedAt.get(video);
      if (startedAt === undefined) return;
      seekStartedAt.delete(video);
      batch.seekMs.push(performance.now() - startedAt);
    });

    // getVideoPlaybackQuality は再生セッション単位ではなく <video> 生存期間の
    // 累積値なので、毎回前回値との差分だけを集計に足す(要素が消えれば
    // WeakMap ごと自然に消える=セッション境界のリセットになる)
    const qualityTimer = setInterval(() => {
      if (typeof video.getVideoPlaybackQuality !== "function") return;
      const q = video.getVideoPlaybackQuality();
      const prev = lastQuality.get(video) ?? { dropped: 0, total: 0 };
      const droppedDelta = Math.max(0, q.droppedVideoFrames - prev.dropped);
      const totalDelta = Math.max(0, q.totalVideoFrames - prev.total);
      batch.droppedDelta += droppedDelta;
      batch.totalDelta += totalDelta;
      lastQuality.set(video, { dropped: q.droppedVideoFrames, total: q.totalVideoFrames });
    }, 1000);

    // requestVideoFrameCallback の mediaTime 間隔(再生連続性)。
    // 未対応ブラウザ(既定 Chromium 系のみ実装)では黙ってスキップする
    const vfcVideo = video as VideoWithVFC;
    if (typeof vfcVideo.requestVideoFrameCallback === "function") {
      let lastMediaTime: number | null = null;
      let cancelled = false;
      const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (cancelled) return;
        if (lastMediaTime !== null && !video.paused) {
          const deltaMs = (metadata.mediaTime - lastMediaTime) * 1000;
          if (deltaMs > 0) batch.frameIntervalMs.push(deltaMs);
        }
        lastMediaTime = metadata.mediaTime;
        vfcVideo.requestVideoFrameCallback?.(onFrame);
      };
      vfcVideo.requestVideoFrameCallback(onFrame);
      rvfcCancel.set(video, () => {
        cancelled = true;
      });
    }

    video.addEventListener(
      "emptied",
      () => {
        clearInterval(qualityTimer);
        rvfcCancel.get(video)?.();
      },
      { once: true },
    );
  }

  function scan(): void {
    root.querySelectorAll("video").forEach((el) => instrument(el as HTMLVideoElement));
  }

  scan();
  const observer = new MutationObserver(() => scan());
  observer.observe(root, { childList: true, subtree: true });

  function flush(useBeacon: boolean): void {
    if (
      batch.seekMs.length === 0 &&
      batch.frameIntervalMs.length === 0 &&
      batch.droppedDelta === 0 &&
      batch.totalDelta === 0
    ) {
      return;
    }
    lastSnapshot = {
      seekMsP50: percentile(batch.seekMs, 50),
      seekMsP95: percentile(batch.seekMs, 95),
      frameIntervalP95: percentile(batch.frameIntervalMs, 95),
      dropRatePct: batch.totalDelta > 0 ? (100 * batch.droppedDelta) / batch.totalDelta : null,
    };
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      recording,
      seekMs: batch.seekMs,
      frameIntervalMs: batch.frameIntervalMs,
      droppedDelta: batch.droppedDelta,
      totalDelta: batch.totalDelta,
    });
    batch = emptyBatch();
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon("/metrics", new Blob([payload], { type: "application/json" }));
      return;
    }
    fetch("/metrics", {
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
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", () => flush(true));

  return {
    setRecording: (name: string) => {
      recording = name;
    },
    getSnapshot: () => lastSnapshot,
    dispose: () => {
      observer.disconnect();
      clearInterval(flushTimer);
      document.removeEventListener("visibilitychange", onHidden);
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
      `drop: ${fmt(s.dropRatePct, "%")}`;
  }, 1000);
  return () => {
    clearInterval(timer);
    el.remove();
  };
}
