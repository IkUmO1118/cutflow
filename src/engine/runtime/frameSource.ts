// src/engine/runtime/frameSource.ts — 1本の動画ソース(proxy.mp4 / 素材ファイル)
// を時刻指定で取り出す層(M3a Phase2)。OpenCut services/video-cache/service.ts
// （337行）の設計——「現フレーム有効ならそのまま/少し先ならイテレータ前進/
// 遠ければ seek し直し」+ 先読み + seek 世代管理 + 要求の直列化——を写す。
//
// sink 種別は mediabunny の VideoSampleSink を使う(fork の参照ファイルは
// CanvasSink だが、母艦§9「M3a方針確定」で決めた blit 経路(crop/colorFilter/
// 色空間をこちら側で吸収する。docs/plans/2026-07-28-engine-m3a-engine-core-design.md
// §2)には生の VideoSample(≒VideoFrame)の .draw()/.drawWithFit() が要るため)。
//
// ブラウザ専用(mediabunny・DOM 前提)。src/engine/ 直下の純関数からは import
// しない(README.md の import 方向を参照)。
import { ALL_FORMATS, Input, UrlSource, VideoSample, VideoSampleSink } from "mediabunny";

/** イテレータ前進を試みる猶予(秒)。これを超えて先の時刻を要求されたら
 * reseek する。OpenCut video-cache/service.ts の `lastTime + 2.0` を踏襲 */
export const ITERATE_AHEAD_WINDOW_SEC = 2.0;

export type FrameFetchStrategy = "current" | "advance" | "reseek";

export interface FetchStrategyState {
  /** 直近に保持しているサンプルの timestamp(秒)。未取得なら null */
  currentTimestamp: number | null;
  /** 直近に保持しているサンプルの duration(秒) */
  currentDuration: number;
}

/**
 * 現在の保持状態と目標時刻から、次に取るべき戦略を決める純関数
 * (OpenCut の resolveFrame の判断部分を実際のデコード I/O から切り出した
 * もの。ここだけ実 movie 無しで単体テストできる。§4 Phase2「検証」)。
 */
export function decideFetchStrategy(
  state: FetchStrategyState,
  targetTime: number,
): FrameFetchStrategy {
  const { currentTimestamp, currentDuration } = state;
  if (
    currentTimestamp !== null &&
    targetTime >= currentTimestamp &&
    targetTime < currentTimestamp + currentDuration
  ) {
    return "current";
  }
  if (
    currentTimestamp !== null &&
    targetTime >= currentTimestamp &&
    targetTime < currentTimestamp + ITERATE_AHEAD_WINDOW_SEC
  ) {
    return "advance";
  }
  return "reseek";
}

export interface FrameSourceStats {
  seeks: number;
  advances: number;
  reuses: number;
  /** getSampleAt がタイムアウトで打ち切った回数(R4 Phase5)。0 が理想。
   * 0 でなければ decode の詰まりが実在する証拠 */
  timeouts: number;
}

/** getSampleAt の1回分の解決を待つ上限(ms)。通常の seek/advance は
 * 数十〜数百msで終わるため、3000ms は「本当に詰まった」判定として
 * 保守的な値(§4 Phase5「検証」。this.chain が永久に詰まらないようにする
 * ための安全弁で、通常経路の速さには影響しない) */
const GET_SAMPLE_TIMEOUT_MS = 3000;

/**
 * 所有権の契約(§5 落とし穴): `getSampleAt` が返す VideoSample は**呼び出し側が
 * 使い終わったら必ず close() する**(frameBlit が blit 完了直後に close する
 * ことを想定)。FrameSource は内部の `current`(自分の bookkeeping 用の
 * 別参照)を独立に保持し、呼び出し側へは常に `.clone()` を渡す
 * (mediabunny の VideoSample.clone() は VideoFrame 由来の軽量参照複製で
 * あり、ピクセルコピーではない)。こうすることで「呼び出し側が close した
 * せいで内部の再利用判定が壊れる」というエイリアシング事故を構造的に防ぐ。
 */
export class FrameSource {
  readonly sourceId: string;
  private readonly url: string;
  private input: InstanceType<typeof Input> | null = null;
  private sink: InstanceType<typeof VideoSampleSink> | null = null;
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private current: VideoSample | null = null;
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();
  readonly stats: FrameSourceStats = { seeks: 0, advances: 0, reuses: 0, timeouts: 0 };

  constructor(sourceId: string, url: string) {
    this.sourceId = sourceId;
    this.url = url;
  }

