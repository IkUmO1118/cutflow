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
 * (FrameWright の演出に回転は無い) */
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
 * external item の配置。
 *
 * - "resolved": ソースの実ピクセル寸法が JSON 側で既知(ベース映像=
 *   manifest.video の canvas.w/h)なときだけ、describeFrame が
 *   sourceRect(ソースのクロップ範囲)+ quad(出力px の最終矩形)まで
 *   解決する(cropFitStyle 相当の計算を逐語移植)。
 * - "fit": 素材ファイル(overlay/insert/design 背景の画像・動画)は
 *   実ピクセル寸法が描画時にしか分からない(FrameWright は素材を事前
 *   probe しない)。この場合は箱(box)+fit をそのまま渡し、実寸に
 *   基づくクロップはペインタ(実際にデコードした側)が解決する。
 */
export type ExternalPlacement =
  | { mode: "resolved"; sourceRect?: Rect; quad: Quad }
  | {
      mode: "fit";
      fit: "contain" | "cover";
      box: Rect;
      /** contain フィットで余る余白(レターボックス)の色。省略時は透過
       * (rect 指定のオーバーレイ=PiP のように、余白が下層を透かす配置)。
       * 全画面のオーバーレイ/挿入クリップは Main.tsx が AbsoluteFill の
       * backgroundColor:"black" を敷くため "black" になる */
      letterboxColor?: string;
    };

/** 映像フレーム参照(素材ファイルをデコードしてそのまま貼る) */
export interface ExternalItem {
  kind: "external";
  /** ソースを一意に指す識別子。通常は publicDir 相対のファイルパス
   * (videoFile / insert file / overlay file のいずれか) */
  sourceId: string;
  /** そのソース内の再生位置(秒)。画像素材では無視される */
  sourceTimeSec: number;
  /** 動画か画像か(ペインタがデコード方式を分けるために必要) */
  sourceKind: "video" | "image";
  placement: ExternalPlacement;
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

/**
 * rendered item の配置。
 *
 * - "quad": 完全に解決済みの矩形(annotation の rect / blur の rect /
 *   fill 等。JSON の値をそのままカット後秒へ写像しただけで実サイズが
 *   決まるもの)。
 * - "anchor": テキストの実サイズ(フォント計測・折り返し)に依存するため
 *   矩形を決め切れない(caption 専用)。アンカー点+アンカーの意味
 *   (CaptionLayer.tsx の3パターン: topLeft=左上を点に置く / center=
 *   中心を点に置く / bottomCenter=水平中央・下端を点に置く。無指定
 *   テロップの下部中央フォールバックが bottomCenter)だけを渡し、
 *   実サイズは描画側(参照ペインタ/バックエンド)が決める。maxWidthPx は
 *   bottomCenter のときだけ意味を持つ(横幅の90%で自動折り返し。
 *   位置指定テロップは手動改行のみで自動折り返みしない=maxWidthPx 省略)
 */
export type RenderedPlacement =
  | { mode: "quad"; quad: Quad }
  | {
      mode: "anchor";
      point: { x: number; y: number };
      anchor: "topLeft" | "center" | "bottomCenter";
      maxWidthPx?: number;
    };

/** placement(quad/anchor)で決まる位置の上から追加でかける平行移動・拡縮
 * (caption の登場/退場アニメ用。CSS `transform: translate() scale()` /
 * `transform-origin: center` と同じ意味論。テキストの実サイズが決まる
 * 描画時にならないと中心=pivot が定まらないため、値だけをそのまま渡し
 * 実際の適用は描画側(参照ペインタ/バックエンド)が行う) */
export interface Transform {
  translateX: number;
  translateY: number;
  scale: number;
}

export interface RenderedItem {
  kind: "rendered";
  content: RenderedContent;
  /** content(+出力解像度)の安定ハッシュ(hash.ts の contentHashOf)。
   * 同一ハッシュ = 同一の「内容」。**ラスタ結果まで同一とは限らない**
   * (placement/opacity/transform は content の外にあり、ラスタライズ時に
   * テクスチャへ焼き込まれる)。テクスチャキャッシュのキーにはこれ単体では
   * 足りず、runtime/textureCache.ts の renderedTextureId が座標側も
   * 合わせて畳む */
  contentHash: string;
  /** content 自身に幾何が無い(caption のテキスト・fill の単色矩形)ときだけ
   * 指定する。annotation(box/spotlight/arrow)・blurRegion は rect/from-to を
   * content 自身が持つため省略(placement で重複させない) */
  placement?: RenderedPlacement;
  opacity: number;
  blend?: BlendMode;
  effects?: Effect[];
  /** caption の anim(登場/退場)が指定されているときだけ載る。
   * 省略時は恒等(anim 未指定=器を包まない、という Main.tsx の契約と対応) */
  transform?: Transform;
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
