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
  /** 再生速度倍率。省略時1(等速)。M3b で追加(playbackRate 対応) */
  rate?: number;
}

/** mapping + 現在の AudioContext 時刻から出力秒を算出する純関数
 * (rate 対応。rate 省略時は従来どおり等速)。テスト用に切り出す */
export function outputSecFromMapping(mapping: ClockMapping, contextTime: number): number {
  return mapping.startOutputSec + (contextTime - mapping.startContextTime) * (mapping.rate ?? 1);
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
  /** 描画の詰まりで強制復帰した回数(R4 Phase5)。0 が理想。0 でなければ
   * 詰まりが実在する証拠なので、回数と発生位置を計測して報告する(§3) */
  forcedResets: number;
  /** 直近の強制復帰までにかかった詰まり時間(ms)。強制復帰が一度も
   * 無ければ 0 */
  lastStallMs: number;
}

/** 描画が詰まってから強制復帰すべきかを決める純関数(§4 Phase5「検証」で
 * 固定する)。stallMs を超えて rendering 状態が続いていたら true */
export function shouldForceReset(renderStartedMs: number, nowMs: number, stallMs: number): boolean {
  return nowMs - renderStartedMs > stallMs;
}

/** 描画の詰まりを検知する閾値(ms)。通常の1フレームは数〜数十msで終わる
 * ため、1000ms は「本当に詰まった」判定として十分保守的(誤検知で
 * 正常なフレームを打ち切らない)一方、詰まったままにはしない値 */
const STALL_MS = 1000;

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
  private rate = 1;
  private mapping: ClockMapping = { startOutputSec: 0, startContextTime: 0, rate: 1 };
  private rafHandle: number | null = null;
  private lastTickMs: number | null = null;
  /** 現在 in-flight な描画の世代トークン。null なら空き(§2 決定6: 真偽値
   * ではなく世代トークンにして、強制復帰後に来る「古い」finally() が
   * 新しい in-flight 状態を誤ってクリアしないようにする) */
  private activeGeneration: number | null = null;
  private renderGenerationCounter = 0;
  /** 現在 in-flight な描画が始まった時刻(performance.now()。強制復帰の
   * 詰まり時間判定に使う。activeGeneration が null なら無効) */
  private renderStartedMs: number | null = null;

  readonly stats: PresentationStats = {
    presentedFrames: 0,
    droppedFrames: 0,
    lastIntervalMs: 0,
    intervalsMs: [],
    forcedResets: 0,
    lastStallMs: 0,
  };

  constructor(audioContext: AudioContext, onFrame: PresentFrame) {
    this.audioContext = audioContext;
    this.onFrame = onFrame;
  }

  /** 音がマスター: 再生中は AudioContext.currentTime から算出する。
   * 一時停止中は最後に確定した秒をそのまま返す */
  currentOutputSec(): number {
    if (!this.playing) return this.pausedAtSec;
    return outputSecFromMapping(this.mapping, this.audioContext.currentTime);
  }

  getMapping(): ClockMapping {
    return this.mapping;
  }

  seek(sec: number): void {
    this.pausedAtSec = sec;
    if (this.playing) {
      this.mapping = { startOutputSec: sec, startContextTime: this.audioContext.currentTime, rate: this.rate };
    }
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.mapping = {
      startOutputSec: this.pausedAtSec,
      startContextTime: this.audioContext.currentTime,
      rate: this.rate,
    };
    this.lastTickMs = null;
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /** 再生速度を変更する。再生中は現在秒を保ったまま mapping を切り直す
   * (音声側は AudioScheduler.start が呼び直され、その予約時刻計算も
   * 同じ rate を使う=映像・音声が同じ倍率で進む) */
  setRate(rate: number): void {
    if (this.playing) {
      const sec = this.currentOutputSec();
      this.rate = rate;
      this.mapping = { startOutputSec: sec, startContextTime: this.audioContext.currentTime, rate };
    } else {
      this.rate = rate;
    }
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
    if (this.activeGeneration !== null) {
      if (this.renderStartedMs !== null && shouldForceReset(this.renderStartedMs, now, STALL_MS)) {
        // 詰まりを黙って直さない(§2 決定6): 強制復帰の事実と時間を必ず記録する。
        // 古い in-flight の finally() は自分の世代トークンが現行と一致しない
        // ため、後から解決してもこの状態を壊さない
        this.stats.forcedResets++;
        this.stats.lastStallMs = now - this.renderStartedMs;
        console.warn(
          `PresentationClock: 描画が${this.stats.lastStallMs.toFixed(0)}ms詰まったため強制復帰します` +
            `(forcedResets=${this.stats.forcedResets})`,
        );
        this.activeGeneration = null;
        this.renderStartedMs = null;
        // このtickでそのまま次フレームの描画を開始する(下続く)
      } else {
        this.stats.droppedFrames++;
        return;
      }
    }

    const myGeneration = ++this.renderGenerationCounter;
    this.activeGeneration = myGeneration;
    this.renderStartedMs = now;
    this.stats.presentedFrames++;
    void this.onFrame(this.currentOutputSec()).finally(() => {
      if (this.activeGeneration === myGeneration) {
        this.activeGeneration = null;
        this.renderStartedMs = null;
      }
    });
  };

  dispose(): void {
    this.pause();
  }
}
