// remotion/Main.tsx の背景レイヤーが使う純関数。zooms(overlays.json 由来。
// カット後の秒・rect・easeSec/easeOutSec 解決済み)から、時刻 t における
// 背景レイヤーの拡大・平行移動を求める。区間外は恒等(scale=1, translate=0)。
// 区間の頭 easeSec 秒でイーズイン、末尾 easeOutSec 秒でイーズアウトし、
// 遷移カーブは cubic-bezier(0.16,1,0.3,1)(OpenScreen 移植 D3・zoomEase)。
// 区間が短いときは各遷移を区間の半分へ縮める(wipeFull の既存規則を踏襲)。
// **旧 smoothstep からの差し替えで「孤立区間の値は従来とビット等価」という
// 不変条件を意図的に破る**(docs/decisions.md 参照。§docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md)。
//
// 連鎖(パン遷移): 隣のズームと隙間なく接する(前の end === 次の start)とき、
// 境界で等倍へ戻らない。前の区間は末尾までフルズームを保ち(イーズアウトを
// しない)、次の区間の頭 easeSec 秒で前の rect から次の rect へ直接パンする
// (scale・translate を zoomEase で補間)。孤立した区間の値は smoothstep から
// zoomEase への差し替えの影響を受ける(カーブが変わるため)。
import {
  DEFAULT_ZOOM_CHAIN_GAP_SEC,
  DEFAULT_ZOOM_EASE_IN_SEC,
  DEFAULT_ZOOM_EASE_OUT_SEC,
} from "../types.ts";
import type { Region } from "../types.ts";

/** config.yaml の render.zoom の部分形状(renderProps.ts が buildRenderProps に
 * 渡す Config["render"]["zoom"] と構造的に互換)。zoom.ts は config.ts を
 * import しない(config.ts は node:fs 等を持ち込み、renderProps.ts 経由で
 * ブラウザ/Remotion バンドルへ漏れるため。§docs/decisions.md) */
export interface ZoomRenderCfg {
  easeSec?: number;
  easeInSec?: number;
  easeOutSec?: number;
  chainGapSec?: number;
}

/** render.zoom.{easeInSec,easeOutSec,chainGapSec} を既定値で解決する純関数
 *  (OpenScreen 移植 D3。§docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md)。
 *  ease の優先順位は各方向とも「easeInSec/easeOutSec 個別指定」→「easeSec(両方
 *  未指定時の後方互換値。対称のまま値だけ引き継ぐ)」→「新既定(1.5秒/1.0秒の
 *  非対称)」。buildRenderProps はここで解決した値へさらに zooms[].easeSec/
 *  easeOutSec(zoom 1件ごとの個別指定)を上書きする */
export function resolveZoomCfg(zoomCfg: ZoomRenderCfg | undefined): {
  easeInSec: number;
  easeOutSec: number;
  chainGapSec: number;
} {
  const z = zoomCfg ?? {};
  return {
    easeInSec: z.easeInSec ?? z.easeSec ?? DEFAULT_ZOOM_EASE_IN_SEC,
    easeOutSec: z.easeOutSec ?? z.easeSec ?? DEFAULT_ZOOM_EASE_OUT_SEC,
    chainGapSec: z.chainGapSec ?? DEFAULT_ZOOM_CHAIN_GAP_SEC,
  };
}

/** ズーム演出1件(カット後の秒に写像済み・easeSec 解決済み) */
export interface ZoomSpan {
  start: number;
  end: number;
  rect: Region;
  easeSec: number;
  easeOutSec?: number;
  /** 隣接ズームを連鎖(パン遷移)とみなす gap の上限(秒)。省略時
   * DEFAULT_ZOOM_CHAIN_GAP_SEC(1.5)。OpenScreen 移植 D3(#2・D2a) */
  chainGapSec?: number;
}

export interface ZoomTransform {
  /** 出力全体に掛ける一様スケール(1 = 等倍) */
  scale: number;
  /** スケール後に加える平行移動量(px。transform-origin を左上とした前提) */
  translateX: number;
  translateY: number;
}

const IDENTITY: ZoomTransform = { scale: 1, translateX: 0, translateY: 0 };

/** 浮動小数の合成誤差の吸収用(秒)。元収録秒で end === start(gap=0 の
 * 完全隣接)なら renderProps の写像(同じ算術)を通ってもカット後の秒は
 * 厳密に一致するが、合成誤差に備えて 1µs まで許す(演算誤差(高々 1e-10 秒
 * 程度)より十分小さいギャップ差は意図的な区別と誤認しない程度に小さい) */
