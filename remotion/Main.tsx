import { Fragment, useEffect, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  getRemotionEnvironment,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CAPTION_DEFAULT_FONT_FAMILY,
  DEFAULT_LAYER_ORDER,
  capNum,
  ovNum,
} from "../src/types.ts";
import type { LayerId } from "../src/types.ts";
import { frameSpans } from "../src/lib/renderProps.ts";
import { buildCaptionIndex, lookupCaption } from "../src/lib/captionIndex.ts";
import { arrowHeadPoints } from "../src/lib/annotation.ts";
import { blurRadiusPx, mosaicBlockPx, outputRectToCanvasRegion } from "../src/lib/blur.ts";
import { cssFilterOf } from "../src/lib/colorFilter.ts";
import { duckFactorAt } from "../src/lib/duck.ts";
import { valuesAt } from "../src/lib/keyframes.ts";
import { cropFitStyle } from "../src/lib/panelStyle.ts";
import { zoomTransformAt } from "../src/lib/zoom.ts";
import { PositionedCaption } from "./CaptionLayer.tsx";
import type { OverlayItem, Region, RenderProps, Span } from "./props.ts";
// 副作用 import: テロップ既定フォント(Noto Sans JP 可変)を登録する。
import "./loadFonts.ts";

const JP_FONT = CAPTION_DEFAULT_FONT_FAMILY;

/** 素材が無いトラックに毎回新しい [] を渡さないための共有の空配列 */
const EMPTY_OVERLAYS: OverlayItem[] = [];

/** 素材オーバーレイをトラック番号別にまとめる(配列順は保つ)。layerNode が
 * 毎フレーム props.overlays.filter(...) で全件走査+配列確保していたのを解消 */
function groupOverlaysByTrack(overlays: OverlayItem[]): Map<number, OverlayItem[]> {
  const m = new Map<number, OverlayItem[]>();
  for (const o of overlays) {
    const arr = m.get(o.track);
    if (arr) arr.push(o);
    else m.set(o.track, [o]);
  }
  return m;
}

// ---- Player 専用: 再生補助の切り分けフラグ ----
// エディタの URL にクエリを付けると、再生補助の機構を個別に無効化して
// ブラウザごとの症状を切り分けられる(例: http://127.0.0.1:4310/?nohold)。
//   ?nohold     … フレームホールド(ファイル末尾)を無効化
//   ?nopremount … カット境界・挿入・素材の premount(2秒先読み)を無効化
// 呼び出し時に評価する(isPlayer を示す window.remotion_isPlayer は
// モジュール評価の時点ではまだ立っていない)。最終レンダー・frames は
// isPlayer=false なので常に既定動作(影響なし)
const playerFlag = (name: string): boolean =>
  typeof location !== "undefined" &&
  getRemotionEnvironment().isPlayer &&
  location.search.includes(name);
/** Sequence の premountFor 値(?nopremount で切れる。Player 専用の挙動) */
const premountFrames = (fps: number) =>
  playerFlag("nopremount") ? undefined : fps * 2;

/**
 * 最終レンダーのレイアウト:
 * - 背景: カット済み動画から画面領域をクロップして全面表示(常に最下層)
 * - 右下: カメラ領域をクロップしたワイプ(角丸)
 * - 下部中央: 文字起こしベースの字幕(位置指定のあるテロップは任意の場所)
 * ワイプ・素材・テロップの重なりは props.layerOrder(下→上)に従う
 */
