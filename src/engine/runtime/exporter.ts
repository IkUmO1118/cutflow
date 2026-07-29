// src/engine/runtime/exporter.ts — M4 Phase1: 書き出し用ブラウザ側エントリ。
// headless Chrome 内で動作し、CLI(renderEngine.ts)が CDP 経由で駆動する。
//
// Window に事前注入されたシリアライズ済み RenderProps を読み取り、
// SourcePool + EngineCompositor を初期化して per-frame レンダーを提供する。
// 描画結果は CDP Page.captureScreenshot で CLI 側が取得する
// (headless Chrome の WebGPU canvas 読戻し制限への workaround: webgpuBackend.ts:157-167)。
//
// PresentationClock / AudioScheduler は使わない(ステップ駆動)。
// 音声は ffmpeg 音声ベッドで別途処理する。
import { describeFrame } from "../describeFrame.ts";
import type { ExternalItem, FrameDescriptor } from "../descriptor.ts";
import { EngineCompositor } from "./compositor.ts";
import { SourcePool } from "./sourcePool.ts";
import type { RenderProps } from "../../lib/renderPropsTypes.ts";

declare global {
  interface Window {
    __EXPORT_CONFIG__: ExportConfig;
    __framewrightExporter: FrameWrightExporter;
  }
}

export interface ExportConfig {
  props: RenderProps;
  durationSec: number;
  videoFile: string;
  sourceUrls: Record<string, string>;
}

interface FrameWrightExporter {
  readonly durationSec: number;
  init(): Promise<void>;
  renderFrame(tOut: number): Promise<FrameEntry>;
  getCanvasRect(): CanvasRect;
  dispose(): void;
}

interface FrameEntry {
  tOut: number;
  stats: { elapsedMs: number; decodeMs: number; blitMs: number };
  descriptorInfo: { itemCount: number; externalCount: number; renderedCount: number };
}

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sourceTimeOf(item: ExternalItem): number {
  return item.sourceTimeSec;
}

let compositor: EngineCompositor | null = null;
let sourcePool: SourcePool | null = null;
let props: RenderProps | null = null;
let durSec = 0;
let ready = false;

async function init(): Promise<void> {
  if (ready) return;
  const cfg = window.__EXPORT_CONFIG__;
  props = cfg.props;
  durSec = cfg.durationSec;

  const statusEl = document.getElementById("export-status") as HTMLDivElement;
  statusEl.textContent = "フォント読込中…";
  try {
    await document.fonts.load('400 24px "Noto Sans JP"');
    await document.fonts.ready;
    statusEl.textContent = "GPU 初期化中…";
    sourcePool = new SourcePool((id) => cfg.sourceUrls[id] ?? id);
    compositor = await EngineCompositor.create(
      props.width,
      props.height,
      sourcePool,
      props.canvas,
    );
    const host = document.getElementById("canvas-host") as HTMLDivElement;
    host.innerHTML = "";
    host.appendChild(compositor.canvas);
  } catch (e) {
    statusEl.style.display = "";
    statusEl.textContent = `GPU init failed: ${String(e)}`;
    throw e;
  }
  ready = true;
  statusEl.style.display = "none";
}

async function renderFrame(tOut: number): Promise<FrameEntry> {
  if (!compositor || !props) throw new Error("init() を先に呼んでください");
  const descriptor = describeFrame(props, Math.min(tOut, durSec));
  const stats = await compositor.renderDescriptor(descriptor, sourceTimeOf);
  return {
    tOut,
    stats: { elapsedMs: stats.elapsedMs, decodeMs: stats.decodeMs, blitMs: stats.blitMs },
    descriptorInfo: {
      itemCount: descriptor.items.length,
      externalCount: descriptor.items.filter((i) => i.kind === "external").length,
      renderedCount: descriptor.items.filter((i) => i.kind === "rendered").length,
    },
  };
}

function getCanvasRect(): CanvasRect {
  if (!compositor) throw new Error("init() を先に呼んでください");
  const rect = compositor.canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function dispose(): void {
  if (compositor) compositor.dispose();
  compositor = null;
  sourcePool = null;
  props = null;
  ready = false;
}

Object.defineProperties(window, {
  __framewrightExporter: {
    value: Object.freeze({
      get durationSec() { return durSec; },
      init,
      renderFrame,
      getCanvasRect,
      dispose,
    }),
    writable: false,
    configurable: false,
  },
});
