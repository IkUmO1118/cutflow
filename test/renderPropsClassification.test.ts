// RenderProps の新キーに「render 最適化での扱い」の明示分類を強制する回帰ゲート。
//
// 背景: chunk 差分レンダーの globalVideoProps は手書きの射影なので、RenderProps に
// キーを足して射影へ入れ忘れると「旧デザインのまま黙って concat」型の正確性バグに
// なる(render.design 導入時に実際に起きた。docs/programs/render-design-program.md §2.3)。
// FAST 側も同型: fastPlan が知らない時間変化キーは FAST span が黙って描き落とす。
//
// このテストは remotion/props.ts のソースから RenderProps のトップレベルキーを
// 実行時に抽出し、下の分類表と一致しない限り npm test を落とす。キーを足すときは:
//   1. src/lib/fastPlan.ts — FAST での扱いを決める(基底/レイヤーで消費するか、
//      SLOW/全編フォールバックの引き金にするか)
//   2. src/lib/chunkPlan.ts — globalVideoProps(全域)/ chunkVideoKey(局所)/
//      audioKey(音声)のどれに入れるかを決める
//   3. ファイル参照を持つキーなら src/lib/renderKey.ts の materialFilesOf にも追加
//   4. この分類表と MUTATIONS に追記する(chunk 分類は下の挙動テストで実測に固定される)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audioKey, chunkVideoKey, globalVideoKey } from "../src/lib/chunkPlan.ts";
import type { RenderProps } from "../remotion/props.ts";

/** chunk 差分レンダーでの扱い(挙動テストで実測に固定する) */
type ChunkClass =
  | "global" // globalVideoProps 射影に入る = 変えると全チャンク無効
  | "chunk-local" // 重なるチャンクの chunkVideoKey だけ変わる(global は不変)
  | "audio" // audioKey のみ(映像キーは不変。変われば音声作り直し=フルレンダー)
  | "preview-only" // エディタプレビュー専用。最終レンダーでは常に未指定
  | "shorts-only" // ショート/縦プリセット専用。チャンクパス(本編のみ)には現れない
  | "via-cutstat"; // cut.mp4 の内容記述子。フラグ単独では変わらず cutStat 経由で無効化される

/** render 高速パス(fastPlan/fastSegment)での扱い(分類の宣言。実装対応の宣誓) */
type FastClass =
  | "base" // 基底(composite/design/plain-identity)の判定・argv/graph が消費
  | "layer" // 時間レイヤー(FAST の PNG 合成、表現不能なら span を SLOW へ)として消費
  | "fallback" // fastPlan が SLOW 島/全編フォールバックの引き金にする
  | "audio" // audioGate / 音声パスの責務(FAST 映像グラフには影響しない)
  | "preview-only" // 最終レンダーでは常に未指定(fastRender は最終レンダー専用)
  | "shorts-only"; // 高速パスは本編 render のみ。isPlainIdentityBase は防御的に拒否する