export const Main = (props: RenderProps) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  // videoFile が空 = Studio をリポジトリ直下で開いた状態(cut.mp4 が無い)。
  // 動画の代わりにプレースホルダーを出してデザイン調整だけできるようにする
  const hasVideo = props.videoFile !== "";
  const src = hasVideo ? staticFile(props.videoFile) : "";

  // カメラが無ければ(plain)ワイプレイヤー自体を描かないので値は使われない
  const wipeH = props.cameraRegion
    ? Math.round((props.wipe.widthPx * props.cameraRegion.h) / props.cameraRegion.w)
    : 0;
  const inSpan = (spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);
  // ワイプ全画面区間は、ワイプの器を画面サイズまで広げる。transitionSec が
  // あれば区間の頭で広がり・末尾で戻る(0=1 の進行度を smoothstep で緩急)。
  // 区間が遷移2回分より短いときは遷移を区間の半分へ縮め、短い区間でも
  // 必ず全画面に到達させる(遷移導入前のデータの見え方を保つ)
  const wipeT = props.wipe.transitionSec ?? 0;
  const wipeProgress = props.wipeFull.reduce((max, s) => {
    if (t < s.start || t >= s.end) return max;
    const wt = Math.min(wipeT, (s.end - s.start) / 2);
    const p = wt <= 0 ? 1 : Math.min(1, (t - s.start) / wt, (s.end - t) / wt);
    return Math.max(max, p);
  }, 0);
  const wipeEase = wipeProgress * wipeProgress * (3 - 2 * wipeProgress);
  const wipeW = Math.round(props.wipe.widthPx + (props.width - props.wipe.widthPx) * wipeEase);
  const wipeHNow = Math.round(wipeH + (props.height - wipeH) * wipeEase);

  // カット境界のディップ・トゥ・ブラック(config.yaml の render.cutTransition が
  // dip-to-black のときだけ props に載る)。境界点 tb の前後 sec/2 で
  // 0→1→0 の黒フェードを重ねる。尺・音声・字幕のタイミングには一切触れず、
  // 最上層(テロップより上)に黒い AbsoluteFill を重ねるだけの合成層の演出
  // ズーム演出(画面の一部を拡大)。ベース映像の背景レイヤーだけに掛ける
  // transform(props.layout があるショート/縦経路には zooms が乗らないので
  // 自動的にここは恒等のまま=関与しない。D2 と同じ相乗り)
  const zoomT = zoomTransformAt(t, props.zooms ?? [], props.width, props.height);
  // 簡易カラー調整(overlays.json の colorFilter)。ベース映像(画面クロップ+
  // カメラ=同一収録動画)だけに効く CSS filter(renderBase の全呼び出しに
  // 乗せる。素材オーバーレイ・挿入クリップは対象外)
  const filterCss = cssFilterOf(props.colorFilter);

  const cutHalf = (props.cutTransition?.sec ?? 0) / 2;
  const cutOpacity =
    cutHalf > 0
      ? (props.cutBoundarySecs ?? []).reduce((max, tb) => {
          if (t < tb - cutHalf || t > tb + cutHalf) return max;
          const p = t <= tb ? (t - (tb - cutHalf)) / cutHalf : (tb + cutHalf - t) / cutHalf;
          return Math.max(max, p);
        }, 0)
      : 0;

  // ベース映像の再生区間。挿入(inserts)があると分割され、区間ごとに
  // videoFile 内の videoStart から再生する(挿入中はベース映像が止まる)。
  // 画面クロップとワイプの両方が同じ分割を共有する
  const baseSegs = props.baseSegments ?? [
    { start: 0, videoStart: 0, durationSec: props.durationSec },
  ];
  // ベース区間・挿入の Sequence のフレーム区間。独立に丸めると境界に
  // 1フレームの黒穴や音の二重再生ができるので、隣接区間で境界フレームを
  // 共有させる(詳細は frameSpans のコメント)
  // frameSpans は props にのみ依存する純関数だが、useCurrentFrame より下で
  // 呼ぶので memo しないと再生中フレームごとに O(baseSegments log n) のソートと
  // 配列確保が走る(長尺=keep 数百でプロキシのベース区間もその数になる)。
  // 入力は再生中に変わらないので memo 化で毎フレームの再計算・確保を消す
  const seqFrames = useMemo(
    () =>
      frameSpans({
        baseSegments: baseSegs,
        inserts: props.inserts ?? [],
        fps,
        durationInFrames,
      }),
    [baseSegs, props.inserts, fps, durationInFrames],
  );
  const continuous =
    baseSegs.length === 1 &&
    baseSegs[0].start === 0 &&
    baseSegs[0].videoStart === 0 &&
    baseSegs[0].playbackRate === undefined;
  const renderBase = (
    region: Region,
    width: number,
    height: number,
    muted: boolean,
    fit: "contain" | "cover" = "cover",
    imageRendering?: "pixelated",
  ) =>
    continuous ? (
      <CroppedVideo
        src={src}
        canvas={props.canvas}
        region={region}
        width={width}
        height={height}
        muted={muted}
        fit={fit}
        filter={filterCss}
        imageRendering={imageRendering}
      />
    ) : (
      baseSegs.map((seg, i) => (
        <Sequence
          key={seg.start}
          from={seqFrames.base[i].from}
          durationInFrames={seqFrames.base[i].durationInFrames}
          // エディタ(Player)では次の区間の <video> を2秒先読みして
          // シーク済みにしておく(カット境界の黒フラッシュ防止)。
          // 最終レンダーには影響しない(premount は Player 専用の挙動)
          premountFor={premountFrames(fps)}
        >
          <CroppedVideo
            src={src}
            startFromFrames={Math.round(seg.videoStart * fps)}
            {...(seg.playbackRate !== undefined ? { playbackRate: seg.playbackRate } : {})}
            canvas={props.canvas}
            region={region}
            width={width}
            height={height}
            muted={muted}
            fit={fit}
            filter={filterCss}
            imageRendering={imageRendering}
          />
        </Sequence>
      ))
    );

  // 縦プリセット等の panels 描画経路(props.layout があるときだけ)。
  // 配列順(下→上)に CroppedVideo で敷き、region(screen/camera)を
  // panel.rect(省略時 全画面)へ panel.fit で収める。同じ動画ファイルの
  // 複数コピーになるので、音声の二重再生を避けて先頭パネルだけ音を出す
  // (どのパネルを無音にするかは見た目に関係しない。muteBase は先頭にのみ適用)
  const renderPanels = (layout: NonNullable<RenderProps["layout"]>) =>
    layout.panels.map((panel, i) => {
      // カメラが無ければ(plain)screenRegion へ解決する(camera→screen 解決の
      // 本実装は B4。plain は現状 props.layout を持たないのでここは到達しない)
      const region =
        panel.source === "screen" ? props.screenRegion : (props.cameraRegion ?? props.screenRegion);
      const rect = panel.rect ?? { x: 0, y: 0, w: props.width, h: props.height };
      const muted = i === 0 ? (props.muteBase ?? false) : true;
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            overflow: "hidden",
          }}
        >
          {renderBase(region, rect.w, rect.h, muted, panel.fit)}
        </div>
      );
    });

  // テロップトラックごとの表示中テロップ。旧式データ(track なし)は 1 扱い。
  // 位置・スタイルはテロップごとに解決済み(hideCaption は全テロップトラックに効く)。
  // 索引(トラック別・start 昇順)を memo 化して、毎フレームの線形走査
  // (props.captions 全件)を二分探索に落とす。ただし同一トラックのテロップが
  // 時間的に重なる手編集データでは .find の「配列順で最初の一致」と二分探索の
  // 「直前に始まった1件」が食い違うため、重なりの無い"clean"なトラックだけ
  // 二分探索し、重なりのあるトラックは従来どおり .find で厳密一致を保つ
  // (プレビューと最終レンダーの絵を1ピクセルも変えない)
  const captionIndex = useMemo(() => buildCaptionIndex(props.captions), [props.captions]);
  const captionAt = (track: number) => lookupCaption(captionIndex, track, t);

  // 素材オーバーレイもトラック別に前計算(layerNode が毎フレーム
  // props.overlays.filter(...) で全件走査+配列確保していたのを解消)
  const overlaysByTrack = useMemo(() => groupOverlaysByTrack(props.overlays), [props.overlays]);

  const wipeLayer: ReactNode = (
    <div
      style={{
        position: "absolute",
        right: 0,
        bottom: 0,
        width: wipeW,
        height: wipeHNow,
        overflow: "hidden",
      }}
    >
      {hasVideo && props.cameraRegion ? (
        renderBase(props.cameraRegion, wipeW, wipeHNow, true)
      ) : (
        <Placeholder label="カメラ" />
      )}
    </div>
  );

  // 重ね合わせレイヤー(ベース映像より上)。描画順 = layerOrder(下→上)。
  // ov<N>(素材)と cap<N>(テロップ)はどちらも可変個数
  const layerNode = (id: LayerId): ReactNode => {
    const n = ovNum(id);
    if (n !== null) {
      return (
        <OverlayLayer
          items={overlaysByTrack.get(n) ?? EMPTY_OVERLAYS}
          fps={fps}
        />
      );
    }
    const track = capNum(id);
    if (track !== null) {
      const caption = captionAt(track);
      if (!caption || inSpan(props.hideCaption)) return null;
      return (
        <PositionedCaption
          caption={caption}
          defaults={props.caption}
          captionDefaultPos={props.captionDefaultPos}
          cameraRegion={props.cameraRegion}
          wipe={props.wipe}
          width={props.width}
          t={t}
        />
      );
    }
    // 縦プリセット等(props.layout あり)ではワイプという概念が無いので
    // レイヤーとしても描画しない(D3)。カメラが無い(plain)場合も同様。
    // wipeFull もこのレイヤーが無ければ見た目に影響しない
    return id === "wipe"
      ? (props.layout || !props.cameraRegion || props.wipeBurnedIn ? null : wipeLayer)
      : null;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {hasVideo ? (
        props.layout ? (
          renderPanels(props.layout)
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transformOrigin: "0 0",
              transform: `translate(${zoomT.translateX}px, ${zoomT.translateY}px) scale(${zoomT.scale})`,
            }}
          >
            {renderBase(props.screenRegion, props.width, props.height, props.muteBase ?? false)}
          </div>
        )
      ) : (
        <Placeholder label="画面(screenRegion)" />
      )}

      {/* 挿入クリップ(イントロ等)。ベース映像と同じ最下層で、音声も持てる。
          premount はエディタ(Player)用の2秒先読み(頭の固まり防止) */}
      {(props.inserts ?? []).map((ins, i) => (
        <Sequence
          key={`ins-${i}`}
          from={seqFrames.inserts[i].from}
          durationInFrames={seqFrames.inserts[i].durationInFrames}
          premountFor={premountFrames(fps)}
        >
          <InsertView ins={ins} fps={fps} muteBase={props.muteBase ?? false} />
        </Sequence>
      ))}

      {/* 領域ぼかし/モザイク。ベース映像+zoom+挿入の直上・素材/テロップの直下。
          zoom transform の外(独立レイヤー)なので出力px固定。本編経路のみ
          (!props.layout && hasVideo)。ショート(props.layout あり)には
          継承しない(D2/座標が本編基準のため) */}
      {hasVideo && !props.layout &&
        (props.blurs ?? []).map((b, i) => {
          if (t < b.start || t >= b.end) return null; // 硬い ON/OFF(遷移なし)
          const now = b.keyframes
            ? valuesAt(
                { x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h, strength: b.strength },
                b.keyframes,
                t,
              )
            : null;
          const rect = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : b.rect;
          const strength = now?.strength ?? b.strength;
          const cr = outputRectToCanvasRegion(rect, props.screenRegion, props.width, props.height);
          const container = {
            position: "absolute" as const,
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            overflow: "hidden" as const,
          };
          if (b.type === "mosaic") {
            const block = mosaicBlockPx(strength);
            // 縮小レンダー → pixelated 拡大。box を block で割った小箱に描き、
            // その箱を scale(block) で拡大(ニアレストネイバー)。端数は ceil して
            // 余りをはみ出させ overflow:hidden で切る(隙間を作らない)
            const smallW = Math.max(1, Math.ceil(rect.w / block));
            const smallH = Math.max(1, Math.ceil(rect.h / block));
            return (
              <div key={`blur-${i}`} style={container}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: smallW,
                    height: smallH,
                    transform: `scale(${block})`,
                    transformOrigin: "0 0",
                    imageRendering: "pixelated",
                  }}
                >
                  {renderBase(cr, smallW, smallH, true, "cover", "pixelated")}
                </div>
              </div>
            );
          }
          // type === "blur"(既定): コンテナに blur() を掛ける。colorFilter は
          // 内側 CroppedVideo に既に乗っているので、コンテナ blur は色補正済みの
          // 映像にさらに合成される(CSS filter は積み重なる)
          return (
            <div
              key={`blur-${i}`}
              style={{ ...container, filter: `blur(${blurRadiusPx(strength)}px)` }}
            >
              {renderBase(cr, rect.w, rect.h, true, "cover")}
            </div>
          );
        })}

      {(props.layerOrder ?? DEFAULT_LAYER_ORDER)
        .filter((id) => !props.hiddenLayers?.includes(id))
        .map((id) => (
          <Fragment key={id}>{layerNode(id)}</Fragment>
        ))}

      {/* 注釈グラフィック(矢印/囲み/スポットライト)。独立レイヤーで最前面
          (テロップより上)。layerOrder には載らない固定順。zoom transform の
          外なので出力px固定。本編経路のみ(!props.layout && hasVideo)。
          ショート(props.layout あり)には継承しない(D2 と同じ相乗り) */}
      {hasVideo && !props.layout &&
        (props.annotations ?? []).map((a, i) => {
          if (t < a.start || t >= a.end) return null; // 硬い ON/OFF(遷移なし)
          if (a.type === "arrow") {
            const now = a.keyframes
              ? valuesAt(
                  {
                    fromX: a.from.x,
                    fromY: a.from.y,
                    toX: a.to.x,
                    toY: a.to.y,
                    widthPx: a.widthPx,
                    headPx: a.headPx,
                  },
                  a.keyframes,
                  t,
                )
              : null;
            const from = now ? { x: now.fromX, y: now.fromY } : a.from;
            const to = now ? { x: now.toX, y: now.toY } : a.to;
            const widthPx = now?.widthPx ?? a.widthPx;
            const headPx = now?.headPx ?? a.headPx;
            const { p1, p2 } = arrowHeadPoints(from, to, headPx);
            return (
              <svg
                key={`ann-${i}`}
                style={{
                  position: "absolute", inset: 0,
                  width: props.width, height: props.height, overflow: "visible",
                }}
              >
                <line
                  x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={a.color} strokeWidth={widthPx} strokeLinecap="round"
                />
                <polygon
                  points={`${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`}
                  fill={a.color}
                />
              </svg>
            );
          }
          if (a.type === "box") {
            const now = a.keyframes
              ? valuesAt(
                  {
                    x: a.rect.x,
                    y: a.rect.y,
                    w: a.rect.w,
                    h: a.rect.h,
                    widthPx: a.widthPx,
                    radiusPx: a.radiusPx,
                  },
                  a.keyframes,
                  t,
                )
              : null;
            return (
              <div
                key={`ann-${i}`}
                style={{
                  position: "absolute",
                  left: now?.x ?? a.rect.x,
                  top: now?.y ?? a.rect.y,
                  width: now?.w ?? a.rect.w,
                  height: now?.h ?? a.rect.h,
                  boxSizing: "border-box",
                  border: `${now?.widthPx ?? a.widthPx}px solid ${a.color}`,
                  borderRadius: now?.radiusPx ?? a.radiusPx,
                  ...(a.fill ? { backgroundColor: a.fill } : {}),
                }}
              />
            );
          }
          // spotlight: フルスクリーンの黒(fillOpacity=dim)に mask で rect(または
          // ellipse)の穴を開ける。featherPx は穴形状への feGaussianBlur で表現
          const maskId = `ann-spotlight-mask-${i}`;
          const blurId = `ann-spotlight-blur-${i}`;
          const now = a.keyframes
            ? valuesAt(
                {
                  x: a.rect.x,
                  y: a.rect.y,
                  w: a.rect.w,
                  h: a.rect.h,
                  dim: a.dim,
                  featherPx: a.featherPx,
                  radiusPx: a.radiusPx,
                },
                a.keyframes,
                t,
              )
            : null;
          const rect = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : a.rect;
          const dim = now?.dim ?? a.dim;
          const featherPx = now?.featherPx ?? a.featherPx;
          const radiusPx = now?.radiusPx ?? a.radiusPx;
          return (
            <svg
              key={`ann-${i}`}
              style={{
                position: "absolute", inset: 0,
                width: props.width, height: props.height,
              }}
            >
              <defs>
                {featherPx > 0 && (
                  <filter id={blurId}>
                    <feGaussianBlur stdDeviation={featherPx} />
                  </filter>
                )}
                <mask id={maskId}>
                  <rect x={0} y={0} width={props.width} height={props.height} fill="white" />
                  <g filter={featherPx > 0 ? `url(#${blurId})` : undefined}>
                    {a.shape === "ellipse" ? (
                      <ellipse
                        cx={rect.x + rect.w / 2}
                        cy={rect.y + rect.h / 2}
                        rx={rect.w / 2}
                        ry={rect.h / 2}
                        fill="black"
                      />
                    ) : (
                      <rect
                        x={rect.x} y={rect.y} width={rect.w} height={rect.h}
                        rx={radiusPx} fill="black"
                      />
                    )}
                  </g>
                </mask>
              </defs>
              <rect
                x={0} y={0} width={props.width} height={props.height}
                fill="black" fillOpacity={dim} mask={`url(#${maskId})`}
              />
            </svg>
          );
        })}

      {cutOpacity > 0 && (
        <AbsoluteFill style={{ backgroundColor: "black", opacity: cutOpacity }} />
      )}

      {!props.muteBgm &&
        props.bgm.map((track, i) => (
          <BgmTrack key={i} track={track} fps={fps} />
        ))}
    </AbsoluteFill>
  );
};

