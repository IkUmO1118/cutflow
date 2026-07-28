// editor/client/EnginePreview.tsx — M3b T2-2: Remotion Player の代替コンポーネント。
// 中身は engineDev.ts(M3a Phase5 開発ページ)の main() の React 化。
// App.tsx が使っている PlayerRef API の閉じた集合(§1.2/§2-1。設計書
// docs/plans/2026-07-28-engine-m3b-preview-integration-design.md)だけを
// useImperativeHandle で実装する。App.tsx 側の配線(frameupdate→playhead・
// remount 再 seek・setVolume 効果・ショートカット)は無改造で動く前提。
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CallbackListener, EventTypes as PlayerEventTypes, PlayerRef } from "@remotion/player";
import { describeFrame } from "../../src/engine/describeFrame.ts";
import type { ExternalItem } from "../../src/engine/descriptor.ts";
import { EngineCompositor } from "../../src/engine/runtime/compositor.ts";
import { SourcePool } from "../../src/engine/runtime/sourcePool.ts";
import { PresentationClock } from "../../src/engine/runtime/clock.ts";
import { AudioScheduler } from "../../src/engine/runtime/audioScheduler.ts";
import type { RenderProps } from "../../remotion/props.ts";
import { audioSignatureOf, timelineFromBaseSegments } from "./enginePreviewTimeline.ts";

/** App.tsx の built props memo は videoFile("media/proxy.mp4")に加え、
 * overlays[].file / inserts[].file / bgm[].file / design の背景・素材ファイルを
 * すべて `media/${元パス}` へ書き換え済み(Player の staticFile 用の付け替え。
 * App.tsx:1580 付近)。EnginePreview はこの**書き換え後**の props を受け取る
 * ため、sourceId は常にこの "media/" 接頭辞を含む(engineDev.ts の単体ページは
 * buildRenderProps を直接呼ぶため未加工の sourceId で、resolveUrl 側で
 * `/media/` を足していた=同じ関数名でも規約が違う。混同しないこと)。
 * encodeURIComponent は Timeline.tsx/AiVisualReview.tsx の mediaUrl と同じ
 * 規約(素材ファイル名の空白/日本語等を安全に URL 化する) */
const VIDEO_FILE = "media/proxy.mp4";

function resolveUrl(sourceId: string): string {
  return `/${encodeURIComponent(sourceId).replace(/%2F/g, "/")}`;
}

function sourceTimeOf(item: ExternalItem): number {
  return item.sourceTimeSec;
}

/** App.tsx が実際に呼ぶ PlayerRef API の閉じた集合(§1.2で grep 済み)。
 * Remotion 自身の型から Pick することで、App.tsx 側の呼び出し
 * (CallbackListener<"frameupdate"> 等)を1行も変えずに Player/EnginePreview
 * どちらの ref も同じ形で受けられる */
export type PreviewHandle = Pick<
  PlayerRef,
  | "seekTo"
  | "play"
  | "pause"
  | "isPlaying"
  | "getCurrentFrame"
  | "setVolume"
  | "addEventListener"
  | "removeEventListener"
>;

export interface EnginePreviewProps {
  props: RenderProps;
  durationInFrames: number;
  fps: number;
  loop: boolean;
  playbackRate: number;
  initialVolume: number;
  /** WebGPU 非対応/初期化失敗時に呼ばれる(throw しない。§2-2 決定)。
   * 呼び出し側(App.tsx)は legacy(Player)へ切り替える */
  onFallback: (reason: string) => void;
}

type Listener<T extends PlayerEventTypes> = CallbackListener<T>;