const CLASSIFICATION = {
  videoFile: { chunk: "global", fast: "base" },
  bgm: { chunk: "audio", fast: "audio" },
  muteBase: { chunk: "preview-only", fast: "preview-only" },
  muteBgm: { chunk: "preview-only", fast: "preview-only" },
  hiddenLayers: { chunk: "preview-only", fast: "preview-only" },
  durationSec: { chunk: "global", fast: "base" },
  fps: { chunk: "global", fast: "base" },
  width: { chunk: "global", fast: "base" },
  height: { chunk: "global", fast: "base" },
  canvas: { chunk: "global", fast: "base" },
  screenRegion: { chunk: "global", fast: "base" },
  cameraRegion: { chunk: "global", fast: "base" },
  wipe: { chunk: "global", fast: "base" },
  // フラグは cut.mp4 の内容(カメラ焼き込み済みか)の記述子。フラグが変わる
  // ときは cut.mp4 自体が再生成されており cutStat で全チャンク無効になる
  wipeBurnedIn: { chunk: "via-cutstat", fast: "base" },
  colorFilter: { chunk: "global", fast: "base" },
  design: { chunk: "global", fast: "base" },
  layout: { chunk: "shorts-only", fast: "shorts-only" },
  caption: { chunk: "global", fast: "layer" },
  captionDefaultPos: { chunk: "shorts-only", fast: "shorts-only" },
  captions: { chunk: "chunk-local", fast: "layer" },
  overlays: { chunk: "chunk-local", fast: "layer" },
  wipeFull: { chunk: "chunk-local", fast: "fallback" },
  zooms: { chunk: "chunk-local", fast: "fallback" },
  // blurs は意図的に chunk-local(全域無効化を避ける。chunkPlan.ts §4 タスク6)
  blurs: { chunk: "chunk-local", fast: "fallback" },
  annotations: { chunk: "chunk-local", fast: "layer" },
  cutTransition: { chunk: "chunk-local", fast: "fallback" },
  cutBoundarySecs: { chunk: "chunk-local", fast: "fallback" },
  hideCaption: { chunk: "chunk-local", fast: "layer" },
  layerOrder: { chunk: "global", fast: "layer" },
  baseSegments: { chunk: "global", fast: "base" },
  inserts: { chunk: "chunk-local", fast: "fallback" },
} as const satisfies Record<keyof RenderProps, { chunk: ChunkClass; fast: FastClass }>;

const FPS = 30;
const CUT_STAT = { mtimeMs: 1000, size: 2000 };
// 全編(10秒 = 300 frame)を1チャンクで覆う: どの時間局所要素の変更も必ず映る
const WHOLE = { from: 0, to: 300 };

/** 全 optional キーを載せた最大構成(preview/shorts 専用キーだけは未指定に
 * しておき、MUTATIONS が「未指定 → 指定」の変化を作る) */
const BASE: RenderProps = {
  videoFile: "cut.mp4",
  bgm: [{ file: "materials/bgm.mp3", volumeDb: -22, start: 0, end: 10, fadeOutSec: 2 }],
  durationSec: 10,
  fps: FPS,
  width: 1920,
  height: 1080,
  canvas: { w: 3840, h: 1080 },
  screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
  cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  wipe: { widthPx: 480, marginPx: 32, transitionSec: 0.3 },
  colorFilter: { brightness: 1.05 },
  design: {
    backgroundColor: "#101418",
    screen: { rect: { x: 100, y: 22, w: 1720, h: 968 }, radiusPx: 24, shadow: true },
    camera: { rect: { x: 1517, y: 677, w: 375, h: 375 }, radiusPx: 96, shadow: true },
  },
  caption: { fontSizePx: 44 },
  captions: [{ start: 1, end: 2, text: "テロップ", track: 1 }],
  overlays: [{ start: 1, end: 3, file: "materials/a.png", track: 1, fit: "contain" }],
  wipeFull: [{ start: 4, end: 5 }],
  zooms: [{ start: 2, end: 3, rect: { x: 0, y: 0, w: 960, h: 540 }, easeSec: 0.4, wipeScale: 0.8 }],
  blurs: [{ start: 3, end: 4, rect: { x: 10, y: 10, w: 200, h: 100 }, strength: 0.5 }],
  annotations: [
    { type: "box", start: 4, end: 5, rect: { x: 50, y: 50, w: 300, h: 200 }, color: "#ff0000", widthPx: 4, radiusPx: 8 },
  ],
  cutTransition: { sec: 0.5 },
  cutBoundarySecs: [5],
  hideCaption: [{ start: 8, end: 9 }],
  layerOrder: ["wipe", "caption"],
  baseSegments: [{ start: 0, videoStart: 0, durationSec: 10 }],
  inserts: [{ start: 7, end: 8, file: "materials/i.mp4", fit: "cover" }],
};

