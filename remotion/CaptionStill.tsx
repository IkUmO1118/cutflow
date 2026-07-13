import { AbsoluteFill } from "remotion";
import { PositionedCaption } from "./CaptionLayer.tsx";
import type { Caption, RenderProps } from "./props.ts";
import type { Region } from "../src/types.ts";

export type CaptionStillProps = {
  width: number;
  height: number;
  caption: Caption;
  defaults: RenderProps["caption"];
  captionDefaultPos?: RenderProps["captionDefaultPos"];
  cameraRegion?: Region;
  wipe: RenderProps["wipe"];
};

export const CaptionStill = (props: CaptionStillProps) => (
  <AbsoluteFill style={{ backgroundColor: "transparent" }}>
    <PositionedCaption
      caption={props.caption}
      defaults={props.defaults}
      captionDefaultPos={props.captionDefaultPos}
      cameraRegion={props.cameraRegion}
      wipe={props.wipe}
      width={props.width}
      t={props.caption.start}
    />
  </AbsoluteFill>
);

export const captionStillDefaultProps: CaptionStillProps = {
  width: 1920,
  height: 1080,
  caption: { start: 0, end: 1, text: "サンプル字幕", track: 1 },
  defaults: { fontSizePx: 44 },
  wipe: { widthPx: 480, marginPx: 32 },
};
