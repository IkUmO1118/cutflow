// src/engine/descriptor.ts — FrameDescriptor: そのフレームの絵の仕様だけを持つ
// 純データの中間表現。JSON(正) → 翻訳層(describeFrame。M2 Phase2) →
// この型 → 描画バックエンド(M3a)、の一方向。
//
// ブラウザ安全な純 TS のみ(node import 禁止)。editor client / 将来の
// Worker / CLI テストの全部から import される
// (docs/plans/2026-07-28-engine-m2-frame-descriptor-design.md §2)。
//
// キーは時刻(出力秒)。フレーム番号を主キーにしない(元収録・cut.mp4 とも
// VFR であり、CFR 前提を焼き込むと VFR 継ぎ目の再スタンプ問題を再生産する)。
//
// OpenCut(MIT fork。~/dev/labs/opencut)のテクスチャ2分類(external/
// rendered)を踏襲する。external = 映像フレーム参照(source id + 元収録秒)、
// rendered = 描画仕様(解決済みテロップ/注釈/色面。contentHash 付き)。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 出力矩形(移動/スケール/クロップ込みの最終配置)。回転は持たない
 * (CutFlow の演出に回転は無い) */
export type Quad = Rect;

export type BlendMode = "normal";

/** ベース映像だけに効く簡易カラー調整(overlays.json の colorFilter)。
 * CSS filter 文字列への変換(cssFilterOf 相当)はペインタ側の仕事とし、
 * descriptor はバックエンド非依存の数値のまま持つ */
export interface ColorFilterEffect {
  kind: "colorFilter";
  brightness: number;
  contrast: number;
  saturate: number;
}

export type Effect = ColorFilterEffect;

/**
 * 映像フレーム参照(素材ファイルをデコードしてそのまま貼る)。
 * sourceRect はソースのピクセル座標系(動画なら canvas.w/h 基準)での
 * クロップ範囲、quad はそれを出力px へ配置する矩形。contain/cover の
 * 違いは describeFrame が sourceRect+quad の組へ解決済みにする
 * (fit 種別そのものは descriptor に残らない)。
 */
export interface ExternalItem {
  kind: "external";
  /** ソースを一意に指す識別子。通常は publicDir 相対のファイルパス
   * (videoFile / insert file / overlay file のいずれか) */
  sourceId: string;
  /** そのソース内の再生位置(秒)。画像素材では無視される */
  sourceTimeSec: number;
  /** 動画か画像か(ペインタがデコード方式を分けるために必要) */
  sourceKind: "video" | "image";
  /** ソース側のクロップ範囲(ピクセル座標)。省略時はソース全体 */
  sourceRect?: Rect;
  quad: Quad;
  opacity: number;
  blend?: BlendMode;
  effects?: Effect[];
  /** 角丸(design パネル・ワイプの角丸表現)。省略時 0 */
  radiusPx?: number;
}

// ---- rendered content(判別 union) ----

export interface CaptionWord {
  text: string;
  active: boolean;
  /** "fill" モードのときだけ、いま発話中の語の塗り進み(0〜1) */
  fillProgress?: number;
}

export interface CaptionBackgroundContent {
  color: string;
  paddingPx: number;
  radiusPx: number;
}

export interface CaptionContent {
  kind: "caption";
  text: string;
  fontSizePx: number;
  color: string;
  outlineColor: string;
  /** "none" 相当(縁なし)は outlineColor: "none" のまま持たせる
   * (types.ts の CAPTION_DEFAULT_OUTLINE と同じ契約) */
  outlineWidthPx: number;
  fontFamily: string;
  fontWeight: number;
  background?: CaptionBackgroundContent;
  /** anim(登場/退場)で解決済みの状態は quad/opacity 側に畳み込み、
   * content には持たせない(hash が毎フレーム変わらないようにする)。
   * カラオケの語別彩色だけはここに展開する
   * (hash は語境界でだけ変わるのが正) */
  words?: CaptionWord[];
  karaokeMode?: "word" | "fill";
  karaokeActiveColor?: string;
  karaokeInactiveColor?: string;
  karaokeInactiveOpacity?: number;
}

export interface AnnotationArrowContent {
  kind: "annotationArrow";
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  widthPx: number;
  headPx: number;
}

export interface AnnotationBoxContent {
  kind: "annotationBox";
  rect: Rect;
  color: string;
  widthPx: number;
  radiusPx: number;
  fill?: string;
}

export interface AnnotationSpotlightContent {
  kind: "annotationSpotlight";
  rect: Rect;
  shape: "rect" | "ellipse";
  dim: number;
  featherPx: number;
  radiusPx: number;
}

/**
 * 領域ぼかし。rect の下に描かれている外側(external)アイテムをぼかす、
 * という手続き的な意味を持つ唯一の rendered content(backdrop サンプリング)。
 * それ以外の rendered content は自己完結でラスタライズできる
 */
export interface BlurRegionContent {
  kind: "blurRegion";
  rect: Rect;
  radiusPx: number;
}

/** 単色矩形(ワイプの黒背景、dip-to-black 等) */
export interface FillContent {
  kind: "fill";
  color: string;
}

export type RenderedContent =
  | CaptionContent
  | AnnotationArrowContent
  | AnnotationBoxContent
  | AnnotationSpotlightContent
  | BlurRegionContent
  | FillContent;

export interface RenderedItem {
  kind: "rendered";
  content: RenderedContent;
  /** content(+出力解像度)の安定ハッシュ(hash.ts の contentHashOf)。
   * 同一ハッシュ = 同一ラスタ結果になることがバックエンドのテクスチャ
   * キャッシュ判定の前提 */
  contentHash: string;
  quad: Quad;
  opacity: number;
  blend?: BlendMode;
  effects?: Effect[];
}

export type FrameItem = ExternalItem | RenderedItem;

export interface FrameDescriptor {
  /** 出力秒(カット後タイムライン基準)。フレーム番号ではない */
  tOut: number;
  size: { w: number; h: number };
  /** 背景色(design の背景色 or 既定の黒)。単色なので item 化せず
   * descriptor 直下に置く(全レイヤーの最下層) */
  backgroundColor: string;
  /** 下から上への描画順 */
  items: FrameItem[];
}
