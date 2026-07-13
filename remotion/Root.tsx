import { Composition } from "remotion";
import { Main } from "./Main.tsx";
import { CaptionStill, captionStillDefaultProps } from "./CaptionStill.tsx";
import type { CaptionStillProps } from "./CaptionStill.tsx";
import { defaultProps } from "./props.ts";
import type { RenderProps } from "./props.ts";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";

export const RemotionRoot = () => (
  <>
    <Composition
      id="Main"
      component={Main}
      durationInFrames={300}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
      calculateMetadata={({ props }: { props: RenderProps }) => ({
        durationInFrames: compositionDurationInFrames(props.durationSec, props.fps),
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
    <Composition
      id="CaptionStill"
      component={CaptionStill}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={captionStillDefaultProps}
      calculateMetadata={({ props }: { props: CaptionStillProps }) => ({
        durationInFrames: 1,
        fps: 30,
        width: props.width,
        height: props.height,
      })}
    />
  </>
);
