// remotion/OverlayLayer.tsx — Main.tsx の OverlayLayer / OverlayItemView を
// verbatim 抽出(DOM は1ノードも変えない)。OverlayItemView は
// OverlayStill.tsx(render 高速パスの静止画ラスタライズ)からも再利用される。
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { valuesAt } from "../src/lib/keyframes.ts";
import { fadeFactor, isImageFile } from "../src/lib/overlayFade.ts";
import { premountFrames } from "./playerFlags.ts";
import type { OverlayItem } from "./props.ts";

/** 素材オーバーレイの1トラック分。Sequence に載せることで、
 * 動画素材は表示区間の頭から再生される(区間外は存在しない)。
 * 頭出し・挿入で割れた断片は startFrom で素材の続きから再生する */
export const OverlayLayer = ({
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
export const OverlayItemView = ({ item: o, fps }: { item: OverlayItem; fps: number }) => {
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
