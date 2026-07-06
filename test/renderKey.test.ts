// lib/renderKey.ts — render の final.mp4 全スキップ可否を決めるキャッシュキー
// 生成・一致判定を固定する。props(編集内容)・cut.mp4・参照素材ファイル・
// hardwareAcceleration 設定のどれかが変われば不一致になり、render は
// Remotion 実行をスキップせず再生成すること。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderCacheKey,
  materialFilesOf,
  renderCacheKeyEquals,
} from "../src/lib/renderKey.ts";
import type { RenderProps } from "../remotion/props.ts";

const PROPS = {
  videoFile: "cut.mp4",
  bgm: [{ file: "bgm.mp3", volumeDb: -22, start: 0, end: 10 }],
  durationSec: 10,
  fps: 30,
  width: 1920,
  height: 1080,
  canvas: { w: 1920, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 0, y: 0, w: 0, h: 0 },
  wipe: { widthPx: 480, marginPx: 32 },
  caption: { fontSizePx: 44 },
  captions: [{ start: 0, end: 1, text: "hi", track: 1 }],
  overlays: [{ start: 0, end: 1, file: "materials/a.png", track: 1, fit: "contain" as const }],
  wipeFull: [],
  hideCaption: [],
  inserts: [{ start: 0, end: 1, file: "materials/b.mp4", fit: "contain" as const }],
} satisfies RenderProps;

const STAT_SIZES: Record<string, { mtimeMs: number; size: number }> = {
  "/dir/materials/a.png": { mtimeMs: 100, size: 200 },
  "/dir/materials/b.mp4": { mtimeMs: 300, size: 400 },
  "/dir/bgm.mp3": { mtimeMs: 500, size: 600 },
};
const statFile = (p: string) => STAT_SIZES[p] ?? { mtimeMs: 0, size: 0 };

function keyOf(overrides: {
  props?: RenderProps;
  cut?: { mtimeMs: number; size: number };
  hardwareAcceleration?: string;
  statFile?: (p: string) => { mtimeMs: number; size: number };
}) {
  return buildRenderCacheKey({
    props: overrides.props ?? PROPS,
    dir: "/dir",
    cut: overrides.cut ?? { mtimeMs: 1000, size: 2000 },
    hardwareAcceleration: overrides.hardwareAcceleration ?? "if-possible",
    statFile: overrides.statFile ?? statFile,
  });
}

test("materialFilesOf: overlays/inserts/bgm の file を重複なく列挙(ソート済み)", () => {
  assert.deepEqual(materialFilesOf(PROPS), ["bgm.mp3", "materials/a.png", "materials/b.mp4"]);
});

test("materialFilesOf: 同じファイルが複数箇所から参照されても1件にまとまる", () => {
  const props = {
    ...PROPS,
    inserts: [{ ...PROPS.inserts![0], file: "materials/a.png" }],
  } satisfies RenderProps;
  assert.deepEqual(materialFilesOf(props), ["bgm.mp3", "materials/a.png"]);
});

test("renderCacheKeyEquals: 全く同じ入力からは一致するキー", () => {
  assert.ok(renderCacheKeyEquals(keyOf({}), keyOf({})));
});

test("renderCacheKeyEquals: props(テロップ・演出等)が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({
    props: { ...PROPS, captions: [{ start: 0, end: 2, text: "hi", track: 1 }] },
  });
  assert.ok(!renderCacheKeyEquals(a, b));
});

test("renderCacheKeyEquals: cut.mp4 の mtime/size が変わると不一致", () => {
  const a = keyOf({});
  assert.ok(!renderCacheKeyEquals(a, keyOf({ cut: { mtimeMs: 1001, size: 2000 } })));
  assert.ok(!renderCacheKeyEquals(a, keyOf({ cut: { mtimeMs: 1000, size: 2001 } })));
});

test("renderCacheKeyEquals: 素材ファイルの mtime/size が変わると不一致", () => {
  const a = keyOf({});
  const changed = keyOf({
    statFile: (p) =>
      p === "/dir/materials/a.png" ? { mtimeMs: 999, size: 200 } : statFile(p),
  });
  assert.ok(!renderCacheKeyEquals(a, changed));
});

test("renderCacheKeyEquals: hardwareAcceleration 設定が変わると不一致", () => {
  const a = keyOf({});
  const b = keyOf({ hardwareAcceleration: "disable" });
  assert.ok(!renderCacheKeyEquals(a, b));
});
