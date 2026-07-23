/** 再生位置の表示形式 "M:SS.ss"(分:秒.センチ秒)。例 83.4 → "1:23.40" */
export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

/**
 * fmtTime の逆関数。"M:SS.ss"(分:秒)または裸の秒数("83.4")を秒へ。
 * 解釈できない文字列・負値は null(呼び出し側は現在位置を保つ)。
 * 秒フィールドの上限は厳格に弾かない(fmtTime は丸めで "0:60.00" を出しうる)。
 */
export function parseTimecode(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  let sec: number;
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) return null;
    const [mStr, sStr] = parts;
    if (!/^\d+$/.test(mStr)) return null;
    if (!/^\d+(?:\.\d+)?$/.test(sStr)) return null;
    sec = Number(mStr) * 60 + Number(sStr);
  } else {
    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    sec = Number(s);
  }
  if (!Number.isFinite(sec) || sec < 0) return null;
  return sec;
}
