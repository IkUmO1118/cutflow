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
import type { LayerId } from "../../src/types.ts";

/** overlays.json のどの配列か(hide 系はエディタ非表示の手書き互換) */
export type SpanKind = "overlays" | "wipeFull" | "hideCaption";

/** トラックの空き領域ドラッグで作れる区間の種類 */
export type AddKind = "overlays" | "wipeFull" | "caption";

/** 選択・ドラッグの対象。index は各ドキュメントの配列の添字
 * (caption は transcript.segments、insert は overlays.inserts の添字)。
 * wipe / bgm は表示専用 */
export type SelKind =
  | "cut"
  | "insert"
  | "caption"
  | "overlays"
  | "wipeFull"
  | "wipe"
  | "bgm";
export type Selection = { kind: SelKind; index: number } | null;

export type DragMode = "move" | "trim-start" | "trim-end";

/** 音声を持つ固定トラック(映像・BGM)。ラベルにミュートボタンを出す */
export type AudioTrackId = "cut" | "bgm";

export type TrackId =
  | "caption"
  | "wipe"
  | "cut"
  | "bgm"
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
  cut: {
    id: "cut", label: "映像", audio: "cut",
    hint:
      "画面+マイク。keep 区間の移動・トリム(最下層固定)。" +
      "ファイルをドロップするとその位置にインサート(後続が後ろへズレる)",
  },
  bgm: { id: "bgm", label: "BGM", audio: "bgm" },
} satisfies Partial<Record<TrackId, TrackDef>>;

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
    TRACK_DEFS.cut,
    TRACK_DEFS.bgm,
  ];
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
