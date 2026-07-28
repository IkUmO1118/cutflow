// src/engine/runtime/clock.ts — 音マスターの提示クロック(M3a Phase4)。
// AudioContext.currentTime を正として出力秒を算出し、rAF ごとに
// 「その時刻の descriptor を要求→前回の描画がまだ終わっていなければ
// 据え置き（=ドロップ）」を行う。ドロップ数・提示間隔は計測カウンタに残す
// (§4 Phase5 で headless 計測に使う)。
//
// ブラウザ専用(AudioContext・requestAnimationFrame 前提)。
export interface ClockMapping {
  startOutputSec: number;
  startContextTime: number;
}

/** 直近の提示間隔を固定長のリングバッファで保持する(p50/p95 計算用。
 * 際限なく伸びないよう上限を設ける) */
const INTERVAL_HISTORY_LIMIT = 600; // 60fps 想定で約10秒分

export interface PresentationStats {
  presentedFrames: number;
  droppedFrames: number;
  lastIntervalMs: number;
  /** 直近 INTERVAL_HISTORY_LIMIT 件の提示間隔(ms)。p50/p95 は呼び出し側で算出 */
  intervalsMs: number[];
}

/** 1フレーム分の提示処理。descriptor 要求→合成までを行い、実際に
 * 描画した(=ドロップしなかった)かを呼び出し側の都合で判定して返す。
 * ここでは常に true を期待する(据え置き判定は Clock 側の in-flight
 * ガードで行うため。個別の onFrame が独自に false を返す余地は残す) */
export type PresentFrame = (outputSec: number) => Promise<void>;

export class PresentationClock {
  private readonly audioContext: AudioContext;
  private readonly onFrame: PresentFrame;
  private playing = false;
  private pausedAtSec = 0;
  private mapping: ClockMapping = { startOutputSec: 0, startContextTime: 0 };
  private rafHandle: number | null = null;
  private lastTickMs: number | null = null;
  private rendering = false;

  readonly stats: PresentationStats = {
    presentedFrames: 0,
    droppedFrames: 0,
    lastIntervalMs: 0,
    intervalsMs: [],
  };

  constructor(audioContext: AudioContext, onFrame: PresentFrame) {
    this.audioContext = audioContext;
    this.onFrame = onFrame;
  }

  /** 音がマスター: 再生中は AudioContext.currentTime から算出する。
   * 一時停止中は最後に確定した秒をそのまま返す */
  currentOutputSec(): number {
    if (!this.playing) return this.pausedAtSec;
    return this.mapping.startOutputSec + (this.audioContext.currentTime - this.mapping.startContextTime);
  }

  getMapping(): ClockMapping {
    return this.mapping;
  }

  seek(sec: number): void {
    this.pausedAtSec = sec;
    if (this.playing) {
      this.mapping = { startOutputSec: sec, startContextTime: this.audioContext.currentTime };
    }
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.mapping = { startOutputSec: this.pausedAtSec, startContextTime: this.audioContext.currentTime };
    this.lastTickMs = null;
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAtSec = this.currentOutputSec();
    this.playing = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private tick = (): void => {
    if (!this.playing) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    const now = performance.now();
    if (this.lastTickMs !== null) {
      const interval = now - this.lastTickMs;
      this.stats.lastIntervalMs = interval;
      this.stats.intervalsMs.push(interval);
      if (this.stats.intervalsMs.length > INTERVAL_HISTORY_LIMIT) this.stats.intervalsMs.shift();
    }
    this.lastTickMs = now;

    // 前回の合成がまだ終わっていない=ドロップ(遅れた映像フレームは
    // 描かず捨てる。§2 不変条件)。新しい合成を重ねて開始しない
    if (this.rendering) {
      this.stats.droppedFrames++;
      return;
    }

    this.rendering = true;
    this.stats.presentedFrames++;
    void this.onFrame(this.currentOutputSec()).finally(() => {
      this.rendering = false;
    });
  };

  dispose(): void {
    this.pause();
  }
}
