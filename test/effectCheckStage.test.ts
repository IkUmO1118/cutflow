// stages/effectCheck.ts の劣化保証を固定する。決定論チェックの結果は
// still 撮影(VLM の入力=任意レーン)が失敗しても必ず書かれ、exit 0 相当で
// 返る(設計書 §1-1 / §1-2)。frames() は元収録・cutplan が無いと例外を
// 投げるので、それを利用して「撮影失敗でも決定論レポートは成功する」を実測する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectCheck, EFFECT_CHECK_FILE } from "../src/stages/effectCheck.ts";
import { loadConfig } from "../src/lib/config.ts";

const cfg = loadConfig();

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-effect-check-"));
  const manifest = {
    dir,
    source: "does-not-exist.mp4",
    durationSec: 120,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-11T00:00:00.000Z",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ language: "ja", model: "t", segments: [] }));
  // 効いた演出をわざと zoom×blur で重ねる(決定論で blur-zoom-overlap を出す)
  const overlays = {
    zooms: [{ id: "zm_aaaaaa", start: 10, end: 20, rect: { x: 0, y: 0, w: 960, h: 540 } }],
    blurs: [{ id: "bl_aaaaaa", start: 12, end: 18, rect: { x: 100, y: 100, w: 100, h: 100 } }],
  };
  writeFileSync(join(dir, "overlays.json"), JSON.stringify(overlays));
  return dir;
}

test("effectCheck: still 撮影が失敗しても決定論レポートは書かれ、例外を投げない(--no-vlm)", async () => {
  const dir = makeDir();
  try {
    // 元収録も cutplan も無いので captureStills → frames() は必ず例外を投げる。
    // それでも effectCheck は throw せず結果を返し、レポートを書くはず
    const result = await effectCheck(dir, cfg, { useVlm: false });
    // 決定論警告は計算済み(blur-zoom-overlap が出ている)
    assert.ok(result.warnings.some((w) => w.kind === "blur-zoom-overlap"));
    // still は劣化して空
    assert.deepEqual(result.stills, []);
    // レポートが実際にディスクへ書かれている
    const report = JSON.parse(readFileSync(join(dir, EFFECT_CHECK_FILE), "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.ok(Array.isArray(report.warnings));
    assert.ok(report.warnings.some((w: { kind: string }) => w.kind === "blur-zoom-overlap"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effectCheck: VLM 既定(useVlm 省略)でも still 撮影失敗を優雅に劣化させ、撮影失敗を明示する", async () => {
  const dir = makeDir();
  try {
    const result = await effectCheck(dir, cfg);
    // 決定論レポートは成功
    assert.ok(result.warnings.some((w) => w.kind === "blur-zoom-overlap"));
    // VLM は実行されていない。useVlm 既定(true)で still 撮影が失敗したので、
    // route 未設定より先に撮影失敗が理由として明示される
    assert.equal(result.vlm.ran, false);
    assert.match(result.vlm.note, /still 撮影に失敗/);
    // 補正候補(blur を zoom 領域へ広げる)も出ており patch が書かれている
    assert.ok(result.patchPath !== null);
    const patch = JSON.parse(readFileSync(result.patchPath as string, "utf8"));
    assert.ok(Array.isArray(patch.ops) && patch.ops.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
