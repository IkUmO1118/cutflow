// render.props.json のスキーマ定義。
// src/stages/render.ts が生成し、Remotion コンポジション(Main.tsx)が受け取る。
// 時刻はすべて「カット済み動画(cut.mp4)のタイムライン」の秒。

import type {
  CaptionBackground,
  CaptionStyle,
  ColorFilter,
  KeyframeEasing,
  LayerId,
  SpotlightShape,
} from "../src/types.ts";
import type { DesignProps } from "../src/lib/design.ts";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
  /** テロップトラック番号(1始まり)。重なりは layerOrder の位置で決まる */
  track: number;
  /** 表示位置(出力px)。無ければ既定の下部中央 */
  pos?: { x: number; y: number };
  /** pos の解釈(トラック標準との合成は buildRenderProps で解決済み)。
   * 省略時 center = テキスト中心 / topLeft = テキストボックスの左上 */
  anchor?: "topLeft";
  /** 見た目の上書き(トラック標準との合成は buildRenderProps で解決済み)。
   * 無い項目は既定値(サイズは caption.fontSizePx、色は白/青縁) */
  style?: CaptionStyle;
  /** 語単位タイミング(カラオケ描画用。カット後=出力の秒)。この断片の
   * [start,end) にクリップ済み。省略時(元 segment に words[] が無い/
   * この断片に映る語が無い)はカラオケ非対応=従来どおりの1塊描画。
   * text は必ずしも語の連結と一致しない(手編集で text だけ直した場合)ので、
   * 描画側で text と語を突き合わせる(alignKaraoke)。 */
  words?: { text: string; start: number; end: number }[];
}

/** 単純な時間区間(カット済みタイムラインの秒) */
export interface Span {
  start: number;
  end: number;
  /** wipeFull の区間別遷移秒。0=最初から全画面、未指定=全体設定 */
  transitionSec?: number;
}

export interface ResolvedKeyframe {
  at: number;
  easing: KeyframeEasing;
  values: Record<string, number>;
}

/** 表示する素材(画像/動画)。rect が無ければ画面いっぱい */
export interface OverlayItem {
  start: number;
  end: number;
  /** publicDir(収録フォルダ)からの相対パス */
  file: string;
  /** 素材トラック番号(1始まり)。重なりは layerOrder の ov<N> の位置で決まる */
  track: number;
  /** contain: 全体を見せる(全画面時の余白は黒、rect 配置時は透過) /
   * cover: 領域を埋める(端が切れる) */
  fit: "contain" | "cover";
  /** 動画素材の再生開始位置(秒)。overlays.json の頭出し(startFrom)に、
   * 挿入(インサート)で割れた2番目以降の断片の表示済み秒数を足した値
   * (画像では無視) */
  startFrom?: number;
  /** 音量(0〜2、1=素材の音量のまま)。省略時 0 = 無音(動画のみ) */
  volume?: number;
  /** 不透明度(0〜1)。省略時 1 */
  opacity?: number;
  /** フェードイン/アウト(秒)。この断片の頭/末尾で不透明度と音量を遷移する
   * (挿入で割れたときは buildRenderProps が最初/最後の断片にだけ載せる) */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** 表示領域(出力px)。省略時は全画面 */
  rect?: Region;
  keyframes?: ResolvedKeyframe[];
}

export interface ResolvedBlur {
  start: number;
  end: number;
  rect: Region;
  strength: number;
  keyframes?: ResolvedKeyframe[];
}

/** 注釈グラフィック1件(overlays.json の annotations。カット後の秒へ写像・
 * 既定解決済み=具体値のみ)。src/lib/annotation.ts の resolveAnnotation が
 * 組み立てる。Main.tsx はフォールバックを持たずこの値をそのまま描く */
export type ResolvedAnnotation =
  | {
      type: "arrow";
      start: number;
      end: number;
      from: { x: number; y: number };
      to: { x: number; y: number };
      color: string;
      widthPx: number;
      headPx: number;
      keyframes?: ResolvedKeyframe[];
    }
  | {
      type: "box";
      start: number;
      end: number;
      rect: Region;
      color: string;
      widthPx: number;
      radiusPx: number;
      fill?: string;
      keyframes?: ResolvedKeyframe[];
    }
  | {
      type: "spotlight";
      start: number;
      end: number;
      rect: Region;
      shape: SpotlightShape;
      dim: number;
      featherPx: number;
      radiusPx: number;
      keyframes?: ResolvedKeyframe[];
    };