/** BGM トラック1区間。Sequence に載せて start〜end の間だけループ再生し、
 * 覆っていない時間は無音にする。音量は「基準音量 × 発話ダッキング ×
 * 区間頭/末尾のフェード」。ダッキングの spans は出力タイムライン通しの秒
 * なので、Sequence 内の相対フレーム f を from ぶんずらして絶対秒に直す */
const BgmTrack = ({
  track,
  fps,
}: {
  track: RenderProps["bgm"][number];
  fps: number;
}) => {
  const from = Math.round(track.start * fps);
  const durationInFrames = Math.max(1, Math.round((track.end - track.start) * fps));
  const gain = Math.pow(10, track.volumeDb / 20);
  const fadeInFrames = (track.fadeInSec ?? 0) * fps;
  const fadeOutFrames = (track.fadeOutSec ?? 0) * fps;
  const duck = track.duck;
  const duckGain = duck ? Math.pow(10, duck.duckDb / 20) : 1;
  // 発話ダッキングの係数(1=通常、duckGain=下げ切り)を区間の手前 fadeSec 秒で
  // 下げ、後ろ fadeSec 秒で戻す。duck.spans は非重複・隙間 > fadeSec×2 が
  // 保証されているので lib/duck.ts の二分探索に落とせる(毎フレーム
  // duck.spans 全件を線形走査していたのを解消)
  const duckFade = duck ? Math.max(duck.fadeSec, 1 / fps) : 0;
  return (
    <Sequence from={from} durationInFrames={durationInFrames}>
      <Audio
        loop
        // BGM が区間より短くループするとき、volume コールバックの f を
        // 周回内の相対フレームではなく区間通しのフレームにする
        // (既定の "repeat" だと2周目以降ダッキングとフェードがずれる)
        loopVolumeCurveBehavior="extend"
        src={staticFile(track.file)}
        {...(track.startFrom ? { startFrom: Math.round(track.startFrom * fps) } : {})}
        volume={(f) => {
          const sec = (from + f) / fps;
          const fadeIn =
            fadeInFrames > 0
              ? interpolate(f, [0, fadeInFrames], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 1;
          const fadeOut =
            fadeOutFrames > 0
              ? interpolate(f, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 1;
          const duckFactor = duck ? duckFactorAt(duck.spans, sec, duckFade, duckGain) : 1;
          return gain * duckFactor * fadeIn * fadeOut;
        }}
      />
    </Sequence>
  );
};

/** 素材オーバーレイの1トラック分。Sequence に載せることで、
 * 動画素材は表示区間の頭から再生される(区間外は存在しない)。
 * 頭出し・挿入で割れた断片は startFrom で素材の続きから再生する */
const OverlayLayer = ({
  items,
  fps,
}: {
  items: OverlayItem[];
  fps: number;
}) => (
  <>
    {items
      .map((o, i) => (
        <Sequence
          key={`${o.file}-${o.start}-${i}`}
          from={Math.round(o.start * fps)}
          durationInFrames={Math.max(1, Math.round((o.end - o.start) * fps))}
          // エディタ(Player)では素材の <video>/<Img> を2秒先読みして
          // 表示開始時の固まりを防ぐ(最終レンダーには影響しない)
          premountFor={premountFrames(fps)}
        >
          <OverlayItemView item={o} fps={fps} />
        </Sequence>
      ))}
  </>
);

/** 素材1枚分の描画。フェード(不透明度・音量)は Sequence 内の相対フレームで
 * 計算する。rect 指定は部分配置(ピクチャ・イン・ピクチャ。contain の余白は
 * 透過)、無指定は従来どおり全画面+黒余白 */
const OverlayItemView = ({ item: o, fps }: { item: OverlayItem; fps: number }) => {
  const frame = useCurrentFrame();
  const { fps: configFps } = useVideoConfig();
  const durFrames = Math.max(1, Math.round((o.end - o.start) * fps));
  const fade = fadeFactor(frame, durFrames, fps, o.fadeInSec, o.fadeOutSec);
  const t = o.start + frame / configFps;
  const base = o.rect
    ? {
        x: o.rect.x,
        y: o.rect.y,
        w: o.rect.w,
        h: o.rect.h,
        opacity: o.opacity ?? 1,
      }
    : null;
  const now = base && o.keyframes ? valuesAt(base, o.keyframes, t) : base;
  const opacity = (now?.opacity ?? o.opacity ?? 1) * fade;
  const vol = o.volume ?? 0;
  const media = isImageFile(o.file) ? (
    <Img
      src={staticFile(o.file)}
      style={{ width: "100%", height: "100%", objectFit: o.fit }}
    />
  ) : (
    <OffthreadVideo
      muted={vol <= 0}
      volume={(f) => vol * fadeFactor(f, durFrames, fps, o.fadeInSec, o.fadeOutSec)}
      src={staticFile(o.file)}
      startFrom={Math.round((o.startFrom ?? 0) * fps)}
      // false 明示(既定 true)。理由は CroppedVideo の同プロップのコメント参照
      pauseWhenBuffering={false}
      style={{ width: "100%", height: "100%", objectFit: o.fit }}
    />
  );
  return now ? (
    <div
      style={{
        position: "absolute",
        left: now.x,
        top: now.y,
        width: now.w,
        height: now.h,
        overflow: "hidden",
        opacity,
      }}
    >
      {media}
    </div>
  ) : (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>{media}</AbsoluteFill>
  );
};

/** 挿入クリップ1つ分の描画。フェードは黒からの明転/黒への暗転
 * (挿入中はベース映像が完全に隠れる前提なので、器の黒は不透明のまま
 * 中身だけをフェードする)。音量もフェードに連動する */
const InsertView = ({
  ins,
  fps,
  muteBase,
}: {
  ins: NonNullable<RenderProps["inserts"]>[number];
  fps: number;
  muteBase: boolean;
}) => {
  const frame = useCurrentFrame();
  const durFrames = Math.max(1, Math.round((ins.end - ins.start) * fps));
  const fade = fadeFactor(frame, durFrames, fps, ins.fadeInSec, ins.fadeOutSec);
  const vol = ins.volume ?? 1;
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <div style={{ position: "absolute", inset: 0, opacity: fade }}>
        {isImageFile(ins.file) ? (
          <Img
            src={staticFile(ins.file)}
            style={{ width: "100%", height: "100%", objectFit: ins.fit }}
          />
        ) : (
          <OffthreadVideo
            muted={muteBase || vol <= 0}
            volume={(f) => vol * fadeFactor(f, durFrames, fps, ins.fadeInSec, ins.fadeOutSec)}
            src={staticFile(ins.file)}
            startFrom={Math.round((ins.startFrom ?? 0) * fps)}
            // false 明示(既定 true)。理由は CroppedVideo の同プロップのコメント参照
            pauseWhenBuffering={false}
            style={{ width: "100%", height: "100%", objectFit: ins.fit }}
          />
        )}
      </div>
    </AbsoluteFill>
  );
};

/** フェードイン/アウトの係数(0〜1)。区間の頭 fadeIn 秒で 0→1、
 * 末尾 fadeOut 秒で 1→0。両方が重なる短い区間では小さい方を採る */
const fadeFactor = (
  frame: number,
  durFrames: number,
  fps: number,
  fadeInSec?: number,
  fadeOutSec?: number,
): number => {
  let g = 1;
  const fin = Math.round((fadeInSec ?? 0) * fps);
  const fout = Math.round((fadeOutSec ?? 0) * fps);
  if (fin > 0) g = Math.min(g, Math.max(0, Math.min(1, frame / fin)));
  if (fout > 0) g = Math.min(g, Math.max(0, Math.min(1, (durFrames - frame) / fout)));
  return g;
};

const isImageFile = (f: string) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f);

