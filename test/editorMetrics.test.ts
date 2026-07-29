// lib/editorMetrics.ts — POST /metrics の保存先パス組み立て。
// recording はクライアント POST body 由来の未信頼値なので、パス区切りを
// 含む値やパストラバーサルを狙った値でも収録フォルダ外に閉じ込められること、
// 追記が実際に ~/.cutflow/editor/metrics/ 配下へ JSONL 行として起きることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendMetricsBatch,
  metricsFilePath,
  metricsStateDir,
  sanitizeRecordingName,
} from "../src/lib/editorMetrics.ts";

test("sanitizeRecordingName: 通常の収録フォルダ名はそのまま", () => {
  assert.equal(sanitizeRecordingName("2026-07-02-whisper-bench"), "2026-07-02-whisper-bench");
});

test("sanitizeRecordingName: パス区切りは _ に潰す(パストラバーサル対策)", () => {
  assert.equal(sanitizeRecordingName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeRecordingName("a/b\\c"), "a_b_c");
});

test("sanitizeRecordingName: 非文字列・空文字は unknown に落ちる", () => {
  assert.equal(sanitizeRecordingName(undefined), "unknown");
  assert.equal(sanitizeRecordingName(null), "unknown");
  assert.equal(sanitizeRecordingName(123), "unknown");
  assert.equal(sanitizeRecordingName("   "), "unknown");
});

test("metricsFilePath: metricsStateDir 配下に <recording>.jsonl を組み立てる", () => {
  assert.equal(
    metricsFilePath("rec1"),
    join(metricsStateDir(), "rec1.jsonl"),
  );
});

test("appendMetricsBatch: JSONL として1行ずつ追記される(未信頼な recording も安全化される)", () => {
  // metricsStateDir は ~/.cutflow/editor/metrics 固定(homedir 依存)なので、
  // ここでは実際に書かれたファイルを読み、後片付けで消す
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = metricsFilePath(sanitizeRecordingName(marker));
  try {
    appendMetricsBatch(marker, { a: 1 });
    appendMetricsBatch(marker, { a: 2 });
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { a: 2 });
  } finally {
    rmSync(path, { force: true });
  }
});
