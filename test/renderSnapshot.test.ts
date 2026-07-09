import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES } from "../src/lib/profile.ts";
import {
  buildSnapshotRenderProps,
  readEditSnapshot,
  resolveSnapshotRenderContext,
} from "../src/lib/renderSnapshot.ts";
import type { Config } from "../src/lib/config.ts";
import type { EditSnapshot } from "../src/lib/review.ts";

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-render-snapshot-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 40,
      video: {
        width: 1920,
        height: 1080,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      },
      layout: "plain",
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [
        { id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "a" },
        { id: "seg_bbbbbb", start: 10, end: 20, action: "cut", reason: "b" },
        { id: "seg_cccccc", start: 20, end: 30, action: "keep", reason: "c" },
      ],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [
        { id: "cap_aaaaaa", start: 2, end: 4, text: "base caption" },
        { id: "cap_bbbbbb", start: 22, end: 24, text: "later caption" },
      ],
    });
    write("overlays.json", {});
    mkdirSync(join(dir, "materials"), { recursive: true });
    writeFileSync(join(dir, "materials", "pip.png"), "");
    fn(dir);
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
} as Config;

test("buildSnapshotRenderProps: candidate caption/overlay/blur/annotation をディスク書き換えなしで反映する", () => {
  withTmpProject((dir) => {
    const diskBefore = readFileSync(join(dir, "transcript.json"), "utf8");
    const snapshot: EditSnapshot = {
      cutplan: readEditSnapshot(dir).cutplan,
      transcript: {
        language: "ja",
        model: "test",
        segments: [{ id: "cap_aaaaaa", start: 2, end: 4, text: "candidate caption" }],
      },
      overlays: {
        overlays: [{ start: 1, end: 5, file: "materials/pip.png" }],
        blurs: [{ start: 2, end: 3, rect: { x: 10, y: 20, w: 30, h: 40 } }],
        annotations: [{
          start: 2,
          end: 3,
          type: "box",
          rect: { x: 20, y: 30, w: 40, h: 50 },
        }],
      },
      bgm: null,
      shorts: null,
    };

    const props = buildSnapshotRenderProps({ dir, cfg, snapshot });
    assert.equal(props.captions[0]?.text, "candidate caption");
    assert.equal(props.overlays[0]?.file, "materials/pip.png");
    assert.deepEqual(props.blurs?.[0]?.rect, { x: 10, y: 20, w: 30, h: 40 });
    assert.equal(props.annotations?.[0]?.type, "box");
    assert.equal(readFileSync(join(dir, "transcript.json"), "utf8"), diskBefore);
  });
});

test("buildSnapshotRenderProps: candidate cutplan の keep 集合で output 写像が変わる", () => {
  withTmpProject((dir) => {
    const base = readEditSnapshot(dir);
    const propsA = buildSnapshotRenderProps({ dir, cfg, snapshot: base });
    const snapshotB: EditSnapshot = {
      ...base,
      cutplan: {
        approved: false,
        segments: [
          { start: 0, end: 5, action: "keep", reason: "a" },
          { start: 5, end: 25, action: "cut", reason: "b" },
          { start: 25, end: 30, action: "keep", reason: "c" },
        ],
      },
    };
    const propsB = buildSnapshotRenderProps({ dir, cfg, snapshot: snapshotB });
    assert.equal(propsA.durationSec, 20);
    assert.equal(propsB.durationSec, 10);
    assert.deepEqual(
      { start: propsA.captions[1]?.start, end: propsA.captions[1]?.end },
      { start: 12, end: 14 },
    );
    assert.deepEqual(
      { start: propsB.captions[0]?.start, end: propsB.captions[0]?.end },
      { start: 2, end: 4 },
    );
  });
});

test("resolveSnapshotRenderContext: short snapshot をメモリ上 docs から解決できる", () => {
  withTmpProject((dir) => {
    const snapshot: EditSnapshot = {
      ...readEditSnapshot(dir),
      shorts: {
        shorts: [{
          name: "intro",
          approved: false,
          profile: "vertical",
          ranges: [{ start: 20, end: 30 }],
          captionTracks: [{ track: 1, x: 540, y: 1400 }],
        }],
      },
    };

    const ctx = resolveSnapshotRenderContext({ dir, cfg, snapshot, shortName: "intro" });
    assert.equal(ctx.props.durationSec, 10);
    assert.deepEqual(ctx.profile, PROFILES.vertical);
    assert.deepEqual(ctx.props.captionDefaultPos, {
      x: PROFILES.vertical.layout?.caption?.x ?? 540,
      y: PROFILES.vertical.layout?.caption?.y ?? 1560,
      anchor: "center",
    });
    assert.equal(ctx.props.captions.length, 1);
    assert.equal(ctx.props.captions[0]?.text, "later caption");
    assert.deepEqual(ctx.props.captions[0]?.pos, { x: 540, y: 1400 });
  });
});

test("buildSnapshotRenderProps: recording root 外 media path を拒否する", () => {
  withTmpProject((dir) => {
    const snapshot: EditSnapshot = {
      ...readEditSnapshot(dir),
      overlays: {
        overlays: [{ start: 1, end: 2, file: "../secret.png" }],
      },
    };
    assert.throws(
      () => buildSnapshotRenderProps({ dir, cfg, snapshot }),
      /収録フォルダ外/,
    );
  });
});