/** キーごとの「有効な値の変更」。chunk 分類の挙動テストがこれを当てて実測する */
const MUTATIONS: Record<keyof RenderProps, (p: RenderProps) => RenderProps> = {
  videoFile: (p) => ({ ...p, videoFile: "cut2.mp4" }),
  bgm: (p) => ({ ...p, bgm: [{ ...p.bgm[0], volumeDb: -10 }] }),
  muteBase: (p) => ({ ...p, muteBase: true }),
  muteBgm: (p) => ({ ...p, muteBgm: true }),
  hiddenLayers: (p) => ({ ...p, hiddenLayers: ["wipe"] }),
  durationSec: (p) => ({ ...p, durationSec: 12 }),
  fps: (p) => ({ ...p, fps: 24 }),
  width: (p) => ({ ...p, width: 1280 }),
  height: (p) => ({ ...p, height: 720 }),
  canvas: (p) => ({ ...p, canvas: { w: 1920, h: 1080 } }),
  screenRegion: (p) => ({ ...p, screenRegion: { ...p.screenRegion, w: 1720 } }),
  cameraRegion: (p) => ({ ...p, cameraRegion: { x: 2000, y: 0, w: 1840, h: 1080 } }),
  wipe: (p) => ({ ...p, wipe: { ...p.wipe, widthPx: 400 } }),
  wipeBurnedIn: (p) => ({ ...p, wipeBurnedIn: true }),
  colorFilter: (p) => ({ ...p, colorFilter: { brightness: 1.2 } }),
  design: (p) => ({
    ...p,
    design: { ...p.design!, screen: { ...p.design!.screen, radiusPx: 32 } },
  }),
  layout: (p) => ({ ...p, layout: { panels: [{ source: "screen", fit: "contain" }] } }),
  caption: (p) => ({ ...p, caption: { fontSizePx: 48 } }),
  captionDefaultPos: (p) => ({ ...p, captionDefaultPos: { x: 540, y: 1600 } }),
  captions: (p) => ({ ...p, captions: [{ ...p.captions[0], text: "編集後" }] }),
  overlays: (p) => ({ ...p, overlays: [{ ...p.overlays[0], start: 1.5 }] }),
  wipeFull: (p) => ({ ...p, wipeFull: [{ start: 4, end: 5.5 }] }),
  zooms: (p) => ({ ...p, zooms: [{ ...p.zooms![0], rect: { x: 0, y: 0, w: 1280, h: 720 } }] }),
  blurs: (p) => ({ ...p, blurs: [{ ...p.blurs![0], strength: 0.8 }] }),
  annotations: (p) => ({ ...p, annotations: [{ ...p.annotations![0], widthPx: 6 }] }),
  cutTransition: (p) => ({ ...p, cutTransition: { sec: 0.9 } }),
  cutBoundarySecs: (p) => ({ ...p, cutBoundarySecs: [6] }),
  hideCaption: (p) => ({ ...p, hideCaption: [{ start: 8, end: 9.5 }] }),
  layerOrder: (p) => ({ ...p, layerOrder: ["caption", "wipe"] }),
  baseSegments: (p) => ({
    ...p,
    baseSegments: [{ start: 0, videoStart: 0, durationSec: 9 }],
  }),
  inserts: (p) => ({ ...p, inserts: [{ ...p.inserts![0], start: 7.2 }] }),
};

function keysOf(props: RenderProps) {
  return {
    global: globalVideoKey(props, CUT_STAT),
    chunk: chunkVideoKey(props, WHOLE.from, WHOLE.to, CUT_STAT, FPS),
    audio: audioKey(props, CUT_STAT, []),
  };
}

function classifiedKeys(chunk: ChunkClass): (keyof RenderProps)[] {
  return (Object.keys(CLASSIFICATION) as (keyof RenderProps)[]).filter(
    (k) => CLASSIFICATION[k].chunk === chunk,
  );
}

/** remotion/props.ts のソースから RenderProps のトップレベルキーを抽出する
 * (2スペースインデントの識別子行。ネストのフィールドは4スペース以上なので
 * 拾わない)。型は実行時に消えるので、ソースを実行時の正とする */