  private async ensureInit(): Promise<void> {
    if (this.sink) return;
    const input = new Input({ source: new UrlSource(this.url), formats: ALL_FORMATS });
    let track;
    try {
      track = await input.getPrimaryVideoTrack();
    } catch (e) {
      throw new Error(`frameSource: ${this.sourceId} (${this.url}) の初期化に失敗: ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!track) {
      input.dispose();
      throw new Error(`frameSource: ${this.sourceId} (${this.url}) に映像トラックが無い`);
    }
    this.input = input;
    this.sink = new VideoSampleSink(track);
  }

  /**
   * 指定秒(このソース自身の再生位置秒。CutFlow の元収録秒とは限らない——
   * 素材ファイルは素材自身の秒)のサンプルを返す。要求は直列化される
   * (同時に複数呼ばれても内部の seek/advance が競合しない)。
   */
  async getSampleAt(time: number): Promise<VideoSample | null> {
    await this.ensureInit();
    const generation = ++this.generation;
    const run = this.chain.then(async () => {
      if (generation !== this.generation) {
        // 自分より新しい要求が来ている=この結果はもう要らない。
        // 世代番号だけ進めて現在値を返す(古い結果で上書きしない)
        return this.current ? this.current.clone() : null;
      }
      const sample = await this.resolveWithTimeout(time);
      return sample ? sample.clone() : null;
    });
    // タイムアウトで reject しても this.chain 自体は必ず解決させる
    // (R4 Phase5。§落とし穴: this.chain が永久に詰まらないようにする)
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** resolve(time) が GET_SAMPLE_TIMEOUT_MS を超えて解決しないときは
   * reject して呼び出し側(getSampleAt)へ伝える。1つの未解決 Promise が
   * this.chain(直列化キュー)全体をデッドロックさせないための安全弁
   * (R4 §1.3(b))。タイムアウト時はイテレータを破棄し、次回の呼び出しが
   * 必ず reseek(sink.samples 呼び直し)から再開するようにする */
  private async resolveWithTimeout(time: number): Promise<VideoSample | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.stats.timeouts++;
        this.iterator = null;
        reject(
          new Error(
            `frameSource: ${this.sourceId} の取得が ${GET_SAMPLE_TIMEOUT_MS}ms を超えたためタイムアウトしました`,
          ),
        );
      }, GET_SAMPLE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.resolve(time), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolve(time: number): Promise<VideoSample | null> {
    const strategy = decideFetchStrategy(
      { currentTimestamp: this.current?.timestamp ?? null, currentDuration: this.current?.duration ?? 0 },
      time,
    );
    if (strategy === "current" && this.current) {
      this.stats.reuses++;
      return this.current;
    }
    if (strategy === "advance") {
      const advanced = await this.advanceTo(time);
      if (advanced) return advanced;
      // イテレータが尽きた/追いつけなかった場合は reseek にフォールバック
    }
    return this.seekTo(time);
  }

  private setCurrent(sample: VideoSample): void {
    if (this.current && this.current !== sample) this.current.close();
    this.current = sample;
  }

  private async advanceTo(time: number): Promise<VideoSample | null> {
    if (!this.iterator) return null;
    // 1回の advance で先読みしすぎない上限(暴走防止。通常は数フレームで届く)
    for (let i = 0; i < 64; i++) {
      const { value, done } = await this.iterator.next();
      if (done || !value) {
        this.iterator = null;
        return null;
      }
      this.setCurrent(value);
      this.stats.advances++;
      if (time >= value.timestamp && time < value.timestamp + value.duration) return value;
      if (value.timestamp > time + ITERATE_AHEAD_WINDOW_SEC) return null;
    }
    return null;
  }

  private async seekTo(time: number): Promise<VideoSample | null> {
    if (!this.sink) return null;
    if (this.iterator) {
      await this.iterator.return(undefined);
      this.iterator = null;
    }
    this.iterator = this.sink.samples(Math.max(0, time));
    this.stats.seeks++;
    const { value } = await this.iterator.next();
    if (!value) return null;
    this.setCurrent(value);
    return value;
  }

  /** VideoFrame リーク計測用(§6 完了基準)。close 済みなら 0 */
  get openSampleCount(): number {
    return this.current ? 1 : 0;
  }

  dispose(): void {
    if (this.iterator) void this.iterator.return(undefined);
    this.iterator = null;
    if (this.current) this.current.close();
    this.current = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}
