// src/types.ts — manifest のレイアウト判定(plain/obs-canvas)、
// テロップの実効スタイル解決(captionStyleOf)の純関数を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionStyleOf, hasCamera, manifestLayout, resolveCaptionBackground } from "../src/types.ts";
import type {
  CaptionBackground,
  Manifest,
  Overlays,
  TranscriptSegment,
} from "../src/types.ts";

const obsManifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 3840,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

test("manifestLayout: 未指定は obs-canvas(旧 manifest 互換)", () => {
  assert.equal(manifestLayout({}), "obs-canvas");
  assert.equal(manifestLayout({ layout: undefined }), "obs-canvas");
});

test("manifestLayout: plain 明示は plain", () => {
  assert.equal(manifestLayout({ layout: "plain" }), "plain");
});

test("manifestLayout: obs-canvas 明示は obs-canvas", () => {
  assert.equal(manifestLayout({ layout: "obs-canvas" }), "obs-canvas");
});

test("hasCamera: obs-canvas で cameraRegion があれば true", () => {
  assert.equal(hasCamera(obsManifest), true);
});

test("hasCamera: layout 無し(旧 manifest)でも cameraRegion があれば true", () => {
  const { layout: _layout, ...rest } = obsManifest;
  assert.equal(hasCamera(rest as Manifest), true);
});

test("hasCamera: plain(cameraRegion 無し)は false", () => {
  const plain: Manifest = {
    ...obsManifest,
    layout: "plain",
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    },
  };
  assert.equal(hasCamera(plain), false);
});

test("hasCamera: obs-canvas なのに cameraRegion 欠落(壊れたデータ)は false", () => {
  const broken: Manifest = {
    ...obsManifest,
    video: { width: 3840, height: 1080, fps: 30, screenRegion: obsManifest.video.screenRegion },
  };
  assert.equal(hasCamera(broken), false);
});

// anim/karaoke は background と同じく「まるごと1キー」でセグメント→トラックの
// 順に上書きされる(部分マージしない)。既存の項目単位マージに素通しで乗ることを固定する
test("captionStyleOf: anim/karaoke はトラック標準→セグメント個別の順にキー単位で上書きされる", () => {
  const overlays: Overlays = {
    captionTracks: [
      { track: 1, style: { anim: { in: "fade" }, karaoke: { mode: "word" } } },
    ],
  };
  // セグメント側に無ければトラック標準がそのまま運ばれる
  const segNoOverride: TranscriptSegment = { start: 0, end: 1, text: "a" };
  assert.deepEqual(captionStyleOf(segNoOverride, overlays), {
    anim: { in: "fade" },
    karaoke: { mode: "word" },
  });
  // セグメント側の指定はキー単位でトラック標準を上書きする(部分マージしない)
  const segOverride: TranscriptSegment = {
    start: 0, end: 1, text: "a",
    style: { anim: { in: "pop", durationSec: 0.5 } },
  };
  assert.deepEqual(captionStyleOf(segOverride, overlays), {
    anim: { in: "pop", durationSec: 0.5 }, // まるごと差し替え(トラック標準の fade は残らない)
    karaoke: { mode: "word" }, // 個別指定が無いキーはトラック標準のまま
  });
});

test("captionStyleOf: anim/karaoke 未指定(トラック標準・セグメントとも無し)は現状どおり該当キー無し", () => {
  const seg: TranscriptSegment = { start: 0, end: 1, text: "a", style: { color: "#fff" } };
  assert.deepEqual(captionStyleOf(seg, {}), { color: "#fff" });
});

/* ---------------- 帯(background)の3層解決と "none" 番兵 ----------------
 * 解決順は config 既定 → captionTracks[].style → segment.style。
 * undefined は「指定なし=継承」で、"none" が「この層で帯を消す」。
 * この非対称を取り違えると「帯を消したのに既定から復活する」に戻る */

const BAND: CaptionBackground = { color: "rgba(35,35,35,0.9)", paddingPx: 52, radiusPx: 20 };

test("resolveCaptionBackground: どちらも未指定なら帯なし", () => {
  assert.equal(resolveCaptionBackground(undefined, undefined), undefined);
});

test("resolveCaptionBackground: 下の層(config 既定)の帯を継承する", () => {
  assert.deepEqual(resolveCaptionBackground(undefined, BAND), BAND);
});

test('resolveCaptionBackground: "none" は下の層の帯を打ち消す(これが「帯を消す」)', () => {
  assert.equal(resolveCaptionBackground("none", BAND), undefined);
});

test("resolveCaptionBackground: 上の層の帯が下の層に優先する", () => {
  const own: CaptionBackground = { color: "#ff0000" };
  assert.deepEqual(resolveCaptionBackground(own, BAND), own);
});

test('resolveCaptionBackground: 下の層が "none" でも上の層の帯は出る', () => {
  const own: CaptionBackground = { color: "#ff0000" };
  assert.deepEqual(resolveCaptionBackground(own, "none"), own);
});

test('captionStyleOf → resolveCaptionBackground: 章トラックの "none" が config 既定の帯を消す', () => {
  // 章(track 2)はトラック標準で帯なし、テロップ(track 1)は config 既定の帯のまま
  const ov: Overlays = { captionTracks: [{ track: 2, name: "章", style: { background: "none" } }] };
  const chapter: TranscriptSegment = { start: 0, end: 1, text: "章タイトル", track: 2 };
  const telop: TranscriptSegment = { start: 0, end: 1, text: "テロップ" };

  assert.equal(
    resolveCaptionBackground(captionStyleOf(chapter, ov)?.background, BAND),
    undefined,
    "章トラックは帯なし",
  );
  assert.deepEqual(
    resolveCaptionBackground(captionStyleOf(telop, ov)?.background, BAND),
    BAND,
    "テロップトラックは config 既定の帯を継承",
  );
});

test('captionStyleOf: セグメントの帯がトラック標準の "none" に優先する(1件だけ帯を戻す)', () => {
  const own: CaptionBackground = { color: "#000000" };
  const ov: Overlays = { captionTracks: [{ track: 2, style: { background: "none" } }] };
  const s: TranscriptSegment = { start: 0, end: 1, text: "例外", track: 2, style: { background: own } };
  assert.deepEqual(resolveCaptionBackground(captionStyleOf(s, ov)?.background, BAND), own);
});
