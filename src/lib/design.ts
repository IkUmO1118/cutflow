// lib/design.ts — ベースレイアウトのデザイン(背景画像 + 画面パネル + カメラワイプ)。
// 既定(config.yaml の render.design 無し / enabled: false)では resolveDesign が
// undefined を返し、props.design が載らない = 従来の「画面全面 + 右下ワイプ」と
// バイト等価。remotion/Main.tsx と src/lib/renderProps.ts が使う純関数
// (fs は触らない=ブラウザでも動く。背景画像の取り込みは designAsset.ts)。
import type { Region } from "../types.ts";

/** config.yaml の render.design(全項目省略可。既定値は DEFAULT_DESIGN) */
export interface DesignConfig {
  /** false / 省略でデザイン無効(従来の全面ベース + 右下ワイプ) */
  enabled?: boolean;
  /** 背景画像。publicDir(収録フォルダ)相対のパス。省略時は backgroundColor の単色 */
  backgroundFile?: string;
  /** 背景色(背景画像の下地・画像が無いときの背景) */
  backgroundColor?: string;
  /** 画面(screenRegion)パネル。左右・下の余白から矩形を決め、上余白は
   * 出力アスペクト維持の成り行きになる */
  screen?: {
    /** 左右の余白(出力px) */
    marginXPx?: number;
    /** 下の余白(出力px) */
    marginBottomPx?: number;
    /** 角丸(出力px) */
    radiusPx?: number;
    /** 影を落とすか */
    shadow?: boolean;
  };
  /** カメラ(ワイプ)。正方形に center-crop して右下へ置く角丸矩形 */
  camera?: {
    /** 一辺(出力px) */
    sizePx?: number;
    /** 右・下からの余白(出力px) */
    marginPx?: number;
    /** 角丸(出力px)。sizePx/2 でクランプ(= そこが最大の丸み = 円) */
    radiusPx?: number;
    /** 影を落とすか(画面パネルの shadow とは独立に決める) */
    shadow?: boolean;
  };
}

/** 解決済みのデザイン(すべて出力px。RenderProps に載る) */
export interface DesignProps {
  backgroundFile?: string;
  backgroundColor: string;
  screen: { rect: Region; radiusPx: number; shadow: boolean };
  /** カメラ(ワイプ)。design は obs-canvas 収録にしか載らないので必ず存在する */
  camera: { rect: Region; radiusPx: number; shadow: boolean };
  /** render.fast/design/ に生成した静的レイアウト資産。ユーザー入力ではなく、
   * render/frames/editor の prepare 段階だけが付与する */
  assets?: DesignAssetRefs;
}

/** Main と FAST 基底が共有する内容アドレス式の静的レイアウト資産。camera
 * 参照は plain design に備えて optional にする */
export interface DesignAssetRefs {
  key: string;
  backdropFile: string;
  screenMaskFile: string;
  cameraShadowFile?: string;
  cameraMaskFile?: string;
}

/** DesignConfig の既定値(config.yaml で省略された項目に入る) */
export const DEFAULT_DESIGN = {
  backgroundColor: "#000000",
  screen: { marginXPx: 100, marginBottomPx: 90, radiusPx: 24, shadow: true },
  camera: { sizePx: 300, marginPx: 28, radiusPx: 96, shadow: true },
} as const;

/** 落ち影の CSS(近接の締まり + 広がりのぼけ の重ね)。shadow: true のときだけ
 * 各レイヤーの box-shadow に載る(remotion/Main.tsx) */
export const SCREEN_SHADOW_CSS = "0 24px 80px rgba(0,0,0,0.35)";
export const CAMERA_SHADOW_CSS = "0 8px 20px rgba(0,0,0,0.22), 0 24px 64px rgba(0,0,0,0.32)";

/**
 * config の design を出力px の矩形へ解決する。無効なら undefined。
 *
 * **OBS 拡張キャンバス収録(obs-canvas)だけに効く。** 判別は manifest に
 * cameraRegion があるか(= hasCamera)で行う: これは ingest / run を
 * `--layout obs-canvas` で通したときだけ書かれるので、通常動画(plain。
 * エディタの bootstrap を含む)は cameraRegion を持たず、config で design を
 * 有効にしていても常に undefined = 従来どおり収録そのままの絵になる。
 * 「背景+パネル+ワイプ」というデザインは画面とカメラが別々に取れる収録が
 * 前提なので、カメラの無い収録に部分適用(背景+パネルだけ)しても
 * 意図した絵にならない。
 *
 * 画面パネルは「左右 marginXPx・下 marginBottomPx」から幅と Y を決め、高さは
 * 出力アスペクト(width:height)維持の成り行き。上余白は
 * height - marginBottomPx - h になる(上下非対称)。
 */