/** Studio で実データなしにレイアウト確認するためのプレースホルダー */
const Placeholder = ({ label }: { label: string }) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#2a2d35",
      alignItems: "center",
      justifyContent: "center",
      color: "#8b93a5",
      fontFamily: JP_FONT,
      fontSize: 32,
    }}
  >
    {label}
  </AbsoluteFill>
);

// ---- Player 専用: カット境界の黒フラッシュ対策(フレームホールド) ----
// ブラウザの <video> は「まだ1フレームもデコードできていない」間は何も
// 描かず(透明)、合成の背景(黒)が透ける。カット境界はベース区間ごとに
// 別の <video> なので、次の区間の初回フレームが間に合わないと一瞬黒くなる。
// premount(2秒先読み)で普通は防げるが、非表示の <video> にフレームを
// 供給しないブラウザ(Safari 等)では全境界で起きる。そこで再生中の
// ベース映像の生フレームを共有キャンバスに控え、各 <video> は自分の
// 初回フレームが出るまでの間だけ控えを下に敷く(NLE のプレビューと同じ
// 「直前フレームで持ちこたえる」挙動)。requestVideoFrameCallback が
// 無い環境では何もしない。最終レンダー(isRendering)には一切関与しない
let frameHold: HTMLCanvasElement | null = null;

type VideoWithVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/** wrap 内の <video> を監視し、feed ならフレームが出るたび控えへ写し、
 * 自分の初回フレームが出るまで fallback キャンバスに控えを敷く */
const useFrameHold = (
  wrapRef: RefObject<HTMLDivElement | null>,
  fallbackRef: RefObject<HTMLCanvasElement | null>,
  feed: boolean,
) => {
  useEffect(() => {
    if (playerFlag("nohold") || !getRemotionEnvironment().isPlayer) return;
    const video = wrapRef.current?.querySelector("video") as VideoWithVFC | null;
    if (!video?.requestVideoFrameCallback) return;
    let gotFrame = false;
    let raf = 0;
    let vfc = 0;
    const onFrame = () => {
      gotFrame = true;
      if (feed && video.videoWidth > 0) {
        frameHold ??= document.createElement("canvas");
        if (frameHold.width !== video.videoWidth) {
          frameHold.width = video.videoWidth;
          frameHold.height = video.videoHeight;
        }
        frameHold.getContext("2d")?.drawImage(video, 0, 0);
      }
      vfc = video.requestVideoFrameCallback!(onFrame);
    };
    vfc = video.requestVideoFrameCallback(onFrame);
    const blit = () => {
      // 自分のフレームが出たら以降は <video> が常に上を覆うので終了
      if (gotFrame) return;
      const fb = fallbackRef.current;
      if (fb && frameHold) {
        if (fb.width !== frameHold.width) {
          fb.width = frameHold.width;
          fb.height = frameHold.height;
        }
        fb.getContext("2d")?.drawImage(frameHold, 0, 0);
      }
      raf = requestAnimationFrame(blit);
    };
    raf = requestAnimationFrame(blit);
    return () => {
      video.cancelVideoFrameCallback?.(vfc);
      cancelAnimationFrame(raf);
    };
  }, []);
};

