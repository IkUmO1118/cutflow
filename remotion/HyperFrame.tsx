// remotion/HyperFrame.tsx — HyperFrames 作図契約(spec)を Remotion 内で
// シーク可能に描画するコンポジション用コンポーネント(C1)。author の HTML を
// iframe に srcDoc として流し込み、window.__hyperframes.__seek(tMs) を
// フレームごとに呼んで Web Animations を該当時刻へ pause+シークする。
// **node 専用モジュールを import しないこと**(Root.tsx からブラウザバンドルへ
// 入る。AnnotationLayer.tsx と同じ注意)。
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildIframeSrcdoc, SAMPLE_HTML } from "../src/lib/hyperframe.ts";

export type HyperFrameProps = {
  html: string;
  variables: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
};

export const hyperFrameDefaultProps: HyperFrameProps = {
  html: SAMPLE_HTML,
  variables: { title: "CutFlow", accent: "#22c55e" },
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 4,
};

type HyperFramesWindow = Window & {
  __hyperframes?: {
    getVariables: () => Record<string, unknown>;
    __seek: (tMs: number) => void;
  };
};

export const HyperFrame = (props: HyperFrameProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handleRef = useRef<number | null>(null);

  const srcDoc = useMemo(
    () => buildIframeSrcdoc(props.html, props.variables),
    [props.html, props.variables],
  );

  if (handleRef.current === null) {
    handleRef.current = delayRender(`hf-frame-${frame}`);
  }

  const seekAndContinue = useCallback(() => {
    const hf = (iframeRef.current?.contentWindow as HyperFramesWindow | null | undefined)?.__hyperframes;
    if (!hf) return;
    try {
      hf.__seek((frame / fps) * 1000);
    } catch {
      // seek 失敗は致命ではない(継続してレンダーを進める)
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (handleRef.current !== null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      });
    });
  }, [frame, fps]);

  useEffect(() => {
    seekAndContinue();
  }, [seekAndContinue]);

  const onLoad = () => {
    const hf = (iframeRef.current?.contentWindow as HyperFramesWindow | null | undefined)?.__hyperframes;
    hf?.__seek(0);
    seekAndContinue();
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        onLoad={onLoad}
        width={props.width}
        height={props.height}
        style={{ border: 0, width: props.width, height: props.height, display: "block" }}
      />
    </AbsoluteFill>
  );
};
