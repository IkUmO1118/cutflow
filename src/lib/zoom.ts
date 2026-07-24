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
  DEFAULT_ZOOM_CHAIN_PAN_SEC,
  DEFAULT_ZOOM_EASE_IN_SEC,
  DEFAULT_ZOOM_EASE_OUT_SEC,
  DEFAULT_ZOOM_LEAD_SEC,
} from "../types.ts";
import type { Region } from "../types.ts";
// C 枝(per-zoom 強さ): OpenScreen 逐語の depth テーブル/clamp 境界だけを使う。
// zoom.ts は Remotion バンドルに乗るため、vendor の「純関数のみ」の types.ts
// (node 依存なし)からしか import しない
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, ZOOM_DEPTH_SCALES } from "./vendor/openscreen/types.ts";

/** config.yaml の render.zoom の部分形状(renderProps.ts が buildRenderProps に
 * 渡す Config["render"]["zoom"] と構造的に互換)。zoom.ts は config.ts を
 * import しない(config.ts は node:fs 等を持ち込み、renderProps.ts 経由で
 * ブラウザ/Remotion バンドルへ漏れるため。§docs/decisions.md) */
export interface ZoomRenderCfg {
  easeSec?: number;
  easeInSec?: number;
  easeOutSec?: number;
  chainGapSec?: number;
  leadSec?: number;
  chainPanSec?: number;
  /** baked経路の reactive webcam 縮小の下限(0..1)。省略時 0.35
   * (OpenScreen WEBCAM_REACTIVE_ZOOM_MIN_SCALE 逐語)。1.0=縮小なし。
   * 値を上げるほど縮小が穏やかになる */
  webcamReactiveMinScale?: number;
}

/** render.zoom.webcamReactiveMinScale 未指定時の既定。OpenScreen 移植
 * (vendor/openscreen/webcamReactive.ts の WEBCAM_REACTIVE_ZOOM_MIN_SCALE 参照) */
export const DEFAULT_WEBCAM_REACTIVE_MIN_SCALE = 0.35;

/** render.zoom.{easeInSec,easeOutSec,chainGapSec,leadSec,chainPanSec} を
 *  既定値で解決する純関数(OpenScreen 移植 D3。
 *  §docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md)。
 *  ease の優先順位は各方向とも「easeInSec/easeOutSec 個別指定」→「easeSec(両方
 *  未指定時の後方互換値。対称のまま値だけ引き継ぐ)」→「新既定(1.5秒/1.0秒の
 *  非対称)」。buildRenderProps はここで解決した値へさらに zooms[].easeSec/
 *  easeOutSec(zoom 1件ごとの個別指定)を上書きする。chainGapSec/leadSec/
 *  chainPanSec は zoom 1件ごとの上書きは非目標(overlays.json のスキーマは
 *  変えない) */
