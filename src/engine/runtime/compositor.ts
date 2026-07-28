// src/engine/runtime/compositor.ts — 自前 WGSL コンポジタ(webgpuBackend.ts)を
// メインスレッドで動かすオーケストレーション層(M3a Phase3)。
// `initCompositor`/`renderFrame` は document 束縛の自前 canvas でしか
// 動作しない(Worker 不可。母艦§9「M3a Phase 3 前・構成修正」)ため、
// ここはブラウザのメインスレッドから呼ぶ前提で書く。
//
// FrameDescriptor(src/engine/descriptor.ts。CutFlow 側の抽象)→ このファイルが
// webgpuBackend.ts の CompositorFrameInput(テクスチャ付き矩形の配列)へ
// 組み立てて `renderFrame` を呼ぶ。
import {
  getCompositorCanvas,
  initCompositor,
  initializeGpu,
  renderFrame as backendRenderFrame,
  resizeCompositor,
  type CompositorFrameInput,
  type CompositorLayerInput,
} from "./webgpuBackend.ts";
import type {
  ColorFilterEffect,
  ExternalItem,
  FrameDescriptor,
  FrameItem,
  Rect,
  RenderedItem,
} from "../descriptor.ts";
import { blitVideoSample } from "./frameBlit.ts";
import type { SourcePool } from "./sourcePool.ts";
import { externalTextureId, TextureCache } from "./textureCache.ts";

export function quadToTransform(quad: Rect): CompositorLayerInput["transform"] {
  return {
    centerX: quad.x + quad.w / 2,
    centerY: quad.y + quad.h / 2,
    width: quad.w,
    height: quad.h,
  };
}

/**
 * blur 2パス合成の分割点(§2・§5落とし穴)。`describeFrame` 本体
 * (src/engine/describeFrame.ts の同名関数)は items を
 * 「base→shortPanels→inserts→blurs→layerOrderスタック(caption/素材/wipe)→
 * annotations→cutTransition」の固定順で push する(グループ=役割の順)ため、
 * blurRegion アイテムの前後で配列を割るだけで「下層(base+inserts)/上層」の
 * 役割分割になる(layerOrder の配列順そのものには依存しない。CLAUDE.md の
 * 「かかるのは下層(ベース映像+挿入)だけ」という仕様と一致)。
 * blurRegion が無ければ below=全item・above=空(呼び出し側は1パスで済ませる)。
 */
export function splitLayersForBlur(items: FrameItem[]): {
  below: FrameItem[];
  blurs: RenderedItem[];
  above: FrameItem[];
} {
  const blurIndices: number[] = [];
  items.forEach((item, i) => {
    if (item.kind === "rendered" && item.content.kind === "blurRegion") blurIndices.push(i);
  });
  if (blurIndices.length === 0) return { below: items, blurs: [], above: [] };
  const first = blurIndices[0];
  const last = blurIndices[blurIndices.length - 1];
  return {
    below: items.slice(0, first),
    blurs: blurIndices.map((i) => items[i] as RenderedItem),
    above: items.slice(last + 1),
  };
}

/** 任意の CSS 色文字列(named/hex/rgb()等)を 0..1 の RGBA へ。canvas 自身に
 * 正規化させる(refPainter.ts が `ctx.fillStyle = color` で描くのと同じ経路を
 * 通すことで、対応する色表現の解釈が両者で必ず一致する) */
export function cssColorToRgba(color: string): [number, number, number, number] {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
}

export interface RenderStats {
  elapsedMs: number;
  externalCount: number;
  renderedCount: number;
  twoPassBlur: boolean;
}

/** sourceId(publicDir 相対パス)→ そのソース自身の再生位置(秒)を返す関数。
 * base video は cutplan の keep→元収録秒写像、素材/insert は素材自身の秒。
 * 呼び出し側(engine-dev ページ)が timeline.ts の写像から組み立てる */
export type SourceTimeResolver = (item: ExternalItem) => number;