export const ZOOM_CONTIG_EPS = 1e-6;

/** a(先行)の直後に b(後続)が chainGapSec 以内の gap で続くか = パン遷移で
 * つなぐ連鎖か(OpenScreen 移植 D3・D2a)。負の gap(重なり。validate が
 * そもそもエラーにする)は連鎖にしない(誤差吸収の ZOOM_CONTIG_EPS だけ許容)。
 * 旧仕様(完全隣接 = gap 以内 1µs)は chainGapSec: 0 を渡すのと等価 */
export function zoomContiguous(aEnd: number, bStart: number, chainGapSec: number): boolean {
  const gap = bStart - aEnd;
  return gap >= -ZOOM_CONTIG_EPS && gap <= chainGapSec + ZOOM_CONTIG_EPS;
}

/** z の直前に chainGapSec 以内の gap で連鎖するズーム(無ければ undefined)。
 * zooms は重ならない前提(validate がエラーにする)なので該当は高々1つ */
function contiguousPrev(z: ZoomSpan, zooms: ZoomSpan[]): ZoomSpan | undefined {
  const chainGapSec = z.chainGapSec ?? DEFAULT_ZOOM_CHAIN_GAP_SEC;
  return zooms.find((o) => o !== z && zoomContiguous(o.end, z.start, chainGapSec));
}

/** z の直後に chainGapSec 以内の gap で連鎖するズーム(無ければ undefined) */
function contiguousNext(z: ZoomSpan, zooms: ZoomSpan[]): ZoomSpan | undefined {
  const chainGapSec = z.chainGapSec ?? DEFAULT_ZOOM_CHAIN_GAP_SEC;
  return zooms.find((o) => o !== z && zoomContiguous(z.end, o.start, chainGapSec));
}

/** cubic-bezier(x1,y1,x2,y2) の P0=(0,0)・P3=(1,1) 固定版を x=raw で解いて
 * y を返す(WebKit の UnitBezier と同じ Newton-Raphson + 収束しないときの
 * 二分法フォールバック。純粋・決定論)。x は [0,1] にクランプ済み前提 */
