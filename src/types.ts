// パイプラインの中間ファイル(JSON)のスキーマ定義。
// 各ステージはここで定義した型のファイルを読み書きする。

/** ingest が生成。収録ファイルの構成情報(manifest.json) */
export interface Manifest {
  /** 収録フォルダの絶対パス */
  dir: string;
  /** 元ファイル名(収録フォルダ内) */
  source: string;
  durationSec: number;
  video: {
    width: number;
    height: number;
    fps: number;
    /** 3840x1080 内での画面キャプチャ領域 */
    screenRegion: Region;
    /** 3840x1080 内でのカメラ領域 */
    cameraRegion: Region;
  };
  audio: {
    /** マイク音声のストリーム番号(ffmpeg の a:N) */
    micStream: number;
    /** システム音声のストリーム番号。存在しない場合は null */
    systemStream: number | null;
    /** 抽出済みマイク音声(16kHz mono wav、収録フォルダからの相対パス) */
    micWav: string;
  };
  createdAt: string;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** transcribe が生成(transcript.json) */
export interface Transcript {
  language: string;
  model: string;
  segments: TranscriptSegment[];
}

export interface TranscriptSegment {
  /** 秒 */
  start: number;
  end: number;
  text: string;
  /** テロップトラック番号(1始まり)。省略時 1。重なりは layerOrder が決める */
  track?: number;
  /** このテロップだけの表示位置(テキスト中心、出力px)。
   * 省略時はトラックの標準位置(overlays.json の captionTracks)、
   * それも無ければ従来の下部中央 */
  pos?: CaptionPos;
  /** このテロップだけの見た目。項目単位でトラック標準・既定値に重なる */
  style?: CaptionStyle;
}

/** テロップの表示位置。出力解像度上のテキスト中心座標(px) */
export interface CaptionPos {
  x: number;
  y: number;
}

/** テロップの見た目。項目単位で「セグメント個別 → トラック標準 → 既定値」の
 * 順に重なる(サイズの既定は config.yaml の render.captionFontSizePx) */
export interface CaptionStyle {
  fontSizePx?: number;
  /** 文字色(CSS カラー)。既定は白 */
  color?: string;
  /** 縁取り色(CSS カラー)。既定は青。"none" で縁取りを消す
   * (座布団=background と組み合わせるときの定番) */
  outlineColor?: string;
  /** フォント種(CSS の font-family)。既定は日本語ゴシック(CAPTION_DEFAULT_FONT_FAMILY) */
  fontFamily?: string;
  /** 文字の太さ(CSS の font-weight 相当の 100〜900)。既定は 700 */
  fontWeight?: number;
  /** 座布団(テキスト背後の背景帯)。YouTube テロップの定番表現。
   * 省略時はなし。縁取りを消したい場合は outlineColor: "none" を併用する */
  background?: CaptionBackground;
}

/** テロップの座布団(背景帯)の設定 */
export interface CaptionBackground {
  /** 帯の色(CSS カラー。半透明の rgba() も可) */
  color: string;
  /** テキスト周りの余白(px、横方向)。省略時はフォントサイズの 0.35 倍。
   * 縦の余白はこの 0.5 倍にする */
  paddingPx?: number;
  /** 角丸の半径(px)。省略時 8 */
  radiusPx?: number;
}

/** style 未指定時の文字色・縁取り色・フォント種・太さ */
export const CAPTION_DEFAULT_COLOR = "#ffffff";
export const CAPTION_DEFAULT_OUTLINE = "#2563eb";
export const CAPTION_DEFAULT_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
export const CAPTION_DEFAULT_FONT_WEIGHT = 700;

/** detect が生成(cuts.auto.json)。機械的に検出したカット候補 */
export interface AutoCuts {
  /** 検出パラメータ(再現性のため記録) */
  params: { silenceDb: number; minSilenceSec: number; padSec: number };
  /** 無音区間(この区間がカット候補。補集合=発話区間は render の
   * BGM ダッキングにも使われる) */
  silences: Interval[];
  /** 残す区間(無音の補集合+前後パディング) */
  keepSegments: Interval[];
  /** 残す区間の合計秒数 */
  keptDurationSec: number;
  originalDurationSec: number;
}

export interface Interval {
  start: number;
  end: number;
}

/** plan が生成、人間が編集して承認する(cutplan.json) */
export interface CutPlan {
  approved: boolean;
  /** 残す区間のリスト(時系列順)。reason は人間が確認するための説明 */
  segments: PlanSegment[];
}

export interface PlanSegment {
  start: number;
  end: number;
  /** keep: 残す / cut: 切る(確認用に候補も残しておく) */
  action: "keep" | "cut";
  reason: string;
}

/** plan が生成(chapters.json)。YouTube チャプター用の章立てメタデータ
 * (概要欄の「0:00 導入」リストの元)。動画への描画には使われない:
 * 章タイトルの表示は plan が通常テロップとして transcript.json に書く */
export interface Chapters {
  chapters: {
    start: number;
    title: string;
  }[];
}

/** 画面の重なりレイヤーの識別子。overlays.json の layerOrder と
 * RenderProps で共用する。ov<N> は素材トラック(V1, V2, ... 可変個数)、
 * テロップトラックは1本目が "caption"(従来互換)、2本目以降が cap<N> */
export type LayerId = "wipe" | "caption" | `ov${number}` | `cap${number}`;

export const ovId = (n: number): LayerId => `ov${n}`;
/** "ov3" → 3。素材トラックでなければ null */
export const ovNum = (id: string): number | null => {
  const m = /^ov([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** テロップトラック n の LayerId。1本目は従来互換の "caption" */
export const capId = (n: number): LayerId => (n === 1 ? "caption" : `cap${n}`);
/** "caption" → 1、"cap3" → 3。テロップトラックでなければ null */
export const capNum = (id: string): number | null => {
  if (id === "caption" || id === "cap1") return 1;
  const m = /^cap([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** transcript セグメントのテロップトラック番号(1始まり) */
export const captionTrack = (s: { track?: number }): number => s.track ?? 1;

/** セグメントが属するテロップトラックの標準設定(captionTracks のエントリ) */
const captionTrackDefOf = (s: { track?: number }, overlays: Overlays) =>
  (overlays.captionTracks ?? []).find((t) => t.track === captionTrack(s));

/** テロップの実効表示位置。セグメント指定 → トラック標準 → null(下部中央) */
export const captionPosOf = (
  s: TranscriptSegment,
  overlays: Overlays,
): CaptionPos | null => {
  if (s.pos) return s.pos;
  const def = captionTrackDefOf(s, overlays);
  return def && def.x !== undefined && def.y !== undefined
    ? { x: def.x, y: def.y }
    : null;
};

/** テロップの実効スタイル。項目単位でトラック標準に個別指定を重ねる。
 * どちらも無ければ null(=すべて既定値) */
export const captionStyleOf = (
  s: TranscriptSegment,
  overlays: Overlays,
): CaptionStyle | null => {
  const merged: CaptionStyle = { ...captionTrackDefOf(s, overlays)?.style, ...s.style };
  return Object.keys(merged).length > 0 ? merged : null;
};

/** テロップの座標の解釈(トラック単位)。center: pos はテキスト中心 /
 * topLeft: pos はテキストボックスの左上(章タイトルなど左寄せ配置用) */
export const captionAnchorOf = (
  s: { track?: number },
  overlays: Overlays,
): "center" | "topLeft" => captionTrackDefOf(s, overlays)?.anchor ?? "center";

/** テロップトラックの表示名。captionTracks の name → 自動ラベル */
export const captionTrackName = (
  track: number,
  overlays: Overlays,
  trackCount: number,
): string => {
  const name = (overlays.captionTracks ?? []).find((t) => t.track === track)?.name;
  return name ?? (trackCount > 1 ? `テロップ T${track}` : "テロップ");
};

/** overlays エントリの素材トラック番号(1始まり)。
 * 旧式の layer は under=V1 / over=V2 に対応付ける */
export const overlayTrack = (o: { track?: number; layer?: "under" | "over" }): number =>
  o.track ?? (o.layer === "over" ? 2 : 1);

/** layerOrder 省略時の重なり順(下→上)。素材 n トラック構成。
 * n=2 は従来の固定レイアウト(V1=ワイプ下 / V2=ワイプ上)と同じで、
 * 3本目以降は V2 の上に積む */
export function defaultLayerOrder(n: number): LayerId[] {
  const extra = Array.from({ length: Math.max(0, n - 2) }, (_, i) => ovId(i + 3));
  return ["ov1", "wipe", "ov2", ...extra, "caption"];
}

/** 従来互換の既定順(素材2トラック) */
export const DEFAULT_LAYER_ORDER: LayerId[] = defaultLayerOrder(2);

/** 人間が書く演出指定(overlays.json)。ファイルが無ければ全部なし。
 * 時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒 */
export interface Overlays {
  /** 素材(画像/動画)を画面いっぱいに表示する区間 */
  overlays?: {
    start: number;
    end: number;
    /** 素材ファイル(収録フォルダからの相対パス) */
    file: string;
    /** 素材トラック番号(1始まり)。省略時 1。重なりは layerOrder が決める */
    track?: number;
    /** 旧式のトラック指定(under=V1 / over=V2)。track があればそちらが優先 */
    layer?: "under" | "over";
    /** contain: 全体を見せる(余白は黒) / cover: 画面を埋める(端が切れる)。
     *  省略時 contain */
    fit?: "contain" | "cover";
  }[];
  /** ベース映像トラックへの挿入クリップ(Premiere のインサート編集相当)。
   * カット後タイムラインの at(元収録の秒)の位置に file を durationSec ぶん
   * 差し込む。at 以降のすべての要素(keep 区間・素材・テロップ)は
   * 元収録の秒のまま動かさず、時刻写像が挿入の尺ぶん後ろへずらす */
  inserts?: {
    /** 挿入位置のアンカー(元収録の秒)。この時刻の手前に挿入される */
    at: number;
    /** 素材ファイル(収録フォルダからの相対パス) */
    file: string;
    /** 挿入する尺(秒)。動画の実尺より長いと最後のフレームで止まる */
    durationSec: number;
    /** contain: 全体を見せる(余白は黒) / cover: 画面を埋める。省略時 contain */
    fit?: "contain" | "cover";
  }[];
  /** ワイプ(カメラ)を全画面にして背景を隠す区間 */
  wipeFull?: Interval[];
  /** 画面の重なり順(下→上)。ベース映像と BGM は対象外。
   *  省略時は DEFAULT_LAYER_ORDER(エディタのトラック並べ替えが書く) */
  layerOrder?: LayerId[];
  /** テロップトラックの標準設定。x/y(出力px)はセグメント側の pos が無い
   * テロップに、style は項目単位で個別指定の無い項目に効く。位置が無い
   * トラックは従来の下部中央、style が無ければ既定の見た目。
   * anchor は座標の解釈(省略時 center=テキスト中心 / topLeft=左上。
   * 章タイトルのような左寄せ配置のトラックに使う)。
   * name はタイムラインに出すトラック名(省略時は自動ラベル) */
  captionTracks?: {
    track: number;
    name?: string;
    x?: number;
    y?: number;
    anchor?: "center" | "topLeft";
    style?: CaptionStyle;
  }[];
  /** 字幕を出さない区間 */
  hideCaption?: Interval[];
}

/** plan が生成(meta.json)。タイトル案と概要欄の下書き */
export interface Meta {
  titles: string[];
  description: string;
}
