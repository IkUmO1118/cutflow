/** 処理区間の所要時間を計測してログに出す(render の内訳表示など) */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await fn();
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  ${label}: ${sec}秒`);
  return result;
}
