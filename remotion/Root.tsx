import { Composition } from "remotion";
import { DesignStill, designStillDefaultProps } from "./DesignStill.tsx";
import type { DesignStillProps } from "./DesignStill.tsx";
import { HyperFrame, hyperFrameDefaultProps } from "./HyperFrame.tsx";
import type { HyperFrameProps } from "./HyperFrame.tsx";
import { compositionDurationInFrames } from "../src/lib/renderFrameMath.ts";

export const RemotionRoot = () => (
  <>
    <Composition
      id="DesignStill"
      component={DesignStill}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={designStillDefaultProps}
      calculateMetadata={({ props }: { props: DesignStillProps }) => {
        const rect = props.role === "screenMask"
          ? props.design.screen.rect
          : props.role === "cameraMask"
            ? props.design.camera.rect
            : { w: props.width, h: props.height };
        return { durationInFrames: 1, fps: 30, width: rect.w, height: rect.h };
      }}
    />
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
