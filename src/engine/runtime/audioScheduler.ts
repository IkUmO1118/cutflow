// src/engine/runtime/audioScheduler.ts — WebAudio 先読みスケジューラ(M3a Phase4)。
// OpenCut apps/web/src/core/managers/audio-manager.ts の設計を写す
// (500ms 間隔の先読み・AudioBufferSourceNode.start(絶対時刻, offset)予約・
// セッションID で古い予約を無効化)。CutFlow は OpenCut の任意クリップ配列
// ではなく「keep セグメント(base 音声)」+「bgm.json のトラック(BGM)」という
// 固定2種のソースだけを扱うため、クリップ抽象は持たず専用に組む。
//
// ブラウザ専用(AudioContext・mediabunny 前提)。
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from "mediabunny";
import type { TimelineEntry } from "../../lib/timeline.ts";
import { bgmVolumeAtFrame } from "../../lib/bgmEnvelope.ts";
import type { RenderProps } from "../../../remotion/props.ts";
import type { ClockMapping } from "./clock.ts";

type BgmTrack = RenderProps["bgm"][number];

/** 出力秒 → その瞬間に対応する AudioContext 絶対時刻。clock.ts の
 * PresentationClock と同じマッピングを共有する(音がマスターなので
 * この式1つに正規化する。二重に持たない) */
export function contextTimeForOutputSec(mapping: ClockMapping, sec: number): number {
  return mapping.startContextTime + (sec - mapping.startOutputSec);
}

/** 先読み窓 [currentSec, windowEnd] にこのエントリをスケジュールすべきか
 * (OpenCut scheduleUpcomingClips の window 判定を写す。純関数) */
export function shouldScheduleEntry(
  entry: { outputStart: number; outputEnd: number },
  currentSec: number,
  windowEnd: number,
): boolean {
  return entry.outputEnd > currentSec && entry.outputStart <= windowEnd;
}

export interface GainAutomationPoint {
  atSec: number;
  gain: number;
}

/**
 * BGM トラックの gain 自動化点列。`bgmVolumeAtFrame`(src/lib/bgmEnvelope.ts。
 * Remotion の BgmTrack と同じ逐フレーム gain 式)を fade-in/out・duck spans の
 * 折れ点でだけサンプルし、WebAudio の `linearRampToValueAtTime` 用の
 * 疎な点列へ間引く(毎フレームサンプルする必要はない=折れ点間は線形補間で
 * 元の式と一致する。duckFactorAt 自体が区分線形のため)。
 */
export function buildBgmGainAutomation(track: BgmTrack, fps: number): GainAutomationPoint[] {
  const breakpoints = new Set<number>([track.start, track.end]);
  const fadeIn = track.fadeInSec ?? 0;
  const fadeOut = track.fadeOutSec ?? 0;
  if (fadeIn > 0) breakpoints.add(Math.min(track.end, track.start + fadeIn));
  if (fadeOut > 0) breakpoints.add(Math.max(track.start, track.end - fadeOut));
  if (track.duck) {
    const duckFade = Math.max(track.duck.fadeSec, 1 / fps);
    for (const span of track.duck.spans) {
      for (const t of [span.start - duckFade, span.start, span.end, span.end + duckFade]) {
        if (t > track.start && t < track.end) breakpoints.add(t);
      }
    }
  }
  const sorted = [...breakpoints].filter((t) => t >= track.start && t <= track.end).sort((a, b) => a - b);
  return sorted.map((t) => ({
    atSec: t,
    gain: bgmVolumeAtFrame(track, Math.round((t - track.start) * fps), fps),
  }));
}

const LOOKAHEAD_SEC = 2;
const SCHEDULE_INTERVAL_MS = 500;

export interface AudioSchedulerOptions {
  audioContext: AudioContext;
  /** proxy.mp4(音声トラック込み)の URL。keep セグメントの音源 */
  baseAudioUrl: string;
  timeline: TimelineEntry[];
  bgm: BgmTrack[];
  fps: number;
  muteBase?: boolean;
  muteBgm?: boolean;
}

