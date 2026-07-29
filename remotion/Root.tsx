import { Composition } from "remotion";
import { HyperFrame, hyperFrameDefaultProps } from "./HyperFrame.tsx";
import type { HyperFrameProps } from "./HyperFrame.tsx";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";

export const RemotionRoot = () => (
  <>
    <Composition
      id="HyperFrame"
      component={HyperFrame}
      durationInFrames={120}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={hyperFrameDefaultProps}
      calculateMetadata={({ props }: { props: HyperFrameProps }) => ({
        durationInFrames: compositionDurationInFrames(props.durationSec, props.fps),
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  </>
);
