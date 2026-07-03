import { Composition } from "remotion";
import { Main } from "./Main.tsx";
import { defaultProps } from "./props.ts";
import type { RenderProps } from "./props.ts";

export const RemotionRoot = () => (
  <Composition
    id="Main"
    component={Main}
    durationInFrames={300}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={defaultProps}
    calculateMetadata={({ props }: { props: RenderProps }) => ({
      durationInFrames: Math.max(1, Math.round(props.durationSec * props.fps)),
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