/** 拡張キャンバス動画から region 部分だけを width x height の箱に
 * fit(contain/cover)で収めて表示する。省略時 fit="cover" は、region と
 * 箱のアスペクト比が一致する既存呼び出し(全画面・ワイプ)では現行の
 * `scale = width / region.w` 直結の式と完全に一致する(cropFitStyle 参照) */
const CroppedVideo = ({
  src,
  canvas,
  region,
  width,
  height,
  muted,
  startFromFrames = 0,
  playbackRate,
  fit = "cover",
  filter,
  imageRendering,
}: {
  src: string;
  canvas: { w: number; h: number };
  region: Region;
  width: number;
  height: number;
  muted: boolean;
  /** 動画内の再生開始位置(フレーム)。挿入で分割されたベース区間用 */
  startFromFrames?: number;
  playbackRate?: number;
  /** 箱(width x height)への region の収め方。省略時 "cover" */
  fit?: "contain" | "cover";
  /** 簡易カラー調整(colorFilter)の CSS filter 文字列。省略時は無補正 */
  filter?: string;
  /** mosaic の縮小→拡大でニアレストネイバーにする(pixelated)。省略時は
   * ブラウザ既定の補間(滑らか) */
  imageRendering?: "pixelated";
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLCanvasElement>(null);
  // 控えへの供給は画面側(非ミュート)だけ。ワイプは同じ生フレームの
  // 別クロップなので、控えの絵は両者でそのまま使える
  useFrameHold(wrapRef, fallbackRef, !muted);
  // 控えは生フレーム全体なので、<video> と同じ配置で敷けば同じクロップになる
  const fitted = cropFitStyle({ canvas, region, width, height, fit });
  const mediaStyle = {
    position: "absolute" as const,
    width: fitted.width,
    height: fitted.height,
    left: fitted.left,
    top: fitted.top,
    maxWidth: "none",
    ...(imageRendering ? { imageRendering } : {}),
  };
  return (
    <div
      ref={wrapRef}
      style={{
        width, height, overflow: "hidden", position: "relative",
        ...(filter ? { filter } : {}),
      }}
    >
      {!playerFlag("nohold") && getRemotionEnvironment().isPlayer ? (
        <canvas ref={fallbackRef} style={mediaStyle} />
      ) : null}
      <OffthreadVideo
        src={src}
        muted={muted}
        startFrom={startFromFrames}
        {...(playbackRate !== undefined ? { playbackRate, preservePitch: true } : {})}
        // エディタ(Player)では背景とワイプが別々の <video> になり、Player は
        // 自前の時計とのずれがこの値を超えると currentTime シークで補正する。
        // 小さすぎる(旧 0.1)と UI が一瞬詰まっただけで全 <video> が一斉に
        // シーク→音の途切れ・映像の停止が連鎖する(シーク自体が次のずれを
        // 生む)。大きすぎると字幕・ワイプと音の目に見えるずれを放置する。
        // 0.2 はその折衷。最終レンダーはフレーム単位で正確なので影響しない
        acceptableTimeShiftInSeconds={0.2}
        // 明示的に false(Remotion の既定は true): Safari は play() 直後に
        // 再生中でも偽の 'waiting' を発火し、Remotion は 'canplay' でしか
        // 解除しないため、true だとカット切替のたびに Player の時計が
        // 90〜200ms 凍る(まれに解除されず完全フリーズ)→ 映像が時計より
        // 先行 → 次の境界で一時停止+巻き戻し補正が連鎖し「カット毎の
        // ラグ」になる(実機 Safari の計測で確認済み)。短いバッファ待ちの
        // ずれは acceptableTimeShiftInSeconds の補正に任せる
        pauseWhenBuffering={false}
        style={mediaStyle}
      />
    </div>
  );
};
