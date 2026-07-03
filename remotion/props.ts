// render.props.json のスキーマ定義。
// src/stages/render.ts が生成し、Remotion コンポジション(Main.tsx)が受け取る。
// 時刻はすべて「カット済み動画(cut.mp4)のタイムライン」の秒。

import type { CaptionStyle, LayerId } from "../src/types.ts";

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
}

/** 単純な時間区間(カット済みタイムラインの秒) */
export interface Span {
  start: number;
  end: number;
}

/** 画面いっぱいに表示する素材(画像/動画) */
export interface OverlayItem {
  start: number;
  end: number;
  /** publicDir(収録フォルダ)からの相対パス */
  file: string;
  /** 素材トラック番号(1始まり)。重なりは layerOrder の ov<N> の位置で決まる */
  track: number;
  /** contain: 全体を見せる(余白は黒) / cover: 画面を埋める(端が切れる) */
  fit: "contain" | "cover";
  /** 動画素材の再生開始位置(秒)。挿入(インサート)で割れた2番目以降の
   * 断片が頭からでなく続きから再生するために使う(画像では無視) */
  startFrom?: number;
}

// interface でなく type なのは意図的: Remotion の Composition / Player は
// props に Record<string, unknown> 互換を要求し、type エイリアスだけが満たせる
export type RenderProps = {
  /** publicDir(収録フォルダ)内のカット済み動画ファイル名。
   * 空文字列なら動画なしのプレースホルダー表示(Remotion Studio 用) */
  videoFile: string;
  /** BGM。収録フォルダに bgm.* が無ければ null */
  bgm: {
    file: string;
    volumeDb: number;
    fadeOutSec: number;
    /** 発話中のダッキング(無音検出由来。buildRenderProps が組み立てる)。
     * spans の間だけ BGM をさらに duckDb 下げ、前後 fadeSec 秒で遷移する。
     * 無ければ全編一定音量 */
    duck?: { spans: Span[]; duckDb: number; fadeSec: number };
  } | null;
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
  cameraRegion: Region;
  wipe: { widthPx: number; marginPx: number };
  caption: { fontSizePx: number };
  /** テロップ(位置・スタイルは解決済み) */
  captions: Caption[];
  /** 素材オーバーレイ(overlays.json 由来。無ければ空) */
  overlays: OverlayItem[];
  /** ワイプを全画面にする区間 */
  wipeFull: Span[];
  /** 字幕を出さない区間 */
  hideCaption: Span[];
  /** 画面の重なり順(下→上)。省略時は DEFAULT_LAYER_ORDER */
  layerOrder?: LayerId[];
  /** ベース映像(videoFile)の再生区間。挿入(inserts)があると分割される。
   * start はカット後の秒、videoStart は videoFile 内の秒。
   * 省略時は全編連続再生(挿入なし) */
  baseSegments?: { start: number; videoStart: number; durationSec: number }[];
  /** ベース映像トラックへの挿入クリップ(カット後の秒)。
   * 表示中はベース映像・ワイプが止まり、挿入素材(音声込み)が全面に出る */
  inserts?: { start: number; end: number; file: string; fit: "contain" | "cover" }[];
};

/** Remotion Studio でプレビューする時のダミー値。実レンダーでは --props で上書きされる。
 * videoFile が空なのは、リポジトリ直下で Studio を開くと cut.mp4 が存在せず
 * 再生エラーになるため(実データで見る方法は docs/usage.md 参照) */
export const defaultProps: RenderProps = {
  videoFile: "",
  bgm: null,
  durationSec: 10,
  fps: 30,
  width: 1920,
  height: 1080,
  canvas: { w: 3840, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  wipe: { widthPx: 480, marginPx: 32 },
  caption: { fontSizePx: 44 },
  captions: [],
  overlays: [],
  wipeFull: [],
  hideCaption: [],
};
