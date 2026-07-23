// 左レール「ステッカー」「エフェクト」タブのプリセット・ライブラリ。
// データモデルの変更はゼロ: 既存の overlays.zooms / blurs / annotations /
// wipeFull を書くだけの叩き台(rect/from-to は addByKind の既定値と同じ
// 「編集後にインスペクタで調整する前提」)。
// 設計: docs/plans/2026-07-23-editor-left-rail-tabs-consolidation-design.md §6.2/§7

import type { AnnotationPatch } from "./model.ts";

/** タイムラインのどのトラックに入るか(TrackId と一致させる) */
export type PresetTrack = "annotation" | "zoom" | "blur" | "wipe";

export interface PresetPatch {
  /** annotation の type 切替(box → arrow / spotlight) */
  type?: "arrow" | "box" | "spotlight";
  /** 出力サイズ比の矩形。{x,y,w,h} すべて 0-1 */
  rectRatio?: { x: number; y: number; w: number; h: number };
  /** 矢印の始点・終点(出力サイズ比) */
  fromRatio?: { x: number; y: number };
  toRatio?: { x: number; y: number };
  /** そのまま渡す見た目フィールド(px 指定のものは出力幅 1920 基準で
   * resolvePresetPatch がスケールする) */
  style?: Omit<AnnotationPatch, "type" | "start" | "end" | "rect" | "from" | "to">;
}

export interface EditorPreset {
  /** 安定な識別子。DnD の dataTransfer に載る値でもある */
  id: string;
  /** カードのラベル(日本語) */
  label: string;
  /** カードの補足(title 属性。1行) */
  hint: string;
  /** 追加時に呼ぶ addByKind の種別 */
  kind: "annotation" | "zoom" | "blur" | "wipeFull";
  /** 入る先のトラック(ドラッグ中に一時的に表示する行の決定に使う) */
  track: PresetTrack;
  /** 追加直後に当てる部分パッチ。省略時は add*Span の既定値そのまま */
  patch?: PresetPatch;
}

/** ステッカータブ = overlays.annotations の図形プリセット。
 * arrow / box / spotlight を最低1つ以上含む */
export const ANNOTATION_PRESETS: EditorPreset[] = [
  {
    id: "ann-box",
    label: "囲み(標準)",
    hint: "四角い枠で囲んで注目させます",
    kind: "annotation",
    track: "annotation",
  },
  {
    id: "ann-box-thick",
    label: "囲み(太線)",
    hint: "太めの枠線で強調します",
    kind: "annotation",
    track: "annotation",
    patch: { type: "box", style: { widthPx: 12, radiusPx: 4 } },
  },
  {
    id: "ann-box-fill",
    label: "囲み(半透明塗り)",
    hint: "枠の内側を薄い赤で塗ります",
    kind: "annotation",
    track: "annotation",
    patch: { type: "box", style: { fill: "rgba(255,80,80,0.18)" } },
  },
  {
    id: "ann-arrow-right",
    label: "矢印(左→右)",
    hint: "左から右へ指し示す矢印です",
    kind: "annotation",
    track: "annotation",
    patch: { type: "arrow", fromRatio: { x: 0.25, y: 0.5 }, toRatio: { x: 0.6, y: 0.5 } },
  },
  {
    id: "ann-arrow-down",
    label: "矢印(上→下)",
    hint: "上から下へ指し示す矢印です",
    kind: "annotation",
    track: "annotation",
    patch: { type: "arrow", fromRatio: { x: 0.5, y: 0.2 }, toRatio: { x: 0.5, y: 0.55 } },
  },
  {
    id: "ann-spotlight",
    label: "スポットライト",
    hint: "指定範囲以外を暗くして注目を集めます",
    kind: "annotation",
    track: "annotation",
    patch: { type: "spotlight", rectRatio: { x: 1 / 3, y: 3 / 8, w: 1 / 3, h: 1 / 4 } },
  },
  {
    id: "ann-spotlight-ellipse",
    label: "スポットライト(楕円)",
    hint: "楕円形のスポットライトです",
    kind: "annotation",
    track: "annotation",
    patch: {
      type: "spotlight",
      rectRatio: { x: 1 / 3, y: 3 / 8, w: 1 / 3, h: 1 / 4 },
      style: { shape: "ellipse" },
    },
  },
];

/** エフェクトタブ = ズーム/ぼかし/ワイプのプリセット。
 * トランジションタブが持っていた wipeFull の追加口をここへ移設する
 * (§2: 空トラックは表示されないので、最初の1個を作る手段はタブしかない) */
export const EFFECT_PRESETS: EditorPreset[] = [
  {
    id: "zoom-center",
    label: "ズーム(中央)",
    hint: "画面中央を拡大します",
    kind: "zoom",
    track: "zoom",
  },
  {
    id: "zoom-topleft",
    label: "ズーム(左上)",
    hint: "画面左上を拡大します",
    kind: "zoom",
    track: "zoom",
    patch: { rectRatio: { x: 0.02, y: 0.05, w: 0.5, h: 0.5 } },
  },
  {
    id: "zoom-topright",
    label: "ズーム(右上)",
    hint: "画面右上を拡大します",
    kind: "zoom",
    track: "zoom",
    patch: { rectRatio: { x: 0.48, y: 0.05, w: 0.5, h: 0.5 } },
  },
  {
    id: "blur-center",
    label: "ぼかし(中央帯)",
    hint: "画面中央の帯をぼかして隠します",
    kind: "blur",
    track: "blur",
  },
  {
    id: "blur-wide",
    label: "ぼかし(横長・URLバー想定)",
    hint: "横長の領域をぼかします(URL バー等の目隠しに)",
    kind: "blur",
    track: "blur",
    patch: { rectRatio: { x: 0.08, y: 0.06, w: 0.6, h: 0.06 } },
  },
  {
    id: "wipe-full",
    label: "ワイプ全画面",
    hint: "カメラワイプを全画面に切り替えます(カメラのある収録でのみ使えます)",
    kind: "wipeFull",
    track: "wipe",
  },
];
