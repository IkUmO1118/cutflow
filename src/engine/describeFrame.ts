// src/engine/describeFrame.ts — JSON(正) → buildRenderProps() で解決済みの
// RenderProps → この純関数 → FrameDescriptor、の翻訳層(M2 Phase2)。
// 旧レンダラーの式を逐語移植する(アレンジ禁止。設計書の落とし穴節を参照)。
// ブラウザ安全な純 TS のみ(node import 禁止)。
//
// 演出グループはコミット単位(docs/plans/2026-07-28-engine-m2-frame-descriptor-design.md
// §Phase2)。このファイルは各グループの内部関数を追記していく形で育つ。
import { activeZoomSpanAt, zoomProgressAt, zoomTransformAt } from "../lib/zoom.ts";
import type { ZoomSpan, ZoomTransform } from "../lib/zoom.ts";
import { panelRect, shrinkWipeRect, wipeRectAt } from "../lib/design.ts";
import { wipeProgressAt } from "../lib/wipe.ts";
import { alignKaraoke, animStateAt, karaokeActiveAt, karaokeFillProgress } from "../lib/captionAnim.ts";
import { isImageFile } from "../lib/overlayFade.ts";
import { valuesAt } from "../lib/keyframes.ts";
import { blurRadiusPx } from "../lib/blur.ts";
import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  DEFAULT_LAYER_ORDER,
  KARAOKE_DEFAULT_ACTIVE,
  capNum,
  ovNum,
  resolveCaptionBackground,
} from "../types.ts";
import { contentHashOf } from "./hash.ts";
import type {
  BlurRegionContent,
  CaptionContent,
  CaptionWord,
  ColorFilterEffect,
  Effect,
  ExternalItem,
  FillContent,
  FrameDescriptor,
  FrameItem,
  Rect,
  RenderedContent,
  RenderedItem,
  RenderedPlacement,
} from "./descriptor.ts";
import type { Caption, RenderProps } from "../lib/renderPropsTypes.ts";

const IDENTITY_ZOOM: ZoomTransform = { scale: 1, translateX: 0, translateY: 0 };

/**
 * ズーム transform(t は出力秒)。baked 経路(props.zoomTransformTrack。
 * focusMode opt-in 時のみ)があればフレーム番号で lookup、無ければ legacy の
 * zoomTransformAt(補間)を通す。Main.tsx:102-116 の逐語移植
 * (frame = Math.round(t*fps) への変換だけがここでの追加。
 * zoomTransformTrack 自体が既に fps 量子化されたフレーム配列のため、
 * descriptor の時刻キーからその配列へ橋渡しする一点に限る)。
 */
function zoomTransformAtOut(props: RenderProps, tOut: number): ZoomTransform {
  const zoomSpans: ZoomSpan[] = props.zooms ?? [];
  if (props.zoomTransformTrack) {
    const frame = Math.round(tOut * props.fps);
    const tt = props.zoomTransformTrack;
    const i = frame - tt.startFrame;
    const entry = i >= 0 && i < tt.frames.length ? tt.frames[i] : null;
    return entry
      ? { scale: entry.scale, translateX: entry.x, translateY: entry.y }
      : IDENTITY_ZOOM;
  }
  return zoomTransformAt(tOut, zoomSpans, props.width, props.height);
}

/** rect にズーム transform を適用する(CSS `transform: translate(tx,ty)
 * scale(s)` / transform-origin "0 0" と同じ合成: p' = (tx+s*px, ty+s*py)。
 * Main.tsx:384-421 の zoom 器(背景画像+画面パネルをまとめて拡大する div)
 * の逐語移植 */
function applyZoom(rect: Rect, z: ZoomTransform): Rect {
  return {
    x: z.translateX + z.scale * rect.x,
    y: z.translateY + z.scale * rect.y,
    w: z.scale * rect.w,
    h: z.scale * rect.h,
  };
}

