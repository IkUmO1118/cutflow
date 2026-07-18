// HyperFrames カード(materials/hyperframes/<name>.mp4)をエディタの
// タイムラインへ配置する経路のリグレッション固定。
//
// 前提(コーディネータが実機 HTTP で検証済み。ここでは再検証しない):
//   - GET /api/project の dirFiles にカードが列挙される(サブディレクトリ
//     許容の列挙)
//   - GET /api/media-facts で問題フラグが立たない(h264 はブラウザ再生可能)
//   - 配置(overlay の追加)は POST /api/save で永続化され、baseHashes 不一致は
//     409 になる(§8.3 の content-version 機構。test/saveProject.test.ts と
//     editor 実機で別途担保)
// これらはライブ HTTP テストの担保範囲であり、このファイルの対象外。
//
// このファイルが固定するのは、その配置が依拠する3つの純粋な不変条件:
//   1. サブディレクトリ配下の素材(materials/hyperframes/*.mp4)がクライアント
//      側で「素材ファイル」として認識される述語
//   2. サブディレクトリの素材を参照する overlay が saveProject の検査
//      (validateDocs)を通り、存在しない参照はエラーになる
//   3. renderProps の既定値により、音量/fit を指定しないカードは
//      「無音+contain」で描画される
// これらのどれかが将来のリファクタ(materials/ のフラット化・renderProps
// 既定値の変更等)で壊れると、このテストが落ちる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProject } from "../editor/server.ts";
import type { SaveRequest } from "../editor/client/apiTypes.ts";
import { buildRenderProps } from "../src/lib/renderProps.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest } from "../src/types.ts";

/* ---------------- 1. 素材ファイル述語(editor/client/App.tsx) ---------------- */

// editor/client/App.tsx (~L207) の isMaterialFile をここに書き写して固定する。
// クライアントバンドルの公開面を増やしたくない(テストのためだけに export
// しない)ため、複製した上で pin する。もし App.tsx 側の isMaterialFile が
// 変わったら、このコピーも合わせて更新すること。
const isMaterialFile = (f: string) =>
  f.startsWith("materials/") &&
  /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mp3|m4a|wav|aac|ogg|flac)$/i.test(f);

test("isMaterialFile: materials/ 配下のサブディレクトリ(materials/hyperframes/*.mp4)も素材と認識される", () => {
  assert.equal(isMaterialFile("materials/hyperframes/intro.mp4"), true);
  assert.equal(isMaterialFile("materials/intro.mp4"), true); // サブディレクトリ無しも従来通り
});

test("isMaterialFile: materials/ 配下でも対応拡張子でなければ素材ではない", () => {
  assert.equal(isMaterialFile("materials/hyperframes/intro.txt"), false);
  assert.equal(isMaterialFile("materials/intro.txt"), false);
});

test("isMaterialFile: materials/ 配下でなければ拡張子が一致しても素材ではない", () => {
  assert.equal(isMaterialFile("other/intro.mp4"), false);
});

/* ---------------- 2. saveProject/validateDocs によるサブディレクトリ参照の検査 ---------------- */

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-hf-place-test-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", { durationSec: 100 });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 10, action: "keep", reason: "本編" }],
    });
    write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("saveProject: materials/hyperframes/<name>.mp4 を参照する overlay は検査を通り保存される", () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, "materials", "hyperframes"), { recursive: true });
    writeFileSync(join(dir, "materials", "hyperframes", "intro.mp4"), "dummy-mp4-bytes");

    const body: SaveRequest = {
      overlays: {
        overlays: [{ start: 1, end: 5, file: "materials/hyperframes/intro.mp4" }],
      },
    };
    // 検査(validateDocs)込みの実際の保存経路。エラーなら throw する。
    assert.doesNotThrow(() => saveProject(dir, body));
  });
});

test("saveProject: 存在しない materials/hyperframes/<name>.mp4 を参照する overlay はエラーで拒否される(1バイトも書かない)", () => {
  withTmpProject((dir) => {
    // hyperframes ディレクトリ自体を作らない = 参照先が実在しない
    const body: SaveRequest = {
      overlays: {
        overlays: [{ start: 1, end: 5, file: "materials/hyperframes/missing.mp4" }],
      },
    };
    assert.throws(() => saveProject(dir, body));
  });
});

/* ---------------- 3. renderProps の既定値: 配置直後は無音+contain ---------------- */

const manifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
};

test("buildRenderProps: volume/fit を指定せず置いた HF カードは無音+contain で描画される(既定値)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      overlays: [{ start: 1, end: 5, file: "materials/hyperframes/intro.mp4" }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  const item = props.overlays.find((o) => o.file === "materials/hyperframes/intro.mp4");
  assert.ok(item, "配置した HF カードが overlayItems に含まれる");
  assert.equal(item?.fit, "contain"); // 既定 fit
  assert.equal("volume" in (item ?? {}), false); // volume 未指定 = キーごと省略(無音扱い)
});