export function resolveDesign(
  cfg: DesignConfig | undefined,
  width: number,
  height: number,
  /** manifest.video.cameraRegion があるか(= obs-canvas 収録か) */
  hasCamera: boolean,
): DesignProps | undefined {
  if (!cfg?.enabled) return undefined;
  if (!hasCamera) return undefined; // 通常動画(plain)はデザインを適用しない

  const s = { ...DEFAULT_DESIGN.screen, ...cfg.screen };
  const c = { ...DEFAULT_DESIGN.camera, ...cfg.camera };

  const w = width - s.marginXPx * 2;
  const h = Math.round((w * height) / width);
  const screen: Region = { x: s.marginXPx, y: height - s.marginBottomPx - h, w, h };
  if (w <= 0 || screen.y < 0) {
    throw new Error(
      `render.design.screen の余白が大きすぎます(幅 ${w}px / 上余白 ${screen.y}px)`,
    );
  }

  return {
    ...(cfg.backgroundFile ? { backgroundFile: cfg.backgroundFile } : {}),
    backgroundColor: cfg.backgroundColor ?? DEFAULT_DESIGN.backgroundColor,
    screen: { rect: screen, radiusPx: s.radiusPx, shadow: s.shadow },
    camera: {
      rect: {
        x: width - c.marginPx - c.sizePx,
        y: height - c.marginPx - c.sizePx,
        w: c.sizePx,
        h: c.sizePx,
      },
      // 半径は一辺の半分でクランプ(そこが最大の丸み = 円)。
      // それ以上を書いても円より丸くはならない
      radiusPx: Math.min(c.radiusPx, c.sizePx / 2),
      shadow: c.shadow,
    },
  };
}

/**
 * デザインのカメラワイプの矩形・角丸(出力px)を、ワイプ全画面の進行度
 * (`ease`。0 = 通常の角丸ワイプ / 1 = 出力の全画面)で補間する。
 *
 * `overlays.json` の `wipeFull` はデザイン経路でも効く: 区間に入るとカメラが
 * 右下の角丸正方形から出力いっぱいへ広がり(背景画像・画面パネルは覆い隠され
 * る)、区間を出ると元へ戻る。角丸も 0 へ向かって補間するので、全画面時は
 * デザイン無しの wipeFull と同じ絵になる。ease は Main.tsx が
 * `render.wipeTransitionSec` から作る smoothstep 済みの進行度。
 */
export function wipeRectAt(
  camera: DesignProps["camera"],
  width: number,
  height: number,
  ease: number,
): { rect: Region; radiusPx: number } {
  const lerp = (from: number, to: number) => Math.round(from + (to - from) * ease);
  return {
    rect: {
      x: lerp(camera.rect.x, 0),
      y: lerp(camera.rect.y, 0),
      w: lerp(camera.rect.w, width),
      h: lerp(camera.rect.h, height),
    },
    radiusPx: lerp(camera.radiusPx, 0),
  };
}

/**
 * ベース映像が収まる矩形(出力px)。デザイン有効時は画面パネル、無効時は
 * 出力全面。「design 無し = パネルが出力そのもの」を1箇所で言い切るための
 * 小関数で、これにより toPanelRect / screenRectToOutput が design の有無に
 * かかわらず同じ式で書ける(design 無しではどちらも恒等写像になる)。
 */
export function panelRect(
  design: DesignProps | undefined,
  width: number,
  height: number,
): Region {
  return design?.screen.rect ?? { x: 0, y: 0, w: width, h: height };
}

/**
 * 出力px の矩形を、画面パネル(panel)のローカル座標へ写す。デザイン有効時、
 * ベース映像は出力全面ではなくパネルに収まるので、ベース映像を再クロップする
 * 側(blurs)とベース映像に掛ける側(zooms)は、この写像を通してから
 * 「パネルを出力とみなす」既存の式(blur.ts / zoom.ts)に渡す。
 */
export function toPanelRect(rect: Region, panel: Region): Region {
  return { x: rect.x - panel.x, y: rect.y - panel.y, w: rect.w, h: rect.h };
}

/**
 * toPanelRect の逆。画面クロップの画素座標(screenRegion 基準)の矩形を、
 * 出力px(テロップ `pos` / `blurs.rect` と同じ座標系)へ写す。`frames --ocr` の
 * box がこれを通る(デザイン有効時、画面はパネルに縮んで置かれるため、
 * screenRegion 画素 = 出力px という従来の恒等が成り立たない)。
 * design 無し(panel = 出力全面、かつ出力寸法 = screenRegion 寸法)では恒等。
 */
export function screenRectToOutput(
  rect: Region,
  panel: Region,
  screenRegion: { w: number; h: number },
): Region {
  const sx = panel.w / screenRegion.w;
  const sy = panel.h / screenRegion.h;
  return {
    x: panel.x + rect.x * sx,
    y: panel.y + rect.y * sy,
    w: rect.w * sx,
    h: rect.h * sy,
  };
}