/**
 * cropFitStyle(src/lib/panelStyle.ts)+ 親コンテナの overflow:hidden、の
 * 意味論を sourceRect(ソースのクロップ範囲)+ quad(出力px の最終矩形)へ
 * 分解する。
 *
 * - cover: 箱を隙間なく埋める(quad = box そのもの)。はみ出す分は
 *   sourceRect を箱の縦横比に合わせて中央基準で狭める(クロップ)
 * - contain: source 全体を縮小して収める(sourceRect = region そのまま、
 *   クロップ無し)。箱より小さくなる軸はレターボックス(quad が box の
 *   中央に小さく収まる)
 *
 * cropFitStyle が返す (left, top, width, height) は「region ではなく
 * canvas 全体を scale 倍して置いた座標」なので一見別の形だが、
 * 「screen 座標 = left + canvasX*scale が [0,box] に収まる canvasX の
 * 範囲」を逆算すると sourceRect の式に一致する(Phase0 で導出済み)
 */
function resolveFit(
  region: Rect,
  box: { w: number; h: number },
  fit: "contain" | "cover",
): { sourceRect: Rect; quad: Rect } {
  const scaleX = box.w / region.w;
  const scaleY = box.h / region.h;
  if (fit === "cover") {
    const scale = Math.max(scaleX, scaleY);
    const visW = box.w / scale;
    const visH = box.h / scale;
    return {
      sourceRect: {
        x: region.x - (visW - region.w) / 2,
        y: region.y - (visH - region.h) / 2,
        w: visW,
        h: visH,
      },
      quad: { x: 0, y: 0, w: box.w, h: box.h },
    };
  }
  const scale = Math.min(scaleX, scaleY);
  const quadW = region.w * scale;
  const quadH = region.h * scale;
  return {
    sourceRect: { ...region },
    quad: { x: (box.w - quadW) / 2, y: (box.h - quadH) / 2, w: quadW, h: quadH },
  };
}

/** props.colorFilter を descriptor の Effect へ(ベース映像だけに効く。
 * cssFilterOf と同じ「全既定(1.0)なら無補正」判定。colorFilter.ts:7-14 逐語) */
function colorFilterEffects(props: RenderProps): Effect[] | undefined {
  const cf = props.colorFilter;
  if (!cf) return undefined;
  const brightness = cf.brightness ?? 1;
  const contrast = cf.contrast ?? 1;
  const saturate = cf.saturate ?? 1;
  if (brightness === 1 && contrast === 1 && saturate === 1) return undefined;
  const effect: ColorFilterEffect = { kind: "colorFilter", brightness, contrast, saturate };
  return [effect];
}

/**
 * ベース区間(baseSegments)から出力秒 tOut を含む区間を探し、その区間内での
 * ソース再生位置(秒)を返す。区間が無ければ null(その時刻はベース映像が
 * 無い=挿入クリップ中。renderProps.ts のコメントいわく挿入は独立レイヤーで
 * ベース映像を止める)。baseSegments 省略時は全編連続再生(videoStart=0)
 */
function baseSourceTimeAt(props: RenderProps, tOut: number): number | null {
  const segs = props.baseSegments ?? [{ start: 0, videoStart: 0, durationSec: props.durationSec }];
  for (const seg of segs) {
    if (tOut >= seg.start && tOut < seg.start + seg.durationSec) {
      const rate = seg.playbackRate ?? 1;
      return seg.videoStart + (tOut - seg.start) * rate;
    }
  }
  return null;
}

/**
 * グループ1: ベース映像(画面クロップ)+ zoom(連鎖パン・easeSec 補間)+
 * colorFilter(ベース映像のみ)+ design 背景画像。
 *
 * カメラ(ワイプ)は wipeFull の遷移・zoom 連動縮小と不可分なのでグループ2
 * (wipeFull)側で扱う。縦プロファイル(props.layout があるとき)のパネル合成は
 * グループ6で扱う(このグループでは何も出さない=Main.tsx が
 * `props.layout ? renderPanels(...) : <zoom 器>` で分岐するのと同じ)
 */