export function resolveZoomCfg(zoomCfg: ZoomRenderCfg | undefined): {
  easeInSec: number;
  easeOutSec: number;
  chainGapSec: number;
  leadSec: number;
  chainPanSec: number;
  webcamReactiveMinScale: number;
} {
  const z = zoomCfg ?? {};
  return {
    easeInSec: z.easeInSec ?? z.easeSec ?? DEFAULT_ZOOM_EASE_IN_SEC,
    easeOutSec: z.easeOutSec ?? z.easeSec ?? DEFAULT_ZOOM_EASE_OUT_SEC,
    chainGapSec: z.chainGapSec ?? DEFAULT_ZOOM_CHAIN_GAP_SEC,
    leadSec: z.leadSec ?? DEFAULT_ZOOM_LEAD_SEC,
    chainPanSec: z.chainPanSec ?? DEFAULT_ZOOM_CHAIN_PAN_SEC,
    webcamReactiveMinScale: z.webcamReactiveMinScale ?? DEFAULT_WEBCAM_REACTIVE_MIN_SCALE,
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
  /** 先読み(pre-roll)。区間開始のこの秒だけ前からイーズインを開始する
   * (孤立ズームのみ。連鎖側には効かない)。省略時 DEFAULT_ZOOM_LEAD_SEC(0.5)。
   * OpenScreen 移植 D3(#1・D1c) */
  leadSec?: number;
  /** gap のある連鎖(chainGapSec 以内だが完全隣接ではない)のパン遷移秒数。
   * 完全隣接(gap=0)には効かず easeSec を使う。省略時
   * DEFAULT_ZOOM_CHAIN_PAN_SEC(1.0)。OpenScreen 移植 D3(#2・D2b) */
  chainPanSec?: number;
  /** 省略=manual(固定 focus)。"auto"=カーソル追従。1つでも持つと render は
   * OpenScreen 逐語の precompute 経路(spring 込み)に切り替わる(枝A・P3)。
   * 持たない既存収録はバイト等価(effectiveZoomRange の拡張も未指定時は
   * 一切効かない) */
  focusMode?: "manual" | "auto";
  /** ズームの強さ(段階)。1..6 → ZOOM_DEPTH_SCALES。省略時は rect 由来
   * (scale=width/rect.w)。customScale が優先(枝C) */
  depth?: 1 | 2 | 3 | 4 | 5 | 6;
  /** 強さの直接指定(1.0–5.0)。depth より優先。指定時は rect.w を無視し
   * rect 中心だけを focus として使う(枝C) */
  customScale?: number;
}

/**
 * ズーム区間の有効スケールを解決する(OpenScreen 移植・枝C)。
 * `customScale ?? (depth ? ZOOM_DEPTH_SCALES[depth] : width/rect.w)`。
 * customScale は [MIN_ZOOM_SCALE, MAX_ZOOM_SCALE] へクランプする
 * (`vendor/openscreen/types.ts:getZoomScale` と同じ意味論)。
 * **depth・customScale とも未指定のときは `width / rect.w` を寸分違わず返す**
 * (バイト等価不変条件の要。この分岐だけは従来のリテラル式のまま) */
export function resolveZoomScale(
  z: { rect: Region; depth?: 1 | 2 | 3 | 4 | 5 | 6; customScale?: number },
  width: number,
): number {
  if (z.customScale != null && Number.isFinite(z.customScale)) {
    return Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, z.customScale));
  }
  if (z.depth != null) return ZOOM_DEPTH_SCALES[z.depth];
  return width / z.rect.w;
}

/** OpenScreen 逐語 precompute 経路(focusMode 指定時)のリードイン秒。
 * computeRegionStrength は startMs+ZOOM_IN_OVERLAP_MS(500) から
 * ZOOM_IN_TRANSITION_WINDOW_MS(1522.575) 遡って立ち上がる
 * = 実効開始は startMs-1022.575ms。FAST/SLOW とチャンクキャッシュがこの範囲を
 * SLOW/局所キーに含むよう effectiveZoomRange をこの分だけ前へ広げる(母艦 D4)。 */
export const OPENSCREEN_LEAD_IN_SEC = 1.022575;
/** 同・リードアウト秒。computeRegionStrength は endMs 以降
 * TRANSITION_WINDOW_MS(1015.05ms) かけて 0 へ戻る。 */
export const OPENSCREEN_LEAD_OUT_SEC = 1.01505;

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

/** z より前(z.start 以下の end を持つ)にある他ズームのうち最も遅い end
 * (無ければ 0=タイムライン先頭)。pre-roll が食い込んでよい下限を決めるのに使う */
function timelineFloorBefore(z: ZoomSpan, zooms: ZoomSpan[]): number {
  let floor = 0;
  for (const o of zooms) {
    if (o !== z && o.end <= z.start && o.end > floor) floor = o.end;
  }
  return floor;
}

