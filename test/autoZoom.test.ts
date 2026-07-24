// src/stages/autoZoom.ts(OpenScreen 移植・autozoom コマンドの決定論ステージ)を固定する。
// §docs/plans/2026-07-24-openscreen-autozoom-placement-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoZoom, autoZoomIfFresh, MIN_AUTO_ZOOM_SEC } from "../src/stages/autoZoom.ts";
import { CURSOR_SIDECAR_SUFFIX } from "../src/stages/record.ts";
import type { CursorSample, CursorSidecar } from "../src/stages/record.ts";
import type { Config } from "../src/lib/config.ts";
import type { Overlays } from "../src/types.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cutflow-autozoom-"));
}

/** plain レイアウト・1920x1080・全画面 screenRegion の最小 manifest/cutplan/transcript を書く */
function buildFixture(dir: string, durationSec: number): void {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      source: "raw.mkv",
      durationSec,
      layout: "plain",
      video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-25T00:00:00Z",
    }),
  );
  writeFileSync(
    join(dir, "cutplan.json"),
    JSON.stringify({
      approved: false,
      segments: [{ start: 0, end: durationSec, action: "keep", reason: "" }],
    }),
  );
  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ language: "ja", model: "test", segments: [] }));
}

function sample(recTimeMs: number, cx: number, cy: number): CursorSample {
  return {
    recTimeMs,
    cx,
    cy,
    inBounds: true,
    cursorType: null,
    assetId: null,
    leftButtonDown: false,
    leftButtonPressed: false,
    leftButtonReleased: false,
  };
}

/** samples の並びから固定停留(同じ cx,cy)を成す run を組む(recTimeMs 100ms刻み) */
function dwellRun(startMs: number, endMs: number, cx: number, cy: number, stepMs = 100): CursorSample[] {
  const out: CursorSample[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) out.push(sample(t, cx, cy));
  return out;
}

function writeCursorSidecar(dir: string, samples: CursorSample[]): void {
  const sidecar: CursorSidecar = {
    version: 1,
    provider: "openscreen-mac-cursor-helper",
    display: { id: null, resolvedBy: "unresolved" },
    sync: { offsetMs: 0, driftPpm: 0, method: "obs-timecode" },
    pauses: [],
    samples,
    assets: [],
  };
  writeFileSync(join(dir, `raw${CURSOR_SIDECAR_SUFFIX}`), JSON.stringify(sidecar));
}

/* ---------------- autoZoom: 基本(件数一致・focusMode・非重複) ---------------- */

