import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  KARAOKE_DEFAULT_ACTIVE,
} from "../src/types.ts";
import type { CaptionBackground, CaptionKaraoke, Region } from "../src/types.ts";
import {
  alignKaraoke,
  animStateAt,
  karaokeActiveAt,
  karaokeFillProgress,
} from "../src/lib/captionAnim.ts";
import type { Caption, RenderProps } from "./props.ts";
// 副作用 import: テロップ既定フォント(Noto Sans JP 可変)を登録する。
import "./loadFonts.ts";

const JP_FONT = CAPTION_DEFAULT_FONT_FAMILY;

/** 文字+太い縁取りの字幕テキスト(既定は白文字+青縁)。
 * -webkit-text-stroke は文字の輪郭線上に中央揃えで描かれ内側も削るため、
 * 縁取りだけの層を下に敷き、その上に文字を重ねて内側を保つ。
 * outlineColor が "none" のときは縁取り層を出さない(座布団=background と
 * 組み合わせる定番表現)。background があるときはテキストの背後に帯を敷く。
 * maxWidth は下部中央の字幕(長文の自動折り返し)用。位置指定テロップでは
 * 指定しない: 親が max-content(テキストぴったり幅)なので、%指定を置くと
 * 「自分の幅の90%」に制限されて末尾の数文字が折り返してしまう */
export const OutlinedText = ({
  text,
  fontSizePx,
  color = CAPTION_DEFAULT_COLOR,
  outlineColor = CAPTION_DEFAULT_OUTLINE,
  outlineWidthPx,
  fontFamily = JP_FONT,
  fontWeight = CAPTION_DEFAULT_FONT_WEIGHT,
  background,
  maxWidth,
  words,
  karaokeStyle,
  t,
}: {
  text: string;
  fontSizePx: number;
  color?: string;
  outlineColor?: string;
  /** 縁取りの太さ(出力px)。省略時はフォントサイズの 0.25 倍(従来の既定) */
  outlineWidthPx?: number;
  fontFamily?: string;
  fontWeight?: number;
  background?: CaptionBackground;
  maxWidth?: string;
  /** カラオケ描画用の語単位タイミング(カット後秒)。省略/空なら通常表示(不変) */
  words?: { text: string; start: number; end: number }[];
  karaokeStyle?: CaptionKaraoke;
  /** 現在時刻(カット後秒)。words 指定時のみ使う */
  t?: number;
}) => {
  // 縁取り幅は明示指定(出力px)を優先し、無ければ従来どおりフォントサイズの
  // 0.25 倍。指定 0 は「縁を消す」ではなく hasStroke(outlineColor)で判定する
  const strokeW = outlineWidthPx !== undefined ? outlineWidthPx : Math.round(fontSizePx * 0.25);
  const hasStroke = outlineColor !== "none" && outlineColor !== "transparent";
  // 縁取り層(下)は語ごとに色分けしない=常に1塊 {text} のまま(カラオケでも触らない)。
  // 本文層(上)だけ、karaoke が明示的に有効(style.karaoke 指定)で words があるとき
  // だけ語 span 列に割る。karaokeStyle 省略時は words があっても従来の1塊 {text}(不変)。
  // words は whisper.wordTimestamps で全テロップに付きうる描画専用データなので、
  // karaoke の発動条件を words の有無にすると既定で全テロップが色付いてしまう=
  // 「省略時はカラオケ無し」という契約(types.ts の CaptionKaraoke)に反する
  const km = useMemo(
    () => (karaokeStyle && words && words.length > 0 ? alignKaraoke(text, words) : null),
    [karaokeStyle, text, words],
  );
  const body = km
    ? (
      <span style={{ position: "relative" }}>
        {(() => {
          const now = t ?? 0;
          const act = karaokeActiveAt(km, now);
          const mode = karaokeStyle?.mode ?? "word";
          return km.map((p, i) => {
            if (mode === "fill" && p.start !== null && p.end !== null && now >= p.start && now < p.end) {
              // いま発話中の語だけ左→右の塗り進み。下に inactiveColor の文字、
              // 上に activeColor の同じ文字を重ね、進捗ぶんだけ clip-path で
              // 左側だけ見せる(linear-gradient+background-clip:text でも実装
              // できるが、こちらの方が挙動が単純で色の組み合わせに依存しない)
              const progress = karaokeFillProgress(p.start, p.end, now) * 100;
              const activeColor = karaokeStyle?.activeColor ?? KARAOKE_DEFAULT_ACTIVE;
              const inactiveColor = karaokeStyle?.inactiveColor ?? color;
              return (
                <span key={i} style={{ position: "relative", display: "inline-block" }}>
                  <span style={{ color: inactiveColor }}>{p.text}</span>
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      inset: 0,
                      color: activeColor,
                      whiteSpace: "nowrap",
                      clipPath: `inset(0 ${100 - progress}% 0 0)`,
                    }}
                  >
                    {p.text}
                  </span>
                </span>
              );
            }
            const isActive = act[i];
            return (
              <span
                key={i}
                style={{
                  color: isActive
                    ? (karaokeStyle?.activeColor ?? KARAOKE_DEFAULT_ACTIVE)
                    : (karaokeStyle?.inactiveColor ?? color),
                  ...(!isActive && karaokeStyle?.inactiveOpacity !== undefined
                    ? { opacity: karaokeStyle.inactiveOpacity }
                    : {}),
                }}
              >
                {p.text}
              </span>
            );
          });
        })()}
      </span>
    )
    : <span style={{ position: "relative", color }}>{text}</span>; // ← words 未指定: 現状と同一
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
      {body}
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