/** proxy.mp4 の keep セグメントを鳴らす base 音声 + bgm.json のトラックを
 * 両方まとめて先読みスケジュールする。「所有権(frameSource と同じ発想):
 * decode したバッファは Web Audio の GC(GainNode.disconnect 後は
 * AudioBufferSourceNode 自体がGC対象)に任せる=明示 close は不要
 * (mediabunny の AudioBuffer は WebCodecs VideoFrame と違い明示的な
 * リソース解放が要らない)」 */
export class AudioScheduler {
  private readonly audioContext: AudioContext;
  private readonly masterGain: GainNode;
  private readonly opts: AudioSchedulerOptions;

  private baseInput: InstanceType<typeof Input> | null = null;
  private baseSink: AudioBufferSink | null = null;
  private readonly bgmSinks = new Map<string, { input: InstanceType<typeof Input>; sink: AudioBufferSink }>();

  private mapping: ClockMapping = { startOutputSec: 0, startContextTime: 0 };
  private scheduling = false;
  private sessionId = 0;
  private scheduledBaseIndices = new Set<number>();
  private scheduledBgmIndices = new Set<number>();
  private queuedNodes = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AudioSchedulerOptions) {
    this.opts = opts;
    this.audioContext = opts.audioContext;
    this.masterGain = opts.audioContext.createGain();
    this.masterGain.connect(opts.audioContext.destination);
  }

  private async ensureBaseSink(): Promise<AudioBufferSink | null> {
    if (this.baseSink) return this.baseSink;
    const input = new Input({ source: new UrlSource(this.opts.baseAudioUrl), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      input.dispose();
      return null;
    }
    this.baseInput = input;
    this.baseSink = new AudioBufferSink(track);
    return this.baseSink;
  }

  private async ensureBgmSink(file: string, resolveUrl: (file: string) => string): Promise<AudioBufferSink | null> {
    const existing = this.bgmSinks.get(file);
    if (existing) return existing.sink;
    const input = new Input({ source: new UrlSource(resolveUrl(file)), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      input.dispose();
      return null;
    }
    const sink = new AudioBufferSink(track);
    this.bgmSinks.set(file, { input, sink });
    return sink;
  }

  /** 再生開始/シークのたびに呼ぶ。mapping は clock.ts と同じものを渡す
   * (音がマスター=マッピングの正はそこ1つ) */
  start(mapping: ClockMapping, resolveBgmUrl: (file: string) => string): void {
    this.stopScheduledNodes();
    this.sessionId++;
    this.mapping = mapping;
    this.scheduledBaseIndices = new Set();
    this.scheduledBgmIndices = new Set();
    this.scheduleWindow(mapping.startOutputSec, resolveBgmUrl);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const currentSec =
        this.mapping.startOutputSec + (this.audioContext.currentTime - this.mapping.startContextTime);
      this.scheduleWindow(currentSec, resolveBgmUrl);
    }, SCHEDULE_INTERVAL_MS);
  }

  /** 一時停止/停止。予約済みノードを全部止める */
  stop(): void {
    this.sessionId++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopScheduledNodes();
  }

  private stopScheduledNodes(): void {
    for (const node of this.queuedNodes) {
      try {
        node.stop();
      } catch {
        // 既に終わっている場合は無視
      }
      node.disconnect();
    }
    this.queuedNodes.clear();
  }

  private scheduleWindow(currentSec: number, resolveBgmUrl: (file: string) => string): void {
    if (this.scheduling) return;
    this.scheduling = true;
    const sessionId = this.sessionId;
    const windowEnd = currentSec + LOOKAHEAD_SEC;

    if (!this.opts.muteBase) {
      this.opts.timeline.forEach((entry, index) => {
        if (this.scheduledBaseIndices.has(index)) return;
        if (!shouldScheduleEntry(entry, currentSec, windowEnd)) return;
        this.scheduledBaseIndices.add(index);
        void this.scheduleBaseEntry(entry, sessionId);
      });
    }

    if (!this.opts.muteBgm) {
      this.opts.bgm.forEach((track, index) => {
        if (this.scheduledBgmIndices.has(index)) return;
        if (!shouldScheduleEntry({ outputStart: track.start, outputEnd: track.end }, currentSec, windowEnd)) return;
        this.scheduledBgmIndices.add(index);
        void this.scheduleBgmTrack(track, sessionId, resolveBgmUrl);
      });
    }

    this.scheduling = false;
  }

  private async scheduleBaseEntry(entry: TimelineEntry, sessionId: number): Promise<void> {
    const sink = await this.ensureBaseSink();
    if (!sink || sessionId !== this.sessionId) return;
    // keep セグメント全体を1つの AudioBuffer として取り出す(再生位置=
    // entry.sourceStart から entry.sourceEnd まで)。区間は数秒〜数十秒が
    // 通常でありメモリ上問題ない前提(cut.mp4 と同じ粒度)
    let buffer: AudioBuffer | null = null;
    for await (const chunk of sink.buffers(entry.sourceStart, entry.sourceEnd)) {
      buffer = chunk.buffer;
      break; // 先頭チャンクだけで足りるかは §5 検証課題。Phase5 で実測して分割要否を決める
    }
    if (!buffer || sessionId !== this.sessionId) return;
    const node = this.audioContext.createBufferSource();
    node.buffer = buffer;
    if (entry.speed !== 1) node.playbackRate.value = entry.speed;
    node.connect(this.masterGain);
    const startAt = contextTimeForOutputSec(this.mapping, entry.outputStart);
    if (startAt >= this.audioContext.currentTime) {
      node.start(startAt);
    } else {
      const offset = this.audioContext.currentTime - startAt;
      if (offset < buffer.duration) node.start(this.audioContext.currentTime, offset);
      else return;
    }
    this.queuedNodes.add(node);
    node.addEventListener("ended", () => {
      node.disconnect();
      this.queuedNodes.delete(node);
    });
  }

  private async scheduleBgmTrack(
    track: BgmTrack,
    sessionId: number,
    resolveBgmUrl: (file: string) => string,
  ): Promise<void> {
    const sink = await this.ensureBgmSink(track.file, resolveBgmUrl);
    if (!sink || sessionId !== this.sessionId) return;
    const startFrom = track.startFrom ?? 0;
    let buffer: AudioBuffer | null = null;
    for await (const chunk of sink.buffers(startFrom, startFrom + (track.end - track.start))) {
      buffer = chunk.buffer;
      break;
    }
    if (!buffer || sessionId !== this.sessionId) return;

    const node = this.audioContext.createBufferSource();
    node.buffer = buffer;
    const gain = this.audioContext.createGain();
    node.connect(gain);
    gain.connect(this.masterGain);

    const startAt = contextTimeForOutputSec(this.mapping, track.start);
    const points = buildBgmGainAutomation(track, this.opts.fps);
    gain.gain.cancelScheduledValues(startAt);
    for (const p of points) {
      const t = contextTimeForOutputSec(this.mapping, p.atSec);
      if (t < this.audioContext.currentTime) continue;
      gain.gain.linearRampToValueAtTime(p.gain, t);
    }
    if (points.length > 0 && contextTimeForOutputSec(this.mapping, points[0].atSec) >= this.audioContext.currentTime) {
      gain.gain.setValueAtTime(points[0].gain, contextTimeForOutputSec(this.mapping, points[0].atSec));
    }

    if (startAt >= this.audioContext.currentTime) {
      node.start(startAt, 0);
    } else {
      const offset = this.audioContext.currentTime - startAt;
      if (offset < buffer.duration) node.start(this.audioContext.currentTime, offset);
      else return;
    }
    this.queuedNodes.add(node);
    node.addEventListener("ended", () => {
      node.disconnect();
      gain.disconnect();
      this.queuedNodes.delete(node);
    });
  }

  dispose(): void {
    this.stop();
    this.baseInput?.dispose();
    this.baseInput = null;
    this.baseSink = null;
    for (const { input } of this.bgmSinks.values()) input.dispose();
    this.bgmSinks.clear();
    this.masterGain.disconnect();
  }
}
