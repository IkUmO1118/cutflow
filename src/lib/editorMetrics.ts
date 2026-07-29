// editor/server.ts の POST /metrics が使う、プレビュー体感計測(M1)の
// 保存先パス組み立て+追記。収録フォルダには書かない(CLAUDE.md の方針どおり
// files.ts の分類に属さない実行時計測データなので、収録フォルダの外
// ~/.framewright/editor/metrics/ へ置く)。
// §docs/plans/2026-07-28-engine-m1-media-metrics-design.md Phase 2

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function metricsStateDir(): string {
  return join(homedir(), ".framewright", "editor", "metrics");
}

/**
 * recording はクライアント(POST body)由来の未信頼な文字列なので、
 * パス区切り・空文字はファイル名として使わず安全な既定値に落とす。
 */
export function sanitizeRecordingName(recording: unknown): string {
  if (typeof recording !== "string") return "unknown";
  const cleaned = recording.replace(/[/\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** recording は既に sanitizeRecordingName を通した値を渡すこと */
export function metricsFilePath(recording: string): string {
  return join(metricsStateDir(), `${recording}.jsonl`);
}

/** 1バッチ(client からの POST body そのもの)を1行として追記する。
 *  recording は body 由来の未信頼値なのでそのまま受け取り、内部で sanitize する */
export function appendMetricsBatch(recording: unknown, batch: unknown): void {
  mkdirSync(metricsStateDir(), { recursive: true });
  appendFileSync(metricsFilePath(sanitizeRecordingName(recording)), `${JSON.stringify(batch)}\n`);
}