export function describeBaseLayer(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout) return []; // 縦プロファイル経路はグループ6

  const items: FrameItem[] = [];
  const zoomT = zoomTransformAtOut(props, tOut);
  const design = props.design;
  const panel = panelRect(design, props.width, props.height);

  if (design?.backgroundFile) {
    const quad = applyZoom({ x: 0, y: 0, w: props.width, h: props.height }, zoomT);
    const bg: ExternalItem = {
      kind: "external",
      sourceId: design.backgroundFile,
      sourceTimeSec: 0,
      sourceKind: "image",
      placement: { mode: "fit", fit: "cover", box: quad },
      opacity: 1,
    };
    items.push(bg);
  }

  // ベース映像が無いプロジェクト(映像なし=stills / Studio のプレースホルダー)。
  // 背景だけは描く(S3-fix F3)。ここより前で return すると design.backgroundFile
  // が映像なしプロジェクトで描かれない。
  if (props.videoFile === "") return items;

  const sourceTimeSec = baseSourceTimeAt(props, tOut);
  if (sourceTimeSec !== null) {
    const { sourceRect, quad } = resolveFit(props.screenRegion, panel, "cover");
    const zoomedQuad = applyZoom(
      { x: panel.x + quad.x, y: panel.y + quad.y, w: quad.w, h: quad.h },
      zoomT,
    );
    const screen: ExternalItem = {
      kind: "external",
      sourceId: props.videoFile,
      sourceTimeSec,
      sourceKind: "video",
      placement: { mode: "resolved", sourceRect, quad: zoomedQuad },
      opacity: 1,
      effects: colorFilterEffects(props),
      // 角丸は zoom を掛ける前の px 指定(design.screen.radiusPx)だが、
      // パネルは zoom 器の内側にあるため CSS transform: scale() が
      // border-radius の見た目ごと拡大する。scale を掛けて追随させる
      // (Main.tsx:410 の borderRadius が zoom 器の内側にある構造の逐語再現)
      radiusPx: design ? design.screen.radiusPx * zoomT.scale : undefined,
    };
    items.push(screen);
  }

  return items;
}

/**
 * zoom 連動のワイプ縮小率(0..1)。baked 経路
 * (zoomTransformTrack)は OpenScreen 逐語の reactiveWebcamScale を
 * zoomT.scale から直接駆動、legacy 経路は区間の wipeScale ×
 * zoomProgressAt を使う。区間探索は activeZoomSpanAt で
 * zoomProgressAt と揃えてある。
 */
function wipeReactiveShrink(
  props: RenderProps,
  tOut: number,
  zoomT: ZoomTransform,
  wipeEase: number,
): number {
  const reactiveMin = props.wipe.reactiveMinScale ?? 0.35;
  const reactiveFactor = Math.max(
    reactiveMin,
    Math.min(1, Number.isFinite(zoomT.scale) && zoomT.scale > 0 ? 1 / zoomT.scale : 1),
  );
  if (props.zoomTransformTrack) {
    return 1 - (1 - reactiveFactor) * (1 - wipeEase);
  }
  const zoomSpans = props.zooms ?? [];
  const activeWipeScale = activeZoomSpanAt(tOut, zoomSpans)?.wipeScale ?? 1;
  return 1 - (1 - activeWipeScale) * zoomProgressAt(tOut, zoomSpans) * (1 - wipeEase);
}

/**
 * グループ2: カメラ(ワイプ)+ wipeFull(全画面化の遷移)+ zoom 連動のワイプ
 * 縮小。design 有無で矩形の式が分岐する(design.camera があれば
 * wipeRectAt、無ければ props.wipe.style)し、縮小は選択アンカー基準で行う。
 * 縦プロファイル(layout あり)・カメラ無しのいずれかなら何も出さない
 * (Main.tsx:370-372 の layerNode("wipe") 分岐の逐語移植)。
 *
 * カメラは zoom transform を受けない(zoom 器の外側にある独立レイヤー。
 * Main.tsx の DOM 構造どおり)。layerOrder での重なり順の反映は
 * グループ5(layerOrder)で行う(このグループでは items 配列末尾に積むだけ)
 */
