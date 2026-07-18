import { logStage } from "./obs.ts";

/** timed/timedSync が計測した1件(成功/失敗を問わず送る)。render.report.json の
 *  stages 収集に使う(sink が無ければ何もしない=既存挙動とバイト等価) */
export interface TimingEvent {
  label: string;
  ms: number;
  ok: boolean;
}

/** 現在アクティブな計測シンク(render() が実行中だけ設定する)。
 *  null のときは従来どおり何もしない = 既存挙動とバイト等価 */
let sink: ((e: TimingEvent) => void) | null = null;

export function setTimingSink(fn: (e: TimingEvent) => void): void {
  sink = fn;
}

export function clearTimingSink(): void {
  sink = null;
}

/** 処理区間の所要時間を計測してログに出す(render の内訳表示など)。
 *  obs 経由(stderr・stage kind)で出すので stdout 純度は不変。
 *  加えて sink が設定されていれば成功/失敗を問わず TimingEvent を渡す */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let ok = true;
  try {
    const result = await fn();
    return result;
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    const ms = Date.now() - started;
    if (ok) logStage(label, undefined, ms);
    if (sink) sink({ label, ms, ok });
  }
}

/** 同期処理向けの timed。成功時だけ計測ログを出す意味論も timed と揃える。 */
export function timedSync<T>(label: string, fn: () => T): T {
  const started = Date.now();
  let ok = true;
  try {
    const result = fn();
    return result;
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    const ms = Date.now() - started;
    if (ok) logStage(label, undefined, ms);
    if (sink) sink({ label, ms, ok });
  }
}
