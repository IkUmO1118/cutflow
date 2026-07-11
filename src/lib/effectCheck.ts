// E3(座標視覚検証)+ E4(zoom 相互作用)+ E5(密度ガード)の決定論ロジック。
// §docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md
//
// fs/LLM/VLM に一切依存しない純関数のみ。overlays.json(または呼び出し側が
// 組んだ caption 矩形)を入力に取り、`apply` が食える @id 宛先の EditOp[] を
// 組み立てる。時刻・矩形はすべて既存の zoom/blur/annotation rect からの
// 算術で決まり、LLM/VLM には一切書かせない(母艦 原則4)。
//
// 型の1点だけ設計書の pseudocode(§3 A)から意図的に変えている:
// EffectWarning.suggestion(単数)ではなく suggestions(複数、EditOp[])にした。
// 「zoom 終端の後ろへずらす」補正は start と end の2フィールドを別々の
// set op で変える必要があり(apply の EditOp は1 op = 1 field)、単数の
// suggestion では表現できないため。buildEffectFixPatch は全 suggestions を
// フラットに ops へ束ねる(意味的な不変条件は変えていない)。
import type {
  Annotation,
  EditOp,
  Overlays,
  Region,
  Zoom,
} from "../types.ts";

export interface EffectCheckCfg {
  /** 密度判定の窓(秒)。既定 5 */
  densityWindowSec: number;
  /** 窓内の演出本数の上限。既定 3 */
  maxPerWindow: number;
  /** annotation 表示尺の上限(秒)。既定 8 */
  maxAnnotationSec: number;
  /** 「重なり」とみなす rect 交差率(0..1)。既定 0.3 */
  minRectOverlapRatio: number;
  /** VLM 二次確認を使うか。既定 true(vision route 不在なら呼び出し側が自動 false にする) */
  useVlm: boolean;
}