function cubicBezierY(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleXDeriv = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xErr = sampleX(t) - x;
    if (Math.abs(xErr) < 1e-7) return sampleY(t);
    const d = sampleXDeriv(t);
    if (Math.abs(d) < 1e-6) break;
    t -= xErr / d;
  }
  // Newton-Raphson が発散/収束しなかったときの安全な二分法フォールバック
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 30; i++) {
    const xt = sampleX(t);
    if (Math.abs(xt - x) < 1e-7) break;
    if (xt < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/** OpenScreen 移植 D3(#1): Screen Studio 級の寄りに使われている
 * cubic-bezier(0.16, 1, 0.3, 1)(通称 easeOutExpo 系)。イーズイン・アウト共通の
 * 既定カーブ(dir は将来 in/out で別カーブにする余地を残すための引数で、
 * 本 plan では両方この曲線に固定)。
 * §docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md D1a */
const SCREEN_STUDIO_BEZIER = { x1: 0.16, y1: 1, x2: 0.3, y2: 1 } as const;

/** ズームのイーズ進行度を求める。raw は [0,1] の生の線形進行度(クランプ
 * 済みでなくても内部でクランプする)、dir は将来のイーズ差し替えの余地
 * (現状は in/out とも同じ曲線)。zoomProgressAt/zoomTransformAt はこの
 * 1関数だけを通す(2箇所でカーブ定義が割れないようにする契約) */
export function zoomEase(raw: number, dir: "in" | "out" = "in"): number {
  void dir;
  const x = Math.max(0, Math.min(1, raw));
  return cubicBezierY(
    x,
    SCREEN_STUDIO_BEZIER.x1,
    SCREEN_STUDIO_BEZIER.y1,
    SCREEN_STUDIO_BEZIER.x2,
    SCREEN_STUDIO_BEZIER.y2,
  );
}

/** rect がちょうど全画面になる transform(イーズ完了状態の値) */
function fullTransformOf(rect: Region, width: number, height: number): ZoomTransform {
  const scale = width / rect.w;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    scale,
    translateX: width / 2 - scale * cx,
    translateY: height / 2 - scale * cy,
  };
}

/** scale・translate を p ∈ [0,1] で線形補間する(p=0 で a、p=1 で b)。
 * a=恒等のとき従来の `p * full` と同じ式になる(ビット等価の要) */
function lerpTransform(a: ZoomTransform, b: ZoomTransform, p: number): ZoomTransform {
  return {
    scale: a.scale + (b.scale - a.scale) * p,
    translateX: a.translateX + (b.translateX - a.translateX) * p,
    translateY: a.translateY + (b.translateY - a.translateY) * p,
  };
}

/** 区間 z の入り/出のイーズ窓の長さ(区間が短いときは半分へ縮める) */
function easeWindows(z: ZoomSpan): { easeIn: number; easeOut: number } {
  const half = (z.end - z.start) / 2;
  return {
    easeIn: Math.min(z.easeSec, half),
    easeOut: Math.min(z.easeOutSec ?? z.easeSec, half),
  };
}

/**
 * 時刻 t(カット後の秒)におけるズームの進行度 p ∈ [0,1]。区間外は 0、
 * 区間頭で easeSec 秒かけて 1 へイーズイン、区間末尾で easeOutSec 秒かけて
 * 0 へイーズアウトする(smoothstep)。区間が短いときは各遷移を区間の半分へ
 * 縮める。連鎖(隣接ズーム)がある側は遷移せず 1 のまま(パン中もズームには
 * 入りっぱなし=ワイプ縮小が境界で戻らない)。zoomTransformAt と全く同じ
 * 区間探索・ease クランプ・カーブを使う(縮小ワイプ(render.zoom.wipeScale)等、
 * zoom と同じトランジションを共有したい他の演出がこの関数を再利用する)。
 * zooms は重ならない前提(validate がエラーにする)なので、該当区間は高々1つ。
 */
export function zoomProgressAt(t: number, zooms: ZoomSpan[]): number {
  const z = zooms.find((z) => t >= z.start && t < z.end);
  if (!z) return 0;
  const { easeIn, easeOut } = easeWindows(z);
  const inRaw = contiguousPrev(z, zooms)
    ? 1
    : easeIn <= 0
      ? 1
      : Math.min(1, (t - z.start) / easeIn);
  const outRaw = contiguousNext(z, zooms)
    ? 1
    : easeOut <= 0
      ? 1
      : Math.min(1, (z.end - t) / easeOut);
  // どちらのイーズが効いているか(=raw が小さい方)を dir として渡す。
  // 現状は in/out 同一曲線なので数値は Math.min(inRaw, outRaw) を単に
  // easeする場合と一致する(zoomTransformAt との契約を保つ)
  return inRaw <= outRaw ? zoomEase(inRaw, "in") : zoomEase(outRaw, "out");
}

/**
 * 時刻 t(カット後の秒)における背景レイヤーの transform。
 * rect の中心が出力の中心に来るよう平行移動し、scale = 出力幅 / rect.w に
 * 一様拡大する(歪ませない。rect のアスペクトが出力と違っても崩れない)。
 * 連鎖(隣接ズーム)では、頭のイーズインが「恒等から」ではなく「前の rect の
 * フルズームから」の補間になり(=パン)、末尾は次があればイーズアウトしない。
 * イーズの窓は入り・出で重ならない(各 ≤ 区間の半分)ので、孤立した区間の
 * 値は従来の min(in, out) 合成とビット等価。zooms は重ならない前提
 * (validate がエラーにする)なので、該当区間は高々1つ。
 */
export function zoomTransformAt(
  t: number,
  zooms: ZoomSpan[],
  width: number,
  height: number,
): ZoomTransform {
  const z = zooms.find((z) => t >= z.start && t < z.end);
  if (!z) return IDENTITY;
  const prev = contiguousPrev(z, zooms);
  const { easeIn, easeOut } = easeWindows(z);
  const inRaw = easeIn <= 0 ? 1 : Math.min(1, (t - z.start) / easeIn);
  const outRaw = contiguousNext(z, zooms)
    ? 1
    : easeOut <= 0
      ? 1
      : Math.min(1, (z.end - t) / easeOut);
  const full = fullTransformOf(z.rect, width, height);
  const from = prev ? fullTransformOf(prev.rect, width, height) : IDENTITY;
  // 入り: from(前の rect のフルズーム or 恒等)→ full。出: 恒等へ戻す
  const enter = lerpTransform(from, full, zoomEase(inRaw, "in"));
  return lerpTransform(IDENTITY, enter, zoomEase(outRaw, "out"));
}
