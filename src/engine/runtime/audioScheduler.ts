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
import { fadeFactor, isImageFile } from "../../lib/overlayFade.ts";
import type { OverlayItem, RenderProps } from "../../../remotion/props.ts";
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

export function buildClipGainAutomation(
  startSec: number,
  endSec: number,
  fps: number,
  volume: number,
  fadeInSec?: number,
  fadeOutSec?: number,
): GainAutomationPoint[] {
  const durFrames = Math.max(1, Math.round((endSec - startSec) * fps));
  const fin = fadeInSec ?? 0;
  const fout = fadeOutSec ?? 0;
  const breakpoints = new Set<number>([startSec, endSec]);
  if (fin > 0 && startSec + fin < endSec) breakpoints.add(startSec + fin);
  if (fout > 0 && endSec - fout > startSec) breakpoints.add(endSec - fout);
  const sorted = [...breakpoints].sort((a, b) => a - b);
  return sorted.map((t) => {
    const frame = Math.round((t - startSec) * fps);
    const f = Math.min(durFrames, Math.max(0, frame));
    return {
      atSec: t,
      gain: volume * fadeFactor(f, durFrames, fps, fadeInSec, fadeOutSec),
    };
  });
}

const LOOKAHEAD_SEC = 2;
const SCHEDULE_INTERVAL_MS = 500;

/** reseek() の合体待ち(R4 Phase4。§2 決定5)。スクラブ(pointermove起点の
 * 連続シーク)は SCHEDULE_INTERVAL_MS(500ms)よりずっと速い頻度で来るため、
 * それより十分短い 150ms を「入力が止まった」判定に使う。この間は
 * reseek() の呼び出しがタイマーを張り直すだけで合体し、実際の
 * decode/schedule はスクラブが止まってから1回だけ走る */