export const EnginePreview = forwardRef<PreviewHandle, EnginePreviewProps>(function EnginePreview(
  { props, durationInFrames, fps, loop, playbackRate, initialVolume, onFallback },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);

  // 最新値を effect の外(clock の onFrame・handle のメソッド)から読むための
  // ref。mount エフェクトは初回だけ走らせる([]依存)ので、これらは
  // 「今の値」を常に指す出口として使う
  const propsRef = useRef(props);
  propsRef.current = props;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const durationFramesRef = useRef(durationInFrames);
  durationFramesRef.current = durationInFrames;

  const readyRef = useRef(false);
  const playingRef = useRef(false);
  const volumeRef = useRef(initialVolume);
  const audioSigRef = useRef("");

  const compositorRef = useRef<EngineCompositor | null>(null);
  const sourcePoolRef = useRef<SourcePool | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const schedulerRef = useRef<AudioScheduler | null>(null);
  const clockRef = useRef<PresentationClock | null>(null);

  const listenersRef = useRef<{ [K in PlayerEventTypes]?: Set<Listener<K>> }>({});

  const dispatch = <T extends PlayerEventTypes>(type: T, detail: unknown): void => {
    const set = listenersRef.current[type] as Set<Listener<T>> | undefined;
    if (!set) return;
    for (const cb of set) cb({ detail } as Parameters<Listener<T>>[0]);
  };

  const repaintAt = async (sec: number): Promise<void> => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    const durationSec = durationFramesRef.current / fpsRef.current;
    const descriptor = describeFrame(propsRef.current, Math.min(Math.max(sec, 0), durationSec));
    await compositor.renderDescriptor(descriptor, sourceTimeOf);
  };

  // props(caption/overlay/bgm 等の JSON 編集・ドラッグ draft・hot-reload)が
  // 変わるたびに: 一時停止中なら現在秒を repaint。音に効く要素(bgm/base
  // timeline)が変わっていたら AudioScheduler を作り直す(§2-4 #5)
  useEffect(() => {
    if (!readyRef.current) return;
    const sig = audioSignatureOf(props);
    if (sig !== audioSigRef.current) {
      audioSigRef.current = sig;
      const audioContext = audioContextRef.current;
      const clock = clockRef.current;
      if (audioContext && clock) {
        schedulerRef.current?.dispose();
        const scheduler = new AudioScheduler({
          audioContext,
          baseAudioUrl: resolveUrl(VIDEO_FILE),
          timeline: timelineFromBaseSegments(props),
          bgm: props.bgm,
          fps: fpsRef.current,
        });
        scheduler.setVolume(volumeRef.current);
        schedulerRef.current = scheduler;
        if (playingRef.current) scheduler.start(clock.getMapping(), resolveUrl);
      }
    }
    if (!playingRef.current) void repaintAt(clockRef.current?.currentOutputSec() ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  // playbackRate の変更: clock の rate を切り替え、再生中なら scheduler の
  // 予約をその rate で引き直す(T1-1/T1-2 が担保する mapping.rate 経由)
  useEffect(() => {
    if (!readyRef.current) return;
    clockRef.current?.setRate(playbackRate);
    if (playingRef.current && clockRef.current && schedulerRef.current) {
      schedulerRef.current.start(clockRef.current.getMapping(), resolveUrl);
    }
  }, [playbackRate]);

  // mount 時に1回だけ GPU 初期化+AudioContext/Scheduler/Clock を組み立てる。
  // key={videoVersion}(App.tsx 側)で全体が remount される前提なので、
  // width/height/short 切替は常にこの effect の再実行(=新規 mount)で拾う
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;

    void (async () => {
      let compositor: EngineCompositor;
      const sourcePool = new SourcePool(resolveUrl);
      try {
        compositor = await EngineCompositor.create(props.width, props.height, sourcePool, props.canvas);
      } catch (err) {
        if (!cancelled) onFallback(String((err as Error)?.message ?? err));
        return;
      }
      if (cancelled) {
        compositor.dispose();
        return;
      }

      compositor.canvas.style.width = "100%";
      compositor.canvas.style.height = "auto";
      host?.appendChild(compositor.canvas);
      compositorRef.current = compositor;
      sourcePoolRef.current = sourcePool;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const initialTimeline = timelineFromBaseSegments(props);
      audioSigRef.current = audioSignatureOf(props);
      const scheduler = new AudioScheduler({
        audioContext,
        baseAudioUrl: resolveUrl(VIDEO_FILE),
        timeline: initialTimeline,
        bgm: props.bgm,
        fps,
      });
      scheduler.setVolume(volumeRef.current);
      schedulerRef.current = scheduler;

      const clock = new PresentationClock(audioContext, async (sec) => {
        const fpsNow = fpsRef.current;
        const durationSec = durationFramesRef.current / fpsNow;
        let effectiveSec = sec;
        if (sec >= durationSec) {
          if (loopRef.current) {
            clock.seek(0);
            schedulerRef.current?.start(clock.getMapping(), resolveUrl);
            effectiveSec = 0;
          } else {
            clock.pause();
            schedulerRef.current?.stop();
            playingRef.current = false;
            dispatch("pause", undefined);
            effectiveSec = durationSec;
          }
        }
        await repaintAt(effectiveSec);
        dispatch("frameupdate", { frame: Math.round(Math.min(effectiveSec, durationSec) * fpsNow) });
      });
      clock.setRate(playbackRate);
      clockRef.current = clock;

      readyRef.current = true;
      // 最初の1枚(再生を待たずに絵が出ている状態にする。engineDev と同じ)
      await repaintAt(0);
      dispatch("frameupdate", { frame: 0 });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      playingRef.current = false;
      clockRef.current?.dispose();
      schedulerRef.current?.dispose();
      compositorRef.current?.dispose();
      clockRef.current = null;
      schedulerRef.current = null;
      compositorRef.current = null;
      audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
      sourcePoolRef.current = null;
    };
    // mount/unmount 専用(App.tsx 側の key={videoVersion} が再マウントを担う)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      seekTo(frame: number) {
        const sec = frame / fpsRef.current;
        clockRef.current?.seek(sec);
        if (!playingRef.current) void repaintAt(sec);
        dispatch("frameupdate", { frame });
      },
      play() {
        const audioContext = audioContextRef.current;
        const clock = clockRef.current;
        const scheduler = schedulerRef.current;
        if (!audioContext || !clock || !scheduler) return;
        playingRef.current = true;
        // §2-1: resume() → clock.play() → scheduler.start() → listeners("play")
        void audioContext.resume().then(() => {
          clock.play();
          scheduler.start(clock.getMapping(), resolveUrl);
          dispatch("play", undefined);
        });
      },
      pause() {
        clockRef.current?.pause();
        schedulerRef.current?.stop();
        playingRef.current = false;
        dispatch("pause", undefined);
      },
      isPlaying() {
        return playingRef.current;
      },
      getCurrentFrame() {
        return Math.round((clockRef.current?.currentOutputSec() ?? 0) * fpsRef.current);
      },
      setVolume(v: number) {
        volumeRef.current = v;
        schedulerRef.current?.setVolume(v);
      },
      addEventListener<T extends PlayerEventTypes>(type: T, listener: Listener<T>) {
        const sets = listenersRef.current;
        const existing = sets[type] as Set<Listener<T>> | undefined;
        if (existing) existing.add(listener);
        else sets[type] = new Set([listener]) as (typeof sets)[T];
      },
      removeEventListener<T extends PlayerEventTypes>(type: T, listener: Listener<T>) {
        const set = listenersRef.current[type] as Set<Listener<T>> | undefined;
        set?.delete(listener);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [],
  );

  return <div ref={hostRef} style={{ width: "100%", height: "100%" }} />;
});
