// src/engine/runtime/textureCache.ts — webgpuBackend.ts への GPU テクスチャ
// アップロード+キャッシュ(M3a Phase3)。2種の外部テクスチャIDキーで
// contentHash/座標が変わらない限り再アップロードを省く(母艦§9「M3a方針確定」):
//   - external: 「sourceId + サンプル timestamp + colorFilter 値 + そのテクスチャの
//     画(え)を決める全入力(sourceRect・quadの寸法・radiusPx。R4 Phase2)」
//   - rendered: contentHash そのもの
// blur 2パスの中間テクスチャ(下層スナップショット)は `ensureRaw` で
// 同じキャッシュ機構に相乗りさせる。
//
// R4 §1.1: 同じ sourceId + 同じ timestamp を異なる crop(sourceRect)で
// 複数箇所に置く(obs-canvas の画面パネル+カメラワイプ等)場合、旧IDは
// crop を無視していたため両者が完全一致し、後から解決される側が
// 「アップロード済み」と誤判定されて前者のテクスチャを流用していた。
// キーに sourceRect/quad寸法/radiusPx を含めることで、画(え)が変われば
// 必ず ID も変わることを保証する(ensureRaw の「同じIDなら再アップロード
// しない」という意味論はそのまま=IDを正しくする側で直す。§落とし穴)。
//
// ブラウザ専用(webgpuBackend・OffscreenCanvas 前提)。
import { releaseTexture, uploadTexture } from "./webgpuBackend.ts";
import { drawRendered } from "../refPainter.ts";
import type { ColorFilterEffect, Rect, RenderedItem } from "../descriptor.ts";

/** そのテクスチャの画(え)を決める全入力(§2 決定2)。sourceRect は
 * "fit" 配置(素材/画像)では呼び出し側(compositor.ts)が blitVideoSample の
 * 戻り値から渡す(実デコード解像度判明後にしか分からないため)。
 * 呼び出し不要な引数はここでは持たず、呼び出し側で組み立てる */
export function externalTextureId(
  sourceId: string,
  sampleTimestamp: number,
  colorFilter: ColorFilterEffect | undefined,
  sourceRect: Rect,
  quadSize: { w: number; h: number },
  radiusPx: number | undefined,
): string {
  const cf = colorFilter
    ? `${colorFilter.brightness}:${colorFilter.contrast}:${colorFilter.saturate}`
    : "none";
  const r = (n: number): string => n.toFixed(2);
  const crop = `${r(sourceRect.x)},${r(sourceRect.y)},${r(sourceRect.w)},${r(sourceRect.h)}`;
  const quad = `${r(quadSize.w)}x${r(quadSize.h)}`;
  const radius = radiusPx ? r(radiusPx) : "0";
  // timestamp は秒(mediabunny)。マイクロ秒精度で丸めてキーの揺れを防ぐ
  return `ext:${sourceId}@${sampleTimestamp.toFixed(6)}:${cf}:crop=${crop}:quad=${quad}:r=${radius}`;
}

export function renderedTextureId(item: RenderedItem): string {
  return `rnd:${item.contentHash}`;
}

export class TextureCache {
  private readonly uploaded = new Set<string>();
  private usedThisFrame = new Set<string>();

  private markUsed(id: string): void {
    this.usedThisFrame.add(id);
  }

  /** rendered item を(未アップロードなら)フルフレームサイズでラスタライズ
   * してアップロードする。同じ contentHash が既にアップロード済みなら
   * ラスタライズ自体をスキップする(§2 不変条件) */
  ensureRendered(item: RenderedItem, frameSize: { w: number; h: number }): string {
    const id = renderedTextureId(item);
    this.markUsed(id);
    if (!this.uploaded.has(id)) {
      const canvas = new OffscreenCanvas(Math.max(1, frameSize.w), Math.max(1, frameSize.h));
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error("textureCache: OffscreenCanvas 2d context を取得できません");
      // OffscreenCanvasRenderingContext2D は CanvasRenderingContext2D の
      // 使用箇所(fillStyle/font/measureText/drawImage等)をすべて満たすが、
      // TS の DOM lib 上は別の名目型(drawFocusIfNeeded 等の非使用メソッド差)
      // のため cast する(refPainter.ts 側のシグネチャは変更しない)
      drawRendered(ctx as unknown as CanvasRenderingContext2D, item);
      uploadTexture({ id, source: canvas, width: canvas.width, height: canvas.height });
      this.uploaded.add(id);
    }
    return id;
  }

  /** 呼び出し側(compositor.ts)が frameBlit で作った OffscreenCanvas を
   * 指定 id でアップロードする(external item・blur 中間テクスチャ共用)。
   * 同じ id が既にアップロード済みならスキップする */
  ensureRaw(id: string, canvas: OffscreenCanvas): string {
    this.markUsed(id);
    if (!this.uploaded.has(id)) {
      uploadTexture({ id, source: canvas, width: canvas.width, height: canvas.height });
      this.uploaded.add(id);
    }
    return id;
  }

  /** このフレームで使われなかったテクスチャを解放する。毎フレーム終わりに呼ぶ */
  endFrame(): void {
    for (const id of this.uploaded) {
      if (!this.usedThisFrame.has(id)) {
        releaseTexture(id);
        this.uploaded.delete(id);
      }
    }
    this.usedThisFrame = new Set();
  }

  get uploadedCount(): number {
    return this.uploaded.size;
  }

  disposeAll(): void {
    for (const id of this.uploaded) releaseTexture(id);
    this.uploaded.clear();
    this.usedThisFrame.clear();
  }
}