export function describeWipeLayer(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout || !props.cameraRegion) return [];
  const sourceTimeSec = baseSourceTimeAt(props, tOut);
  if (sourceTimeSec === null) return [];

  const cameraRegion = props.cameraRegion;
  const fallbackWipeH = Math.round((props.wipe.widthPx * cameraRegion.h) / cameraRegion.w);
  const style = props.wipe.style;
  const baseWipeRect = style?.rect ?? {
    x: props.width - props.wipe.widthPx,
    y: props.height - fallbackWipeH,
    w: props.wipe.widthPx,
    h: fallbackWipeH,
  };
  const wipeT = props.wipe.transitionSec ?? 0;
  const wipeEase = wipeProgressAt(tOut, props.wipeFull, wipeT);

  const zoomT = zoomTransformAtOut(props, tOut);
  const shrinkS = wipeReactiveShrink(props, tOut, zoomT, wipeEase);

  const designCamera = props.design?.camera;
  let box: Rect;
  let radiusPx: number | undefined;
  if (designCamera) {
    const designWipe = wipeRectAt(designCamera, props.width, props.height, wipeEase);
    const shrunk = shrinkWipeRect(
      designWipe.rect,
      designWipe.radiusPx,
      style?.anchor ?? "bottom-right",
      shrinkS,
    );
    box = shrunk.rect;
    radiusPx = shrunk.radiusPx;
  } else {
    const lerp = (from: number, to: number) => Math.round(from + (to - from) * wipeEase);
    const expanded = {
      x: lerp(baseWipeRect.x, 0),
      y: lerp(baseWipeRect.y, 0),
      w: lerp(baseWipeRect.w, props.width),
      h: lerp(baseWipeRect.h, props.height),
    };
    const shrunk = shrinkWipeRect(
      expanded,
      style?.radiusPx ?? 0,
      style?.anchor ?? "bottom-right",
      shrinkS,
    );
    box = shrunk.rect;
    radiusPx = shrunk.radiusPx || undefined;
  }

  const { sourceRect, quad } = resolveFit(cameraRegion, box, "cover");
  const camera: ExternalItem = {
    kind: "external",
    sourceId: props.videoFile,
    sourceTimeSec,
    sourceKind: "video",
    placement: {
      mode: "resolved",
      sourceRect,
      quad: { x: box.x + quad.x, y: box.y + quad.y, w: quad.w, h: quad.h },
    },
    opacity: 1,
    effects: colorFilterEffects(props),
    radiusPx,
  };
  return [camera];
}

/** spans のいずれかが [start,end) で t を含むか(Main.tsx の inSpan 逐語) */
function inSpan(spans: { start: number; end: number }[], t: number): boolean {
  return spans.some((s) => t >= s.start && t < s.end);
}

/**
 * 1件のテロップ(caption)の見た目を解決する(CaptionLayer.tsx の
 * PositionedCaption/OutlinedText が毎フレーム行う解決の逐語移植)。
 * 優先順は「セグメント個別 → トラック標準(buildRenderProps で解決済みの
 * caption.style)→ config 既定(defaults)」。karaoke は語単位の状態を
 * この時刻 tOut で解決して content.words に展開する(hash が語境界でだけ
 * 変わる契約)
 */
function resolveCaptionContent(
  caption: Caption,
  defaults: RenderProps["caption"],
  tOut: number,
): CaptionContent {
  const style = caption.style;
  const fontSizePx = style?.fontSizePx ?? defaults.fontSizePx;
  const color = style?.color ?? defaults.color ?? CAPTION_DEFAULT_COLOR;
  const outlineColor = style?.outlineColor ?? defaults.outlineColor ?? CAPTION_DEFAULT_OUTLINE;
  const outlineWidthPx =
    style?.outlineWidthPx !== undefined ? style.outlineWidthPx : Math.round(fontSizePx * 0.25);
  const fontFamily = style?.fontFamily ?? defaults.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY;
  const fontWeight = style?.fontWeight ?? defaults.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT;
  const resolvedBg = resolveCaptionBackground(style?.background, defaults.background);
  const background = resolvedBg
    ? {
        color: resolvedBg.color,
        paddingPx: resolvedBg.paddingPx ?? Math.round(fontSizePx * 0.35),
        radiusPx: resolvedBg.radiusPx ?? 8,
      }
    : undefined;

  const content: CaptionContent = {
    kind: "caption",
    text: caption.text,
    fontSizePx,
    color,
    outlineColor,
    outlineWidthPx,
    fontFamily,
    fontWeight,
    ...(background ? { background } : {}),
  };

  const karaokeStyle = style?.karaoke;
  if (karaokeStyle && caption.words && caption.words.length > 0) {
    const pieces = alignKaraoke(caption.text, caption.words);
    const mode = karaokeStyle.mode ?? "word";
    const activeFlags = karaokeActiveAt(pieces, tOut);
    const words: CaptionWord[] = pieces.map((p, i) => {
      if (mode === "fill" && p.start !== null && p.end !== null && tOut >= p.start && tOut < p.end) {
        return { text: p.text, active: true, fillProgress: karaokeFillProgress(p.start, p.end, tOut) };
      }
      return { text: p.text, active: activeFlags[i] };
    });
    content.words = words;
    content.karaokeMode = mode;
    content.karaokeActiveColor = karaokeStyle.activeColor ?? KARAOKE_DEFAULT_ACTIVE;
    content.karaokeInactiveColor = karaokeStyle.inactiveColor ?? color;
    if (karaokeStyle.inactiveOpacity !== undefined) {
      content.karaokeInactiveOpacity = karaokeStyle.inactiveOpacity;
    }
  }

  return content;
}