const RESEEK_SETTLE_MS = 150;

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
  overlays?: OverlayItem[];
  inserts?: NonNullable<RenderProps["inserts"]>;
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
  private readonly overlaySinks = new Map<string, { input: InstanceType<typeof Input>; sink: AudioBufferSink }>();
  private readonly insertSinks = new Map<string, { input: InstanceType<typeof Input>; sink: AudioBufferSink }>();
  private readonly overlayAudioItems: OverlayItem[];
  private readonly insertAudioItems: NonNullable<RenderProps["inserts"]>;

  private mapping: ClockMapping = { startOutputSec: 0, startContextTime: 0 };
  private scheduling = false;
  private sessionId = 0;
  private scheduledBaseKeys = new Set<string>();
  private scheduledBgmKeys = new Set<string>();
  private scheduledOverlayKeys = new Set<string>();
  private scheduledInsertKeys = new Set<string>();
  private queuedBaseNodes = new Set<AudioBufferSourceNode>();
  private queuedBgmNodes = new Set<AudioBufferSourceNode>();
  private queuedOverlayNodes = new Set<AudioBufferSourceNode>();
  private queuedInsertNodes = new Set<AudioBufferSourceNode>();
  private bgmGainNodes = new Map<number, GainNode>();
  private overlayGainNodes = new Map<number, GainNode>();
  private insertGainNodes = new Map<number, GainNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** reseek() の合体待ちタイマー(R4 Phase4)。setTimeout 中に新たな reseek()
   * が来たら張り直す(スクラブ対応) */
  private reseekTimer: ReturnType<typeof setTimeout> | null = null;
  /** 合体待ち中に確定させた resolveUrl(settle 時にそのまま使う) */
  private pendingReseekResolveUrl: ((file: string) => string) | null = null;
  private mutedBase: boolean;
  private mutedBgm: boolean;
  private _queuedDurationSec = 0;

  constructor(opts: AudioSchedulerOptions) {
    this.opts = opts;
    this.audioContext = opts.audioContext;
    this.masterGain = opts.audioContext.createGain();
    this.masterGain.connect(opts.audioContext.destination);
    this.mutedBase = opts.muteBase ?? false;
    this.mutedBgm = opts.muteBgm ?? false;
    this.overlayAudioItems = (opts.overlays ?? []).filter(
      (o) => !isImageFile(o.file) && (o.volume ?? 0) > 0,
    );
    this.insertAudioItems = (opts.inserts ?? []).filter(
      (ins) => !isImageFile(ins.file) && (ins.volume ?? 1) > 0,
    );
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

  private async ensureClipSink(
    file: string,
    resolveUrl: (file: string) => string,
    cache: Map<string, { input: InstanceType<typeof Input>; sink: AudioBufferSink }>,
  ): Promise<AudioBufferSink | null> {
    const existing = cache.get(file);
    if (existing) return existing.sink;
    const input = new Input({ source: new UrlSource(resolveUrl(file)), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      input.dispose();
      return null;
    }
    const sink = new AudioBufferSink(track);
    cache.set(file, { input, sink });
    return sink;
  }

  /** bgm/overlay/insert の track-level GainNode をゲイン自動化込みで
   * 組み立て直す(start()/reseek() 共通。呼び出し前に disconnectAllGainNodes()
   * 済みで this.mapping が確定している前提) */
  private buildGainNodes(resolveUrl: (file: string) => string): void {
    // BGM の sink と track-level GainNode を事前に作る
    for (let i = 0; i < this.opts.bgm.length; i++) {
      const track = this.opts.bgm[i];
      void this.ensureBgmSink(track.file, resolveUrl);
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
    // overlay/insert の clip-level GainNode を事前に作る
    for (let i = 0; i < this.overlayAudioItems.length; i++) {
      const o = this.overlayAudioItems[i];
      void this.ensureClipSink(o.file, resolveUrl, this.overlaySinks);
      const gain = this.audioContext.createGain();
      gain.connect(this.masterGain);
      const points = buildClipGainAutomation(o.start, o.end, this.opts.fps, o.volume ?? 1, o.fadeInSec, o.fadeOutSec);
      const startAt = contextTimeForOutputSec(this.mapping, o.start);
      gain.gain.cancelScheduledValues(startAt);
      for (const p of points) {
        const t = contextTimeForOutputSec(this.mapping, p.atSec);
        if (t < this.audioContext.currentTime) continue;
        gain.gain.linearRampToValueAtTime(p.gain, t);
      }
      if (points.length > 0 && contextTimeForOutputSec(this.mapping, points[0].atSec) >= this.audioContext.currentTime) {
        gain.gain.setValueAtTime(points[0].gain, contextTimeForOutputSec(this.mapping, points[0].atSec));
      }
      this.overlayGainNodes.set(i, gain);
    }
    for (let i = 0; i < this.insertAudioItems.length; i++) {
      const ins = this.insertAudioItems[i];
      void this.ensureClipSink(ins.file, resolveUrl, this.insertSinks);
      const gain = this.audioContext.createGain();
      gain.connect(this.masterGain);
      const points = buildClipGainAutomation(ins.start, ins.end, this.opts.fps, ins.volume ?? 1, ins.fadeInSec, ins.fadeOutSec);
      const startAt = contextTimeForOutputSec(this.mapping, ins.start);
      gain.gain.cancelScheduledValues(startAt);
      for (const p of points) {
        const t = contextTimeForOutputSec(this.mapping, p.atSec);
        if (t < this.audioContext.currentTime) continue;
        gain.gain.linearRampToValueAtTime(p.gain, t);
      }
      if (points.length > 0 && contextTimeForOutputSec(this.mapping, points[0].atSec) >= this.audioContext.currentTime) {
        gain.gain.setValueAtTime(points[0].gain, contextTimeForOutputSec(this.mapping, points[0].atSec));
      }
      this.insertGainNodes.set(i, gain);
    }
  }

  private disconnectAllGainNodes(): void {
    for (const gn of this.bgmGainNodes.values()) gn.disconnect();
    for (const gn of this.overlayGainNodes.values()) gn.disconnect();
    for (const gn of this.insertGainNodes.values()) gn.disconnect();
    this.bgmGainNodes.clear();
    this.overlayGainNodes.clear();
    this.insertGainNodes.clear();
  }

  private clearScheduledKeys(): void {
    this.scheduledBaseKeys = new Set();
    this.scheduledBgmKeys = new Set();
    this.scheduledOverlayKeys = new Set();
    this.scheduledInsertKeys = new Set();
  }

  /** 通常の先読みタイマー(SCHEDULE_INTERVAL_MS間隔)を張り直す。
   * start()/reseek() の settle 後で共通に使う */
  private startScheduleLoop(resolveUrl: (file: string) => string): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const currentSec =
        this.mapping.startOutputSec + (this.audioContext.currentTime - this.mapping.startContextTime);
      this.scheduleWindow(currentSec, resolveUrl);
    }, SCHEDULE_INTERVAL_MS);
  }

  /** 再生開始/シークのたびに呼ぶ。mapping は clock.ts と同じものを渡す
   * (音がマスター=マッピングの正はそこ1つ) */
  start(mapping: ClockMapping, resolveUrl: (file: string) => string): void {
    this.stopScheduledNodes();
    this.disconnectAllGainNodes();
    // 進行中の reseek() 合体待ちは、通常の start() が来た以上は不要
    if (this.reseekTimer !== null) {
      clearTimeout(this.reseekTimer);
      this.reseekTimer = null;
      this.pendingReseekResolveUrl = null;
    }
    this.sessionId++;
    this.mapping = mapping;
    this.clearScheduledKeys();
    this.buildGainNodes(resolveUrl);
    this.scheduleWindow(mapping.startOutputSec, resolveUrl);
    this.startScheduleLoop(resolveUrl);
  }

  /** 再生中のシークで呼ぶ(R4 Phase4。§2 決定5)。予約済みノードを即時停止し
   * mapping を差し替えるが、再スケジュールはすぐに行わない
   * (先読みタイマーも一旦止める=古いmappingのまま動かないように)。
   * RESEEK_SETTLE_MS だけ入力が止まってから初めて1回だけ
   * ゲインノードの組み立て直し+先読みタイマーの再開を行う。
   * 連続呼び出し(スクラブ)はタイマーを張り直すだけで合体する */
  reseek(mapping: ClockMapping, resolveUrl: (file: string) => string): void {
    this.stopScheduledNodes();
    this.disconnectAllGainNodes();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessionId++;
    this.mapping = mapping;
    this.clearScheduledKeys();
    this.pendingReseekResolveUrl = resolveUrl;
    if (this.reseekTimer !== null) clearTimeout(this.reseekTimer);
    this.reseekTimer = setTimeout(() => {
      this.reseekTimer = null;
      const rUrl = this.pendingReseekResolveUrl;
      this.pendingReseekResolveUrl = null;
      if (!rUrl) return;
      this.buildGainNodes(rUrl);
      this.scheduleWindow(this.mapping.startOutputSec, rUrl);
      this.startScheduleLoop(rUrl);
    }, RESEEK_SETTLE_MS);
  }

  /** 一時停止/停止。予約済みノードを全部止める */
  stop(): void {
    this.sessionId++;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reseekTimer !== null) {
      clearTimeout(this.reseekTimer);
      this.reseekTimer = null;
      this.pendingReseekResolveUrl = null;
    }
    this.stopScheduledNodes();
    this.disconnectAllGainNodes();
  }

  private stopScheduledNodes(): void {
    for (const nodes of [this.queuedBaseNodes, this.queuedBgmNodes, this.queuedOverlayNodes, this.queuedInsertNodes]) {
      for (const node of nodes) {
        try {
          node.stop();
        } catch {
          // 既に終わっている場合は無視
        }
        node.disconnect();
      }
      nodes.clear();
    }
    this._queuedDurationSec = 0;
  }

  private scheduleWindow(currentSec: number, resolveUrl: (file: string) => string): void {
    if (this.scheduling) return;
    this.scheduling = true;
    const sessionId = this.sessionId;
    const windowEnd = currentSec + LOOKAHEAD_SEC;

    if (!this.mutedBase) {
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

    if (!this.mutedBgm) {
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
          void this.scheduleBgmTrack(track, windows[wi], sessionId, index, resolveUrl);
        }
      });
    }

    if (!this.mutedBase) {
      this.overlayAudioItems.forEach((o, index) => {
        const key = String(index);
        if (this.scheduledOverlayKeys.has(key)) return;
        if (!shouldScheduleEntry({ outputStart: o.start, outputEnd: o.end }, currentSec, windowEnd)) return;
        this.scheduledOverlayKeys.add(key);
        const srcEntry: TimelineEntry = {
          outputStart: o.start,
          outputEnd: o.end,
          sourceStart: o.startFrom ?? 0,
          sourceEnd: (o.startFrom ?? 0) + (o.end - o.start),
          speed: 1,
        };
        const windows = splitEntryIntoWindows(srcEntry, WINDOW_SEC);
        for (let wi = 0; wi < windows.length; wi++) {
          void this.scheduleClipEntry(o.file, windows[wi], sessionId, index, resolveUrl, this.overlaySinks, this.overlayGainNodes, this.queuedOverlayNodes, false);
        }
      });
    }

    if (!this.mutedBase) {
      this.insertAudioItems.forEach((ins, index) => {
        const key = String(index);
        if (this.scheduledInsertKeys.has(key)) return;
        if (!shouldScheduleEntry({ outputStart: ins.start, outputEnd: ins.end }, currentSec, windowEnd)) return;
        this.scheduledInsertKeys.add(key);
        const srcEntry: TimelineEntry = {
          outputStart: ins.start,
          outputEnd: ins.end,
          sourceStart: ins.startFrom ?? 0,
          sourceEnd: (ins.startFrom ?? 0) + (ins.end - ins.start),
          speed: 1,
        };
        const windows = splitEntryIntoWindows(srcEntry, WINDOW_SEC);
        for (let wi = 0; wi < windows.length; wi++) {
          void this.scheduleClipEntry(ins.file, windows[wi], sessionId, index, resolveUrl, this.insertSinks, this.insertGainNodes, this.queuedInsertNodes, false);
        }
      });
    }

    this.scheduling = false;
  }

  private trackNode(
    node: AudioBufferSourceNode,
    dur: number,
    set: Set<AudioBufferSourceNode>,
  ): void {
    set.add(node);
    this._queuedDurationSec += dur;
    node.addEventListener("ended", () => {
      node.disconnect();
      set.delete(node);
      this._queuedDurationSec -= dur;
    });
  }

  queuedNodeCount(): number {
    return this.queuedBaseNodes.size + this.queuedBgmNodes.size + this.queuedOverlayNodes.size + this.queuedInsertNodes.size;
  }

  scheduledOutputSec(): number {
    return this._queuedDurationSec;
  }

  /** 現在の mapping(読み取り専用。R4 Phase4: reseek() の検証・デバッグ用) */
  getMapping(): ClockMapping {
    return this.mapping;
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
    this.trackNode(node, buffer.duration, this.queuedBaseNodes);
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
    this.trackNode(node, buffer.duration, this.queuedBgmNodes);
  }

  private async scheduleClipEntry(
    file: string,
    entry: TimelineEntry,
    sessionId: number,
    index: number,
    resolveUrl: (file: string) => string,
    sinks: Map<string, { input: InstanceType<typeof Input>; sink: AudioBufferSink }>,
    gainNodes: Map<number, GainNode>,
    queuedSet: Set<AudioBufferSourceNode>,
    applyRate: boolean,
  ): Promise<void> {
    if (sessionId !== this.sessionId) return;
    const gainNode = gainNodes.get(index);
    if (!gainNode) return;
    let cached = sinks.get(file);
    if (!cached) {
      const sink = await this.ensureClipSink(file, resolveUrl, sinks);
      if (!sink) return;
      cached = sinks.get(file);
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
    if (applyRate) {
      const rate = this.mapping.rate ?? 1;
      if (rate !== 1) node.playbackRate.value = rate;
    }
    node.connect(gainNode);

    const startAt = contextTimeForOutputSec(this.mapping, entry.outputStart);
    if (startAt >= this.audioContext.currentTime) {
      node.start(startAt, 0);
    } else {
      const offset = this.audioContext.currentTime - startAt;
      if (offset < buffer.duration) node.start(this.audioContext.currentTime, offset);
      else return;
    }
    this.trackNode(node, buffer.duration, queuedSet);
  }

  /** マスター音量を即時反映する(0..1。EnginePreview の setVolume 用) */
  setVolume(v: number): void {
    this.masterGain.gain.value = v;
  }

  setMute(muteBase: boolean, muteBgm: boolean): void {
    if (muteBase && !this.mutedBase) {
      for (const nodes of [this.queuedBaseNodes, this.queuedInsertNodes]) {
        for (const node of nodes) {
          try { node.stop(); } catch {}
          node.disconnect();
        }
        nodes.clear();
      }
      this._queuedDurationSec = 0;
    }
    if (!muteBase) {
      this.scheduledBaseKeys.clear();
      this.scheduledInsertKeys.clear();
    }
    if (muteBgm && !this.mutedBgm) {
      for (const node of this.queuedBgmNodes) {
        try { node.stop(); } catch {}
        node.disconnect();
      }
      this.queuedBgmNodes.clear();
      this._queuedDurationSec = 0;
    }
    if (!muteBgm) this.scheduledBgmKeys.clear();
    this.mutedBase = muteBase;
    this.mutedBgm = muteBgm;
  }

  dispose(): void {
    this.stop();
    this.baseInput?.dispose();
    this.baseInput = null;
    this.baseSink = null;
    for (const { input } of this.bgmSinks.values()) input.dispose();
    for (const { input } of this.overlaySinks.values()) input.dispose();
    for (const { input } of this.insertSinks.values()) input.dispose();
    this.bgmSinks.clear();
    this.overlaySinks.clear();
    this.insertSinks.clear();
    this.masterGain.disconnect();
  }
}
