// lib/fastSegment.ts — render 高速パスの FAST スパン1本を ffmpeg だけで
// レンダーする(Remotion を起動しない・映像のみ・音声は別経路)。
//
// FAST スパンは「ベース映像 + 静的テロップ PNG + 適格な静止画 overlay PNG
// だけで合成できる区間」(fastPlan.ts の適格表)。cut.mp4 から該当フレーム
// 範囲を trim し、レイヤー画(テロップ/overlay の透過 PNG)を z-order
// (layerOrder)順に enable 窓付きで overlay するだけの filtergraph で完結
// させる(P5-1: 静止画 overlay の FAST 化。resolveFastCaptions を
// resolveFastLayers へ一般化)。
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./exec.ts";
import { ffmpegColorFilterOf } from "./colorFilter.ts";
import { renderCaptionStill, captionStillKey } from "./captionStill.ts";
import { renderOverlayStill } from "./overlayStill.ts";
import { annotationFastReason } from "./annotation.ts";
import { annotationStillKey, renderAnnotationStill } from "./annotationStill.ts";
import { fadeFrames, overlayFastReason, overlaySeqRange } from "./overlayFade.ts";
import { buildCaptionIndex, lookupCaption } from "./captionIndex.ts";
import { baseLayoutOf, baseSegOf, cutFrameOf } from "./fastBase.ts";
import { capNum, DEFAULT_LAYER_ORDER, ovNum } from "../types.ts";
import type { FastBaseCapability } from "./fastBaseCapability.ts";
import type { FastSpan } from "./fastPlan.ts";
import type { DesignAssetRefs } from "./design.ts";
import type { WarmAssets } from "../stages/frames.ts";
import type { Caption, OverlayItem, RenderProps, ResolvedAnnotation } from "../../remotion/props.ts";
import type { CaptionStillProps } from "../../remotion/CaptionStill.tsx";
import type { LayerId, Region } from "../types.ts";

export const FAST_SEGMENT_DIR = "render.fast/segments";

export type FastFpsRound = "zero" | "inf" | "down" | "up" | "near";

export const FAST_FPS_ROUND: FastFpsRound = "near";

/** design基底が追加する固定PNG。時間レイヤーの上限とは別枠で防御する。 */
export const MAX_FAST_DESIGN_PNG_INPUTS = 4;

/** ffmpeg 側の色空間補正。Remotion(sRGB/full-range 前提のブラウザ合成)と
 * 同じ見た目にするための固定チェーン(limited→full の展開 + BT.709 の
 * primaries を維持したまま SMPTE170M の伝達特性/行列で解釈させる)。
 * PSNR ガードで検証済みの組み合わせなので値を変えない */
export const BASE_COLOR_FILTER =
  "scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p";

/** セグメント内ローカル・フレーム番号の inclusive [from,to] 窓
 * (ffmpeg between(n,from,to) にそのまま渡せる形) */
export type EnableWindow = [number, number];

/** 1つの PNG 入力 + 1段の overlay フィルタ = 1レイヤー操作。
 * fade/opacity<1 の alpha レイヤーは「必要窓だけループ + PTS シフト」
 * (補遺1)。simple レイヤー(fade 無し・opacity=1)は単一フレーム入力
 * (現行のテロップと同じ)。fade を持つのは overlay 由来のレイヤーだけ
 * (caption は常に simple) */
export interface FastLayerSpec {
  pngPath: string;
  /** 定数不透明度(0〜1)。省略 = 1 */
  opacity?: number;
  /** alpha レイヤーのときだけ存在する。startFrame はセグメントローカル
   * (overlay の Sequence 開始 A)、durFrames はその Sequence の長さ(d)。
   * fade の start_frame はストリーム先頭基準(補遺1: 0 と d-fout) */
  fade?: {
    startFrame: number;
    durFrames: number;
    fadeInFrames: number; // 0 可
    fadeOutFrames: number; // 0 可
  };
  enableWindows: EnableWindow[];
}

export interface FastDesignBaseSpec {
  mode: "design";
  backdropPath: string;
  screen: { sourceRect: Region; targetRect: Region; maskPath: string };
  camera: { sourceRect: Region; targetRect: Region; maskPath: string; shadowPath: string };
  /** 時間レイヤーのうち何件を描いた後にcamera shadow/cameraを挿入するか。
   * undefinedはlayerOrderにwipeが無い/hiddenでcameraを描かない。 */
  cameraLayerIndex?: number;
}

