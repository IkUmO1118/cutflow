// タイムライン UI のデータモデル。
// タイムラインの横軸は「カット後の秒」(プレビュー再生と同じ軸)、
// 編集対象の JSON は「元収録の秒」なので、App が両者を変換する。
//
// トラックは Premiere / Final Cut と同じく「動画の基本構成要素」で構成し、
// 上にあるトラックほど前面(z-index が高い)に描画されるものを置く。
// 並びは overlays.json の layerOrder(下→上)で自由に入れ替えられる
// (ベースの映像と BGM は固定)。wipeFull(ワイプ全画面)は独立トラックに
// せず、ワイプレイヤー上の属性スパンとして表現する。字幕を
// 隠したい場合はテロップそのものを削る・縮める(hideCaption は手書き互換)。

import { capNum, ovNum } from "../../src/types.ts";
import type { AnnotationType, CaptionPos, LayerId, Region, SpotlightShape } from "../../src/types.ts";

/** overlays.json のどの配列か(hide 系はエディタ非表示の手書き互換)。
 * "short" はショートモードの ranges 帯(shorts.json のショート単位)。
 * "zoom" はズーム演出(overlays.json の zooms)の区間。
 * "blur" は領域ぼかし(overlays.json の blurs)の区間。
 * "annotation" は注釈グラフィック(overlays.json の annotations)の区間 */
export type SpanKind =
  | "overlays"
  | "wipeFull"
  | "hideCaption"
  | "short"
  | "zoom"
  | "blur"
  | "annotation";

/** トラックの空き領域ドラッグで作れる区間の種類 */
export type AddKind =
  | "overlays"
  | "wipeFull"
  | "caption"
  | "bgm"
  | "short"
  | "zoom"
  | "blur"
  | "annotation";

/** 選択・ドラッグの対象。index は各ドキュメントの配列の添字
 * (caption は transcript.segments、insert は overlays.inserts の添字、
 * short はショートモード中の選択中ショートの ranges の添字、
 * zoom は overlays.zooms の添字、blur は overlays.blurs の添字、
 * annotation は overlays.annotations の添字)。
 * captionTrack だけは例外で、index は**配列の添字ではなくテロップトラック番号**
 * (1始まり。overlays.json の captionTracks[].track と同じ値)。クリップではなく
 * トラックそのものを選んだ状態=インスペクタがそのトラックの標準デザインを編集する。
 * wipe / bgm は表示専用 */
export type SelKind =
  | "cut"
  | "insert"
  | "caption"
  | "captionTrack"
  | "overlays"
  | "wipeFull"
  | "wipe"
  | "bgm"
  | "short"
  | "zoom"
  | "blur"
  | "annotation";
export type Selection = { kind: SelKind; index: number } | null;

export type DragMode = "move" | "trim-start" | "trim-end";

/** 音声を持つ固定トラック(映像・BGM)。ラベルにミュートボタンを出す */
export type AudioTrackId = "cut" | "bgm";

export type TrackId =
  | "caption"
  | "wipe"
  | "zoom"
  | "blur"
  | "annotation"
  | "cut"
  | "bgm"
  | "short"
  | `ov${number}`
  | `cap${number}`;

export interface TrackDef {
  id: TrackId;
  label: string;
  /** 空き領域のドラッグで区間を作れるトラックはその作成先 */
  createKind?: AddKind;
  hint?: string;
  /** ラベルの上下ドラッグで重なり順(overlays.json の layerOrder)を変えられる */
  reorderable?: boolean;
  /** 音声トラック(映像・BGM)。ラベルにプレビューミュートのボタンを出す */
  audio?: AudioTrackId;
  /** 重ね合わせレイヤー(ワイプ・素材・テロップ)。ラベルに
   * プレビュー専用の目トグル(一時非表示)を出す */
  layer?: LayerId;
  /** テロップトラック番号(ダブルクリックでトラック名を変更できる) */
  renamableCaption?: number;
}

