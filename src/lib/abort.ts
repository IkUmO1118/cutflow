/** 協調的な中断(cooperative cancellation)の最小部品。
 * 重いジョブは「あらかじめ決めた seam でだけ」これを呼んで中断する。
 * 書き込みの途中では呼ばないこと(半端なファイルを残さないため) */
export class AbortedError extends Error {
  constructor(message = "処理を中止しました") {
    super(message);
    this.name = "AbortedError";
  }
}

/** signal が未指定なら何もしない(= 呼び出し側の既存挙動は完全に不変) */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}
