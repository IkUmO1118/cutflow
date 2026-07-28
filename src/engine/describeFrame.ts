// src/engine/describeFrame.ts — JSON(正) → buildRenderProps() で解決済みの
// RenderProps → この純関数 → FrameDescriptor、の翻訳層(M2 Phase2)。
// remotion/Main.tsx の式を逐語移植する(アレンジ禁止。設計書の落とし穴節を
// 参照)。ブラウザ安全な純 TS のみ(node import 禁止)。
//
// 演出グループはコミット単位(docs/plans/2026-07-28-engine-m2-frame-descriptor-design.md
// §Phase2)。このファイルは各グループの内部関数を追記していく形で育つ。
import { zoomProgressAt, zoomTransformAt } from "../lib/zoom.ts";
import type { ZoomSpan, ZoomTransform } from "../lib/zoom.ts";
import { panelRect, shrinkRectBottomRight, wipeRectAt } from "../lib/design.ts";
import { wipeProgressAt } from "../lib/wipe.ts";
import type {
  ColorFilterEffect,
  Effect,
  ExternalItem,
  FrameDescriptor,
  FrameItem,
  Rect,
} from "./descriptor.ts";
import type { RenderProps } from "../../remotion/props.ts";

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
 * (wipeFull)側で扱う。ショート(props.layout があるとき)のパネル合成は
 * グループ6で扱う(このグループでは何も出さない=Main.tsx が
 * `props.layout ? renderPanels(...) : <zoom 器>` で分岐するのと同じ)
 */
export function describeBaseLayer(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout) return []; // ショート経路はグループ6
  if (props.videoFile === "") return []; // Studio のプレースホルダー表示は対象外

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
 * zoom 連動のワイプ縮小率(0..1。Main.tsx:130-140 の逐語移植)。baked 経路
 * (zoomTransformTrack)は OpenScreen 逐語の reactiveWebcamScale を
 * zoomT.scale から直接駆動、legacy 経路は区間の wipeScale ×
 * zoomProgressAt を使う(§Phase0 記録のとおり2経路で式が分岐する)
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
  const activeWipeScale = zoomSpans.find((z) => tOut >= z.start && tOut < z.end)?.wipeScale ?? 1;
  return 1 - (1 - activeWipeScale) * zoomProgressAt(tOut, zoomSpans) * (1 - wipeEase);
}

/**
 * グループ2: カメラ(ワイプ)+ wipeFull(全画面化の遷移)+ zoom 連動のワイプ
 * 縮小。design 有無で矩形の式が分岐する(design.camera があれば
 * wipeRectAt+shrinkRectBottomRight、無ければ右下 flush の素の矩形)。
 * ショート(layout あり)・カメラ無し・wipeBurnedIn(render 高速パスで
 * cut.mp4 に焼き込み済み)のいずれかなら何も出さない
 * (Main.tsx:370-372 の layerNode("wipe") 分岐の逐語移植)。
 *
 * カメラは zoom transform を受けない(zoom 器の外側にある独立レイヤー。
 * Main.tsx の DOM 構造どおり)。layerOrder での重なり順の反映は
 * グループ5(layerOrder)で行う(このグループでは items 配列末尾に積むだけ)
 */
export function describeWipeLayer(props: RenderProps, tOut: number): FrameItem[] {
  if (props.layout || !props.cameraRegion || props.wipeBurnedIn) return [];
  const sourceTimeSec = baseSourceTimeAt(props, tOut);
  if (sourceTimeSec === null) return [];

  const cameraRegion = props.cameraRegion;
  const wipeH = Math.round((props.wipe.widthPx * cameraRegion.h) / cameraRegion.w);
  const wipeT = props.wipe.transitionSec ?? 0;
  const wipeEase = wipeProgressAt(tOut, props.wipeFull, wipeT);
  const wipeW = Math.round(props.wipe.widthPx + (props.width - props.wipe.widthPx) * wipeEase);
  const wipeHNow = Math.round(wipeH + (props.height - wipeH) * wipeEase);

  const zoomT = zoomTransformAtOut(props, tOut);
  const shrinkS = wipeReactiveShrink(props, tOut, zoomT, wipeEase);

  const designCamera = props.design?.camera;
  let box: Rect;
  let radiusPx: number | undefined;
  if (designCamera) {
    const designWipe = wipeRectAt(designCamera, props.width, props.height, wipeEase);
    const shrunk = shrinkRectBottomRight(designWipe.rect, designWipe.radiusPx, shrinkS);
    box = shrunk.rect;
    radiusPx = shrunk.radiusPx;
  } else {
    const wipeWNow = Math.round(wipeW * shrinkS);
    const wipeHShrunk = Math.round(wipeHNow * shrinkS);
    box = { x: props.width - wipeWNow, y: props.height - wipeHShrunk, w: wipeWNow, h: wipeHShrunk };
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
    radiusPx,
  };
  return [camera];
}

export function describeFrame(props: RenderProps, tOut: number): FrameDescriptor {
  const items: FrameItem[] = [];
  items.push(...describeBaseLayer(props, tOut));
  items.push(...describeWipeLayer(props, tOut));
  return {
    tOut,
    size: { w: props.width, h: props.height },
    backgroundColor: props.design?.backgroundColor ?? "black",
    items,
  };
}
