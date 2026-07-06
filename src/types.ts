// パイプラインの中間ファイル(JSON)のスキーマ定義。
// 各ステージはここで定義した型のファイルを読み書きする。

/** ingest が生成。収録ファイルの構成情報(manifest.json) */
export interface Manifest {
  /** 収録フォルダの絶対パス */
  dir: string;
  /** 元ファイル名(収録フォルダ内) */
  source: string;
  durationSec: number;
  /** レイアウト。省略時は "obs-canvas"(旧 manifest 互換)。
   *  obs-canvas: 拡張キャンバス(画面+カメラ横並び)。cameraRegion を持つ
   *  plain:      通常動画。カメラ無し。screenRegion は全フレーム */
  layout?: "obs-canvas" | "plain";
  video: {
    width: number;
    height: number;
    fps: number;
    /** 出力に使う画面領域(=出力解像度)。obs-canvas は 3840x1080 内の
     *  画面部分、plain は全フレーム(= {x:0,y:0,w:width,h:height}) */
    screenRegion: Region;
    /** カメラ(ワイプ)領域。plain では無し(ワイプ非対応) */
    cameraRegion?: Region;
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

/** manifest のレイアウト(未指定は旧 manifest 互換で obs-canvas) */
export const manifestLayout = (m: { layout?: string }): "obs-canvas" | "plain" =>
  m.layout === "plain" ? "plain" : "obs-canvas";

/** ワイプ(カメラ)を持つレイアウトか。plain・cameraRegion 欠落は false */
export const hasCamera = (m: Manifest): boolean =>
  manifestLayout(m) === "obs-canvas" && m.video.cameraRegion != null;

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
  /** 語/トークン単位のタイミング(whisper -ojf の per-token offsets 由来)。
   * 省略可(後方互換)。**カラオケアニメ等の描画専用の補助データで、テロップの
   * 文言・表示区間そのものは常に text / start / end が正**。人間が text を
   * 手編集すると words[] は古くなりうる(§5 参照)。特殊トークン([_BEG_] /
   * [_TT_NNN] 等)と空 text は除外済み。時刻は他と同じく「元収録(raw)の秒」。
   * words[] は時系列順で、各 word の [start,end) は親 segment の [start,end] に収まる */
  words?: WordTiming[];
}

/** transcript の1語/1トークンのタイミング。whisper のサブワード単位
 * (日本語は分かち書きが無いためトークン=サブワード)。時刻は元収録の秒 */
export interface WordTiming {
  /** トークン文字列(前後空白を trim 済み。特殊トークンは含めない) */
  text: string;
  /** 開始・終了(元収録の秒)。start < end。親 segment の範囲内 */
  start: number;
  end: number;
  /** whisper の確信度(0..1、-ojf の token.p)。省略可 */
  confidence?: number;
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
  /** 登場/退場アニメ(フェード・スライド・ポップ)。省略時アニメ無し=現状
   * (器の opacity/transform は動かず、追加 div も出ない)。素材(overlays)の
   * fadeInSec/fadeOutSec に対応するテロップ版 */
  anim?: CaptionAnim;
  /** カラオケ表示(発話に同期した語の色替え)。segment.words[](語単位
   * タイムスタンプ)を消費する。省略時カラオケ無し=現状。words[] が無い
   * テロップに指定しても無視され通常表示になる(validate が警告) */
  karaoke?: CaptionKaraoke;
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

/** テロップの登場/退場アニメ。CaptionStyle.anim。省略時はアニメ無し(現状)。
 * in/out はキー単位で独立(片方だけ指定可)。durationSec は in/out 共通。
 * かかるのはテロップの器(位置・レイアウトは不変)で、opacity と transform
 * だけを時間で動かす。素材の fadeInSec/fadeOutSec に対応するテロップ版。 */
export interface CaptionAnim {
  /** 登場(表示開始 start から durationSec 秒)。省略時 in なし(瞬時に出る) */
  in?: CaptionAnimKind;
  /** 退場(表示終了 end の手前 durationSec 秒)。省略時 out なし(瞬時に消える) */
  out?: CaptionAnimKind;
  /** in/out それぞれの遷移秒。省略時 DEFAULT_CAPTION_ANIM_SEC(0.3)。
   * 表示区間が in+out より短いときは短い方へ自動で縮める(fadeFactor と同じ) */
  durationSec?: number;
}

/** アニメ種別の最小セット。"none" は明示的にアニメ無し(トラック標準を打ち消す用) */
export type CaptionAnimKind =
  | "fade"        // 不透明度 0→1
  | "slide-up"    // 下からせり上がりながらフェード
  | "slide-down"  // 上から降りながらフェード
  | "slide-left"  // 右から寄りながらフェード
  | "slide-right" // 左から寄りながらフェード
  | "pop"         // 小さめから拡大しながらフェード
  | "none";

/** テロップのカラオケ表示。CaptionStyle.karaoke。省略時はカラオケ無し(現状)。
 * segment.words[](語単位タイムスタンプ)を消費し、発話済みの語を activeColor に、
 * 未発話の語を inactiveColor(既定=テロップの本文色)にして左から順に色を進める。
 * words[] が無いテロップに指定した場合は無視され通常表示になる(validate が警告)。 */
export interface CaptionKaraoke {
  /** 発話済み(t >= 語の start)の語の色。省略時 KARAOKE_DEFAULT_ACTIVE(#ffe14d) */
  activeColor?: string;
  /** 未発話の語の色。省略時はテロップの本文色(style.color→既定の白)。
   * 「未発話は薄く」したいときは inactiveOpacity と併用 */
  inactiveColor?: string;
  /** 未発話の語の不透明度(0〜1)。省略時 1。0.4 等で「これから読む所を薄く」 */
  inactiveOpacity?: number;
  /** 語をまたぐ塗りの進み方。"word"(既定): 語単位で瞬間に色が切り替わる /
   * "fill": いま発話中の語だけ左から右へ塗り進む(karaoke 字幕の定番)。 */
  mode?: "word" | "fill";
}

/** style 未指定時の文字色・縁取り色・フォント種・太さ */
export const CAPTION_DEFAULT_COLOR = "#ffffff";
export const CAPTION_DEFAULT_OUTLINE = "#2563eb";
export const CAPTION_DEFAULT_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
export const CAPTION_DEFAULT_FONT_WEIGHT = 700;

/** CaptionAnim.durationSec 未指定時の既定(秒)。in/out 共通。描画側の最終フォールバック */
export const DEFAULT_CAPTION_ANIM_SEC = 0.3;
/** CaptionKaraoke.activeColor 未指定時の既定(発話済みの語の色) */
export const KARAOKE_DEFAULT_ACTIVE = "#ffe14d";

/** render.wipeTransitionSec 未指定時の既定(秒)。renderProps と設定画面で共有。
 * config.ts は node 専用(node:fs 等)なので、ブラウザにも入るこのファイルに置く */
export const DEFAULT_WIPE_TRANSITION_SEC = 0.3;

/** render.cutTransition.sec 未指定時の既定(秒)。dip-to-black 使用時の
 * 黒への往復の合計秒(前半でフェードアウト、後半でフェードイン) */
export const DEFAULT_CUT_TRANSITION_SEC = 0.3;

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
  /** 人間の承認意図の表示(GUI チェックボックスのモデル)。**render のゲートでは
   * ない**(src/lib/approval.ts を参照)。render は approvals.json の承認
   * レコード(keep 集合のハッシュに束縛)だけを見る。ここが true でもレコードが
   * 無い/内容が変わっていれば render は拒否される(validate が警告する) */
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

/** 承認レコード(approvals.json)。承認は cutplan/short の keep 集合の
 * ハッシュに束縛され、内容が変われば hash 不一致で自動失効する。
 * render の唯一のゲート。boolean approved は人間の意図表示に降格
 * (CutPlan.approved / Short.approved のコメント参照)。
 * 収録フォルダ直下の別ファイルに置く(cutplan.json 等の編集ワークフローとは
 * 別行為にするため。src/lib/approval.ts が算出・読み書きする) */
export interface Approvals {
  version: 1;
  cutplan?: ApprovalRecord;
  shorts?: Record<string, ApprovalRecord>;
}

export interface ApprovalRecord {
  /** "sha256:…"。src/lib/approval.ts が現内容から算出した値と一致で承認有効 */
  hash: string;
  /** 承認した時刻(情報用。ゲート判定には使わない) */
  approvedAt: string;
  /** 承認した経路(情報用。監査の助け。信頼できる値ではないため判定には使わない) */
  by?: "cli" | "gui";
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
 * 3本目以降は V2 の上に積む。n=1(素材ゼロ/1本の案件)は意図的に
 * ワイプより上の素材レーン(V2)を出さない(空トラック抑制) */
export function defaultLayerOrder(n: number): LayerId[] {
  const extra = Array.from({ length: Math.max(0, n - 1) }, (_, i) => ovId(i + 2));
  return ["ov1", "wipe", ...extra, "caption"];
}

/** 従来互換の既定順(素材2トラック) */
export const DEFAULT_LAYER_ORDER: LayerId[] = defaultLayerOrder(2);

/** テロップトラックの標準設定1件。overlays.json の captionTracks と
 * shorts.json の各ショートの captionTracks で共用する */
export interface CaptionTrackDef {
  track: number;
  name?: string;
  x?: number;
  y?: number;
  anchor?: "center" | "topLeft";
  style?: CaptionStyle;
}

/** 人間が書く演出指定(overlays.json)。ファイルが無ければ全部なし。
 * 時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒 */
export interface Overlays {
  /** 素材(画像/動画)を表示する区間。省略時は画面いっぱい、rect で
   * 部分配置(ピクチャ・イン・ピクチャ)もできる */
  overlays?: {
    start: number;
    end: number;
    /** 素材ファイル(収録フォルダからの相対パス) */
    file: string;
    /** 素材トラック番号(1始まり)。省略時 1。重なりは layerOrder が決める */
    track?: number;
    /** 旧式のトラック指定(under=V1 / over=V2)。track があればそちらが優先 */
    layer?: "under" | "over";
    /** contain: 全体を見せる(全画面時の余白は黒、rect 配置時は透過) /
     *  cover: 領域を埋める(端が切れる)。省略時 contain */
    fit?: "contain" | "cover";
    /** 頭出し(In点)。素材ファイル内の再生開始位置(秒)。省略時 0(頭から)。
     *  動画素材のみ有効(画像では無視) */
    startFrom?: number;
    /** 音量(0〜2、1=素材の音量のまま)。省略時 0 = 無音(従来どおり)。
     *  動画素材のみ有効。マイク音声・BGM はそのまま重なる */
    volume?: number;
    /** 不透明度(0〜1)。省略時 1 */
    opacity?: number;
    /** フェードイン/アウト(秒)。表示区間の頭/末尾で不透明度(と音量)を
     *  なめらかに遷移する。省略時 0(なし) */
    fadeInSec?: number;
    fadeOutSec?: number;
    /** 表示領域(出力px の {x, y, w, h})。省略時は全画面。
     *  fit はこの領域内での素材の収め方になる */
    rect?: Region;
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
    /** 頭出し(In点)。素材ファイル内の再生開始位置(秒)。省略時 0(頭から)。
     *  動画素材のみ有効(画像では無視)。startFrom + durationSec が素材の
     *  実尺を超えると、超えた分は最後のフレームで止まる */
    startFrom?: number;
    /** contain: 全体を見せる(余白は黒) / cover: 画面を埋める。省略時 contain */
    fit?: "contain" | "cover";
    /** 音量(0〜2、1=素材の音量のまま)。省略時 1(音声込み。従来どおり)。
     *  0 で無音になる */
    volume?: number;
    /** フェードイン/アウト(秒)。黒からの明転/黒への暗転(音量も連動)。
     *  省略時 0(なし) */
    fadeInSec?: number;
    fadeOutSec?: number;
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
  captionTracks?: CaptionTrackDef[];
  /** 字幕を出さない区間 */
  hideCaption?: Interval[];
  /** ズーム演出(画面の一部を拡大して見せる)。区間は重ならないこと。
   * かかるのはベース映像の背景レイヤー(画面クロップ)だけで、ワイプ・
   * テロップ・素材オーバーレイ・挿入クリップは動かない。ショート
   * (profile の layout 経路)には効かない(overlays.json を継承しないため) */
  zooms?: Zoom[];
  /** 簡易カラー調整(全編一律。区間指定なし)。かかるのはベース映像
   * (画面クロップ+カメラ=同一収録動画)だけで、素材オーバーレイ・
   * 挿入クリップには効かない。ショート(profile の layout 経路)にも
   * 例外的に継承される(本編とショートで肌色が変わる事故を防ぐため。
   * render.ts のショート経路がここだけ拾って渡す) */
  colorFilter?: ColorFilter;
  /** 領域ぼかし/モザイク(秘匿情報の目隠し)。かかるのはベース映像
   * (画面クロップ)だけで、素材・挿入・テロップは対象外。zoom には追従せず
   * 出力px固定。ショート(profile 経路)には継承されない(座標が本編基準の
   * ため。shorts があると validate が警告する) */
  blurs?: BlurRegion[];
}

/** 簡易カラー調整(overlays.json の colorFilter)。各キー省略可・既定 1.0
 * (無補正)。CSS filter(brightness/contrast/saturate)として解決する */
export interface ColorFilter {
  brightness?: number;
  contrast?: number;
  saturate?: number;
}

/** ズーム演出1件(overlays.json の zooms)。start/end は元収録の秒 */
export interface Zoom {
  start: number;
  end: number;
  /** 全画面に拡大する矩形(出力px。テロップ pos・overlays rect と同じ座標系)。
   * 拡大率は書かせない(rect の幅から scale = 出力幅 / rect.w が一意に決まる。
   * 倍率と rect の二重指定は矛盾の温床になるため) */
  rect: Region;
  /** 区間の頭でズームイン・末尾でズームアウトする遷移時間(秒)。
   * 省略時 config.yaml の render.zoom.easeSec(既定 DEFAULT_ZOOM_EASE_SEC)。
   * 区間が遷移2回分より短いときは遷移を区間の半分へ縮める(wipeFull と同じ規則) */
  easeSec?: number;
}

/** render.zoom.easeSec 未指定時の既定(秒)。renderProps と設定画面で共有 */
export const DEFAULT_ZOOM_EASE_SEC = 0.4;

/** 領域ぼかし/モザイクの効果種別。省略時 "blur"。
 * 将来 "box"(単色塗り)を足す場合はここに追加する(今はスコープ外) */
export type BlurType = "blur" | "mosaic";

/** 領域ぼかし/モザイク1件(overlays.json の blurs)。開発画面の API キー・
 * PII・パスワードなど、ベース映像(画面クロップ)の一部を隠す。start/end は
 * 元収録の秒、rect は出力px({x,y,w,h}。テロップ pos・zooms rect と同座標系)。
 * かかるのはベース映像だけ。zoom には追従せず出力px固定(zoom と時間が重なる
 * と validate が警告する)。ショート(profile 経路)には継承されない */
export interface BlurRegion {
  start: number;
  end: number;
  /** 隠す矩形(出力px)。画面外へはみ出すと validate がエラーにする */
  rect: Region;
  /** 効果種別。省略時 "blur"(CSS ぼかし)。"mosaic" はピクセル化 */
  type?: BlurType;
  /** 強度(0〜1)。省略時 0.5。type ごとに px へ写像する
   * (blur=ぼかし半径 / mosaic=ブロック辺長。src/lib/blur.ts) */
  strength?: number;
}

/** BlurRegion.strength / type 未指定時の既定。renderProps と描画・検査で共有 */
export const DEFAULT_BLUR_STRENGTH = 0.5;
export const DEFAULT_BLUR_TYPE: BlurType = "blur";

/** 人間が書く BGM 指定(bgm.json)。ファイルが無ければ、収録フォルダ直下の
 * bgm.mp3 / bgm.m4a / bgm.wav(あれば)を全編1曲として流す従来動作になる。
 * 時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒 */
export interface Bgm {
  /** BGM を流す区間。時系列順でなくてよく、覆っていない区間は無音になる
   * (「イントロだけ BGM なし」= その区間を覆わない)。別ファイルの区間を
   * 並べれば曲の切り替え、区間を重ねれば重奏になる。各区間はループ再生 */
  tracks: {
    /** 流し始め(元収録の秒) */
    start: number;
    /** 流し終わり(元収録の秒) */
    end: number;
    /** BGM ファイル(収録フォルダからの相対パス。例: bgm.mp3 / materials/outro.mp3) */
    file: string;
    /** 音量(dB)。0=原音量。省略時は config の render.bgm.volumeDb */
    volumeDb?: number;
    /** 頭出し(In点)。ファイル内の再生開始位置(秒)。省略時 0(頭から) */
    startFrom?: number;
    /** フェードイン/アウト(秒)。区間の頭/末尾で音量をなめらかに遷移する。
     *  省略時 0(なし)。区間終端を動画の終端に合わせて fadeOutSec を付けると
     *  従来の終端フェードアウトと同じになる */
    fadeInSec?: number;
    fadeOutSec?: number;
  }[];
}

/** plan が生成(meta.json)。タイトル案と概要欄の下書き */
export interface Meta {
  titles: string[];
  description: string;
}

/** 人間が書くショート動画指定(shorts.json)。ファイルが無ければショートは
 * 無い。時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒 */
export interface Shorts {
  shorts: Short[];
}

export interface Short {
  /** 出力ファイル名(shorts/<name>.mp4)。[a-z0-9-_]+ のみ・収録内で一意 */
  name: string;
  /** 出力プロファイル(src/lib/profile.ts の PROFILES のキー)。
   * 省略時 "vertical" */
  profile?: string;
  /** 人間の承認意図の表示。**render --short のゲートではない**(cutplan.json の
   * approved と同じく src/lib/approval.ts の承認レコードに格下げ済み。承認は
   * 人間の仕事で AI が自分で true にしない、という原則自体は変わらない) */
  approved: boolean;
  /** このショートの keep 区間(元収録の秒)。本編 cutplan の keep とは独立で、
   * mergeIntervals した集合がそのままショートの keep 集合になる(交差なし)。
   * 飛び区間で連結でき、フィラーを飛ばしたいときはレンジを分割する */
  ranges: Interval[];
  /** 縦用テロップ位置/スタイルの上書き(任意)。overlays.captionTracks と
   * 同型・同じ解決順(セグメント → トラック標準 → 既定)で
   * buildRenderProps に渡す */
  captionTracks?: CaptionTrackDef[];
}

/** 人間/AIが書くサムネイル指定(thumbnail.json)。t は元収録の秒で、
 * frames と違いスナップしない(カットされた瞬間も指定できる。サムネは
 * 動画に入っていない絵も使ってよいため) */
export interface Thumbnail {
  t: number;
  texts: ThumbnailText[];
}

export interface ThumbnailText {
  text: string;
  /** 表示位置(テキスト中心、出力px)。transcript のテロップと違い省略不可
   * (サムネに「既定の下部中央」は無い) */
  pos: CaptionPos;
  /** 見た目。transcript のテロップと同じ CaptionStyle を共有する
   * (動画と見た目の言語を揃えるため) */
  style?: CaptionStyle;
}
