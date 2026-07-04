import { Fragment } from "react";
import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  DEFAULT_LAYER_ORDER,
  capNum,
  ovNum,
} from "../src/types.ts";
import type { CaptionBackground, LayerId } from "../src/types.ts";
import type { OverlayItem, Region, RenderProps, Span } from "./props.ts";

const JP_FONT = CAPTION_DEFAULT_FONT_FAMILY;

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

  const wipeH = Math.round(
    (props.wipe.widthPx * props.cameraRegion.h) / props.cameraRegion.w,
  );
  const inSpan = (spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);
  // ワイプ全画面区間は、ワイプの器を画面サイズまで広げる
  const wipeIsFull = inSpan(props.wipeFull);
  const wipeW = wipeIsFull ? props.width : props.wipe.widthPx;
  const wipeHNow = wipeIsFull ? props.height : wipeH;

  const bgmGain = props.bgm ? Math.pow(10, props.bgm.volumeDb / 20) : 0;
  const bgmFadeFrames = props.bgm ? props.bgm.fadeOutSec * fps : 0;
  const duck = props.bgm?.duck;
  const duckGain = duck ? Math.pow(10, duck.duckDb / 20) : 1;
  /** 発話ダッキングの係数(1=通常、duckGain=下げ切り)。区間の手前
   * fadeSec 秒で下げ、区間の後ろ fadeSec 秒で戻す。重なりは小さい方を採る */
  const duckFactorAt = (sec: number): number => {
    if (!duck) return 1;
    const fade = Math.max(duck.fadeSec, 1 / fps);
    let g = 1;
    for (const s of duck.spans) {
      let v = 1;
      if (sec >= s.start && sec < s.end) v = duckGain;
      else if (sec >= s.start - fade && sec < s.start)
        v = 1 - ((sec - (s.start - fade)) / fade) * (1 - duckGain);
      else if (sec >= s.end && sec < s.end + fade)
        v = duckGain + ((sec - s.end) / fade) * (1 - duckGain);
      if (v < g) g = v;
    }
    return g;
  };

  // ベース映像の再生区間。挿入(inserts)があると分割され、区間ごとに
  // videoFile 内の videoStart から再生する(挿入中はベース映像が止まる)。
  // 画面クロップとワイプの両方が同じ分割を共有する
  const baseSegs = props.baseSegments ?? [
    { start: 0, videoStart: 0, durationSec: props.durationSec },
  ];
  const continuous =
    baseSegs.length === 1 && baseSegs[0].start === 0 && baseSegs[0].videoStart === 0;
  const renderBase = (region: Region, width: number, height: number, muted: boolean) =>
    continuous ? (
      <CroppedVideo
        src={src}
        canvas={props.canvas}
        region={region}
        width={width}
        height={height}
        muted={muted}
      />
    ) : (
      baseSegs.map((seg) => (
        <Sequence
          key={seg.start}
          from={Math.round(seg.start * fps)}
          durationInFrames={Math.max(1, Math.round(seg.durationSec * fps))}
          // エディタ(Player)では次の区間の <video> を2秒先読みして
          // シーク済みにしておく(カット境界の黒フラッシュ防止)。
          // 最終レンダーには影響しない(premount は Player 専用の挙動)
          premountFor={fps * 2}
        >
          <CroppedVideo
            src={src}
            startFromFrames={Math.round(seg.videoStart * fps)}
            canvas={props.canvas}
            region={region}
            width={width}
            height={height}
            muted={muted}
          />
        </Sequence>
      ))
    );

  // テロップトラックごとの表示中テロップ。旧式データ(track なし)は 1 扱い。
  // 位置・スタイルはテロップごとに解決済み(hideCaption は全テロップトラックに効く)
  const captionAt = (track: number) =>
    props.captions.find((c) => (c.track ?? 1) === track && t >= c.start && t < c.end);

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
      {hasVideo ? (
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
          items={props.overlays.filter((o) => o.track === n)}
          fps={fps}
        />
      );
    }
    const track = capNum(id);
    if (track !== null) {
      const caption = captionAt(track);
      if (!caption || inSpan(props.hideCaption)) return null;
      const styled = (maxWidth?: string) => (
        <OutlinedText
          text={caption.text}
          fontSizePx={caption.style?.fontSizePx ?? props.caption.fontSizePx}
          color={caption.style?.color}
          outlineColor={caption.style?.outlineColor}
          fontFamily={caption.style?.fontFamily}
          fontWeight={caption.style?.fontWeight}
          background={caption.style?.background}
          maxWidth={maxWidth}
        />
      );
      if (caption.pos) {
        // 位置指定あり: 幅はテキストに自動フィットし、自動では折り返さない
        // (改行はテキスト内の改行で指定する)。anchor で座標の解釈が変わる:
        // 省略時はテキスト中心を pos に置き、topLeft は左上を pos に置く
        return (
          <div
            style={{
              position: "absolute",
              left: caption.pos.x,
              top: caption.pos.y,
              width: "max-content",
              ...(caption.anchor === "topLeft"
                ? {}
                : { transform: "translate(-50%, -50%)" }),
            }}
          >
            {styled()}
          </div>
        );
      }
      return (
        <div
          style={{
            position: "absolute",
            bottom: props.wipe.marginPx,
            left: 0,
            // ワイプと重ならないように右側を空ける
            width: props.width - props.wipe.widthPx - props.wipe.marginPx * 2,
            display: "flex",
            justifyContent: "center",
          }}
        >
          {styled("90%")}
        </div>
      );
    }
    return id === "wipe" ? wipeLayer : null;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {hasVideo ? (
        renderBase(props.screenRegion, props.width, props.height, props.muteBase ?? false)
      ) : (
        <Placeholder label="画面(screenRegion)" />
      )}

      {/* 挿入クリップ(イントロ等)。ベース映像と同じ最下層で、音声も持てる */}
      {(props.inserts ?? []).map((ins, i) => (
        <Sequence
          key={`ins-${i}`}
          from={Math.round(ins.start * fps)}
          durationInFrames={Math.max(1, Math.round((ins.end - ins.start) * fps))}
        >
          <AbsoluteFill style={{ backgroundColor: "black" }}>
            {isImageFile(ins.file) ? (
              <Img
                src={staticFile(ins.file)}
                style={{ width: "100%", height: "100%", objectFit: ins.fit }}
              />
            ) : (
              <OffthreadVideo
                muted={props.muteBase ?? false}
                src={staticFile(ins.file)}
                startFrom={Math.round((ins.startFrom ?? 0) * fps)}
                style={{ width: "100%", height: "100%", objectFit: ins.fit }}
              />
            )}
          </AbsoluteFill>
        </Sequence>
      ))}

      {(props.layerOrder ?? DEFAULT_LAYER_ORDER)
        .filter((id) => !props.hiddenLayers?.includes(id))
        .map((id) => (
          <Fragment key={id}>{layerNode(id)}</Fragment>
        ))}

      {props.bgm && !props.muteBgm && (
        <Audio
          loop
          src={staticFile(props.bgm.file)}
          volume={(f) =>
            bgmGain *
            duckFactorAt(f / fps) *
            interpolate(
              f,
              [durationInFrames - bgmFadeFrames, durationInFrames],
              [1, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            )
          }
        />
      )}
    </AbsoluteFill>
  );
};