function renderPropsKeysFromSource(): string[] {
  const src = readFileSync(new URL("../remotion/props.ts", import.meta.url), "utf8");
  const start = src.indexOf("export type RenderProps = {");
  assert.ok(start >= 0, "remotion/props.ts に export type RenderProps が見つからない");
  const end = src.indexOf("\n};", start);
  assert.ok(end > start, "RenderProps の閉じ '};' が見つからない");
  const block = src.slice(start, end);
  return [...block.matchAll(/^  ([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm)].map((m) => m[1]);
}

test("RenderProps の全キーが分類表・MUTATIONS に載っている(新キーは分類してから)", () => {
  const source = renderPropsKeysFromSource().sort();
  const classified = Object.keys(CLASSIFICATION).sort();
  const mutated = Object.keys(MUTATIONS).sort();
  assert.deepEqual(
    classified,
    source,
    "RenderProps のキーと分類表がずれている。新キーは fastPlan(FAST での扱い)と " +
      "chunkPlan(globalVideoProps / chunkVideoKey / audioKey)での扱いを決め、" +
      "ファイル参照を持つなら renderKey.ts の materialFilesOf にも追加してから、" +
      "この分類表と MUTATIONS に追記する(このファイル冒頭のコメント参照)",
  );
  assert.deepEqual(mutated, source, "MUTATIONS が RenderProps のキーとずれている");
});

test("chunk分類 global: 変更で globalVideoKey(=全チャンク)が変わる", () => {
  const before = keysOf(BASE);
  for (const key of classifiedKeys("global")) {
    const after = keysOf(MUTATIONS[key](BASE));
    assert.notEqual(after.global, before.global, `${key}: global 射影に入っていない`);
    assert.notEqual(after.chunk, before.chunk, `${key}: chunkVideoKey が変わらない`);
  }
});

test("chunk分類 chunk-local: 変更で重なるチャンクだけ変わり global は不変", () => {
  const before = keysOf(BASE);
  for (const key of classifiedKeys("chunk-local")) {
    const after = keysOf(MUTATIONS[key](BASE));
    assert.equal(after.global, before.global, `${key}: global を無駄に無効化している`);
    assert.notEqual(after.chunk, before.chunk, `${key}: chunkVideoKey に映っていない`);
  }
});

test("chunk分類 audio: 変更で audioKey だけ変わる(映像キーは不変)", () => {
  const before = keysOf(BASE);
  for (const key of classifiedKeys("audio")) {
    const after = keysOf(MUTATIONS[key](BASE));
    assert.equal(after.global, before.global, `${key}: global を無駄に無効化している`);
    assert.equal(after.chunk, before.chunk, `${key}: 映像キーを無駄に無効化している`);
    assert.notEqual(after.audio, before.audio, `${key}: audioKey に映っていない`);
  }
});

test("chunk分類 preview-only / shorts-only / via-cutstat: どのキーも変えない", () => {
  const before = keysOf(BASE);
  const inert: ChunkClass[] = ["preview-only", "shorts-only", "via-cutstat"];
  for (const cls of inert) {
    for (const key of classifiedKeys(cls)) {
      const after = keysOf(MUTATIONS[key](BASE));
      assert.equal(after.global, before.global, `${key}(${cls}): global が変わった`);
      assert.equal(after.chunk, before.chunk, `${key}(${cls}): chunkVideoKey が変わった`);
      assert.equal(after.audio, before.audio, `${key}(${cls}): audioKey が変わった`);
    }
  }
});

test("射影の分離: overlay の volume は音声のみに効く(映像キー不変・audioKey 変化)", () => {
  const before = keysOf(BASE);
  const after = keysOf({ ...BASE, overlays: [{ ...BASE.overlays[0], volume: 1 }] });
  assert.equal(after.global, before.global);
  assert.equal(after.chunk, before.chunk, "volume が映像射影に漏れている");
  assert.notEqual(after.audio, before.audio, "volume が audioKey に映っていない");
});