// interface でなく type なのは意図的: Remotion の Composition / Player は
// props に Record<string, unknown> 互換を要求し、type エイリアスだけが満たせる
export type RenderProps = {
  /** publicDir(収録フォルダ)内のカット済み動画ファイル名。
   * 空文字列なら動画なしのプレースホルダー表示(Remotion Studio 用) */
  videoFile: string;
  /** BGM トラック(カット後タイムラインの再生区間。buildRenderProps が bgm.json
   * を写像して組み立てる)。BGM が無ければ空配列。区間はループ再生し、
   * 覆っていない時間は無音。複数区間で曲の切り替え・重奏を表現する */
  bgm: {
    file: string;
    volumeDb: number;
    /** 出力タイムラインでの再生区間(カット後の秒) */
    start: number;
    end: number;
    /** 頭出し(ファイル内の再生開始秒)。省略時 0(頭から) */
    startFrom?: number;
    /** 区間の頭/末尾のフェード(秒)。省略時 0(なし) */
    fadeInSec?: number;
    fadeOutSec?: number;
    /** 発話中のダッキング(無音検出由来。buildRenderProps が組み立てる。
     * 全 BGM 区間で共通)。spans の間だけ BGM をさらに duckDb 下げ、前後
     * fadeSec 秒で遷移する。無ければ一定音量。spans は出力(カット後)の秒 */
    duck?: { spans: Span[]; duckDb: number; fadeSec: number };
  }[];
  /** エディタのプレビュー専用: ベース映像(挿入クリップ含む)の音を消す。
   * 最終レンダーでは常に未指定 */
  muteBase?: boolean;
  /** エディタのプレビュー専用: BGM の音を消す。最終レンダーでは常に未指定 */
  muteBgm?: boolean;
  /** エディタのプレビュー専用: 一時的に非表示にするレイヤー(目トグル)。
   * 最終レンダーでは常に未指定 */
  hiddenLayers?: LayerId[];
  durationSec: number;
  fps: number;
  /** 出力解像度(通常は screenRegion と同じ 1920x1080) */
  width: number;
  height: number;
  /** カット済み動画の寸法(拡張キャンバスのまま。例: 3840x1080) */
  canvas: { w: number; h: number };
  screenRegion: Region;
  /** カメラ(ワイプ)領域。plain(manifest.video.cameraRegion 無し)では
   *  undefined(ワイプ非描画。ワイプ関連レイヤーが到達しない) */
  cameraRegion?: Region;
  /** 右下ワイプの寸法。transitionSec はワイプ全画面(wipeFull)の出入りの
   * 遷移時間(秒。省略・0 で瞬時) */
  wipe: { widthPx: number; marginPx: number; transitionSec?: number };
  /** true = ワイプ(カメラ)を cut.mp4 に焼き込み済み。Main.tsx はワイプレイヤーを
   * 描かない(ベース抽出1回の高速レンダー。docs/plans/perf-render-single-extraction.md)。
   * 最終レンダーの composite 経路でのみ立つ。エディタ Player / short では未指定 */
  wipeBurnedIn?: boolean;
  /** 簡易カラー調整(overlays.json の colorFilter)。ベース映像(画面クロップ+
   * カメラ)だけに CSS filter として効く(src/lib/colorFilter.ts が変換)。
   * 素材オーバーレイ・挿入クリップには効かない。省略時は無補正 */
  colorFilter?: ColorFilter;
  /** ベースレイアウトのデザイン(背景画像 + 画面パネル + カメラ円)。
   * config.yaml の render.design を buildRenderProps が出力px の矩形へ解決した
   * もの(src/lib/design.ts)。省略時は従来の「画面全面 + 右下ワイプ」。
   * layout(縦プリセット)経路には載らない=ショートには継承されない */
  design?: DesignProps;
  /** ベース映像パネルの配置(縦プリセット用。src/lib/profile.ts の
   * Profile.layout から buildRenderProps が渡す)。省略時は現行ワイプ経路
   * (screen 全面 + camera 右下ワイプ)のまま */
  layout?: {
    panels: { source: "screen" | "camera"; rect?: Region; fit: "contain" | "cover" }[];
  };
  /** テロップの既定の見た目(config.yaml の render.caption* を buildRenderProps が
   * 解決)。fontSizePx 以外は省略可で、無ければ描画側の定数
   * (CAPTION_DEFAULT_*)が最終フォールバックになる */
  caption: {
    fontSizePx: number;
    color?: string;
    outlineColor?: string;
    fontFamily?: string;
    fontWeight?: number;
    background?: CaptionBackground;
  };
  /** 位置指定の無いテロップの既定位置(縦プリセット用。profile.layout.caption
   * から buildRenderProps が渡す)。省略時は現行の下部中央 */
  captionDefaultPos?: { x: number; y: number; anchor?: "center" | "topLeft" };
  /** テロップ(位置・スタイルは解決済み) */
  captions: Caption[];
  /** 素材オーバーレイ(overlays.json 由来。無ければ空) */
  overlays: OverlayItem[];
  /** ワイプを全画面にする区間 */
  wipeFull: Span[];
  /** ズーム演出(overlays.json の zooms。カット後の秒に写像・easeSec 解決済み)。
   * ベース映像の背景レイヤーだけを拡大する(ワイプ・テロップ・素材・挿入は
   * 動かない)。省略時(空)は現行の描画と完全に同じ */
  zooms?: { start: number; end: number; rect: Region; easeSec: number; easeOutSec?: number }[];
  /** 領域ぼかし(overlays.json の blurs。カット後の秒へ写像・
   * strength 解決済み)。ベース映像(画面クロップ)の rect 部分だけを
   * 隠す。zoom 追従なしの出力px固定。省略時(空)は現行の描画と完全に同じ。
   * props.layout(ショート/縦)経路では描画しない(本編のみ) */
  blurs?: ResolvedBlur[];
  /** 注釈グラフィック(overlays.json の annotations。カット後の秒へ写像・
   * 既定解決済み)。最前面に出力px固定で描く。省略時(空)は現行の描画と
   * 完全に同じ。props.layout(ショート/縦)経路では描画しない(本編のみ) */
  annotations?: ResolvedAnnotation[];
  /** カット境界のディップ・トゥ・ブラック(config.yaml の render.cutTransition
   * が dip-to-black のときだけ載る)。sec は黒への往復の合計秒 */
  cutTransition?: { sec: number };
  /** dip-to-black の対象境界(カット後の秒。先頭0・末尾は含まない)。
   * cutTransition が無ければ意味を持たない */
  cutBoundarySecs?: number[];
  /** 字幕を出さない区間 */
  hideCaption: Span[];
  /** 画面の重なり順(下→上)。省略時は DEFAULT_LAYER_ORDER */
  layerOrder?: LayerId[];
  /** ベース映像(videoFile)の再生区間。挿入(inserts)があると分割される。
   * start はカット後の秒、videoStart は videoFile 内の秒。
   * 省略時は全編連続再生(挿入なし) */
  baseSegments?: {
    start: number;
    videoStart: number;
    durationSec: number;
    playbackRate?: number;
  }[];
  /** ベース映像トラックへの挿入クリップ(カット後の秒)。
   * 表示中はベース映像・ワイプが止まり、挿入素材(音声込み)が全面に出る。
   * startFrom は頭出し(素材内の再生開始秒。省略時 0・動画のみ有効)。
   * volume は音量(0〜2。省略時 1)、fadeIn/OutSec は黒からの明転/暗転(秒) */
  inserts?: {
    start: number;
    end: number;
    file: string;
    fit: "contain" | "cover";
    startFrom?: number;
    volume?: number;
    fadeInSec?: number;
    fadeOutSec?: number;
  }[];
};

/** Remotion Studio でプレビューする時のダミー値。実レンダーでは --props で上書きされる。
 * videoFile が空なのは、リポジトリ直下で Studio を開くと cut.mp4 が存在せず
 * 再生エラーになるため(実データで見る方法は docs/usage.md 参照) */
export const defaultProps: RenderProps = {
  videoFile: "",
  bgm: [],
  durationSec: 10,
  fps: 30,
  width: 1920,
  height: 1080,
  canvas: { w: 3840, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  // cameraRegion は defaultProps に置かない。plain の inputProps は cameraRegion を
  // 持たず(undefined は JSON 化で欠落)、defaultProps にダミーがあると Remotion の
  // props マージでそれが漏れて plain にワイプが描かれてしまう(plain=カメラ無しの
  // 前提が壊れる)。obs のレンダーは buildRenderProps が manifest から必ず
  // cameraRegion を載せるので、defaultProps 側のダミーは不要
  wipe: { widthPx: 480, marginPx: 32 },
  caption: { fontSizePx: 44 },
  captions: [],
  overlays: [],
  wipeFull: [],
  hideCaption: [],
};
