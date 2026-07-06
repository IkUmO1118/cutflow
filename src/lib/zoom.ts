// remotion/Main.tsx の背景レイヤーが使う純関数。zooms(overlays.json 由来。
// カット後の秒・rect・easeSec 解決済み)から、時刻 t における背景レイヤーの
// 拡大・平行移動を求める。区間外は恒等(scale=1, translate=0)。区間の頭
// easeSec 秒でイーズイン、末尾 easeSec 秒でイーズアウトし、遷移カーブは
// wipeFull(remotion/Main.tsx の wipeEase)と同じ smoothstep。区間が遷移
// 2回分より短いときは遷移を区間の半分へ縮める(wipeFull の既存規則を踏襲)。
import type { Region } from "../types.ts";

/** ズーム演出1件(カット後の秒に写像済み・easeSec 解決済み) */
export interface ZoomSpan {
  start: number;
  end: number;
  rect: Region;
  easeSec: number;
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
  const ease = Math.min(z.easeSec, (z.end - z.start) / 2);
  const raw = ease <= 0 ? 1 : Math.min(1, (t - z.start) / ease, (z.end - t) / ease);
  const p = raw * raw * (3 - 2 * raw); // smoothstep
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
