import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Region, RenderProps } from "./props";

const JP_FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

/**
 * 最終レンダーのレイアウト:
 * - 背景: カット済み動画から画面領域をクロップして全面表示
 * - 右下: カメラ領域をクロップしたワイプ(角丸)
 * - 下部中央: 文字起こしベースの字幕
 * - 章の頭: 左上に章タイトルカードを数秒表示
 */
export const Main = (props: RenderProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const src = staticFile(props.videoFile);

  const wipeH = Math.round(
    (props.wipe.widthPx * props.cameraRegion.h) / props.cameraRegion.w,
  );
  const caption = props.captions.find((c) => t >= c.start && t < c.end);
  const chapter = props.chapters.find(
    (c) => t >= c.start && t < c.start + props.chapterCardSec,
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <CroppedVideo
        src={src}
        canvas={props.canvas}
        region={props.screenRegion}
        width={props.width}
        height={props.height}
        muted={false}
      />

      <div
        style={{
          position: "absolute",
          right: props.wipe.marginPx,
          bottom: props.wipe.marginPx,
          width: props.wipe.widthPx,
          height: wipeH,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        }}
      >
        <CroppedVideo
          src={src}
          canvas={props.canvas}
          region={props.cameraRegion}
          width={props.wipe.widthPx}
          height={wipeH}
          muted
        />
      </div>

      {caption && (
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
          <div
            style={{
              maxWidth: "90%",
              padding: "12px 28px",
              borderRadius: 12,
              backgroundColor: "rgba(0,0,0,0.65)",
              color: "white",
              fontFamily: JP_FONT,
              fontSize: props.caption.fontSizePx,
              fontWeight: 700,
              lineHeight: 1.4,
              textAlign: "center",
            }}
          >
            {caption.text}
          </div>
        </div>
      )}

      {chapter && (
        <ChapterCardView
          title={chapter.title}
          progress={(t - chapter.start) / props.chapterCardSec}
          fontSizePx={props.caption.fontSizePx}
          marginPx={props.wipe.marginPx}
        />
      )}
    </AbsoluteFill>
  );
};

/** 拡張キャンバス動画から region 部分だけを width x height に切り出して表示する */
const CroppedVideo = ({
  src,
  canvas,
  region,
  width,
  height,
  muted,
}: {
  src: string;
  canvas: { w: number; h: number };
  region: Region;
  width: number;
  height: number;
  muted: boolean;
}) => {
  const scale = width / region.w;
  return (
    <div style={{ width, height, overflow: "hidden", position: "relative" }}>
      <OffthreadVideo
        src={src}
        muted={muted}
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

/** 章の頭に左上へ出すタイトルカード(フェードイン/アウト付き) */
const ChapterCardView = ({
  title,
  progress,
  fontSizePx,
  marginPx,
}: {
  title: string;
  /** 表示期間内の進行度 0..1 */
  progress: number;
  fontSizePx: number;
  marginPx: number;
}) => {
  const opacity = interpolate(
    progress,
    [0, 0.1, 0.85, 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <div
      style={{
        position: "absolute",
        top: marginPx,
        left: marginPx,
        padding: "14px 32px",
        borderRadius: 12,
        backgroundColor: "rgba(20,20,20,0.85)",
        borderLeft: "8px solid #ffd54a",
        color: "white",
        fontFamily: JP_FONT,
        fontSize: fontSizePx,
        fontWeight: 700,
        opacity,
      }}
    >
      {title}
    </div>
  );
};
