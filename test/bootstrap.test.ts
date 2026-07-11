// stages/bootstrap.ts が動画だけの収録フォルダに書く初期 transcript /
// cutplan が、stages/validate.ts の検査(validateDocs)を通ることを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapProjectWithLayout, emptyTranscript, initialCutplan } from "../src/stages/bootstrap.ts";
import { validateDocs } from "../src/stages/validate.ts";
import type { Config } from "../src/lib/config.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

const DIR = "/tmp/cutflow-test";

function baseDocs(over: Partial<LoadedDocs> = {}): LoadedDocs {
  return {
    manifest: { durationSec: 100 },
    cutplan: initialCutplan(100),
    transcript: emptyTranscript(),
    overlays: {},
    bgm: null,
    chapters: null,
    meta: null,
    shorts: null,
    thumbnail: null,
    ...over,
  };
}

test("初期 transcript(空)は validateDocs を通る", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
});

test("初期 cutplan(全編 keep)は validateDocs を通る", () => {
  const r = validateDocs(DIR, baseDocs());
  assert.deepEqual(r.errors, []);
  assert.equal(initialCutplan(100).segments[0].end, 100);
  assert.equal(initialCutplan(100).approved, false);
});

test("bootstrapProjectWithLayout: 既存 manifest と明示 layout が食い違うと拒否する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-bootstrap-layout-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      durationSec: 10,
      layout: "plain",
      video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
      audio: { micStream: 0, systemStream: null, micWav: "audio/mic.wav" },
    }, null, 2));
    await assert.rejects(
      () => bootstrapProjectWithLayout(dir, cfg(), "obs-canvas"),
      /manifest\.json は既に plain として作成済み/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cfg(): Config {
  return {
    recordingsDir: "/tmp",
    ingest: {
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
      micTrack: 1,
      systemTrack: 2,
    },
    whisper: { bin: "whisper-cli", model: "model.bin", language: "ja" },
    detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.4 },
    plan: { targetMinutes: 10 },
    preview: { width: 1280 },
    render: {
      wipeWidthPx: 480,
      wipeMarginPx: 32,
      captionFontSizePx: 52,
      chapterCardSec: 3,
      targetLufs: -14,
      bgm: { volumeDb: -22, fadeOutSec: 2 },
    },
  };
}