const REORDER_HINT = "ラベルを上下にドラッグで重なり順を変更";
const TRACK_DEFS = {
  wipe: {
    id: "wipe", label: "ワイプ", createKind: "wipeFull", reorderable: true, layer: "wipe",
    hint: `ドラッグで全画面区間を作成。${REORDER_HINT}`,
  },
  zoom: {
    id: "zoom", label: "ズーム", createKind: "zoom",
    hint:
      "画面の一部を拡大して見せる区間(overlays.json の zooms)。" +
      "ドラッグで区間を作成。かかるのはベース映像の背景だけで、" +
      "ワイプ・テロップ・素材は動かない",
  },
  blur: {
    id: "blur", label: "ぼかし", createKind: "blur",
    hint:
      "領域ぼかし区間(overlays.json の blurs)。秘匿情報の目隠し。" +
      "ドラッグで区間を作成。かかるのはベース映像だけで、ズームには追従せず" +
      "出力px固定(ショートには継承されない)",
  },
  annotation: {
    id: "annotation", label: "注釈", createKind: "annotation",
    hint:
      "注釈グラフィック区間(overlays.json の annotations)。矢印・囲み・" +
      "スポットライトで「ここを見ろ」を示す。ドラッグで区間を作成(既定は囲み)。" +
      "最前面(テロップより上)・ズームには追従せず出力px固定(ショートには継承されない)",
  },
  cut: {
    id: "cut", label: "映像", audio: "cut",
    hint:
      "画面+マイク。keep 区間の移動・トリム(最下層固定)。" +
      "ファイルをドロップするとその位置にインサート(後続が後ろへズレる)",
  },
  bgm: {
    id: "bgm", label: "BGM", audio: "bgm", createKind: "bgm",
    hint:
      "BGM 区間(bgm.json)。区間の端をドラッグで削り(イントロ無音など)、" +
      "本体をドラッグで移動。空きをドラッグで区間作成、音声/動画ファイルを" +
      "ドロップで追加。区間を並べれば曲の切り替え・重ねれば重奏。覆っていない" +
      "時間は無音(bgm.json が無ければ収録フォルダ直下の bgm.* を全編で流す)",
  },
  short: {
    id: "short", label: "ショート範囲", createKind: "short",
    hint:
      "このショートの ranges(元収録の keep 集合。本編のカットとは独立)。" +
      "ドラッグで移動・端をトリム、空きをドラッグで区間を追加",
  },
} satisfies Partial<Record<TrackId, TrackDef>>;

/** ショートモードのタイムライン専用トラック(ranges 帯)。App.tsx が
 * この1本 + テロップトラックだけを Timeline へ渡す(D6: 別ビューを作らない) */
export const SHORT_TRACK_DEF: TrackDef = TRACK_DEFS.short;

/** 素材トラック(V1, V2, ... 可変個数)の定義 */
const materialTrackDef = (n: number): TrackDef => ({
  id: `ov${n}`,
  label: `素材 V${n}`,
  createKind: "overlays",
  reorderable: true,
  layer: `ov${n}`,
  hint:
    `素材トラック。空きをドラッグで区間作成、ファイルをドロップで追加。` +
    `クリップは上下ドラッグで別の素材トラックへ。${REORDER_HINT}`,
});

/** テロップトラック(T1, T2, ... 可変個数)の定義。1本目の id は従来互換の
 * "caption"。表示位置・スタイルは全トラック共通(重なり順だけが違う)。
 * name は overlays.json の captionTracks に付けた任意のトラック名 */
const captionTrackDef = (n: number, count: number, name?: string): TrackDef => ({
  id: n === 1 ? "caption" : `cap${n}`,
  label: name ?? (count > 1 ? `テロップ T${n}` : "テロップ"),
  createKind: "caption",
  reorderable: true,
  layer: n === 1 ? "caption" : `cap${n}`,
  renamableCaption: n,
  hint:
    `ドラッグで追加、選択して文言を編集。ラベルのダブルクリックで名前を変更。` +
    (count > 1 ? `クリップは上下ドラッグで別のテロップトラックへ。` : "") +
    REORDER_HINT,
});

/** 表示順(上=前面)。layerOrder(下→上)を逆順に並べ、
 * ベースの映像と BGM は最下段に固定する。
 * capName はテロップトラック名の解決(overlays.json の captionTracks) */
export const buildTracks = (
  layerOrder: LayerId[],
  capName?: (n: number) => string | undefined,
): TrackDef[] => {
  const capCount = layerOrder.filter((id) => capNum(id) !== null).length;
  return [
    ...[...layerOrder].reverse().map((id) => {
      const n = ovNum(id);
      if (n !== null) return materialTrackDef(n);
      const cn = capNum(id);
      if (cn !== null) return captionTrackDef(cn, capCount, capName?.(cn));
      return TRACK_DEFS[id as keyof typeof TRACK_DEFS];
    }),
    TRACK_DEFS.zoom,
    TRACK_DEFS.blur,
    TRACK_DEFS.annotation,
    TRACK_DEFS.cut,
    TRACK_DEFS.bgm,
  ];
};

/** annotation の部分更新パッチ(App の updateAnnotation / Inspector の
 * type 切替・見た目編集で使う緩い union)。delete-undefined 機構
 * (undefined を渡すとキー削除)に type 切替も乗せるため、各 union
 * メンバーのフィールドを全部緩く持たせる */
