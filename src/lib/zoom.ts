// remotion/Main.tsx の背景レイヤーが使う純関数。zooms(overlays.json 由来。
// カット後の秒・rect・easeSec 解決済み)から、時刻 t における背景レイヤーの
// 拡大・平行移動を求める。区間外は恒等(scale=1, translate=0)。区間の頭
// easeSec 秒でイーズイン、末尾 easeOutSec 秒でイーズアウトし、遷移カーブは
// wipeFull(remotion/Main.tsx の wipeEase)と同じ smoothstep。区間が短いときは
// 各遷移を区間の半分へ縮める(wipeFull の既存規則を踏襲)。
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

/**
 * 時刻 t(カット後の秒)におけるズームの進行度 p ∈ [0,1]。区間外は 0、
 * 区間頭で easeSec 秒かけて 1 へイーズイン、区間末尾で easeOutSec 秒かけて
 * 0 へイーズアウトする(smoothstep)。区間が短いときは各遷移を区間の半分へ
 * 縮める。zoomTransformAt と全く同じ区間探索・ease クランプ・カーブを使う
 * (縮小ワイプ(render.zoom.wipeScale)等、zoom と同じトランジションを共有
 * したい他の演出がこの関数を再利用する)。zooms は重ならない前提
 * (validate がエラーにする)なので、該当区間は高々1つ。
 */
export function zoomProgressAt(t: number, zooms: ZoomSpan[]): number {
  const z = zooms.find((z) => t >= z.start && t < z.end);
  if (!z) return 0;
  const half = (z.end - z.start) / 2;
  const easeIn = Math.min(z.easeSec, half);
  const easeOut = Math.min(z.easeOutSec ?? z.easeSec, half);
  const inRaw = easeIn <= 0 ? 1 : Math.min(1, (t - z.start) / easeIn);
  const outRaw = easeOut <= 0 ? 1 : Math.min(1, (z.end - t) / easeOut);
  const raw = Math.min(inRaw, outRaw);
  return raw * raw * (3 - 2 * raw); // smoothstep
}

/**
 * 時刻 t(カット後の秒)における背景レイヤーの transform。
 * rect の中心が出力の中心に来るよう平行移動し、scale = 出力幅 / rect.w に
 * 一様拡大する(歪ませない。rect のアスペクトが出力と違っても崩れない)。
 * zooms は重ならない前提(validate がエラーにする)なので、該当区間は
 * 高々1つ。
 */
export function zoomTransformAt(
  t: number,
  zooms: ZoomSpan[],
  width: number,
  height: number,
): ZoomTransform {
  const z = zooms.find((z) => t >= z.start && t < z.end);
  if (!z) return IDENTITY;
  const p = zoomProgressAt(t, zooms);
  const targetScale = width / z.rect.w;
  const scale = 1 + (targetScale - 1) * p;
  const cx = z.rect.x + z.rect.w / 2;
  const cy = z.rect.y + z.rect.h / 2;
  // p=0: 恒等(translate 0)。p=1: rect 中心が出力中心に来る平行移動
  // (scale(p) 済みの座標系での移動量なので targetScale を使う)
  const translateX = p * (width / 2 - targetScale * cx);
  const translateY = p * (height / 2 - targetScale * cy);
  return { scale, translateX, translateY };
}
