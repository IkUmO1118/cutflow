// remotion/Main.tsx の背景レイヤーが使う純関数。zooms(overlays.json 由来。
// カット後の秒・rect・easeSec 解決済み)から、時刻 t における背景レイヤーの
// 拡大・平行移動を求める。区間外は恒等(scale=1, translate=0)。区間の頭
// easeSec 秒でイーズイン、末尾 easeOutSec 秒でイーズアウトし、遷移カーブは
// wipeFull(remotion/Main.tsx の wipeEase)と同じ smoothstep。区間が短いときは
// 各遷移を区間の半分へ縮める(wipeFull の既存規則を踏襲)。
//
// 連鎖(パン遷移): 隣のズームと隙間なく接する(前の end === 次の start)とき、
// 境界で等倍へ戻らない。前の区間は末尾までフルズームを保ち(イーズアウトを
// しない)、次の区間の頭 easeSec 秒で前の rect から次の rect へ直接パンする
// (scale・translate を smoothstep で補間)。孤立した区間の値は従来と不変。
import type { Region } from "../types.ts";

/** ズーム演出1件(カット後の秒に写像済み・easeSec 解決済み) */
export interface ZoomSpan {
  start: number;
  end: number;
  rect: Region;
  easeSec: number;
  easeOutSec?: number;
}

export interface ZoomTransform {
  /** 出力全体に掛ける一様スケール(1 = 等倍) */
  scale: number;
  /** スケール後に加える平行移動量(px。transform-origin を左上とした前提) */
  translateX: number;
  translateY: number;
}

const IDENTITY: ZoomTransform = { scale: 1, translateX: 0, translateY: 0 };

/** 連鎖(隣接)判定の許容誤差(秒)。元収録秒で end === start なら
 * renderProps の写像(同じ算術)を通ってもカット後の秒は厳密に一致するが、
 * 浮動小数の合成誤差に備えて 1µs まで許す(意図的な微小ギャップを連鎖と
 * 誤認しない程度に小さく、演算誤差(高々 1e-10 秒程度)より十分大きく) */
export const ZOOM_CONTIG_EPS = 1e-6;

/** a(先行)の直後に b(後続)が隙間なく続くか = パン遷移でつなぐ連鎖か */
export function zoomContiguous(aEnd: number, bStart: number): boolean {
  return Math.abs(bStart - aEnd) <= ZOOM_CONTIG_EPS;
}

/** z の直前に隙間なく接するズーム(無ければ undefined)。zooms は重ならない
 * 前提(validate がエラーにする)なので該当は高々1つ */
function contiguousPrev(z: ZoomSpan, zooms: ZoomSpan[]): ZoomSpan | undefined {
  return zooms.find((o) => o !== z && zoomContiguous(o.end, z.start));
}

/** z の直後に隙間なく接するズーム(無ければ undefined) */
function contiguousNext(z: ZoomSpan, zooms: ZoomSpan[]): ZoomSpan | undefined {
  return zooms.find((o) => o !== z && zoomContiguous(z.end, o.start));
}

const smoothstep = (raw: number): number => raw * raw * (3 - 2 * raw);

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
  return smoothstep(Math.min(inRaw, outRaw));
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
  const enter = lerpTransform(from, full, smoothstep(inRaw));
  return lerpTransform(IDENTITY, enter, smoothstep(outRaw));
}
