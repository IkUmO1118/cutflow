// 出力プロファイル(サイズ+ベース映像のパネル配置+字幕既定)の組み込み定数。
// config.yaml には追加しない(D1: プリセットは閉じた組み込み。設定爆発の回避)。
import type { Region } from "../types.ts";

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

// 幾何は仮案(実装時にプレビューで調整)。default の width/height は
// resolveProfile が defaultSize(manifest.video.screenRegion)で上書きする
// (ここはプレースホルダ)
export const PROFILES: Record<string, Profile> = {
  default: { width: 1920, height: 1080 }, // layout 無し = 現行ワイプ経路
  vertical: {
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
  "vertical-cover": {
    width: 1080,
    height: 1920,
    layout: {
      panels: [{ source: "camera", rect: { x: 0, y: 0, w: 1080, h: 1920 }, fit: "cover" }],
      caption: { x: 540, y: 1500, anchor: "center", fontScale: 1.6 },
    },
  },
  "vertical-screen": {
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
};

/** ショートの省略時 profile 名。camera 有り→"vertical"、plain→"vertical-screen" */
export function defaultShortProfileName(hasCamera: boolean): string {
  return hasCamera ? "vertical" : "vertical-screen";
}

/** その profile を plain(カメラ無し)に使えるか。panels の source 集合が
 * screen と camera を両方含むときだけ false(validate の plain ガードと同一規則)。
 * layout 無し(default)・screen のみ・camera のみは true */
export function profileSupportsPlain(profileName: string): boolean {
  const panels = PROFILES[profileName]?.layout?.panels;
  if (!panels) return true;
  const src = new Set(panels.map((p) => p.source));
  return !(src.has("screen") && src.has("camera"));
}

/**
 * プロファイル名から Profile を解決する。省略/"default" は
 * defaultSize(呼び出し側が渡す出力解像度。通常 manifest.video.screenRegion)
 * のサイズ(layout 無し = 現行ワイプ経路)。縦プリセットは defaultSize を
 * 無視して固定サイズを返す。未知の名前は throw(バリデーションは呼び出し側で
 * 先に済ませる想定)
 */
export function resolveProfile(defaultSize: { w: number; h: number }, name?: string): Profile {
  const key = name ?? "default";
  if (key === "default") {
    return { width: defaultSize.w, height: defaultSize.h };
  }
  const profile = PROFILES[key];
  if (!profile) throw new Error(`未知の profile 名です: ${key}`);
  return profile;
}
