import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readEditSnapshot } from "../src/lib/renderSnapshot.ts";
import {
  normalizeReviewSpec,
  sliceReviewContext,
  validateReviewSpec,
  type EditSnapshot,
} from "../src/lib/review.ts";
import { reviewEdit } from "../src/stages/review.ts";
import type { Config } from "../src/lib/config.ts";

async function withTmpProject(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-review-"));
  const write = (file: string, data: unknown): void => {
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
  };
  write("manifest.json", {
    source: "raw.mp4",
    durationSec: 40,
    video: {
      width: 1920,
      height: 1080,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-09T00:00:00Z",
    layout: "plain",
  });
  write("cutplan.json", {
    approved: false,
    segments: [
      { id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "a" },
      { id: "seg_bbbbbb", start: 10, end: 20, action: "cut", reason: "b" },
      { id: "seg_cccccc", start: 20, end: 35, action: "keep", reason: "c" },
    ],
  });
  write("transcript.json", {
    language: "ja",
    model: "test",
    segments: [
      { id: "cap_aaaaaa", start: 2, end: 4, text: "first caption" },
      { id: "cap_bbbbbb", start: 24, end: 26, text: "second caption" },
    ],
  });
  write("overlays.json", {
    blurs: [{ id: "bl_aaaaaa", start: 22, end: 28, rect: { x: 10, y: 20, w: 30, h: 40 } }],
  });
  write("approvals.json", { cutplan: { approvedAt: "2026-07-09T00:00:00Z", keepsHash: "x" } });
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cfg = {
  render: {
    wipeWidthPx: 480,
    wipeMarginPx: 32,
    captionFontSizePx: 52,
    chapterCardSec: 3,
    targetLufs: -14,
    bgm: { volumeDb: -22, fadeOutSec: 2 },
  },
  detect: {
    silenceDb: -35,
    minSilenceSec: 0.5,
  },
  av: {
    everySec: 2,
    windowSec: 2,
    cols: 4,
    stripWidthPx: 1200,
    freeze: { noiseDb: -50, durationSec: 2 },
    scdetThreshold: 10,
  },
} as Config;

test("normalizeReviewSpec: frame/clip 上限を clamp する", () => {
  const normalized = normalizeReviewSpec({
    range: { axis: "source", startSec: 0, endSec: 120 },
    frames: Array.from({ length: 9 }, (_, i) => ({
      axis: "source" as const,
      atSec: i * 2,
      reason: `f${i}`,
      ocr: true,
    })),
    clip: {
      range: { axis: "source", startSec: 0, endSec: 80 },
    },
    observations: { ocr: true },
  }, {
    sourceDurationSec: 100,
    baseOutputDurationSec: 30,
    candidateOutputDurationSec: 28,
  });

  assert.equal(normalized.frames.length, 8);
  assert.equal(normalized.clip?.range.endSec, 55);
  assert.equal(normalized.range.endSec - normalized.range.startSec, 60);
  assert.equal(normalized.frames.filter((frame) => frame.ocr).length, 4);
  assert.ok(normalized.warnings.length >= 3);
});

test("validateReviewSpec: observations は boolean 以外を拒否する", () => {
  const problems = validateReviewSpec({
    frames: [{ axis: "source", atSec: 1, reason: "caption" }],
    observations: { motion: "yes" as never, sound: 1 as never },
  });
  assert.deepEqual(
    problems.map((problem) => problem.where),
    ["observations.motion", "observations.sound"],
  );
});

test("sliceReviewContext: selectedIds と playhead から bounded range を作る", () => {
  const projection = {
    schemaVersion: 1,
    source: { file: "raw.mp4", durationSec: 40, layout: "plain", video: {}, audio: {} },
    summary: {},
    keeps: [
      { index: 0, start: 0, end: 10, durationSec: 10, outStart: 0, outEnd: 10 },
      { index: 1, start: 20, end: 35, durationSec: 15, outStart: 10, outEnd: 25 },
    ],
    cuts: [],
    captions: [
      { id: "cap_aaaaaa", index: 0, start: 2, end: 4, text: "a", track: 1, out: [], keepIndex: 0, visible: true },
      { id: "cap_bbbbbb", index: 1, start: 24, end: 26, text: "b", track: 1, out: [], keepIndex: 1, visible: true },
    ],
    overlays: {
      materials: [],
      inserts: [],
      wipeFull: [],
      zooms: [],
      blurs: [{ id: "bl_aaaaaa", start: 22, end: 28, rect: { x: 0, y: 0, w: 1, h: 1 }, out: [] }],
      hideCaption: [],
      colorFilter: null,
      layerOrder: null,
      captionTracks: [],
    },
    chapters: [],
    meta: { titles: [], description: "" },
    bgm: { source: "none" },
    shorts: [],
  } as never;

  const selected = sliceReviewContext(projection, {
    scope: "selection",
    selectedIds: ["bl_aaaaaa"],
  });
  assert.deepEqual(selected.sourceRange, { startSec: 20, endSec: 30 });
  assert.ok(selected.frameCandidates.some((frame) => frame.reason === "selected-object"));

  const playhead = sliceReviewContext(projection, {
    scope: "playhead",
    playheadSec: 8,
  });
  assert.deepEqual(playhead.sourceRange, { startSec: 2, endSec: 14 });
});

test("reviewEdit: editable files と approval を変えずに review.probe を生成する", async () => {
  await withTmpProject(async (dir) => {
    const transcriptBefore = statSync(join(dir, "transcript.json")).mtimeMs;
    const approvalsBefore = readFileSync(join(dir, "approvals.json"), "utf8");
    const base = readEditSnapshot(dir);
    const candidate: EditSnapshot = {
      ...base,
      cutplan: {
        approved: false,
        segments: [
          { start: 0, end: 8, action: "keep", reason: "tighten" },
          { start: 8, end: 22, action: "cut", reason: "cut" },
          { start: 22, end: 35, action: "keep", reason: "keep" },
        ],
      },
      transcript: {
        ...base.transcript,
        segments: [
          { id: "cap_aaaaaa", start: 2, end: 4, text: "changed caption" },
          { id: "cap_bbbbbb", start: 24, end: 26, text: "second caption" },
        ],
      },
    };
    const bundle = await reviewEdit(dir, cfg, base, candidate, {
      frames: [
        { axis: "source", atSec: 2, reason: "caption", ocr: true },
        { axis: "source", atSec: 24, reason: "late" },
      ],
      clip: {
        range: { axis: "source", startSec: 0, endSec: 80 },
      },
      observations: { motion: true, sound: true, ocr: true },
    }, {
      hooks: {
        async renderStill({ side, outFile, outSec }) {
          writeFileSync(outFile, `${side}:${outSec}`);
        },
        async renderClip({ side, outFile }) {
          if (side === "after") throw new Error("clip failed");
          writeFileSync(outFile, "clip");
        },
        async analyzeMotion() {
          return { sceneChanges: 1, frozenSec: 0, meanSceneScore: 0.2 };
        },
        async analyzeSound() {
          return { integratedLufs: -16, truePeakDbtp: -1, silenceSec: 0.5, clippingSamples: 0 };
        },
        async runOcr() {
          return { text: "changed caption", lines: [{ text: "changed caption", confidence: 1, box: { x: 0, y: 0, w: 10, h: 10 } }], image: { w: 1920, h: 1080 } };
        },
      },
    });

    assert.equal(bundle.stills.length, 2);
    assert.ok(bundle.warnings.some((warning) => warning.includes("clip failed")));
    assert.ok(existsSync(join(dir, "review.probe", "index.json")));
    assert.equal(statSync(join(dir, "transcript.json")).mtimeMs, transcriptBefore);
    assert.equal(readFileSync(join(dir, "approvals.json"), "utf8"), approvalsBefore);
  });
});
