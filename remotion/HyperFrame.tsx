// remotion/HyperFrame.tsx — HyperFrames 作図契約(spec)を Remotion 内で
// シーク可能に描画するコンポジション用コンポーネント(C1)。author の HTML を
// iframe に srcDoc として流し込み、window.__hyperframes.__seek(tMs) を
// フレームごとに呼んで Web Animations を該当時刻へ pause+シークする。
// **node 専用モジュールを import しないこと**(Root.tsx からブラウザバンドルへ
// 入る。AnnotationLayer.tsx と同じ注意)。
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildIframeSrcdoc, SAMPLE_HTML } from "../src/lib/hyperframe.ts";
import type { HyperframeRenderProfile } from "../src/lib/hyperframeRenderProfile.ts";

export type HyperFrameProps = {
  html: string;
  variables: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  profile: HyperframeRenderProfile;
};

export const hyperFrameDefaultProps: HyperFrameProps = {
  html: SAMPLE_HTML,
  variables: { title: "CutFlow", accent: "#22c55e" },
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 4,
  profile: "default",
};

type HyperFramesWindow = Window & {
  __hyperframes?: {
    getVariables: () => Record<string, unknown>;
    __seek: (tMs: number) => void;
    __isReady?: () => Promise<void>;
    __failed?: { message: string; fatal: boolean }[];
  };
};

export const HyperFrame = (props: HyperFrameProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handleRef = useRef<number | null>(null);

  const srcDoc = useMemo(
    () => buildIframeSrcdoc(props.html, props.variables, props.profile),
    [props.html, props.profile, props.variables],
  );

  if (handleRef.current === null) {
    handleRef.current = delayRender(`hf-frame-${frame}`);
  }

  // __seek(tMs) + __isReady() gate + __failed 監視をまとめて1回で行う
  // (B1)。iframe が上がっていなければ何もしない(onLoad が再駆動する=
  // 従来どおりの挙動)。__isReady() が未定義になることは無い
  // (bootstrap は常に __isReady を用意する)が、無いカードでも壊れない
  // よう防御的にフォールバックする
  const finishAfterReady = useCallback(() => {
    const hf = (iframeRef.current?.contentWindow as HyperFramesWindow | null | undefined)?.__hyperframes;
    if (!hf) return;

    const fatalMsg = (): string | null => {
      const f = (hf.__failed || []).filter((x) => x.fatal);
      return f.length ? f.map((x) => x.message).join("; ") : null;
    };

    // fatal な失敗があり、かつまだ handle が消費されていなければ
    // cancelRender する(1 handle につき最大1回)
    const failFatal = (): boolean => {
      const msg = fatalMsg();
      if (msg) {
        if (handleRef.current !== null) {
          cancelRender(new Error(`HyperFrame card failed / カードが失敗しました: ${msg}`));
          handleRef.current = null;
        }
        return true;
      }
      return false;
    };

    if (failFatal()) return;

    const go = () => {
      try {
        hf.__seek((frame / fps) * 1000);
      } catch {
        // seek 失敗は致命ではない(継続してレンダーを進める)
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (failFatal()) return;
          if (handleRef.current !== null) {
            continueRender(handleRef.current);
            handleRef.current = null;
          }
        });
      });
    };

    if (hf.__isReady) {
      hf.__isReady().then(() => {
        if (!failFatal()) go();
      });
    } else {
      go();
    }
  }, [frame, fps]);

  useEffect(() => {
    finishAfterReady();
  }, [finishAfterReady]);

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        onLoad={finishAfterReady}
        width={props.width}
        height={props.height}
        style={{ border: 0, width: props.width, height: props.height, display: "block" }}
      />
    </AbsoluteFill>
  );
};
