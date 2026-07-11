// lib/words.ts — 語タイムスタンプ(transcript.json の segment.words[])の
// 資産化状態を判定する純関数(§W0 docs/plans/2026-07-11-d7-w0-implementation-design.md)

import type { Transcript } from "../types.ts";

/** transcript が語タイムスタンプ(words[])を1つでも持つか。
 * 章テロップ等の合成 segment は words を持たないので、
 * 「発話 segment のどれかが words を持つ」を基準にする(緩め=false positive を避ける)。 */
export function transcriptHasWords(transcript: Transcript): boolean {
  return transcript.segments.some(
    (s) => Array.isArray(s.words) && s.words.length > 0,
  );
}
