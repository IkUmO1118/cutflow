// lib/renderReport.ts — render.report.json(直近の render() 試行の構造化
// サマリ)を組み立てる RenderReportCollector とハッシュ/書込ヘルパーを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RenderReportCollector,
  RENDER_REPORT_FILE,
  RENDER_REPORT_SCHEMA_VERSION,
  hashInputSnapshot,
  writeRenderReport,
} from "../src/lib/renderReport.ts";

test("RenderReportCollector: 初期状態", () => {
  const c = new RenderReportCollector();
  assert.equal(c.status, "ok");
  assert.deepEqual(c.stages, []);
  assert.equal(c.path, null);
  assert.equal(c.fallbackReason, null);
  assert.equal(c.cutReused, false);
  assert.equal(c.finalFullSkip, false);
  assert.equal(c.changedChunkCount, null);
  assert.equal(c.chunkCount, null);
  assert.equal(c.fastCoverage, null);
  assert.equal(c.concurrency, null);
  assert.equal(c.inputHash, null);
  assert.equal(c.output, null);
  assert.equal(c.error, null);
});

test("RenderReportCollector.finish: schemaVersion は RENDER_REPORT_SCHEMA_VERSION", () => {
  const c = new RenderReportCollector();
  assert.equal(c.finish().schemaVersion, RENDER_REPORT_SCHEMA_VERSION);
});

test("recordStage: 追加した順にそのまま積む", () => {
  const c = new RenderReportCollector();
  c.recordStage({ label: "a", ms: 10, ok: true });
  c.recordStage({ label: "b", ms: 20, ok: false });
  const report = c.finish();
  assert.equal(report.stages.length, 2);
  assert.deepEqual(report.stages[0], { label: "a", ms: 10, ok: true });
  assert.deepEqual(report.stages[1], { label: "b", ms: 20, ok: false });
});

test("setPath: path を設定する", () => {
  const c = new RenderReportCollector();
  c.setPath("fast");
  assert.equal(c.finish().path, "fast");
});

test("setFallback: 最初の値だけ残す(2回目以降は無視)", () => {
  const c = new RenderReportCollector();
  c.setFallback("first reason");
  c.setFallback("second reason");
  assert.equal(c.finish().fallbackReason, "first reason");
});

test("markFailed: Error は message を、それ以外は String() を error に入れる", () => {
  const a = new RenderReportCollector();
  a.markFailed(new Error("boom"));
  const reportA = a.finish();
  assert.equal(reportA.status, "failed");
  assert.equal(reportA.error, "boom");

  const b = new RenderReportCollector();
  b.markFailed("x");
  const reportB = b.finish();
  assert.equal(reportB.status, "failed");
  assert.equal(reportB.error, "x");
});

test("finish: durationMs・startedAt・finishedAt を nowMs から計算する", () => {
  const c = new RenderReportCollector(1000);
  const report = c.finish(4000);
  assert.equal(report.durationMs, 3000);
  assert.equal(report.startedAt, new Date(1000).toISOString());
  assert.equal(report.finishedAt, new Date(4000).toISOString());
});

test("finish: 返り値は stages のコピー(finish 後に collector.stages を変えても影響しない)", () => {
  const c = new RenderReportCollector(1000);
  c.recordStage({ label: "a", ms: 1, ok: true });
  const report = c.finish(2000);
  c.stages.push({ label: "b", ms: 2, ok: true });
  assert.equal(report.stages.length, 1);
});

test("hashInputSnapshot: 決定論的・sha256: 接頭辞・入力が違えば違う値", () => {
  const a = hashInputSnapshot({ x: 1, y: [1, 2, 3] });
  const b = hashInputSnapshot({ x: 1, y: [1, 2, 3] });
  const c = hashInputSnapshot({ x: 2, y: [1, 2, 3] });
  assert.equal(a, b);
  assert.ok(a.startsWith("sha256:"));
  assert.notEqual(a, c);
});

test("writeRenderReport: アトミック書込のラウンドトリップ(.tmp が残らない)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-renderreport-"));
  try {
    const c = new RenderReportCollector(1000);
    c.setPath("full-remotion");
    const report = c.finish(2000);
    writeRenderReport(dir, report);

    const outPath = join(dir, RENDER_REPORT_FILE);
    assert.ok(existsSync(outPath));
    assert.ok(!existsSync(outPath + ".tmp"));

    const roundTripped = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(roundTripped.schemaVersion, RENDER_REPORT_SCHEMA_VERSION);
    assert.equal(roundTripped.path, "full-remotion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