export interface FastSegmentSpec {
  cutPath: string;
  outPath: string;
  /** 出力(セグメント)フレーム区間。セグメント長 = toFrame - fromFrame */
  fromFrame: number;
  toFrame: number;
  /** cut.mp4 の CFR 格子上の trim 開始フレーム。**省略時は fromFrame**
   * (= 挿入なし=恒等写像。既存の argv と1バイトも変わらない。design-T4.md §2-C) */
  videoFromFrame?: number;
  fps: number;
  fpsRound?: FastFpsRound;
  /** z-order 下→上 */
  layers: FastLayerSpec[];
  /** ベース映像に掛ける colorFilter の ffmpeg フィルタ列(適用順)。
   * 省略/空 = 無補正(既存挙動とバイト等価)。BASE_COLOR_FILTER の直後に
   * RGB 段として挿入される(design-T3.md §3) */
  colorFilters?: string[];
  /** 省略時は現行composite基底。P1-2では純関数graphだけを接続し、
   * runFastRenderからのdesign activationはP1-3まで行わない。 */
  base?: FastDesignBaseSpec;
}

// ---- レイヤー解決 ----

export type FastLayerItem =
  | { kind: "caption"; caption: Caption; enableWindows: EnableWindow[] }
  | {
      kind: "overlay";
      item: OverlayItem;
      /** セグメントローカル。overlay の Sequence 開始(overlaySeqRange 由来) */
      startFrame: number;
      /** overlay の Sequence 長(overlaySeqRange 由来) */
      durFrames: number;
      enableWindows: EnableWindow[];
    }
  | { kind: "annotation"; annotation: ResolvedAnnotation; enableWindows: EnableWindow[] };

/** caption 1件から CaptionStill 用の props を組み立てる(renderFastSegment /
 * fastLayerMergeKey で共有) */
export function captionStillPropsOf(props: RenderProps, caption: Caption): CaptionStillProps {
  return {
    width: props.width,
    height: props.height,
    caption,
    defaults: props.caption,
    captionDefaultPos: props.captionDefaultPos,
    cameraRegion: props.cameraRegion,
    wipe: props.wipe,
  };
}

/** span 内で描かれるレイヤーを layerOrder(下→上)に解決する。
 * - ov<N>: そのトラックの overlays を配列順(= Main.tsx の Sequence 順 =
 *   後勝ちで上に載る)。fastPlan の不動点が保証する不変条件(span に完全
 *   収容されるか、一切現れないかのどちらか)が破れていたら例外を投げる
 *   (fastRender の try/catch がフルレンダーへフォールバックする)
 * - cap<N>: 現行の frame scan(lookupCaption・hideCaption 減算・anim/karaoke
 *   ガード)そのまま */