export class EngineCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly textures = new TextureCache();
  private readonly sourcePool: SourcePool;
  private readonly canvasSize?: { w: number; h: number };

  private constructor(canvas: HTMLCanvasElement, sourcePool: SourcePool, canvasSize?: { w: number; h: number }) {
    this.canvas = canvas;
    this.sourcePool = sourcePool;
    this.canvasSize = canvasSize;
  }

  /** GPU コンテキスト+コンポジタを初期化する。canvas は webgpuBackend が
   * 自前で作る(document 束縛)ものをそのまま使う=呼び出し側で作って
   * 渡さない(§5 落とし穴)。呼び出し側は返り値の `.canvas` を mount する */
  static async create(
    width: number,
    height: number,
    sourcePool: SourcePool,
    canvasSize?: { w: number; h: number },
  ): Promise<EngineCompositor> {
    await initializeGpu();
    initCompositor(width, height);
    return new EngineCompositor(getCompositorCanvas(), sourcePool, canvasSize);
  }

  resize(width: number, height: number): void {
    resizeCompositor(width, height);
  }

  private async resolveExternalLayer(item: ExternalItem, sourceTimeOf: SourceTimeResolver): Promise<CompositorLayerInput | null> {
    const source = this.sourcePool.acquire(item.sourceId);
    const sample = await source.getSampleAt(sourceTimeOf(item));
    if (!sample) return null;
    const colorFilter = item.effects?.find((e): e is ColorFilterEffect => e.kind === "colorFilter");
    const { canvas, quad } = blitVideoSample(sample, {
      placement: item.placement,
      canvasSize: this.canvasSize,
      colorFilter,
      radiusPx: item.radiusPx,
    });
    const id = externalTextureId(item.sourceId, sample.timestamp, colorFilter);
    // blit は同期処理で完結している(frameBlit.ts の契約)ので、ここで
    // 即 close してよい(§5 落とし穴。所有権: frameSource→blit→close)
    sample.close();
    this.textures.ensureRaw(id, canvas);
    return { textureId: id, transform: quadToTransform(quad), opacity: item.opacity };
  }

  private resolveRenderedLayer(item: RenderedItem, frameSize: { w: number; h: number }): CompositorLayerInput {
    const id = this.textures.ensureRendered(item, frameSize);
    return {
      textureId: id,
      transform: quadToTransform({ x: 0, y: 0, w: frameSize.w, h: frameSize.h }),
      opacity: 1,
    };
  }

  private async resolveLayers(
    items: FrameItem[],
    frameSize: { w: number; h: number },
    sourceTimeOf: SourceTimeResolver,
  ): Promise<CompositorLayerInput[]> {
    const layers: CompositorLayerInput[] = [];
    for (const item of items) {
      const layer =
        item.kind === "external"
          ? await this.resolveExternalLayer(item, sourceTimeOf)
          : this.resolveRenderedLayer(item, frameSize);
      if (layer) layers.push(layer);
    }
    return layers;
  }

  /** 下層(below)だけを描画済みの現 canvas から、blur 領域を加工した1枚の
   * スナップショットテクスチャを作る(§2 blur2パス。refPainter.ts の
   * drawBlurRegion と同じ自己参照 drawImage+filter:blur() の手法) */
  private snapshotBlurredBelow(frameSize: { w: number; h: number }, blurs: RenderedItem[]): OffscreenCanvas {
    const snap = new OffscreenCanvas(Math.max(1, frameSize.w), Math.max(1, frameSize.h));
    const ctx = snap.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(this.canvas, 0, 0, frameSize.w, frameSize.h);
    for (const item of blurs) {
      if (item.content.kind !== "blurRegion") continue;
      const { rect, radiusPx } = item.content;
      try {
        ctx.save();
        ctx.filter = `blur(${radiusPx}px)`;
        ctx.drawImage(snap, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
      } catch {
        // 環境非対応は無視(劣化。refPainter.ts drawBlurRegion と同じ扱い)
      }
    }
    return snap;
  }

  async renderDescriptor(descriptor: FrameDescriptor, sourceTimeOf: SourceTimeResolver): Promise<RenderStats> {
    const t0 = performance.now();
    const clear = cssColorToRgba(descriptor.backgroundColor);
    const { below, blurs, above } = splitLayersForBlur(descriptor.items);

    let layers: CompositorLayerInput[];
    if (blurs.length === 0) {
      layers = await this.resolveLayers(descriptor.items, descriptor.size, sourceTimeOf);
    } else {
      const belowLayers = await this.resolveLayers(below, descriptor.size, sourceTimeOf);
      backendRenderFrame({
        width: descriptor.size.w,
        height: descriptor.size.h,
        clear: { color: clear },
        items: belowLayers,
      } satisfies CompositorFrameInput);
      const snapshot = this.snapshotBlurredBelow(descriptor.size, blurs);
      // tOut ごとに id を変える(下層は毎フレーム変わるため。§2「hash一致なら
      // 再アップロード省略」の対象は rendered/external のみで、この
      // スナップショットは常に新規アップロードでよい=キャッシュ対象外)
      const snapshotId = `blur-snapshot@${descriptor.tOut.toFixed(6)}`;
      this.textures.ensureRaw(snapshotId, snapshot);
      const aboveLayers = await this.resolveLayers(above, descriptor.size, sourceTimeOf);
      layers = [
        {
          textureId: snapshotId,
          transform: quadToTransform({ x: 0, y: 0, w: descriptor.size.w, h: descriptor.size.h }),
          opacity: 1,
        },
        ...aboveLayers,
      ];
    }

    backendRenderFrame({
      width: descriptor.size.w,
      height: descriptor.size.h,
      clear: { color: clear },
      items: layers,
    } satisfies CompositorFrameInput);
    this.textures.endFrame();

    return {
      elapsedMs: performance.now() - t0,
      externalCount: descriptor.items.filter((i) => i.kind === "external").length,
      renderedCount: descriptor.items.filter((i) => i.kind === "rendered").length,
      twoPassBlur: blurs.length > 0,
    };
  }

  dispose(): void {
    this.textures.disposeAll();
  }
}