/** props.captions に登場するトラック番号の一覧(昇順・重複無し) */
function captionTracksOf(props: RenderProps): number[] {
  return Array.from(new Set(props.captions.map((c) => c.track))).sort((a, b) => a - b);
}

/**
 * 指定トラックの、その時刻に表示中のテロップ1件を解決する(無ければ null)。
 * CaptionLayer.tsx の lookupCaption と同じ優先度(配列順で最初の一致)。
 * hideCaption 区間は常に null(Main.tsx:354 の
 * `if (!caption || inSpan(props.hideCaption)) return null` 相当)
 */
function captionItemForTrack(props: RenderProps, tOut: number, track: number): RenderedItem | null {
  if (inSpan(props.hideCaption, tOut)) return null;
  const caption = props.captions.find((c) => c.track === track && tOut >= c.start && tOut < c.end);
  if (!caption) return null;

  const content = resolveCaptionContent(caption, props.caption, tOut);
  const contentHash = contentHashOf(content, { w: props.width, h: props.height });

  const anim = caption.style?.anim;
  const a = animStateAt(anim, caption.start, caption.end, tOut, content.fontSizePx);

  const pos = caption.pos ?? props.captionDefaultPos;
  let placement: RenderedPlacement;
  if (pos) {
    const resolvedAnchor = caption.pos ? caption.anchor : props.captionDefaultPos?.anchor;
    placement = {
      mode: "anchor",
      point: { x: pos.x, y: pos.y },
      anchor: resolvedAnchor === "topLeft" ? "topLeft" : "center",
    };
  } else {
    // カメラがあるときだけワイプと重ならないよう右側を空ける(B1: plain は予約ゼロ)
    const reserve = props.cameraRegion ? props.wipe.widthPx + props.wipe.marginPx * 2 : 0;
    const bandWidth = props.width - reserve;
    placement = {
      mode: "anchor",
      point: { x: bandWidth / 2, y: props.height - props.wipe.marginPx },
      anchor: "bottomCenter",
      maxWidthPx: bandWidth * 0.9,
    };
  }

  return {
    kind: "rendered",
    content,
    contentHash,
    placement,
    opacity: a.opacity,
    ...(anim ? { transform: { translateX: a.translateX, translateY: a.translateY, scale: a.scale } } : {}),
  };
}

/**
 * グループ3: テロップ(caption)。トラック番号昇順で「その時刻に表示中の
 * 1件」を積む。layerOrder による他レイヤーとの重なり順の反映はグループ5の
 * describeLayerOrderStack が行う(このグループ単体はトラック順のまま)
 */
export function describeCaptionLayer(props: RenderProps, tOut: number): FrameItem[] {
  const items: FrameItem[] = [];
  for (const track of captionTracksOf(props)) {
    const item = captionItemForTrack(props, tOut, track);
    if (item) items.push(item);
  }
  return items;
}

/** フェード係数(0〜1)。overlayFade.ts の fadeFactor(フレーム量子化)の
 * 連続時間版(descriptor は時刻キーなのでフレームを経由しない。区間の頭
 * fadeInSec 秒で 0→1、末尾 fadeOutSec 秒で 1→0。両方重なる短い区間では
 * 小さい方= min を採る、という意味論は完全に同じ) */
function fadeFactorAt(t: number, start: number, end: number, fadeInSec?: number, fadeOutSec?: number): number {
  let g = 1;
  if (fadeInSec && fadeInSec > 0) g = Math.min(g, Math.max(0, Math.min(1, (t - start) / fadeInSec)));
  if (fadeOutSec && fadeOutSec > 0) g = Math.min(g, Math.max(0, Math.min(1, (end - t) / fadeOutSec)));
  return g;
}