export function resolveFastLayers(props: RenderProps, span: FastSpan): FastLayerItem[] {
  const fps = props.fps;
  const order = props.layerOrder ?? DEFAULT_LAYER_ORDER;
  const index = buildCaptionIndex(props.captions);
  const out: FastLayerItem[] = [];
  for (const id of order) {
    const ov = ovNum(id);
    if (ov !== null) {
      for (const o of props.overlays) {
        if (o.track !== ov) continue;
        const r = overlaySeqRange(o, fps);
        if (r.toFrame <= span.fromFrame || r.fromFrame >= span.toFrame) continue; // このスパンに映らない
        const reason = overlayFastReason(o, fps);
        if (reason !== null) {
          throw new Error(`FAST span[${span.fromFrame},${span.toFrame}) に不適格 overlay が混入(${reason}: ${o.file})`);
        }
        if (r.fromFrame < span.fromFrame || r.toFrame > span.toFrame) {
          // fastPlan の不動点が保証する不変条件。破れたら実装バグ
          throw new Error(`FAST span[${span.fromFrame},${span.toFrame}) を overlay がまたいでいる(${o.file})`);
        }
        const local = r.fromFrame - span.fromFrame;
        out.push({
          kind: "overlay",
          item: o,
          startFrame: local,
          durFrames: r.durFrames,
          enableWindows: [[local, local + r.durFrames - 1]],
        });
      }
      continue;
    }
    const track = capNum(id);
    if (track === null) continue; // "wipe" は cut.mp4 に焼き込み済み(wipeBurnedIn)= 無視
    const placements = new Map<Caption, Extract<FastLayerItem, { kind: "caption" }>>();
    for (let frame = span.fromFrame; frame < span.toFrame; frame++) {
      const t = frame / fps;
      if ((props.hideCaption ?? []).some((h) => t >= h.start && t < h.end)) continue;
      const caption = lookupCaption(index, track, t);
      if (!caption) continue;
      if (caption.style?.anim || caption.style?.karaoke) {
        throw new Error(
          `FAST span[${span.fromFrame},${span.toFrame}) に anim/karaoke テロップが混入(start=${caption.start})`,
        );
      }
      let placement = placements.get(caption);
      if (!placement) {
        placement = { kind: "caption", caption, enableWindows: [] };
        placements.set(caption, placement);
      }
      const localFrame = frame - span.fromFrame;
      const last = placement.enableWindows.at(-1);
      if (last && last[1] === localFrame - 1) last[1] = localFrame;
      else placement.enableWindows.push([localFrame, localFrame]);
    }
    out.push(...placements.values());
  }
  // ---- 注釈グラフィック(最前面。layerOrder には載らない固定順) ----
  // Main.tsx は layerOrder の全レイヤーを描いた「後」に annotations を配列順で
  // 重ねる(後の要素ほど上)。FAST では layers 配列の末尾 = 最後の overlay
  // フィルタ段 = 最前面になる。可視判定は Main と同一の t>=start && t<end を
  // フレームごとに評価する(丸め規則を別実装しない)。
  const annotations = props.annotations ?? [];
  if (annotations.length > 0) {
    const windows = new Map<number, EnableWindow[]>();
    for (let frame = span.fromFrame; frame < span.toFrame; frame++) {
      const t = frame / fps;
      for (let j = 0; j < annotations.length; j++) {
        const a = annotations[j];
        if (t < a.start || t >= a.end) continue;
        const reason = annotationFastReason(a);
        if (reason !== null) {
          // fastPlan が SLOW へ送っているはずの annotation。破れたら実装バグ
          throw new Error(
            `FAST span[${span.fromFrame},${span.toFrame}) に不適格 annotation が混入(${reason}: ${a.type} @${a.start})`,
          );
        }
        const localFrame = frame - span.fromFrame;
        const ws = windows.get(j);
        if (!ws) windows.set(j, [[localFrame, localFrame]]);
        else {
          const last = ws[ws.length - 1];
          if (last[1] === localFrame - 1) last[1] = localFrame;
          else ws.push([localFrame, localFrame]);
        }
      }
    }
    // 配列順(= Main の兄弟順 = 後勝ちで上)を保って push
    for (let j = 0; j < annotations.length; j++) {
      const ws = windows.get(j);
      if (ws) out.push({ kind: "annotation", annotation: annotations[j], enableWindows: ws });
    }
  }
  return out;
}

/** overlay 側が alpha 入力(fade あり or 定数 opacity<1)かどうか */
function overlayIsAlpha(o: OverlayItem, fps: number): boolean {
  const fin = fadeFrames(o.fadeInSec, fps);
  const fout = fadeFrames(o.fadeOutSec, fps);
  const opacity = o.opacity ?? 1;
  return fin > 0 || fout > 0 || opacity !== 1;
}

/** FastLayerItem が畳み込み対象になりえない(alpha)操作かどうか。
 * caption は常に simple(fade/opacity を持たない) */
function isAlphaOp(it: FastLayerItem, fps: number): boolean {
  return it.kind === "overlay" && overlayIsAlpha(it.item, fps);
}

/** 畳み込み用の純粋キー。同じキー = 同じ PNG(内容アドレスキーと 1:1) */
export function fastLayerMergeKey(props: RenderProps, it: FastLayerItem): string {
  if (it.kind === "caption") return `cap:${captionStillKey(captionStillPropsOf(props, it.caption))}`;
  if (it.kind === "annotation") {
    return `ann:${annotationStillKey({ annotation: it.annotation, width: props.width, height: props.height })}`;
  }
  const o = it.item;
  return `ov:${o.file}|${o.fit}|${o.rect ? `${o.rect.x},${o.rect.y},${o.rect.w},${o.rect.h}` : "-"}`;
}

function windowsOverlap(a: EnableWindow[], b: EnableWindow[]): boolean {
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      if (a0 <= b1 && b0 <= a1) return true;
    }
  }
  return false;
}

