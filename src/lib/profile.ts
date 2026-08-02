// 出力キャンバス(サイズ)とベース映像の置き方の組み込み定数。
// config.yaml には追加しない(D1: プリセットは閉じた組み込み。設定爆発の回避)。
import { hasCamera, type Manifest, type Region } from "../types.ts";

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

export interface CanvasSize {
  /** 固定寸法。省略時は screenRegion の寸法を使う(landscape だけ) */
  width?: number;
  height?: number;
  /** UI に出す用途名 */
  label: string;
  /** アスペクト比の表示文字列(例 "16:9")。UI がタイルの形と見出しに使う。
   *  landscape は寸法を持たない(収録のまま)ので、ここが唯一の比の出所 */
  aspect: string;
}

export interface BaseLayoutPreset {
  label: string;
}

export type BaseLayoutKind = "screen" | "camera" | "stack";
export type BaseLayoutName = "auto" | BaseLayoutKind;

export const CANVAS_SIZES: Record<string, CanvasSize> = {
  landscape: { label: "YouTube 動画(収録のまま)", aspect: "16:9" },
  "landscape-hd": { width: 1920, height: 1080, label: "YouTube 動画(1080p)", aspect: "16:9" },
  "landscape-4k": { width: 3840, height: 2160, label: "YouTube 動画(4K)", aspect: "16:9" },
  portrait: { width: 1080, height: 1920, label: "ショート(Shorts/Reels/TikTok)", aspect: "9:16" },
  "portrait-4k": { width: 2160, height: 3840, label: "ショート(4K)", aspect: "9:16" },
  square: { width: 1080, height: 1080, label: "Instagram フィード", aspect: "1:1" },
  "portrait-4x5": { width: 1080, height: 1350, label: "Instagram 縦", aspect: "4:5" },
  cinema: { width: 2560, height: 1080, label: "シネマ", aspect: "21:9" },
  classic: { width: 1440, height: 1080, label: "4:3", aspect: "4:3" },
};

export const BASE_LAYOUTS: Record<BaseLayoutName, BaseLayoutPreset> = {
  auto: { label: "自動" },
  screen: { label: "画面のみ" },
  camera: { label: "カメラのみ" },
  stack: { label: "カメラ+画面(上下)" },
};

const LEGACY_CANVAS_ALIASES: Record<string, { canvas: string; baseLayout?: BaseLayoutName }> = {
  landscape: { canvas: "landscape" },
  portrait: { canvas: "portrait" },
  "portrait-cover": { canvas: "portrait", baseLayout: "camera" },
  "portrait-screen": { canvas: "portrait", baseLayout: "screen" },
  square: { canvas: "square" },
  "portrait-4x5": { canvas: "portrait-4x5" },
};

const LAYOUT_FONT_SCALE: Record<BaseLayoutKind, number> = { screen: 1.6, camera: 1.6, stack: 1.6 };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function captionBand(size: { width: number; height: number }): number {
  return Math.round(clamp(0.40 * size.width, 0.15 * size.height, 0.30 * size.height));
}

/** キャンバス寸法 + レイアウト種別から Profile.layout を組み立てる単一の出所。 */
export function buildLayout(
  kind: BaseLayoutKind,
  size: { width: number; height: number },
): NonNullable<Profile["layout"]> {
  const band = captionBand(size);
  const caption = {
    x: size.width / 2,
    y: size.height - band / 2,
    anchor: "center" as const,
    fontScale: LAYOUT_FONT_SCALE[kind] * (size.width / 1080),
  };
  if (kind === "screen") {
    return {
      panels: [{ source: "screen", rect: { x: 0, y: 0, w: size.width, h: size.height - band }, fit: "contain" }],
      caption,
    };
  }
  if (kind === "camera") {
    return {
      panels: [{ source: "camera", rect: { x: 0, y: 0, w: size.width, h: size.height }, fit: "cover" }],
      caption,
    };
  }
  const contentH = size.height - band;
  const firstH = Math.floor(contentH / 2);
  const secondH = contentH - firstH;
  return {
    panels: [
      { source: "camera", rect: { x: 0, y: 0, w: size.width, h: firstH }, fit: "cover" },
      { source: "screen", rect: { x: 0, y: firstH, w: size.width, h: secondH }, fit: "cover" },
    ],
    caption,
  };
}

export const isCanvasPreset = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(CANVAS_SIZES, name) ||
  Object.prototype.hasOwnProperty.call(LEGACY_CANVAS_ALIASES, name);

export const isBaseLayoutPreset = (name: string): name is BaseLayoutName =>
  Object.prototype.hasOwnProperty.call(BASE_LAYOUTS, name);

export function normalizeCanvasRequest(manifest: Pick<Manifest, "canvas" | "baseLayout">): {
  canvas: string;
  baseLayout?: BaseLayoutName;
} {
  const rawCanvas = manifest.canvas ?? "landscape";
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_CANVAS_ALIASES, rawCanvas)
    ? LEGACY_CANVAS_ALIASES[rawCanvas]
    : undefined;
  const canvas = legacy?.canvas ?? rawCanvas;
  const rawBaseLayout = manifest.baseLayout;
  if (rawBaseLayout !== undefined && !isBaseLayoutPreset(rawBaseLayout)) {
    throw new Error(`未知の baseLayout 名です: ${rawBaseLayout}`);
  }
  return {
    canvas,
    ...(rawBaseLayout !== undefined ? { baseLayout: rawBaseLayout } : legacy?.baseLayout ? { baseLayout: legacy.baseLayout } : {}),
  };
}

export function resolveBaseLayoutKind(
  manifest: Manifest,
  canvasKey = normalizeCanvasRequest(manifest).canvas,
  baseLayout = normalizeCanvasRequest(manifest).baseLayout,
): BaseLayoutKind | null {
  if (baseLayout !== undefined && baseLayout !== "auto") return baseLayout;
  if (canvasKey === "landscape" && baseLayout === undefined) return null;
  if (canvasKey.startsWith("landscape")) return null;
  return hasCamera(manifest) ? "stack" : "screen";
}

/** 旧 import 互換用。UI や新規検証では CANVAS_SIZES を使う。 */
export const CANVAS_PRESETS: Record<string, Profile> = Object.fromEntries(
  Object.entries(CANVAS_SIZES).filter(([, size]) => size.width !== undefined && size.height !== undefined)
    .map(([key, size]) => [key, { width: size.width!, height: size.height! }]),
) as Record<string, Profile>;

/**
 * プロジェクトのキャンバスを解決する唯一の関数。canvas 省略/
 * landscape は screenRegion の寸法(layout 無し=従来のワイプ経路)。
 * その他は固定サイズとパネル配置を返し、未知名は throw する。
 */
export function resolveCanvas(manifest: Manifest): Profile {
  const normalized = normalizeCanvasRequest(manifest);
  const size = Object.prototype.hasOwnProperty.call(CANVAS_SIZES, normalized.canvas)
    ? CANVAS_SIZES[normalized.canvas]
    : undefined;
  if (!size) throw new Error(`未知の canvas 名です: ${normalized.canvas}`);
  const width = size.width ?? manifest.video.screenRegion.w;
  const height = size.height ?? manifest.video.screenRegion.h;
  const kind = resolveBaseLayoutKind(manifest, normalized.canvas, normalized.baseLayout);
  if (kind === null) return { width, height };
  return { width, height, layout: buildLayout(kind, { width, height }) };
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
