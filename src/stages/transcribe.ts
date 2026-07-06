import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest, Transcript, TranscriptSegment, WordTiming } from "../types.ts";

/** whisper.cpp の -ojf(output-json-full)の token 1件。-oj でも -ojf でも
 * segment(offsets/text)は同一(実測で確認済み)。tokens[] は -ojf のときだけ付く */
export interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  /** 確信度(0..1)。無いケースは未確認だが防御的に省略可扱いにする */
  p?: number;
}

/** whisper.cpp の JSON 出力(-oj / -ojf)の必要部分 */
interface WhisperJson {
  transcription: Array<{
    offsets: { from: number; to: number };
    text: string;
    /** -ojf のときだけ付く(-oj には無い) */
    tokens?: WhisperToken[];
  }>;
}

/** 角括弧で囲まれた whisper の特殊トークン([_BEG_] / [_TT_441] 等) */
const isSpecialToken = (text: string): boolean => /^\[.*\]$/.test(text);

/**
 * whisper -ojf の1 segment ぶんの tokens[] から words[](WordTiming[])を組み立てる。
 * 特殊トークン([_BEG_] 等)・trim 後空文字・ゼロ幅(from>=to)を除外し、
 * 残りは ms→秒変換して text を trim して返す。時系列順は tokens[] の順のまま
 * (whisper は昇順で出す)。tokens が無ければ空配列
 */
export function buildWords(tokens: WhisperToken[] | undefined): WordTiming[] {
  if (!tokens) return [];
  const words: WordTiming[] = [];
  for (const tok of tokens) {
    const text = tok.text.trim();
    if (text.length === 0) continue;
    if (isSpecialToken(text)) continue;
    const start = tok.offsets.from / 1000;
    const end = tok.offsets.to / 1000;
    if (!(start < end)) continue;
    const word: WordTiming = { text, start, end };
    if (typeof tok.p === "number") word.confidence = tok.p;
    words.push(word);
  }
  return words;
}

/**
 * manifest のマイク音声を whisper.cpp で文字起こしし、
 * transcript.json と transcript.srt を生成する。
 */
export async function transcribe(
  dir: string,
  cfg: Config,
): Promise<Transcript> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;

  if (!existsSync(cfg.whisper.model)) {
    throw new Error(
      `whisper モデルが見つかりません: ${cfg.whisper.model}\n` +
        `README のセットアップ手順に従ってダウンロードしてください。`,
    );
  }

  const outBase = join(dir, "whisper-out");
  await run(cfg.whisper.bin, [
    "-m", cfg.whisper.model,
    "-l", cfg.whisper.language,
    "-f", join(dir, manifest.audio.micWav),
    cfg.whisper.wordTimestamps ? "-ojf" : "-oj", // JSON 出力(-ojf は tokens[] 付き上位互換)
    "-osrt",        // 字幕(srt)も同時に出力
    "-of", outBase, // 出力ファイルのベース名
  ]);

  const whisperJson = JSON.parse(
    readFileSync(`${outBase}.json`, "utf8"),
  ) as WhisperJson;

  const segments: TranscriptSegment[] = whisperJson.transcription
    .map((t) => ({
      start: t.offsets.from / 1000,
      end: t.offsets.to / 1000,
      text: t.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  // words[] の付加は segment を組み立てた後の別ステップ(既存の text/start/end
  // 算出ロジックには一切手を触れない)。segments と同じ filter 条件(trim 後
  // 非空)で whisperJson.transcription 側を絞れば、同じ順序・同じ件数で対応する
  if (cfg.whisper.wordTimestamps) {
    const kept = whisperJson.transcription.filter((t) => t.text.trim().length > 0);
    for (let i = 0; i < segments.length; i++) {
      const words = buildWords(kept[i]?.tokens);
      if (words.length > 0) segments[i].words = words;
    }
  }

  const transcript: Transcript = {
    language: cfg.whisper.language,
    model: cfg.whisper.model,
    segments,
  };
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );
  return transcript;
}