/** 1件の素材オーバーレイを描画する時刻の外側で呼び、その時刻での見た目に
 * 解決する(OverlayItemView の逐語移植)。区間外は null */
function overlayItemAt(
  o: RenderProps["overlays"][number],
  props: RenderProps,
  tOut: number,
): ExternalItem | null {
  if (tOut < o.start || tOut >= o.end) return null;
  const fade = fadeFactorAt(tOut, o.start, o.end, o.fadeInSec, o.fadeOutSec);
  const base = o.rect ? { x: o.rect.x, y: o.rect.y, w: o.rect.w, h: o.rect.h, opacity: o.opacity ?? 1 } : null;
  const now = base && o.keyframes ? valuesAt(base, o.keyframes, tOut) : base;
  const opacity = (now?.opacity ?? o.opacity ?? 1) * fade;
  const box = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : { x: 0, y: 0, w: props.width, h: props.height };
  return {
    kind: "external",
    sourceId: o.file,
    sourceTimeSec: (o.startFrom ?? 0) + (tOut - o.start),
    sourceKind: isImageFile(o.file) ? "image" : "video",
    placement: {
      mode: "fit",
      fit: o.fit,
      box,
      ...(now ? {} : { letterboxColor: "black" }),
    },
    opacity,
  };
}

/** 指定トラックの素材オーバーレイのうち、この時刻に表示中のものを
 * (overlays.json の記載順のまま)集める */
function overlayItemsForTrack(props: RenderProps, tOut: number, track: number): ExternalItem[] {
  const items: ExternalItem[] = [];
  for (const o of props.overlays) {
    if (o.track !== track) continue;
    const item = overlayItemAt(o, props, tOut);
    if (item) items.push(item);
  }
  return items;
}

/**
 * グループ4a: 素材オーバーレイ(overlays.json の overlays[])。
 * OverlayItemView(OverlayLayer.tsx)の逐語移植。rect 指定は部分配置
 * (PiP。contain の余白は透過)、無指定は全画面+黒余白(letterboxColor)。
 * keyframes は valuesAt(既に出力秒へ写像済み)でこの時刻の値を解決する。
 * 音は descriptor 対象外(絵のみ。CLAUDE.md の overlays.json 表どおり)。
 * layerOrder による重なり順の反映はグループ5の describeLayerOrderStack が
 * 行う(このグループ単体は overlays.json の記載順のまま)
 */
export function describeOverlayItems(props: RenderProps, tOut: number): FrameItem[] {
  const items: FrameItem[] = [];
  for (const o of props.overlays) {
    const item = overlayItemAt(o, props, tOut);
    if (item) items.push(item);
  }
  return items;
}

/**
 * グループ4b: 挿入クリップ(overlays.json の inserts[])。InsertView
 * (Main.tsx)の逐語移植。常に全画面+黒背景、keyframes・rect 概念は無い。
 * 音は descriptor 対象外(絵のみ)
 */
export function describeInsertItems(props: RenderProps, tOut: number): FrameItem[] {
  const items: FrameItem[] = [];
  for (const ins of props.inserts ?? []) {
    if (tOut < ins.start || tOut >= ins.end) continue;
    const fade = fadeFactorAt(tOut, ins.start, ins.end, ins.fadeInSec, ins.fadeOutSec);
    const item: ExternalItem = {
      kind: "external",
      sourceId: ins.file,
      sourceTimeSec: (ins.startFrom ?? 0) + (tOut - ins.start),
      sourceKind: isImageFile(ins.file) ? "image" : "video",
      placement: {
        mode: "fit",
        fit: ins.fit,
        box: { x: 0, y: 0, w: props.width, h: props.height },
        letterboxColor: "black",
      },
      opacity: fade,
    };
    items.push(item);
  }
  return items;
}

/**
 * グループ5a: 領域ぼかし(overlays.json の blurs)。Main.tsx:441-483 の
 * 逐語移植。硬い ON/OFF(遷移無し)、strength<=0 は「効果なし」で出さない。
 * rect は zoom に追従せず出力px固定。本編のみ(縦プロファイル/videoFile空は対象外)
 */