/**
 * 先読み(pre-roll)を適用した実効開始秒(クランプ済み。OpenScreen 移植 D3・
 * D1c)。leadSec だけ前倒しし、直前ズームの末尾/タイムライン先頭(0)より
 * 前へは出ないよう詰める(決定論)。呼び出し側は「連鎖(contiguousPrev あり)
 * なら使わない(z.start のまま)」を判断すること(連鎖側は既に前 rect からの
 * パンで入るため pre-roll しない)
 */
function leadAdjustedStart(z: ZoomSpan, zooms: ZoomSpan[]): number {
  const lead = z.leadSec ?? DEFAULT_ZOOM_LEAD_SEC;
  if (lead <= 0) return z.start;
  const floor = timelineFloorBefore(z, zooms);
  return Math.max(floor, z.start - lead);
}

/** z が(区間探索・pre-roll 込みで)実時間 t を担当する開始秒。連鎖側は
 * z.start のまま、孤立側は leadAdjustedStart で前倒しする */
function matchStart(z: ZoomSpan, zooms: ZoomSpan[]): number {
  return contiguousPrev(z, zooms) ? z.start : leadAdjustedStart(z, zooms);
}

/**
 * z が(区間探索込みで)実時間 t を担当する終了秒(OpenScreen 移植 D3・D2b)。
 * 次と gap のある連鎖(chainGapSec 以内だが完全隣接ではない)なら、gap 区間
 * (z.end 〜 次の start)は「z(前)の延長」として扱い、次の区間開始まで z が
 * 担当する(前 rect のフルズームを保持する。z は次と連鎖=contiguousNext ありの
 * 間ずっと outRaw=1 で保持し続けるので、この延長区間でも自然にフルズームの
 * まま)。次が無い/完全隣接(gap=0)なら z.end のまま(拡張の必要が無い) */
function matchEnd(z: ZoomSpan, zooms: ZoomSpan[]): number {
  const next = contiguousNext(z, zooms);
  return next ? Math.max(z.end, next.start) : z.end;
}

/**
 * z が「gap のある連鎖」の後続側か(contiguousPrev があり、かつその gap が
 * ZOOM_CONTIG_EPS を超える=完全隣接ではない)。true なら D2b のパン
 * (chainPanSec)を使う側、false なら従来どおり easeSec を使う側
 */
function gapChainedFrom(z: ZoomSpan, zooms: ZoomSpan[]): ZoomSpan | undefined {
  const prev = contiguousPrev(z, zooms);
  if (!prev) return undefined;
  return z.start - prev.end > ZOOM_CONTIG_EPS ? prev : undefined;
}

/** z より後ろ(z.end 以上の start を持つ)にある他ズームのうち最も早い start
 * (無ければ undefined=タイムライン末尾までクランプなし)。focusMode の
 * リードアウト(OPENSCREEN_LEAD_OUT_SEC)が後続ズームへ食い込まないよう
 * 上限を決めるのに使う */
function timelineCeilAfter(z: ZoomSpan, zooms: ZoomSpan[]): number | undefined {
  let ceil: number | undefined;
  for (const o of zooms) {
    if (o !== z && o.start >= z.end && (ceil === undefined || o.start < ceil)) ceil = o.start;
  }
  return ceil;
}

/**
 * ズーム区間 z の実効区間(pre-roll・gap 保持込み。OpenScreen 移植 D3・
 * D1c・D2b)。FAST/SLOW 判定・チャンクキャッシュキーなど「この時間は
 * ズームの影響を受ける」を判定したい経路は、zoomProgressAt/zoomTransformAt
 * の区間探索と食い違わないようここを通す。孤立側の頭は leadAdjustedStart で
 * 前倒しし、gap のある連鎖の尾は次区間の頭まで延長する(前 rect 保持)。
 * **focusMode 指定時のみ**(枝A・P3)、連鎖しない側の端をさらに
 * OpenScreen 逐語 precompute 経路の実効窓(OPENSCREEN_LEAD_IN_SEC /
 * OPENSCREEN_LEAD_OUT_SEC)まで広げる。focusMode 未指定なら常に
 * matchStart/matchEnd のまま = 従来とバイト等価
 */
