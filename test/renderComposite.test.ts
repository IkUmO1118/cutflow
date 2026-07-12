// stages/render.ts の canBurnWipe — ワイプを cut.mp4 に焼き込んで Remotion の
// ベース映像抽出を2回→1回に減らせる収録かの適格判定を固定する
// (docs/plans/perf-render-single-extraction.md)。camera があり zoom/wipeFull が
// 無く、ワイプ矩形(右下)と交差する blur も無いときだけ true。不適格なら従来の
// 3840 ベース+2抽出へフォールバック(挙動 bit 等価)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { canBurnWipe } from "../src/stages/render.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest, Overlays } from "../src/types.ts";

// 実収録(2026-07-12)と同型: obs-canvas 3840x1080(左=画面 / 右=カメラ)
const CAM = {
  source: "raw.mkv",
  durationSec: 100,
  layout: "obs-canvas",
  video: {
    width: 3840,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null },
} as unknown as Manifest;

// plain(カメラ無し)。元々ワイプが無い=抽出1回なので焼き込み対象外
const PLAIN = {
  source: "raw.mkv",
  durationSec: 100,
  layout: "plain",
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null },
} as unknown as Manifest;

const CFG = { render: { wipeWidthPx: 480 } } as Config;
// ww=480 / wh=round(480*1080/1920)=270 → ワイプ矩形 = {1440,810,480,270}(右下)
const OVER_WIPE = { x: 1500, y: 850, w: 120, h: 120 }; // 交差する
const CLEAR = { x: 0, y: 0, w: 200, h: 200 }; // 左上=交差しない

test("canBurnWipe: camera あり・演出無しは true", () => {
  assert.equal(canBurnWipe(CAM, {} as Overlays, CFG), true);
});

test("canBurnWipe: plain(カメラ無し)は false", () => {
  assert.equal(canBurnWipe(PLAIN, {} as Overlays, CFG), false);
});

test("canBurnWipe: zoom があると false(背景 transform でワイプまで拡大されるため)", () => {
  assert.equal(canBurnWipe(CAM, { zooms: [{}] } as unknown as Overlays, CFG), false);
});

test("canBurnWipe: wipeFull があると false(ワイプが動的=焼き込み不可)", () => {
  assert.equal(canBurnWipe(CAM, { wipeFull: [{}] } as unknown as Overlays, CFG), false);
});

test("canBurnWipe: ワイプ矩形と交差する blur があると false(重なり部の見え方が変わる)", () => {
  assert.equal(canBurnWipe(CAM, { blurs: [{ rect: OVER_WIPE }] } as unknown as Overlays, CFG), false);
});

test("canBurnWipe: ワイプ矩形と交差しない blur は許容(true)", () => {
  assert.equal(canBurnWipe(CAM, { blurs: [{ rect: CLEAR }] } as unknown as Overlays, CFG), true);
});
