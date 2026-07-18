// render() 1回の構造化サマリを収録フォルダ直下に書く中間生成物
// (render.report.json)。採用経路(full-skip/chunk-diff/fast/full-remotion)+
// フォールバック理由・段階ごとの所要時間と成否・キャッシュヒット・
// 変更チャンク数・FAST 被覆率・実効 concurrency・入力スナップショットの
// sha256・出力プローブ・ok/failed を機械可読に残す。純ローカルの副産物で
// 外部送信しない。ショート(renderShort/renderShorts)は対象外(v1 スコープ)。
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RENDER_REPORT_FILE = "render.report.json";
export const RENDER_REPORT_SCHEMA_VERSION = 1;

/** 採用された render 経路 */
export type RenderPathKind = "full-skip" | "chunk-diff" | "fast" | "full-remotion";

/** 段階ごとの所要時間・成否(lib/timing.ts の TimingEvent をそのまま記録する) */
export interface StageTiming {
  label: string;
  ms: number;
  ok: boolean;
}

/** 出力ファイルの実測プローブ */
export interface OutputProbe {
  path: string;
  sizeBytes: number;
  durationSec: number | null;
  frameCount: number | null;
}

export interface RenderReport {
  schemaVersion: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "ok" | "failed";
  path: RenderPathKind | null;
  fallbackReason: string | null;
  cutReused: boolean;
  finalFullSkip: boolean;
  changedChunkCount: number | null;
  chunkCount: number | null;
  fastCoverage: number | null;
  concurrency: number | null;
  inputHash: string | null;
  stages: StageTiming[];
  output: OutputProbe | null;
  error: string | null;
}

/** RenderReport を組み立てる可変コレクタ。render() 内で使い捨てる
 * (finish() で不変の RenderReport を1つ作る) */
export class RenderReportCollector {
  startedAtMs: number;
  status: "ok" | "failed";
  path: RenderPathKind | null;
  fallbackReason: string | null;
  cutReused: boolean;
  finalFullSkip: boolean;
  changedChunkCount: number | null;
  chunkCount: number | null;
  fastCoverage: number | null;
  concurrency: number | null;
  inputHash: string | null;
  stages: StageTiming[];
  output: OutputProbe | null;
  error: string | null;

  constructor(nowMs: number = Date.now()) {
    this.startedAtMs = nowMs;
    this.status = "ok";
    this.path = null;
    this.fallbackReason = null;
    this.cutReused = false;
    this.finalFullSkip = false;
    this.changedChunkCount = null;
    this.chunkCount = null;
    this.fastCoverage = null;
    this.concurrency = null;
    this.inputHash = null;
    this.stages = [];
    this.output = null;
    this.error = null;
  }

  recordStage(e: StageTiming): void {
    this.stages.push(e);
  }

  setPath(p: RenderPathKind): void {
    this.path = p;
  }

  /** フォールバック理由は最初の1件だけ残す(以後の呼び出しは無視) */
  setFallback(reason: string): void {
    if (!this.fallbackReason) this.fallbackReason = reason;
  }

  markFailed(err: unknown): void {
    this.status = "failed";
    this.error = err instanceof Error ? err.message : String(err);
  }

  finish(nowMs: number = Date.now()): RenderReport {
    return {
      schemaVersion: RENDER_REPORT_SCHEMA_VERSION,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: new Date(nowMs).toISOString(),
      durationMs: nowMs - this.startedAtMs,
      status: this.status,
      path: this.path,
      fallbackReason: this.fallbackReason,
      cutReused: this.cutReused,
      finalFullSkip: this.finalFullSkip,
      changedChunkCount: this.changedChunkCount,
      chunkCount: this.chunkCount,
      fastCoverage: this.fastCoverage,
      concurrency: this.concurrency,
      inputHash: this.inputHash,
      stages: [...this.stages],
      output: this.output,
      error: this.error,
    };
  }
}

/** 任意の入力キー(renderKey 等)を安定な短い sha256 に畳む
 * (フルの JSON をそのまま保存すると冗長なため。差分検知だけが目的) */
export function hashInputSnapshot(key: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

/** render.report.json をアトミックに書く(tmp→rename) */
export function writeRenderReport(dir: string, report: RenderReport): void {
  const outPath = join(dir, RENDER_REPORT_FILE);
  const tmpPath = outPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(report, null, 2));
  renameSync(tmpPath, outPath);
}
