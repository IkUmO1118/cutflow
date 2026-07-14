import { Composition } from "remotion";
import { Main } from "./Main.tsx";
import { AnnotationStill, annotationStillDefaultProps } from "./AnnotationStill.tsx";
import type { AnnotationStillProps } from "./AnnotationStill.tsx";
import { CaptionStill, captionStillDefaultProps } from "./CaptionStill.tsx";
import type { CaptionStillProps } from "./CaptionStill.tsx";
import { DesignStill, designStillDefaultProps } from "./DesignStill.tsx";
import type { DesignStillProps } from "./DesignStill.tsx";
import { OverlayStill, overlayStillDefaultProps } from "./OverlayStill.tsx";
import type { OverlayStillProps } from "./OverlayStill.tsx";
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
          : props.role === "cameraMask" && props.design.camera
            ? props.design.camera.rect
            : { w: props.width, h: props.height };
        return { durationInFrames: 1, fps: 30, width: rect.w, height: rect.h };
      }}
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
    <Composition
      id="OverlayStill"
      component={OverlayStill}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={overlayStillDefaultProps}
      calculateMetadata={({ props }: { props: OverlayStillProps }) => ({
        durationInFrames: 1,
        fps: 30,
        width: props.width,
        height: props.height,
      })}
    />
    <Composition
      id="AnnotationStill"
      component={AnnotationStill}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={annotationStillDefaultProps}
      calculateMetadata={({ props }: { props: AnnotationStillProps }) => ({
        durationInFrames: 1,
        fps: 30,
        width: props.width,
        height: props.height,
      })}
    />
  </>
);