export interface EffectWarning {
  kind:
    | "annotation-zoom-overlap"
    | "blur-zoom-overlap"
    | "density"
    | "annotation-too-long"
    | "caption-overlap"
    | "vlm-mismatch";
  /** 対象要素の @id(あれば。id 未採番の要素は undefined) */
  refId?: string;
  startSec: number;
  endSec: number;
  message: string;
  /** 決定論の補正候補(apply の set)。無いこともある(id 未採番・補正不能) */
  suggestions?: EditOp[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** rect どうしの重なり率(0..1)。交差面積 / 小さい方の面積。交差なしは0 */
export function rectOverlapRatio(a: Region, b: Region): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const smaller = Math.min(Math.max(0, a.w * a.h), Math.max(0, b.w * b.h));
  if (smaller <= 0) return 0;
  return inter / smaller;
}

/** 時間区間の重なり(境界共有=接するだけは重なり扱いしない) */
export function timeOverlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/** outer が inner を完全に包含するか(境界含む) */
function containsRect(outer: Region, inner: Region): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** annotation から矩形を取る(box/spotlight のみ。arrow は点なので null) */
function annotationRect(a: Annotation): Region | null {
  if (a.type === "box" || a.type === "spotlight") return a.rect;
  return null;
}

/** zoom 終端の後ろへずらす2 op(start/end を個別 set)。id が無ければ空配列 */
function shiftAfterZoomOps(id: string | undefined, start: number, end: number, zoom: Zoom): EditOp[] {
  if (!id) return [];
  const durationSec = end - start;
  const newStart = round2(zoom.end);
  const newEnd = round2(zoom.end + durationSec);
  return [
    { op: "set", target: `@${id}`, field: "start", value: newStart },
    { op: "set", target: `@${id}`, field: "end", value: newEnd },
  ];
}

/** rect を zoom 領域いっぱいへ広げる1 op。id が無ければ空配列 */
function widenToZoomOps(id: string | undefined, zoom: Zoom): EditOp[] {
  if (!id) return [];
  return [{ op: "set", target: `@${id}`, field: "rect", value: { ...zoom.rect } }];
}

/**
 * E4: zoom と固定px演出(blur/annotation)の時間重なりを検出する。
 * - blur×zoom: rect を持つので widen-vs-shift の補正まで出す(zoom.rect が
 *   blur.rect を包含するなら「blur rect を zoom 領域いっぱいへ広げる」、
 *   包含しないなら「blur を zoom 終端の後ろへずらす」)。
 * - annotation×zoom: box/spotlight は blur と同じ widen-vs-shift、
 *   arrow は rect を持たないため shift のみ(widen できる矩形が無い)。
 * - 重ならなければ何も出さない。
 */
export function checkZoomInteraction(overlays: Overlays): EffectWarning[] {
  const zooms = overlays.zooms ?? [];
  if (zooms.length === 0) return [];
  const warnings: EffectWarning[] = [];

  for (const blur of overlays.blurs ?? []) {
    for (const zoom of zooms) {
      if (!timeOverlaps(blur.start, blur.end, zoom.start, zoom.end)) continue;
      const suggestions = containsRect(zoom.rect, blur.rect)
        ? widenToZoomOps(blur.id, zoom)
        : shiftAfterZoomOps(blur.id, blur.start, blur.end, zoom);
      warnings.push({
        kind: "blur-zoom-overlap",
        refId: blur.id,
        startSec: Math.max(blur.start, zoom.start),
        endSec: Math.min(blur.end, zoom.end),
        message:
          `blur(${blur.id ?? "id未採番"})が zoom(${zoom.id ?? "id未採番"})と時間が重なっています。` +
          "blur は zoom に追従しないため、隠したい情報が矩形からずれて見えることがあります",
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
    }
  }

  for (const ann of overlays.annotations ?? []) {
    for (const zoom of zooms) {
      if (!timeOverlaps(ann.start, ann.end, zoom.start, zoom.end)) continue;
      const rect = annotationRect(ann);
      const suggestions =
        rect !== null
          ? containsRect(zoom.rect, rect)
            ? widenToZoomOps(ann.id, zoom)
            : shiftAfterZoomOps(ann.id, ann.start, ann.end, zoom)
          : shiftAfterZoomOps(ann.id, ann.start, ann.end, zoom); // arrow: rect が無いので shift のみ
      warnings.push({
        kind: "annotation-zoom-overlap",
        refId: ann.id,
        startSec: Math.max(ann.start, zoom.start),
        endSec: Math.min(ann.end, zoom.end),
        message:
          `annotation(${ann.id ?? "id未採番"})が zoom(${zoom.id ?? "id未採番"})と時間が重なっています。` +
          "annotation は zoom に追従しないため、指す位置がずれて見えることがあります",
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
    }
  }

  return warnings;
}

interface EffectSpan {
  kind: "zoom" | "blur" | "annotation";
  id?: string;
  start: number;
  end: number;
}

function collectEffectSpans(overlays: Overlays): EffectSpan[] {
  const spans: EffectSpan[] = [];
  for (const z of overlays.zooms ?? []) spans.push({ kind: "zoom", id: z.id, start: z.start, end: z.end });
  for (const b of overlays.blurs ?? []) spans.push({ kind: "blur", id: b.id, start: b.start, end: b.end });
  for (const a of overlays.annotations ?? []) spans.push({ kind: "annotation", id: a.id, start: a.start, end: a.end });
  return spans;
}

function isInHighlight(t: number, spans: { start: number; end: number }[]): boolean {
  return spans.some((s) => t >= s.start && t <= s.end);
}

/**
 * E5: 密度ガード。
 * - 窓(densityWindowSec)内に演出(zoom+blur+annotation)が maxPerWindow を
 *   超えて開始しているとき density 警告(見せ場 highlightSpans 内は抑制)。
 * - annotation の表示尺が maxAnnotationSec を超えるとき annotation-too-long
 *   警告(補正候補: end を start+maxAnnotationSec へ詰める)。
 */
export function checkDensity(
  overlays: Overlays,
  highlightSpans: { start: number; end: number }[],
  cfg: EffectCheckCfg,
): EffectWarning[] {
  const warnings: EffectWarning[] = [];
  const spans = collectEffectSpans(overlays).sort((a, b) => a.start - b.start);

  const reportedWindows = new Set<number>();
  for (const anchor of spans) {
    const windowEnd = anchor.start + cfg.densityWindowSec;
    const inWindow = spans.filter((s) => s.start >= anchor.start && s.start < windowEnd);
    if (inWindow.length <= cfg.maxPerWindow) continue;
    if (isInHighlight(anchor.start, highlightSpans)) continue;
    const key = Math.round(anchor.start * 100);
    if (reportedWindows.has(key)) continue;
    reportedWindows.add(key);
    warnings.push({
      kind: "density",
      startSec: anchor.start,
      endSec: windowEnd,
      message:
        `${cfg.densityWindowSec}秒の窓に演出が${inWindow.length}件詰まっています` +
        `(上限${cfg.maxPerWindow}件。見せ場の外での多用は視聴体験を損ねます)`,
    });
  }

  for (const a of overlays.annotations ?? []) {
    const durationSec = a.end - a.start;
    if (durationSec <= cfg.maxAnnotationSec) continue;
    const suggestions: EditOp[] = a.id
      ? [{ op: "set", target: `@${a.id}`, field: "end", value: round2(a.start + cfg.maxAnnotationSec) }]
      : [];
    warnings.push({
      kind: "annotation-too-long",
      refId: a.id,
      startSec: a.start,
      endSec: a.end,
      message: `annotation(${a.id ?? "id未採番"})の表示尺(${durationSec.toFixed(1)}s)が上限` +
        `(${cfg.maxAnnotationSec}s)を超えています`,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    });
  }

  return warnings;
}

export interface CaptionRectInput {
  refId?: string;
  start: number;
  end: number;
  rect: Region;
}

interface OverlayRectInput {
  refId?: string;
  start: number;
  end: number;
  rect: Region;
  label: string;
}

function collectOverlayRects(overlays: Overlays): OverlayRectInput[] {
  const rects: OverlayRectInput[] = [];
  for (const b of overlays.blurs ?? []) {
    rects.push({ refId: b.id, start: b.start, end: b.end, rect: b.rect, label: `blur(${b.id ?? "id未採番"})` });
  }
  for (const a of overlays.annotations ?? []) {
    const rect = annotationRect(a);
    if (rect) rects.push({ refId: a.id, start: a.start, end: a.end, rect, label: `annotation(${a.id ?? "id未採番"})` });
  }
  for (const m of overlays.overlays ?? []) {
    if (m.rect) rects.push({ refId: m.id, start: m.start, end: m.end, rect: m.rect, label: `素材(${m.id ?? "id未採番"})` });
  }
  return rects;
}

/**
 * E3(決定論の一次判定): caption pos の矩形が blur/annotation/素材の矩形と
 * 時間・座標の両方で重なっていないかを検出する。captionRects は呼び出し側
 * (effectCheck stage)が transcript/render props から出力px で組んで渡す
 * (pos の無いキャプションは下部中央フローに流れ、矩形が一意に決まらないため
 * v1 では対象外=呼び出し側で除外する)。
 */
export function checkVisualOverlap(
  overlays: Overlays,
  captionRects: CaptionRectInput[],
  cfg: EffectCheckCfg,
): EffectWarning[] {
  const warnings: EffectWarning[] = [];
  const overlayRects = collectOverlayRects(overlays);
  for (const cap of captionRects) {
    for (const ov of overlayRects) {
      if (!timeOverlaps(cap.start, cap.end, ov.start, ov.end)) continue;
      const ratio = rectOverlapRatio(cap.rect, ov.rect);
      if (ratio < cfg.minRectOverlapRatio) continue;
      warnings.push({
        kind: "caption-overlap",
        refId: cap.refId,
        startSec: Math.max(cap.start, ov.start),
        endSec: Math.min(cap.end, ov.end),
        message:
          `テロップ(${cap.refId ?? "id未採番"})が ${ov.label} と重なっています` +
          `(重なり率 ${(ratio * 100).toFixed(0)}%)`,
      });
    }
  }
  return warnings;
}

/** 警告のうち suggestions を持つものを apply パッチ(ops のみ)へ束ねる */
export function buildEffectFixPatch(warnings: EffectWarning[]): { ops: EditOp[] } {
  const ops: EditOp[] = [];
  for (const w of warnings) if (w.suggestions) ops.push(...w.suggestions);
  return { ops };
}
