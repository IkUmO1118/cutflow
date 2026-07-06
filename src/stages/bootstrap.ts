import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findSource } from "../lib/findSource.ts";
import { ingest } from "./ingest.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Manifest, Transcript } from "../types.ts";

/** transcript.json が無いときに書く初期値。何も文字起こししていない状態 */
export function emptyTranscript(): Transcript {
  return { segments: [] } as unknown as Transcript;
}

/** cutplan.json が無いときに書く初期値。全編を keep のまま人間の編集を待つ */
export function initialCutplan(durationSec: number): CutPlan {
  return {
    approved: false,
    segments: [
      { action: "keep", start: 0, end: durationSec, reason: "初期状態(全編)" },
    ],
  };
}

/**
 * editor <dir> 起動時のブートストラップ。動画ファイルだけの収録フォルダでも
 * 開けるように、必須3ファイル(manifest/transcript/cutplan)のうち無いものだけ
 * を決定的に補う。既にあるファイルには一切触れない。whisper/LLM は呼ばない
 * (transcribe / plan は明示的な CLI 実行に任せる)。
 */
export async function bootstrapProject(dir: string, cfg: Config): Promise<void> {
  const manifestPath = join(dir, "manifest.json");
  let manifest: Manifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } else {
    console.log("manifest.json が無いため ingest を実行します(動画を解析)...");
    manifest = await ingest(dir, findSource(dir), cfg);
  }

  const transcriptPath = join(dir, "transcript.json");
  if (!existsSync(transcriptPath)) {
    writeFileSync(transcriptPath, JSON.stringify(emptyTranscript(), null, 2));
    console.log(
      "transcript.json が無いため空で作成しました。文字起こしは " +
        "node src/cli.ts transcribe <dir>",
    );
  }

  const cutplanPath = join(dir, "cutplan.json");
  if (!existsSync(cutplanPath)) {
    writeFileSync(
      cutplanPath,
      JSON.stringify(initialCutplan(manifest.durationSec), null, 2),
    );
    console.log(
      "cutplan.json が無いため全編 keep で作成しました。カット案は " +
        "node src/cli.ts plan <dir>(または run)",
    );
  }
}