export type AnnotationPatch = {
  type?: AnnotationType;
  start?: number;
  end?: number;
  from?: CaptionPos;
  to?: CaptionPos;
  rect?: Region;
  color?: string;
  fill?: string;
  widthPx?: number;
  headPx?: number;
  radiusPx?: number;
  featherPx?: number;
  dim?: number;
  shape?: SpotlightShape;
};

/** タイムラインの1行の高さ(px)。上下ドラッグのトラック判定にも使う */
export const ROW_H = 26;

/** 素材パネル → タイムラインへのドラッグで使う dataTransfer の型
 * (値はプロジェクト相対パス "materials/..."。OS のファイルドロップと区別する) */
export const MATERIAL_MIME = "application/x-cutflow-material";

/** 映像トラックの継ぎ目に出す「カットされた区間」の印。index は
 * cutplan.segments の添字(選択はクリップと同じ kind "cut" を使い回す)。
 * out = 継ぎ目のカット後秒。stack = 同じ継ぎ目に複数の記録があるときの
 * 横ずらし段数(両方掴めるように) */
export interface CutMark {
  index: number;
  out: number;
  durSec: number;
  reason: string;
  stack: number;
}

/** タイムラインに置かれる1ブロック。カットをまたぐ区間は複数に割れるので
 * 同じ kind/index のクリップが複数できることがある */
export interface Clip {
  kind: SelKind;
  index: number;
  track: TrackId;
  /** カット後の秒 */
  outStart: number;
  outEnd: number;
  label?: string;
  /** false は選択・ドラッグ不可 */
  editable: boolean;
  /** 背景レイヤー表示(ワイプ本体・BGM)。ポインタも素通しする */
  static?: boolean;
  /** 左端トリム不可(挿入クリップのアンカー / カットで割れた継ぎ目の辺) */
  noTrimStart?: boolean;
  /** 右端トリム不可(カットで割れた継ぎ目の辺。本当の端だけを掴ませる) */
  noTrimEnd?: boolean;
  /** クリップに描く音声波形。src = ピークの取得元("" はマイク音声、
   * それ以外は素材・BGM の相対パス)。startSec = クリップ先頭に対応する
   * 音声内の秒(クリップ内は連続な前提)。loop = ファイル末尾で先頭へ
   * 戻って描く(BGM はループ合成されるため)。
   * 合成で音が出ないもの(ワイプ・素材トラック)には付けない */
  wave?: { src: string; startSec: number; loop?: boolean };
}

/** 元収録の秒で表す区間(ズーム・ぼかし等の共通部分) */
export interface TimeSpan {
  start: number;
  end: number;
}

/** ズーム区間の重なり回避。ズームは重なれない(CLI と同じ検査を通す保存が
 * 「ズーム区間が重なっています」で落ち、GUI からは直せない状態になる)ので、
 * 編集後の span を「自分以外のズームが空けている隙間」へ収めてから採る。
 *
 * mode="move" は尺を保ったまま隣のズームの手前で止める(隙間が尺より狭ければ
 * null=そのドラッグを採らない)。trim / create は端を隙間へクランプする。
 * 隙間が最小幅(minSpan)未満、またはアンカーが既存ズームの内側なら null。
 * others は順不同でよい。返す秒は round2 済み(呼び出し側の量子と揃える) */
export function fitZoomSpan(
  others: readonly TimeSpan[],
  span: TimeSpan,
  mode: "create" | "move" | "trim-start" | "trim-end",
  minSpan: number,
): TimeSpan | null {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const dur = span.end - span.start;
  if (dur < minSpan) return null;
  // どの隙間へ収めるかはアンカー(動かさない側の点)で決める。move / create は
  // 移動後の中点、trim は固定端のすぐ内側(編集前の span は重なっていない前提)
  const anchor =
    mode === "move" || mode === "create"
      ? (span.start + span.end) / 2
      : mode === "trim-start"
        ? span.end - minSpan / 2
        : span.start + minSpan / 2;
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  for (const o of others) {
    if (o.start < anchor && anchor < o.end) return null; // 隙間が無い
    if (o.end <= anchor) lo = Math.max(lo, o.end);
    if (o.start >= anchor) hi = Math.min(hi, o.start);
  }
  if (hi - lo < minSpan) return null;
  if (mode === "move") {
    if (hi - lo < dur) return null; // 尺のまま平行移動では収まらない
    const start = Math.min(Math.max(span.start, lo), hi - dur);
    return { start: r2(start), end: r2(start + dur) };
  }
  const start = Math.max(span.start, lo);
  const end = Math.min(span.end, hi);
  if (end - start < minSpan) return null;
  return { start: r2(start), end: r2(end) };
}