/** 素材オーバーレイの1トラック分。Sequence に載せることで、
 * 動画素材は表示区間の頭から再生される(区間外は存在しない)。
 * 挿入で割れた断片は startFrom で素材の続きから再生する */
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
        >
          <AbsoluteFill style={{ backgroundColor: "black" }}>
            {isImageFile(o.file) ? (
              <Img
                src={staticFile(o.file)}
                style={{ width: "100%", height: "100%", objectFit: o.fit }}
              />
            ) : (
              <OffthreadVideo
                muted
                src={staticFile(o.file)}
                startFrom={Math.round((o.startFrom ?? 0) * fps)}
                style={{ width: "100%", height: "100%", objectFit: o.fit }}
              />
            )}
          </AbsoluteFill>
        </Sequence>
      ))}
  </>
);

const isImageFile = (f: string) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f);

/** 文字+太い縁取りの字幕テキスト(既定は白文字+青縁)。
 * -webkit-text-stroke は文字の輪郭線上に中央揃えで描かれ内側も削るため、
 * 縁取りだけの層を下に敷き、その上に文字を重ねて内側を保つ。
 * outlineColor が "none" のときは縁取り層を出さない(座布団=background と
 * 組み合わせる定番表現)。background があるときはテキストの背後に帯を敷く。
 * maxWidth は下部中央の字幕(長文の自動折り返し)用。位置指定テロップでは
 * 指定しない: 親が max-content(テキストぴったり幅)なので、%指定を置くと
 * 「自分の幅の90%」に制限されて末尾の数文字が折り返してしまう */