test("autoZoom: 明確な2つのdwellからzoomが2件、非重複で時系列順、focusMode:auto付き", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, [
      ...dwellRun(2000, 2600, 0.2, 0.2),
      ...dwellRun(10000, 10600, 0.6, 0.6),
    ]);
    const result = autoZoom(dir, {} as Config);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.placedCount, 2);
    assert.equal(result.zooms.length, 2);
    for (const z of result.zooms) assert.equal(z.focusMode, "auto");
    assert.ok(result.zooms[0].start < result.zooms[1].start);
    assert.ok(result.zooms[0].end <= result.zooms[1].start);

    const onDisk = JSON.parse(readFileSync(join(dir, "overlays.json"), "utf8")) as Overlays;
    assert.equal(onDisk.zooms?.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- §D3: 境界クランプ ---------------- */

test("autoZoom: 録画端のdwellはstart=0/end=durationSecへクランプされる", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, [
      ...dwellRun(0, 500, 0.1, 0.1), // 中心250ms → start=250-500=-250 → 0 クランプ
      ...dwellRun(19500, 20000, 0.9, 0.9), // 中心19750ms → end=20250 → 20000(=durationSec) クランプ
    ]);
    const result = autoZoom(dir, {} as Config);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.placedCount, 2);
    const starts = result.zooms.map((z) => z.start);
    const ends = result.zooms.map((z) => z.end);
    assert.ok(starts.includes(0));
    assert.ok(ends.includes(20));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoZoom: クランプ後にMIN_AUTO_ZOOM_SEC未満になったdwellは捨てる", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, dwellRun(0, 100, 0.1, 0.1)); // 中心50ms
    const cfg = { plan: { cursor: { minDwellMs: 50, maxWindowMs: 800 } } } as Config;
    // windowMs は maxWindowMs=800 でクランプされる(半分400ms)。
    // 中心50ms → start=50-400=-350→0、end=50+400=450ms=0.45s<MIN_AUTO_ZOOM_SEC(0.5s) → drop
    const result = autoZoom(dir, cfg);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.placedCount, 0);
    assert.deepEqual(result.zooms, []);
    assert.ok(MIN_AUTO_ZOOM_SEC === 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- blurs/annotations 不変 ---------------- */

test("autoZoom: 既存のblurs/annotationsは1バイトも変えず、zoomsだけ置換する", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, dwellRun(2000, 2600, 0.2, 0.2));
    const before: Overlays = {
      blurs: [{ start: 1, end: 2, rect: { x: 50, y: 50, w: 100, h: 100 }, strength: 0.5 }],
      annotations: [{ type: "box", start: 3, end: 4, rect: { x: 10, y: 10, w: 50, h: 50 } }],
    };
    writeFileSync(join(dir, "overlays.json"), JSON.stringify(before, null, 2));

    const result = autoZoom(dir, {} as Config);
    assert.equal(result.placedCount, 1);
    assert.deepEqual(result.overlays.blurs, before.blurs);
    assert.deepEqual(result.overlays.annotations, before.annotations);

    const onDisk = JSON.parse(readFileSync(join(dir, "overlays.json"), "utf8")) as Overlays;
    assert.deepEqual(onDisk.blurs, before.blurs);
    assert.deepEqual(onDisk.annotations, before.annotations);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- cursor 無しで throw ---------------- */

test("autoZoom: cursorサイドカーが無ければ明示エラーで投げる(record --watchへ誘導)", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    assert.throws(() => autoZoom(dir, {} as Config), /record --watch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- スクロール抑制の合流 ---------------- */

test("autoZoom: av.probe/motion.jsonの高sceneScore区間に重なるdwellは候補から落ちる", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, dwellRun(5000, 5500, 0.4, 0.4));

    const withoutMotion = autoZoom(dir, {} as Config);
    assert.equal(withoutMotion.candidateCount, 1);
    assert.equal(withoutMotion.placedCount, 1);

    mkdirSync(join(dir, "av.probe"), { recursive: true });
    writeFileSync(
      join(dir, "av.probe", "motion.json"),
      JSON.stringify({
        motion: [{ outSec: 5.25, sourceSec: 5.25, sceneScore: 0.9 }],
        frozen: [],
      }),
    );

    const withMotion = autoZoom(dir, {} as Config);
    assert.equal(withMotion.candidateCount, 0);
    assert.equal(withMotion.placedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- §D6: autoZoomIfFresh の4分岐 ---------------- */

test("autoZoomIfFresh: plan.cursor.autoZoom=falseならnull", () => {
  const dir = tmpDir();
  try {
    const cfg = { plan: { cursor: { autoZoom: false } } } as Config;
    assert.equal(autoZoomIfFresh(dir, cfg), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoZoomIfFresh: cursorサイドカーが無ければnull", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    assert.equal(autoZoomIfFresh(dir, {} as Config), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoZoomIfFresh: 既存zoomsが非空ならnull(手編集は触らない)", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, dwellRun(2000, 2600, 0.2, 0.2));
    writeFileSync(
      join(dir, "overlays.json"),
      JSON.stringify({ zooms: [{ start: 1, end: 2, rect: { x: 0, y: 0, w: 100, h: 100 } }] }),
    );
    assert.equal(autoZoomIfFresh(dir, {} as Config), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoZoomIfFresh: 3条件充足ならAutoZoomResultを返しoverlays.jsonへ書く", () => {
  const dir = tmpDir();
  try {
    buildFixture(dir, 20);
    writeCursorSidecar(dir, dwellRun(2000, 2600, 0.2, 0.2));
    const result = autoZoomIfFresh(dir, {} as Config);
    assert.ok(result !== null);
    assert.equal(result?.placedCount, 1);
    assert.ok(existsSync(join(dir, "overlays.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