export function describeBlurItems(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout || props.videoFile === "") return [];
  const items: FrameItem[] = [];
  for (const b of props.blurs ?? []) {
    if (tOut < b.start || tOut >= b.end) continue;
    const now = b.keyframes
      ? valuesAt({ x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h, strength: b.strength }, b.keyframes, tOut)
      : null;
    const rect = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : b.rect;
    const strength = now?.strength ?? b.strength;
    if (strength <= 0) continue; // 効果なし(スライダ0=消える、の直感に合わせる)
    const content: BlurRegionContent = { kind: "blurRegion", rect, radiusPx: blurRadiusPx(strength) };
    items.push({
      kind: "rendered",
      content,
      contentHash: contentHashOf(content, { w: props.width, h: props.height }),
      opacity: 1,
    });
  }
  return items;
}

/**
 * グループ5b: 注釈グラフィック(overlays.json の annotations)。
 * AnnotationLayer.tsx の3種別(arrow/box/spotlight)の逐語移植。硬い
 * ON/OFF(遷移無し)。zoom には追従せず出力px固定。最前面固定(layerOrder
 * には載らない)。本編のみ(縦プロファイル/videoFile空は対象外)
 */
export function describeAnnotationItems(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout || props.videoFile === "") return [];
  const items: FrameItem[] = [];
  for (const a of props.annotations ?? []) {
    if (tOut < a.start || tOut >= a.end) continue;
    let content: RenderedContent;
    if (a.type === "arrow") {
      const now = a.keyframes
        ? valuesAt(
            { fromX: a.from.x, fromY: a.from.y, toX: a.to.x, toY: a.to.y, widthPx: a.widthPx, headPx: a.headPx },
            a.keyframes,
            tOut,
          )
        : null;
      content = {
        kind: "annotationArrow",
        from: now ? { x: now.fromX, y: now.fromY } : a.from,
        to: now ? { x: now.toX, y: now.toY } : a.to,
        color: a.color,
        widthPx: now?.widthPx ?? a.widthPx,
        headPx: now?.headPx ?? a.headPx,
      };
    } else if (a.type === "box") {
      const now = a.keyframes
        ? valuesAt(
            { x: a.rect.x, y: a.rect.y, w: a.rect.w, h: a.rect.h, widthPx: a.widthPx, radiusPx: a.radiusPx },
            a.keyframes,
            tOut,
          )
        : null;
      content = {
        kind: "annotationBox",
        rect: now ? { x: now.x, y: now.y, w: now.w, h: now.h } : a.rect,
        color: a.color,
        widthPx: now?.widthPx ?? a.widthPx,
        radiusPx: now?.radiusPx ?? a.radiusPx,
        ...(a.fill !== undefined ? { fill: a.fill } : {}),
      };
    } else {
      const now = a.keyframes
        ? valuesAt(
            { x: a.rect.x, y: a.rect.y, w: a.rect.w, h: a.rect.h, dim: a.dim, featherPx: a.featherPx, radiusPx: a.radiusPx },
            a.keyframes,
            tOut,
          )
        : null;
      content = {
        kind: "annotationSpotlight",
        rect: now ? { x: now.x, y: now.y, w: now.w, h: now.h } : a.rect,
        shape: a.shape,
        dim: now?.dim ?? a.dim,
        featherPx: now?.featherPx ?? a.featherPx,
        radiusPx: now?.radiusPx ?? a.radiusPx,
      };
    }
    items.push({
      kind: "rendered",
      content,
      contentHash: contentHashOf(content, { w: props.width, h: props.height }),
      opacity: 1,
    });
  }
  return items;
}

/**
 * グループ5c: layerOrder(素材/wipe/テロップの重なり順)。
 * normalizeLayerOrder 済みの完全な配列(props.layerOrder。無ければ
 * DEFAULT_LAYER_ORDER)を下から順に辿り、各 id に対応する現在時刻の
 * item を積む(ov<N>=そのトラックの素材、wipe=カメラ、caption/cap<N>=
 * そのトラックのテロップ)。Main.tsx の layerNode(id) 分岐と
 * hiddenLayers filter の逐語移植(完全一致で除外)。
 * 書き出しの props に hiddenLayers が載ることは無いため、
 * 既存 descriptor golden は不変。
 */
