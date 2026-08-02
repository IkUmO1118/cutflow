// 出力キャンバス(サイズ+ベース映像のパネル配置+字幕既定)の組み込み定数。
// config.yaml には追加しない(D1: プリセットは閉じた組み込み。設定爆発の回避)。
import type { Manifest, Region } from "../types.ts";

/** レイアウトを構成する1パネル(ベース映像の一部)。座標系は overlays の
 * rect と同じ出力px+Region+fit */
export interface BasePanel {
  source: "screen" | "camera";
  /** 出力px。省略時は全画面 */
  rect?: Region;
  fit: "contain" | "cover";
}

export interface Profile {
  width: number;
  height: number;
  /** ベース映像の配置。省略時は横 default のワイプ経路
   * (screen 全面 + camera 右下ワイプ) */
  layout?: {
    panels: BasePanel[];
    /** 位置指定の無いテロップの既定位置と大きさ倍率 */
    caption?: { x: number; y: number; anchor?: "center" | "topLeft"; fontScale?: number };
  };
}

export const CANVAS_PRESETS: Record<string, Profile> = {
  landscape: { width: 1920, height: 1080 }, // 寸法は resolveCanvas が screenRegion で上書き
  portrait: {
    width: 1080,
    height: 1920,
    layout: {
      panels: [
        { source: "camera", rect: { x: 0, y: 0, w: 1080, h: 607 }, fit: "cover" },
        { source: "screen", rect: { x: 0, y: 607, w: 1080, h: 607 }, fit: "cover" },
      ], // y=1214..1920(約706px)はテロップ/タイトル帯(背景黒)
      caption: { x: 540, y: 1560, anchor: "center", fontScale: 1.6 },
    },
  },
  "portrait-cover": {
    width: 1080,
    height: 1920,
    layout: {
      panels: [{ source: "camera", rect: { x: 0, y: 0, w: 1080, h: 1920 }, fit: "cover" }],
      caption: { x: 540, y: 1500, anchor: "center", fontScale: 1.6 },
    },
  },
  "portrait-screen": {
    width: 1080,
    height: 1920,
    layout: {
      // screen を上3/4(0..1440)へ contain。16:9 は 1080x608 のフル幅帯として
      // その枠の縦中央(約 y=416..1024)にレターボックスされ、左右も上下も
      // 決して切れない(contain)。縦・スクエア収録はこの枠をより広く使う。
      // 下1/4(1440..1920, 480px)はテロップ/タイトル帯(背景黒)
      panels: [{ source: "screen", rect: { x: 0, y: 0, w: 1080, h: 1440 }, fit: "contain" }],
      caption: { x: 540, y: 1680, anchor: "center", fontScale: 1.6 },
    },
  },
  square: {
    width: 1080,
    height: 1080,
    layout: {
      panels: [{ source: "screen", rect: { x: 0, y: 0, w: 1080, h: 864 }, fit: "contain" }],
      caption: { x: 540, y: 972, anchor: "center", fontScale: 1.3 },
    },
  },
  "portrait-4x5": {
    width: 1080,
    height: 1350,
    layout: {
      panels: [{ source: "screen", rect: { x: 0, y: 0, w: 1080, h: 1080 }, fit: "contain" }],
      caption: { x: 540, y: 1215, anchor: "center", fontScale: 1.4 },
    },
  },
};

export const isCanvasPreset = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(CANVAS_PRESETS, name);

/**
 * プロジェクトのキャンバスを解決する唯一の関数。canvas 省略/
 * landscape は screenRegion の寸法(layout 無し=従来のワイプ経路)。
 * その他は固定サイズとパネル配置を返し、未知名は throw する。
 */
export function resolveCanvas(manifest: Manifest): Profile {
  const key = manifest.canvas ?? "landscape";
  if (key === "landscape") {
    return { width: manifest.video.screenRegion.w, height: manifest.video.screenRegion.h };
  }
  if (!isCanvasPreset(key)) throw new Error(`未知の canvas 名です: ${key}`);
  const profile = CANVAS_PRESETS[key];
  return profile;
}

export function outputSize(manifest: Manifest): { w: number; h: number } {
  const canvas = resolveCanvas(manifest);
  return { w: canvas.width, h: canvas.height };
}

/** screen ソースがキャンバス上で占める実ピクセル矩形。contain/cover の
 * レターボックス/クロップ分も含む。screen の無い preset は undefined。 */
export function screenContentRect(manifest: Manifest): Region | undefined {
  const canvas = resolveCanvas(manifest);
  const panel = canvas.layout?.panels.find((p) => p.source === "screen");
  if (canvas.layout && !panel) return undefined;
  const target = panel?.rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const source = manifest.video.screenRegion;
  const fit = panel?.fit ?? "contain";
  const scale = fit === "cover"
    ? Math.max(target.w / source.w, target.h / source.h)
    : Math.min(target.w / source.w, target.h / source.h);
  const w = source.w * scale;
  const h = source.h * scale;
  return { x: target.x + (target.w - w) / 2, y: target.y + (target.h - h) / 2, w, h };
}
