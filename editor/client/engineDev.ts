// editor/client/engineDev.ts — M3a Phase5 開発ページのエントリ(素のページ。
// React 不使用。GET /engine-dev から配信される。リンクは張らない開発専用)。
//
// buildRenderProps(既存の解決層。editor/client/App.tsx が Player 用に
// 呼ぶのと同じ関数)→ describeFrame(純関数。src/engine/)→
// EngineCompositor(webgpuBackend。src/engine/runtime/)の経路で
// 実際に収録を再生する。
import { buildRenderProps } from "../../src/lib/renderProps.ts";
import { buildTimeline } from "../../src/lib/timeline.ts";
import { describeFrame } from "../../src/engine/describeFrame.ts";
import type { ExternalItem } from "../../src/engine/descriptor.ts";
import { EngineCompositor } from "../../src/engine/runtime/compositor.ts";
import { SourcePool } from "../../src/engine/runtime/sourcePool.ts";
import { PresentationClock } from "../../src/engine/runtime/clock.ts";
import { AudioScheduler } from "../../src/engine/runtime/audioScheduler.ts";
import type { CutPlan, Manifest, Overlays, Transcript, Bgm } from "../../src/types.ts";
import type { Config } from "../../src/lib/config.ts";

interface ProjectData {
  manifest: Manifest;
  transcript: Transcript;
  cutplan: CutPlan;
  overlays: Overlays;
  dirFiles: string[];
  bgm: Bgm | null;
  bgmFile: string | null;
  silences: { start: number; end: number }[] | null;
  renderCfg: Config["render"];
  output: { w: number; h: number };
}

const VIDEO_FILE = "media/proxy.mp4";

/** sourceId → editor サーバの配信 URL。videoFile("media/proxy.mp4")は
 * それ自体が既に /media/ ルーティングの URL セグメントなのでそのまま使う。
 * それ以外(materials/… 等の overlays/inserts/bgm/design 背景の生パス)は
 * editor/client/App.tsx と同じ変換(「素材はローカルサーバーの /media/
 * 経由で配信される」)で /media/ を足す */
function resolveUrl(sourceId: string): string {
  return sourceId === VIDEO_FILE ? `/${sourceId}` : `/media/${sourceId}`;
}

function sourceTimeOf(item: ExternalItem): number {
  return item.sourceTimeSec;
}

async function main(): Promise<void> {
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const hudEl = document.getElementById("hud") as HTMLPreElement;
  const canvasHost = document.getElementById("canvas-host") as HTMLDivElement;
  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const seekBar = document.getElementById("seek") as HTMLInputElement;

  statusEl.textContent = "プロジェクトを取得中…";
  const res = await fetch("/api/project");
  if (!res.ok) throw new Error(`/api/project failed: ${res.status}`);
  const proj = (await res.json()) as ProjectData;

  const keeps = proj.cutplan.segments.filter((s) => s.action === "keep");
  const timeline = buildTimeline(keeps);
  const durationSec = timeline.length > 0 ? timeline[timeline.length - 1].outputEnd : 0;

  const props = buildRenderProps({
    manifest: proj.manifest,
    keeps,
    transcript: proj.transcript,
    overlays: proj.overlays,
    renderCfg: proj.renderCfg,
    width: proj.output.w,
    height: proj.output.h,
    videoFile: VIDEO_FILE,
    videoIsSource: true,
    bgm: proj.bgm,
    bgmFallbackFile: proj.bgmFile,
    silences: proj.silences,
    overlayExists: (f) => proj.dirFiles.includes(f),
    warn: (m) => console.warn("[engine-dev]", m),
  });

  statusEl.textContent = "GPU 初期化中…";
  const sourcePool = new SourcePool(resolveUrl);
  const compositor = await EngineCompositor.create(props.width, props.height, sourcePool, props.canvas);
  canvasHost.appendChild(compositor.canvas);
  compositor.canvas.style.width = "100%";
  compositor.canvas.style.height = "auto";

  const audioContext = new AudioContext();
  const audioScheduler = new AudioScheduler({
    audioContext,
    baseAudioUrl: resolveUrl(VIDEO_FILE),
    timeline,
    bgm: props.bgm,
    fps: props.fps,
  });

  let lastStats = { elapsedMs: 0, externalCount: 0, renderedCount: 0, twoPassBlur: false };
  const clock = new PresentationClock(audioContext, async (sec) => {
    const descriptor = describeFrame(props, Math.min(sec, durationSec));
    lastStats = await compositor.renderDescriptor(descriptor, sourceTimeOf);
    seekBar.value = String(Math.min(sec, durationSec));
  });

  seekBar.min = "0";
  seekBar.max = String(durationSec);
  seekBar.step = "0.01";

  let playing = false;
  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "pause" : "play";
    if (playing) {
      void audioContext.resume();
      clock.play();
      audioScheduler.start(clock.getMapping(), resolveUrl);
    } else {
      clock.pause();
      audioScheduler.stop();
    }
  });

  seekBar.addEventListener("input", () => {
    const sec = Number(seekBar.value);
    clock.seek(sec);
    if (playing) audioScheduler.start(clock.getMapping(), resolveUrl);
    void (async () => {
      const descriptor = describeFrame(props, sec);
      lastStats = await compositor.renderDescriptor(descriptor, sourceTimeOf);
    })();
  });

  statusEl.textContent = `準備完了(尺 ${durationSec.toFixed(1)}s)`;

  // 最初の1枚を描く(再生を待たずに絵が出ている状態にする)
  const first = describeFrame(props, 0);
  lastStats = await compositor.renderDescriptor(first, sourceTimeOf);

  setInterval(() => {
    const intervals = clock.stats.intervalsMs;
    const sorted = [...intervals].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    hudEl.textContent = JSON.stringify(
      {
        currentSec: clock.currentOutputSec().toFixed(2),
        presented: clock.stats.presentedFrames,
        dropped: clock.stats.droppedFrames,
        intervalP50Ms: p50.toFixed(2),
        intervalP95Ms: p95.toFixed(2),
        lastRender: lastStats,
      },
      null,
      2,
    );
  }, 500);

  // headless 計測スクリプト(scripts/engine-bench.mjs)からの参照点
  (window as unknown as { __engineDev: unknown }).__engineDev = {
    clock,
    compositor,
    audioScheduler,
    sourcePool,
    props,
    durationSec,
    seekTo: (sec: number) => {
      clock.seek(sec);
      return (async () => {
        const descriptor = describeFrame(props, sec);
        lastStats = await compositor.renderDescriptor(descriptor, sourceTimeOf);
        return lastStats;
      })();
    },
    play: () => playBtn.click(),
    pause: () => {
      if (playing) playBtn.click();
    },
  };
}

main().catch((err) => {
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = `エラー: ${String((err as Error)?.stack ?? err)}`;
  console.error(err);
});