export function describeLayerOrderStack(props: RenderProps, tOut: number): FrameItem[] {
  const layerOrder = (props.layerOrder ?? DEFAULT_LAYER_ORDER)
    .filter((id) => !props.hiddenLayers?.includes(id));
  const items: FrameItem[] = [];
  for (const id of layerOrder) {
    const ovTrack = ovNum(id);
    if (ovTrack !== null) {
      items.push(...overlayItemsForTrack(props, tOut, ovTrack));
      continue;
    }
    const capTrack = capNum(id);
    if (capTrack !== null) {
      const item = captionItemForTrack(props, tOut, capTrack);
      if (item) items.push(item);
      continue;
    }
    if (id === "wipe") {
      items.push(...describeWipeLayer(props, tOut));
    }
  }
  return items;
}

/**
 * グループ6: profile layout があるプリセット経路のパネル合成。
 * Main.tsx:245-268 の renderPanels の逐語移植。パネルは配列順(下→上)に
 * screen/camera を crop して並べるだけ(zoom・design は縦プリセットには
 * 乗らない=既存の描画分岐どおり。他方 colorFilter は renderBase を共有
 * するため例外的に乗る=CLAUDE.md の overlays.json 表の注記どおり)。
 *
 * RenderProps は呼び出し側が buildRenderProps に profile を渡して構築済みのものを渡す。
 */
export function describeProfilePanelsLayer(props: RenderProps, tOut: number): FrameItem[] {
  if (!props.layout || props.videoFile === "") return [];
  const sourceTimeSec = baseSourceTimeAt(props, tOut);
  if (sourceTimeSec === null) return [];

  const items: FrameItem[] = [];
  for (const panel of props.layout.panels) {
    const region = panel.source === "screen" ? props.screenRegion : (props.cameraRegion ?? props.screenRegion);
    const rect = panel.rect ?? { x: 0, y: 0, w: props.width, h: props.height };
    const { sourceRect, quad } = resolveFit(region, rect, panel.fit);
    const item: ExternalItem = {
      kind: "external",
      sourceId: props.videoFile,
      sourceTimeSec,
      sourceKind: "video",
      placement: {
        mode: "resolved",
        sourceRect,
        quad: { x: rect.x + quad.x, y: rect.y + quad.y, w: quad.w, h: quad.h },
      },
      opacity: 1,
      effects: colorFilterEffects(props),
    };
    items.push(item);
  }
  return items;
}

/**
 * カット境界のディップ・トゥ・ブラック(config.yaml の render.cutTransition
 * が dip-to-black のときだけ props に載る)。Main.tsx:157-165 の逐語移植:
 * 各境界 tb の前後 cutHalf 秒で 0→1→0 の三角波。最上層(annotation より上)
 * の黒い全画面 fill として1件だけ出す(opacity<=0 なら出さない)
 */
export function describeCutTransition(props: RenderProps, tOut: number): FrameItem[] {
  const cutHalf = (props.cutTransition?.sec ?? 0) / 2;
  if (cutHalf <= 0) return [];
  const cutOpacity = (props.cutBoundarySecs ?? []).reduce((max, tb) => {
    if (tOut < tb - cutHalf || tOut > tb + cutHalf) return max;
    const p = tOut <= tb ? (tOut - (tb - cutHalf)) / cutHalf : (tb + cutHalf - tOut) / cutHalf;
    return Math.max(max, p);
  }, 0);
  if (cutOpacity <= 0) return [];
  const content: FillContent = { kind: "fill", color: "black" };
  const item: RenderedItem = {
    kind: "rendered",
    content,
    contentHash: contentHashOf(content, { w: props.width, h: props.height }),
    placement: { mode: "quad", quad: { x: 0, y: 0, w: props.width, h: props.height } },
    opacity: cutOpacity,
  };
  return [item];
}

export function describeFrame(props: RenderProps, tOut: number): FrameDescriptor {
  const items: FrameItem[] = [];
  items.push(...describeBaseLayer(props, tOut));
  items.push(...describeProfilePanelsLayer(props, tOut));
  items.push(...describeInsertItems(props, tOut));
  items.push(...describeBlurItems(props, tOut));
  items.push(...describeLayerOrderStack(props, tOut));
  items.push(...describeAnnotationItems(props, tOut));
  items.push(...describeCutTransition(props, tOut));
  return {
    tOut,
    size: { w: props.width, h: props.height },
    backgroundColor: props.design?.backgroundColor ?? "black",
    items,
  };
}