export function effectiveZoomRange(z: ZoomSpan, zooms: ZoomSpan[]): { start: number; end: number } {
  const prev = contiguousPrev(z, zooms);
  const next = contiguousNext(z, zooms);
  const start =
    !prev && z.focusMode
      ? Math.max(timelineFloorBefore(z, zooms), z.start - OPENSCREEN_LEAD_IN_SEC)
      : matchStart(z, zooms);
  const end =
    !next && z.focusMode
      ? (() => {
          const ceil = timelineCeilAfter(z, zooms);
          const extended = z.end + OPENSCREEN_LEAD_OUT_SEC;
          return ceil !== undefined ? Math.min(extended, ceil) : extended;
        })()
      : matchEnd(z, zooms);
  return { start, end };
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

/** rect がちょうど全画面になる transform(イーズ完了状態の値)。
 * `scale` を渡すと rect.w からではなくその値を使う(rect は中心=focus 専用に
 * 降格。枝C・depth/customScale)。**省略時は `width / rect.w` を使い従来と
 * バイト等価**(呼び出し側が resolveZoomScale で解決した値を渡さない限り
 * 挙動は一切変わらない) */
function fullTransformOf(rect: Region, width: number, height: number, scale?: number): ZoomTransform {
  const s = scale ?? width / rect.w;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    scale: s,
    translateX: width / 2 - s * cx,
    translateY: height / 2 - s * cy,
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
  const z = zooms.find((z) => t >= matchStart(z, zooms) && t < matchEnd(z, zooms));
  if (!z) return 0;
  const { easeIn, easeOut } = easeWindows(z);
  const inRaw = contiguousPrev(z, zooms)
    ? 1
    : easeIn <= 0
      ? 1
      : Math.min(1, (t - leadAdjustedStart(z, zooms)) / easeIn);
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
  const z = zooms.find((z) => t >= matchStart(z, zooms) && t < matchEnd(z, zooms));
  if (!z) return IDENTITY;
  const prev = contiguousPrev(z, zooms);
  const { easeIn, easeOut } = easeWindows(z);
  // 入りの基準秒・窓の長さは3通り(OpenScreen 移植 D3):
  // - 孤立: pre-roll ぶん前倒しした実効開始秒から easeIn で(D1c)
  // - gap のある連鎖(完全隣接ではない): z.start から chainPanSec で(D2b)
  // - 完全隣接(gap=0): 従来どおり z.start から easeIn で
  const gapPrev = gapChainedFrom(z, zooms);
  let inStart: number;
  let inWindow: number;
  if (!prev) {
    inStart = leadAdjustedStart(z, zooms);
    inWindow = easeIn;
  } else if (gapPrev) {
    const half = (z.end - z.start) / 2;
    const chainPanSec = z.chainPanSec ?? DEFAULT_ZOOM_CHAIN_PAN_SEC;
    inStart = z.start;
    inWindow = Math.min(chainPanSec, half);
  } else {
    inStart = z.start;
    inWindow = easeIn;
  }
  const inRaw = inWindow <= 0 ? 1 : Math.min(1, (t - inStart) / inWindow);
  const outRaw = contiguousNext(z, zooms)
    ? 1
    : easeOut <= 0
      ? 1
      : Math.min(1, (z.end - t) / easeOut);
  const full = fullTransformOf(z.rect, width, height, resolveZoomScale(z, width));
  const from = prev ? fullTransformOf(prev.rect, width, height, resolveZoomScale(prev, width)) : IDENTITY;
  // 入り: from(前の rect のフルズーム or 恒等)→ full。出: 恒等へ戻す
  const enter = lerpTransform(from, full, zoomEase(inRaw, "in"));
  return lerpTransform(IDENTITY, enter, zoomEase(outRaw, "out"));
}
