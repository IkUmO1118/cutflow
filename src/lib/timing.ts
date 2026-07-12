import { logStage } from "./obs.ts";

/** 処理区間の所要時間を計測してログに出す(render の内訳表示など)。
 *  obs 経由(stderr・stage kind)で出すので stdout 純度は不変 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await fn();
  logStage(label, undefined, Date.now() - started);
  return result;
}
