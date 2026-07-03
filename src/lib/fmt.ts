// 時刻の表示・解析(CLI の validate / describe / frames で共用)。
// パイプラインの JSON は常に秒の数値で持ち、m:ss.s は人間との会話用。

/** 12.3 → "0:12.3"。エラーメッセージやタイムライン要約で場所を探しやすく */
export function fmtT(sec: number): string {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = (abs - m * 60).toFixed(1).padStart(4, "0");
  return `${sign}${m}:${s}`;
}

/** "150" / "2:30" / "2:30.5" / "1:02:03" → 秒。解釈できなければ null */
export function parseT(text: string): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
