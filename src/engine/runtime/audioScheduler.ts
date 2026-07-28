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
 * この式1つに正規化する。二重に持たない)。rate 省略時は従来どおり等速
 * (M3b: playbackRate 対応で mapping.rate を分母に反映) */
export function contextTimeForOutputSec(mapping: ClockMapping, sec: number): number {
  return mapping.startContextTime + (sec - mapping.startOutputSec) / (mapping.rate ?? 1);
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

/** 窓長(秒)。LOOKAHEAD_SEC(2秒)より短く、かつ短すぎて予約ノードと
 *  decode 呼び出しが爆発しない値を選ぶ。1秒は LOOKAHEAD_SEC の半分で、
 *  keep 区間(最大 15-20s)を 15-20 枚に分割する。各窓は aac パケット
 *  (21.3ms)を約47枚連結する。SCHEDULE_INTERVAL_MS(500ms)の倍なので、
 *  毎回のタイマーで窓1.5枚ぶんのソースノードを予約する形になり、
 *  先読みとスケジュール間隔のバランスが取れる。 */
const WINDOW_SEC = 1.0;

export interface CreateBuffer {
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

export function concatAudioBuffers(
  buffers: AudioBuffer[],
  ctx: CreateBuffer,
): AudioBuffer | null {
  if (buffers.length === 0) return null;
  const sr = buffers[0].sampleRate;
  const ch = buffers[0].numberOfChannels;
  for (const b of buffers) {
    if (b.sampleRate !== sr) throw new Error("concatAudioBuffers: mismatched sampleRate");
    if (b.numberOfChannels !== ch) throw new Error("concatAudioBuffers: mismatched numberOfChannels");
  }
  const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = ctx.createBuffer(ch, totalLen, sr);
  let offset = 0;
  for (const b of buffers) {
    for (let c = 0; c < ch; c++) {
      out.getChannelData(c).set(b.getChannelData(c), offset);
    }
    offset += b.length;
  }
  return out;
}

export function splitEntryIntoWindows(entry: TimelineEntry, windowSec: number): TimelineEntry[] {
  const dur = entry.outputEnd - entry.outputStart;
  if (dur <= windowSec) return [entry];
  const count = Math.ceil(dur / windowSec);
  const result: TimelineEntry[] = [];
  for (let i = 0; i < count; i++) {
    const outputStart = entry.outputStart + i * windowSec;
    const outputEnd = Math.min(entry.outputEnd, outputStart + windowSec);
    const relStart = (i * windowSec) * entry.speed;
    const relEnd = relStart + (outputEnd - outputStart) * entry.speed;
    result.push({
      outputStart,
      outputEnd,
      sourceStart: entry.sourceStart + relStart,
      sourceEnd: entry.sourceStart + relEnd,
      speed: entry.speed,
    });
  }
  return result;
}

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
  private scheduledBaseKeys = new Set<string>();
  private scheduledBgmKeys = new Set<string>();
  private queuedNodes = new Set<AudioBufferSourceNode>();
  private bgmGainNodes = new Map<number, GainNode>();
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
    for (const gn of this.bgmGainNodes.values()) gn.disconnect();
    this.bgmGainNodes.clear();
    this.sessionId++;
    this.mapping = mapping;
    this.scheduledBaseKeys = new Set();
    this.scheduledBgmKeys = new Set();
    // BGM の sink と track-level GainNode を事前に作る
    for (let i = 0; i < this.opts.bgm.length; i++) {
      const track = this.opts.bgm[i];
      void this.ensureBgmSink(track.file, resolveBgmUrl);
      const gain = this.audioContext.createGain();
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
      this.bgmGainNodes.set(i, gain);
    }
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
    for (const gn of this.bgmGainNodes.values()) gn.disconnect();
    this.bgmGainNodes.clear();
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
        const key = String(index);
        if (this.scheduledBaseKeys.has(key)) return;
        if (!shouldScheduleEntry(entry, currentSec, windowEnd)) return;
        this.scheduledBaseKeys.add(key);
        const windows = splitEntryIntoWindows(entry, WINDOW_SEC);
        for (let wi = 0; wi < windows.length; wi++) {
          void this.scheduleBaseEntry(windows[wi], sessionId);
        }
      });
    }

    if (!this.opts.muteBgm) {
      this.opts.bgm.forEach((track, index) => {
        const key = String(index);
        if (this.scheduledBgmKeys.has(key)) return;
        if (!shouldScheduleEntry({ outputStart: track.start, outputEnd: track.end }, currentSec, windowEnd)) return;
        this.scheduledBgmKeys.add(key);
        const srcEntry: TimelineEntry = {
          outputStart: track.start,
          outputEnd: track.end,
          sourceStart: track.startFrom ?? 0,
          sourceEnd: (track.startFrom ?? 0) + (track.end - track.start),
          speed: 1,
        };
        const windows = splitEntryIntoWindows(srcEntry, WINDOW_SEC);
        for (let wi = 0; wi < windows.length; wi++) {
          void this.scheduleBgmTrack(track, windows[wi], sessionId, index, resolveBgmUrl);
        }
      });
    }

    this.scheduling = false;
  }

  private async scheduleBaseEntry(entry: TimelineEntry, sessionId: number): Promise<void> {
    const sink = await this.ensureBaseSink();
    if (!sink || sessionId !== this.sessionId) return;
    const chunks: AudioBuffer[] = [];
    for await (const chunk of sink.buffers(entry.sourceStart, entry.sourceEnd)) {
      if (sessionId !== this.sessionId) return;
      chunks.push(chunk.buffer);
    }
    const buffer = concatAudioBuffers(chunks, this.audioContext);
    if (!buffer || sessionId !== this.sessionId) return;
    const node = this.audioContext.createBufferSource();
    node.buffer = buffer;
    // entry.speed(cutplan の区間速度)と mapping.rate(プレビューの全体再生速度。
    // M3b)は独立な倍率なので掛け合わせる
    const combinedRate = entry.speed * (this.mapping.rate ?? 1);
    if (combinedRate !== 1) node.playbackRate.value = combinedRate;
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
    entry: TimelineEntry,
    sessionId: number,
    trackIndex: number,
    resolveBgmUrl: (file: string) => string,
  ): Promise<void> {
    if (sessionId !== this.sessionId) return;
    const gainNode = this.bgmGainNodes.get(trackIndex);
    if (!gainNode) return;
    let cached = this.bgmSinks.get(track.file);
    if (!cached) {
      const sink = await this.ensureBgmSink(track.file, resolveBgmUrl);
      if (!sink) return;
      cached = this.bgmSinks.get(track.file);
      if (!cached) return;
    }
    const { sink } = cached;
    const chunks: AudioBuffer[] = [];
    for await (const chunk of sink.buffers(entry.sourceStart, entry.sourceEnd)) {
      if (sessionId !== this.sessionId) return;
      chunks.push(chunk.buffer);
    }
    const buffer = concatAudioBuffers(chunks, this.audioContext);
    if (!buffer || sessionId !== this.sessionId) return;

    const node = this.audioContext.createBufferSource();
    node.buffer = buffer;
    const rate = this.mapping.rate ?? 1;
    if (rate !== 1) node.playbackRate.value = rate;
    node.connect(gainNode);

    const startAt = contextTimeForOutputSec(this.mapping, entry.outputStart);
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
      this.queuedNodes.delete(node);
    });
  }

  /** マスター音量を即時反映する(0..1。EnginePreview の setVolume 用) */
  setVolume(v: number): void {
    this.masterGain.gain.value = v;
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
