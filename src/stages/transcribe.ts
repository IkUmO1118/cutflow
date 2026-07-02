import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest, Transcript, TranscriptSegment } from "../types.ts";

/** whisper.cpp の JSON 出力(-oj)の必要部分 */
interface WhisperJson {
  transcription: Array<{
    offsets: { from: number; to: number };
    text: string;
  }>;
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
    "-oj",          // JSON 出力
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