const OutlinedText = ({
  text,
  fontSizePx,
  color = CAPTION_DEFAULT_COLOR,
  outlineColor = CAPTION_DEFAULT_OUTLINE,
  fontFamily = JP_FONT,
  fontWeight = CAPTION_DEFAULT_FONT_WEIGHT,
  background,
  maxWidth,
}: {
  text: string;
  fontSizePx: number;
  color?: string;
  outlineColor?: string;
  fontFamily?: string;
  fontWeight?: number;
  background?: CaptionBackground;
  maxWidth?: string;
}) => {
  const strokeW = Math.round(fontSizePx * 0.25);
  const hasStroke = outlineColor !== "none" && outlineColor !== "transparent";
  // 座布団があるときは帯(padding 込み)を外側の器に、テキスト積層を内側に置く。
  // padding を積層側に付けると縁取り層(inset:0)が前面テキストとずれるため
  const stack = (
    <div
      style={{
        position: "relative",
        ...(maxWidth !== undefined && !background ? { maxWidth } : {}),
        fontFamily,
        fontSize: fontSizePx,
        fontWeight,
        lineHeight: 1.4,
        textAlign: "center",
        // テキスト内の改行をそのまま行分けとして表示する(手動改行)
        whiteSpace: "pre-line",
      }}
    >
      {hasStroke && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            color: outlineColor,
            WebkitTextStroke: `${strokeW}px ${outlineColor}`,
          }}
        >
          {text}
        </span>
      )}
      <span style={{ position: "relative", color }}>{text}</span>
    </div>
  );
  if (!background) return stack;
  const padX = background.paddingPx ?? Math.round(fontSizePx * 0.35);
  return (
    <div
      style={{
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        boxSizing: "border-box",
        backgroundColor: background.color,
        padding: `${Math.round(padX * 0.5)}px ${padX}px`,
        borderRadius: background.radiusPx ?? 8,
      }}
    >
      {stack}
    </div>
  );
};

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

/** 拡張キャンバス動画から region 部分だけを width x height に切り出して表示する */
const CroppedVideo = ({
  src,
  canvas,
  region,
  width,
  height,
  muted,
  startFromFrames = 0,
}: {
  src: string;
  canvas: { w: number; h: number };
  region: Region;
  width: number;
  height: number;
  muted: boolean;
  /** 動画内の再生開始位置(フレーム)。挿入で分割されたベース区間用 */
  startFromFrames?: number;
}) => {
  const scale = width / region.w;
  return (
    <div style={{ width, height, overflow: "hidden", position: "relative" }}>
      <OffthreadVideo
        src={src}
        muted={muted}
        startFrom={startFromFrames}
        // エディタ(Player)では背景とワイプが別々の <video> になり、既定の
        // 許容ドリフト0.45秒では両者(と音声・字幕)が目に見えてずれる。
        // 最終レンダーはフレーム単位で正確なので、この値は影響しない
        acceptableTimeShiftInSeconds={0.1}
        style={{
          position: "absolute",
          width: canvas.w * scale,
          height: canvas.h * scale,
          left: -region.x * scale,
          top: -region.y * scale,
          maxWidth: "none",
        }}
      />
    </div>
  );
};