export interface PositionedCaptionProps {
  caption: Caption;
  defaults: RenderProps["caption"];
  captionDefaultPos?: RenderProps["captionDefaultPos"];
  cameraRegion?: Region;
  wipe: RenderProps["wipe"];
  width: number;
  t: number;
}

export const PositionedCaption = (p: PositionedCaptionProps): ReactNode => {
  const { caption, defaults, captionDefaultPos, cameraRegion, wipe, width, t } = p;
  const fontSizePx = caption.style?.fontSizePx ?? defaults.fontSizePx;
  const styled = (maxWidth?: string) => (
    <OutlinedText
      text={caption.text}
      fontSizePx={fontSizePx}
      color={caption.style?.color ?? defaults.color}
      outlineColor={caption.style?.outlineColor ?? defaults.outlineColor}
      outlineWidthPx={caption.style?.outlineWidthPx}
      fontFamily={caption.style?.fontFamily ?? defaults.fontFamily}
      fontWeight={caption.style?.fontWeight ?? defaults.fontWeight}
      background={caption.style?.background}
      maxWidth={maxWidth}
      words={caption.words}
      karaokeStyle={caption.style?.karaoke}
      t={t}
    />
  );
  // 登場/退場アニメの器。anim 未指定なら包まず素通し(追加 div なし=DOM 完全一致)。
  // テロップは Sequence に載っていないので、グローバル t と caption.start/end
  // から進行度を出す(Sequence の相対フレームは使えない。zoomTransformAt と同じ)
  const anim = caption.style?.anim;
  const a = animStateAt(anim, caption.start, caption.end, t, fontSizePx);
  const withAnim = (node: ReactNode): ReactNode =>
    anim
      ? (
        <div
          style={{
            opacity: a.opacity,
            transform: `translate(${a.translateX}px, ${a.translateY}px) scale(${a.scale})`,
            transformOrigin: "center",
          }}
        >
          {node}
        </div>
      )
      : node;
  // 位置指定の無いテロップは、captionDefaultPos(縦プリセット等)があれば
  // そこに、無ければ従来の下部中央にフォールバックする
  const pos = caption.pos ?? captionDefaultPos;
  const anchor = caption.pos ? caption.anchor : captionDefaultPos?.anchor;
  if (pos) {
    // 位置指定あり: 幅はテキストに自動フィットし、自動では折り返さない
    // (改行はテキスト内の改行で指定する)。anchor で座標の解釈が変わる:
    // 省略時はテキスト中心を pos に置き、topLeft は左上を pos に置く
    return (
      <div
        style={{
          position: "absolute",
          left: pos.x,
          top: pos.y,
          width: "max-content",
          ...(anchor === "topLeft" ? {} : { transform: "translate(-50%, -50%)" }),
        }}
      >
        {withAnim(styled())}
      </div>
    );
  }
  // カメラがあるときだけワイプと重ならないよう右側を空ける。plain
  // (カメラ無し)は予約ゼロ=全幅中央にする(B1)
  const reserve = cameraRegion ? wipe.widthPx + wipe.marginPx * 2 : 0;
  return (
    <div
      style={{
        position: "absolute",
        bottom: wipe.marginPx,
        left: 0,
        width: width - reserve,
        display: "flex",
        justifyContent: "center",
      }}
    >
      {withAnim(styled("90%"))}
    </div>
  );
};