function coalesceWindows(windows: EnableWindow[]): EnableWindow[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: EnableWindow[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/** z-order 下→上の FastLayerItem 列を畳み込む。fade/opacity<1 の alpha
 * 操作は絶対に畳まない。同一キー(同じ PNG になる操作)の simple 操作は、
 * 間に時間的に重なる別操作が無ければ enable 窓をマージして1入力にする。
 *
 * 正当性: overlay フィルタは enable=0 のフレームでは恒等写像なので、
 * enable 窓が互いに素な2つの overlay 操作は可換。it を候補 cand の直後
 * (元の位置)まで下げるとき、間の全操作が it と時間的に重ならないなら
 * 出力は1ピクセルも変わらない */
export function mergeFastLayers(props: RenderProps, items: FastLayerItem[]): FastLayerItem[] {
  const fps = props.fps;
  interface Entry {
    item: FastLayerItem;
    origIndex: number;
  }
  const merged: Entry[] = [];
  for (let j = 0; j < items.length; j++) {
    const it = items[j];
    if (isAlphaOp(it, fps)) {
      merged.push({ item: it, origIndex: j });
      continue;
    }
    const key = fastLayerMergeKey(props, it);
    let candIdx = -1;
    for (let m = merged.length - 1; m >= 0; m--) {
      if (!isAlphaOp(merged[m].item, fps) && fastLayerMergeKey(props, merged[m].item) === key) {
        candIdx = m;
        break;
      }
    }
    if (candIdx === -1) {
      merged.push({ item: it, origIndex: j });
      continue;
    }
    const cand = merged[candIdx];
    let disjoint = true;
    for (let k = cand.origIndex + 1; k < j; k++) {
      if (windowsOverlap(items[k].enableWindows, it.enableWindows)) {
        disjoint = false;
        break;
      }
    }
    if (disjoint) {
      cand.item = {
        ...cand.item,
        enableWindows: coalesceWindows([...cand.item.enableWindows, ...it.enableWindows]),
      } as FastLayerItem;
    } else {
      merged.push({ item: it, origIndex: j });
    }
  }
  return merged.map((e) => e.item);
}

/** この FAST スパンが必要とする PNG 入力の本数(畳み込み後)。純関数。
 * fastPlan の分割ガードが使う。ffmpeg も PNG も触らない */
export function countFastPngInputs(props: RenderProps, span: FastSpan): number {
  return mergeFastLayers(props, resolveFastLayers(props, span)).length;
}

export interface FastDesignLayerPlan {
  items: FastLayerItem[];
  cameraLayerIndex?: number;
}

/** design cameraはlayerOrderのwipe位置に入るため、wipeをまたぐ畳み込みを
 * 禁止して正確な挿入位置を返す。composite用の解決・畳み込みは変更しない。 */
export function resolveFastDesignLayers(props: RenderProps, span: FastSpan): FastDesignLayerPlan {
  const hidden = new Set(props.hiddenLayers ?? []);
  const order = (props.layerOrder ?? DEFAULT_LAYER_ORDER).filter((id) => !hidden.has(id));
  const wipeIndex = order.indexOf("wipe");
  if (wipeIndex < 0 || props.wipeBurnedIn || !props.cameraRegion) {
    const visibleProps = { ...props, layerOrder: order };
    return { items: mergeFastLayers(visibleProps, resolveFastLayers(visibleProps, span)) };
  }

  const lowerOrder = order.slice(0, wipeIndex) as LayerId[];
  const upperOrder = order.slice(wipeIndex + 1) as LayerId[];
  const lowerProps = { ...props, layerOrder: lowerOrder, annotations: [] };
  const upperProps = { ...props, layerOrder: upperOrder };
  const lower = mergeFastLayers(lowerProps, resolveFastLayers(lowerProps, span));
  const upper = mergeFastLayers(upperProps, resolveFastLayers(upperProps, span));
  return { items: [...lower, ...upper], cameraLayerIndex: lower.length };
}

export function buildFastDesignBaseSpec(args: {
  dir: string;
  props: RenderProps;
  refs: DesignAssetRefs;
  cameraLayerIndex?: number;
}): FastDesignBaseSpec {
  const { dir, props, refs, cameraLayerIndex } = args;
  const design = props.design;
  if (!design?.camera || !props.cameraRegion || !refs.cameraShadowFile || !refs.cameraMaskFile) {
    throw new Error("design基底asset/geometryが不完全です");
  }
  return {
    mode: "design",
    backdropPath: join(dir, refs.backdropFile),
    screen: {
      sourceRect: props.screenRegion,
      targetRect: design.screen.rect,
      maskPath: join(dir, refs.screenMaskFile),
    },
    camera: {
      sourceRect: props.cameraRegion,
      targetRect: design.camera.rect,
      maskPath: join(dir, refs.cameraMaskFile),
      shadowPath: join(dir, refs.cameraShadowFile),
    },
    ...(cameraLayerIndex !== undefined ? { cameraLayerIndex } : {}),
  };
}

// ---- 純関数: filtergraph / argv 組み立て ----

function isAlphaLayer(L: FastLayerSpec): boolean {
  return !!L.fade;
}

/** colorFilter 段(RGB 往復込み)。空/省略なら空文字列 = 既存とバイト等価。
 * BASE_COLOR_FILTER の直後(= 601-full の YUV/RGB 境界)に挿入する
 * (design-T3.md §3。BASE_COLOR_FILTER の内部・末尾の format=yuvj420p は
 * 変更しない)。lutrgb の式はカンマを含むため単引用符で括る
 * (クォーティング注意(直さないこと): run は execFile(シェル非経由)なので、
 * この単引用符は shell ではなく ffmpeg の filtergraph パーサがカンマを
 * フィルタ区切りと誤認しないための保護。既存の enable='between(...)' と同じ
 * 理由) */
function colorFilterStage(filters?: string[]): string {
  if (!filters || filters.length === 0) return "";
  return `,format=rgb24,${filters.join(",")},format=yuvj420p`;
}

/** source regionをtarget aspectへcenter-coverする整数crop。 */
export function centerCoverCrop(source: Region, target: Region): Region {
  if (source.w <= 0 || source.h <= 0 || target.w <= 0 || target.h <= 0) {
    throw new Error("design基底のcover矩形は正の幅・高さが必要です");
  }
  if (source.w * target.h > source.h * target.w) {
    const w = Math.round((source.h * target.w) / target.h);
    return { x: source.x + Math.round((source.w - w) / 2), y: source.y, w, h: source.h };
  }
  const h = Math.round((source.w * target.h) / target.w);
  return { x: source.x, y: source.y + Math.round((source.h - h) / 2), w: source.w, h };
}

function designColorStage(filters?: string[]): string {
  return filters && filters.length > 0
    ? `format=rgb24,${filters.join(",")},format=rgba`
    : "format=rgba";
}

function designInputPaths(base: FastDesignBaseSpec): string[] {
  const paths = [
    base.backdropPath,
    base.screen.maskPath,
    base.camera.shadowPath,
    base.camera.maskPath,
  ];
  if (paths.length > MAX_FAST_DESIGN_PNG_INPUTS) {
    throw new Error(`design基底PNGが上限${MAX_FAST_DESIGN_PNG_INPUTS}本を超えています`);
  }
  return paths;
}

function buildDesignFastSegmentFilter(spec: FastSegmentSpec & { base: FastDesignBaseSpec }): string {
  const { base: design } = spec;
  const cameraAt = design.cameraLayerIndex;
  if (cameraAt !== undefined && (!Number.isInteger(cameraAt) || cameraAt < 0 || cameraAt > spec.layers.length)) {
    throw new Error(`design cameraLayerIndexが範囲外です: ${cameraAt}`);
  }
  const round = spec.fpsRound ?? FAST_FPS_ROUND;
  const v0 = spec.videoFromFrame ?? spec.fromFrame;
  const v1 = v0 + (spec.toFrame - spec.fromFrame);
  const screen = design.screen;
  const camera = design.camera;
  const cover = centerCoverCrop(camera.sourceRect, camera.targetRect);
  const split = cameraAt === undefined ? "" : ",split=2[design-screen-src][design-camera-src]";
  const sourceOut = cameraAt === undefined ? "[design-screen-src]" : "";
  const parts = [
    `[0:v]setpts=PTS-STARTPTS,fps=fps=${spec.fps}:round=${round}:start_time=0,` +
      `trim=start_frame=${v0}:end_frame=${v1},setpts=N/${spec.fps}/TB,` +
      `${BASE_COLOR_FILTER}${split}${sourceOut}`,
    `[design-screen-src]crop=w=${screen.sourceRect.w}:h=${screen.sourceRect.h}:x=${screen.sourceRect.x}:y=${screen.sourceRect.y},` +
      `scale=w=${screen.targetRect.w}:h=${screen.targetRect.h},${designColorStage(spec.colorFilters)}[design-screen-rgb]`,
    "[2:v]alphaextract[design-screen-mask]",
    "[design-screen-rgb][design-screen-mask]alphamerge[design-screen-alpha]",
    "[1:v]format=rgba[design-backdrop]",
    `[design-backdrop][design-screen-alpha]overlay=x=${screen.targetRect.x}:y=${screen.targetRect.y}:format=auto[design-base]`,
  ];
  if (cameraAt !== undefined) {
    parts.push(
      `[design-camera-src]crop=w=${cover.w}:h=${cover.h}:x=${cover.x}:y=${cover.y},` +
        `scale=w=${camera.targetRect.w}:h=${camera.targetRect.h},${designColorStage(spec.colorFilters)}[design-camera-rgb]`,
      "[4:v]alphaextract[design-camera-mask]",
      "[design-camera-rgb][design-camera-mask]alphamerge[design-camera-alpha]",
      "[3:v]format=rgba[design-camera-shadow]",
    );
  }

  let prev = "design-base";
  let op = 0;
  const overlay = (src: string, x: number, y: number, enable?: string) => {
    const out = `design-op${op++}`;
    parts.push(
      `[${prev}][${src}]overlay=x=${x}:y=${y}:format=auto${enable ? `:enable='${enable}'` : ""}[${out}]`,
    );
    prev = out;
  };
  const addCamera = () => {
    overlay("design-camera-shadow", 0, 0);
    overlay("design-camera-alpha", camera.targetRect.x, camera.targetRect.y);
  };
  spec.layers.forEach((L, i) => {
    if (cameraAt === i) addCamera();
    const inputIdx = MAX_FAST_DESIGN_PNG_INPUTS + 1 + i;
    const enable = L.enableWindows.map(([a, b]) => `between(n,${a},${b})`).join("+");
    let src = `${inputIdx}:v`;
    if (isAlphaLayer(L)) {
      const { startFrame: A, durFrames: d, fadeInFrames: fin, fadeOutFrames: fout } = L.fade!;
      const pre: string[] = ["format=rgba"];
      const opacity = L.opacity ?? 1;
      if (opacity !== 1) pre.push(`colorchannelmixer=aa=${opacity}`);
      if (fin > 0) pre.push(`fade=t=in:alpha=1:start_frame=0:nb_frames=${fin}`);
      if (fout > 0) pre.push(`fade=t=out:alpha=1:start_frame=${d - fout}:nb_frames=${fout}`);
      pre.push(`setpts=N/${spec.fps}/TB+${A}/${spec.fps}/TB`);
      parts.push(`[${inputIdx}:v]${pre.join(",")}[design-layer${i}]`);
      src = `design-layer${i}`;
    }
    overlay(src, 0, 0, enable);
  });
  if (cameraAt === spec.layers.length) addCamera();
  parts.push(`[${prev}]format=yuvj420p[vout]`);
  return parts.join(";");
}

export function buildFastSegmentFilter(spec: FastSegmentSpec): string {
  if (spec.base?.mode === "design") {
    designInputPaths(spec.base);
    return buildDesignFastSegmentFilter(spec as FastSegmentSpec & { base: FastDesignBaseSpec });
  }
  // fps は cut.mp4 の timestamp から CFR 格子を作る。そこで frame trim する
  // ことで、Remotion OffthreadVideo の時刻ベース選択と同じソースを選ぶ。
  // trim 後の setpts=N/fps/TB はセグメントローカル PTS を安定化し、FAST と
  // SLOW の混在 concat を frames/fps ちょうどの尺に揃えるためのもの。
  // overlay の n は fps+trim 後のローカル出力フレーム番号なので変わらない。
  const round = spec.fpsRound ?? FAST_FPS_ROUND;
  // videoFromFrame(省略時 fromFrame = 恒等写像)は cut.mp4 の CFR 格子上の
  // trim 開始フレーム(design-T4.md §2-C: baseSegment 由来。挿入で cut.mp4
  // 内の位置が出力フレーム位置と食い違うケースを吸収する)
  const v0 = spec.videoFromFrame ?? spec.fromFrame;
  const v1 = v0 + (spec.toFrame - spec.fromFrame);
  const base =
    `[0:v]setpts=PTS-STARTPTS,fps=fps=${spec.fps}:round=${round}:start_time=0,` +
    `trim=start_frame=${v0}:end_frame=${v1},setpts=N/${spec.fps}/TB,` +
    `${BASE_COLOR_FILTER}${colorFilterStage(spec.colorFilters)}`;
  if (spec.layers.length === 0) return `${base}[vout]`;
  const parts = [`${base}[b0]`];
  let prev = "b0";
  spec.layers.forEach((L, i) => {
    const inputIdx = i + 1; // 0 は cut.mp4
    const outLabel = i === spec.layers.length - 1 ? "vout" : `o${i}`;
    const enable = L.enableWindows.map(([a, b]) => `between(n,${a},${b})`).join("+");
    let src = `${inputIdx}:v`;
    if (isAlphaLayer(L)) {
      // 補遺1: 入力ストリームは overlay 自身の先頭(ストリーム frame 0)から
      // 始まる短いループなので、fade の start_frame はストリーム先頭基準
      // (0 と d-fout)。最後の setpts で n → セグメントローカル frame A+n
      // の PTS へ載せ、base 側(setpts=N/fps/TB)と同じ格子に揃える。
      const { startFrame: A, durFrames: d, fadeInFrames: fin, fadeOutFrames: fout } = L.fade!;
      const pre: string[] = ["format=rgba"];
      const op = L.opacity ?? 1;
      if (op !== 1) pre.push(`colorchannelmixer=aa=${op}`);
      if (fin > 0) pre.push(`fade=t=in:alpha=1:start_frame=0:nb_frames=${fin}`);
      if (fout > 0) pre.push(`fade=t=out:alpha=1:start_frame=${d - fout}:nb_frames=${fout}`);
      pre.push(`setpts=N/${spec.fps}/TB+${A}/${spec.fps}/TB`);
      parts.push(`[${inputIdx}:v]${pre.join(",")}[a${i}]`);
      src = `a${i}`;
    }
    parts.push(`[${prev}][${src}]overlay=x=0:y=0:format=auto:enable='${enable}'[${outLabel}]`);
    prev = outLabel;
  });
  return parts.join(";");
}

export function buildFastSegmentArgs(spec: FastSegmentSpec): string[] {
  const gop = Math.max(1, Math.round(spec.fps * 2));
  const segFrames = spec.toFrame - spec.fromFrame;
  const args = ["-y", "-v", "error", "-i", spec.cutPath];
  if (spec.base?.mode === "design") {
    // alphamerge/overlayのframesyncで静止PNGの既定25fps timestampが基底を
    // 短縮しないよう、固定4枚も出力fps格子で無限ループする。
    for (const path of designInputPaths(spec.base)) {
      args.push("-loop", "1", "-framerate", String(spec.fps), "-i", path);
    }
  }
  for (const L of spec.layers) {
    if (isAlphaLayer(L)) {
      // 補遺1(必須): セグメント全長ではなく overlay 自身の尺(d)ぶんだけ
      // ループする(+1 フレームの余裕)。全長ループは実測で 2.7 倍遅い
      const d = L.fade!.durFrames;
      const loopSec = ((d + 1) / spec.fps).toFixed(3);
      args.push("-loop", "1", "-framerate", String(spec.fps), "-t", loopSec, "-i", L.pngPath);
    } else {
      args.push("-i", L.pngPath); // 現行と同じ(単一フレーム入力)
    }
  }
  args.push(
    "-filter_complex",
    buildFastSegmentFilter(spec),
    "-map",
    "[vout]",
    "-an",
    "-frames:v",
    String(segFrames), // base 長を絶対にする(-shortest は使わない)
    "-c:v",
    "h264_videotoolbox",
    "-profile:v",
    "high",
    "-b:v",
    "8000k",
    "-video_track_timescale",
    "90000",
    "-color_range",
    "pc",
    "-colorspace",
    "smpte170m",
    "-g",
    String(gop),
    "-forced-idr",
    "1",
    "-force_key_frames",
    "expr:eq(n,0)",
    spec.outPath,
  );
  return args;
}
// クォーティング注意(直さないこと): run は execFile(シェルを経由しない)
// なので、enable='between(n,30,119)' の単引用符は shell が解釈するのでは
// なく ffmpeg 自身の filtergraph パーサがカンマを区切りと誤認しないよう
// 保護するためのもの。文字列にそのまま残す。

// ---- 出力パス ----

export function fastSegmentPath(dir: string, index: number): string {
  return join(dir, FAST_SEGMENT_DIR, `seg${String(index).padStart(3, "0")}.mp4`);
}

// ---- 不純関数: 実行 ----

export async function renderFastSegment(args: {
  dir: string;
  props: RenderProps;
  span: FastSpan;
  index: number;
  warm: WarmAssets;
  base?: Extract<FastBaseCapability, { ok: true }>;
}): Promise<string> {
  const { dir, props, span, index, warm } = args;
  if (span.kind !== "fast") throw new Error("renderFastSegment は fast span 専用です");
  // trim 開始 frame は baseSegment 由来(design-T4.md §2-C)。fastPlan の
  // clampFastSpansToBase が保証する不変条件(FAST span は単一 baseSegment に
  // 収まる)が破れていたら実装バグ。fastRender の try/catch がフルレンダーへ
  // フォールバックする
  const layout = baseLayoutOf(props);
  if (!layout.ok) throw new Error(`FAST セグメントに不正な baseSegments(${layout.reason})`);
  const baseSeg = baseSegOf(layout, span);
  if (!baseSeg) {
    throw new Error(`FAST span[${span.fromFrame},${span.toFrame}) が単一の baseSegment に収まっていない`);
  }
  const videoFromFrame = cutFrameOf(baseSeg, span.fromFrame);
  const designLayerPlan = args.base?.mode === "design"
    ? resolveFastDesignLayers(props, span)
    : undefined;
  const items = designLayerPlan?.items ?? mergeFastLayers(props, resolveFastLayers(props, span));
  const layers: FastLayerSpec[] = [];
  for (const it of items) {
    if (it.kind === "caption") {
      const pngPath = await renderCaptionStill({ dir, caption: captionStillPropsOf(props, it.caption), warm });
      layers.push({ pngPath, enableWindows: it.enableWindows });
      continue;
    }
    if (it.kind === "annotation") {
      const pngPath = await renderAnnotationStill({
        dir, annotation: it.annotation, width: props.width, height: props.height, warm,
      });
      layers.push({ pngPath, enableWindows: it.enableWindows });
      continue;
    }
    const pngPath = await renderOverlayStill({
      dir,
      item: it.item,
      width: props.width,
      height: props.height,
      fps: props.fps,
      warm,
    });
    const opacity = it.item.opacity ?? 1;
    const fin = fadeFrames(it.item.fadeInSec, props.fps);
    const fout = fadeFrames(it.item.fadeOutSec, props.fps);
    const alpha = opacity !== 1 || fin > 0 || fout > 0;
    layers.push({
      pngPath,
      ...(opacity !== 1 ? { opacity } : {}),
      ...(alpha
        ? { fade: { startFrame: it.startFrame, durFrames: it.durFrames, fadeInFrames: fin, fadeOutFrames: fout } }
        : {}),
      enableWindows: it.enableWindows,
    });
  }
  const outPath = fastSegmentPath(dir, index);
  mkdirSync(dirname(outPath), { recursive: true });
  const colorPlan = ffmpegColorFilterOf(props.colorFilter);
  if (colorPlan.kind === "unsupported") {
    // fastPlan がここへ来る前に全編フォールバックしているはず。破れたら実装バグ
    throw new Error(`FAST span に表現不能な colorFilter(${colorPlan.reason})`);
  }
  await run(
    "ffmpeg",
    buildFastSegmentArgs({
      cutPath: join(dir, props.videoFile),
      outPath,
      fromFrame: span.fromFrame,
      toFrame: span.toFrame,
      videoFromFrame,
      fps: props.fps,
      layers,
      ...(args.base?.mode === "design"
        ? {
            base: buildFastDesignBaseSpec({
              dir,
              props,
              refs: args.base.design,
              cameraLayerIndex: designLayerPlan?.cameraLayerIndex,
            }),
          }
        : {}),
      ...(colorPlan.kind === "chain" ? { colorFilters: colorPlan.filters } : {}),
    }),
  );
  return outPath;
}
