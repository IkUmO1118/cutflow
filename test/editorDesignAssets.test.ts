import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { designForPlayer } from "../editor/client/designAssets.ts";
import { loadProject } from "../editor/server.ts";
import { resolveDesign } from "../src/lib/design.ts";
import { designAssetRefs } from "../src/lib/designStill.ts";
import type { Config } from "../src/lib/config.ts";

function fixture(backgroundFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-design-"));
  const write = (file: string, value: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
  // design は OBS 拡張キャンバス収録(cameraRegion を持つ)だけに載る。
  // plain 収録は素の映像のまま = design 資産そのものが作られないので、
  // このファイルの資産テストは obs-canvas の収録で組む
  write("manifest.json", {
    dir,
    source: "raw.mp4",
    durationSec: 5,
    layout: "obs-canvas",
    video: {
      width: 2400,
      height: 1080,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      cameraRegion: { x: 1920, y: 0, w: 480, h: 1080 },
    },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-14T00:00:00Z",
  });
  write("transcript.json", { language: "ja", model: "test", segments: [] });
  write("cutplan.json", {
    approved: false,
    segments: [{ start: 0, end: 5, action: "keep", reason: "" }],
  });
  const cfg = {
    render: { design: { enabled: true, ...(backgroundFile ? { backgroundFile } : {}) } },
    preview: { width: 1280 },
    plan: {},
  } as Config;
  return { dir, cfg };
}

/** design 資産の全ロール(背景・画面マスク・カメラの影/マスク)の相対パス */
function assetFiles(refs: ReturnType<typeof designAssetRefs>): string[] {
  return [
    refs.backdropFile,
    refs.screenMaskFile,
    refs.cameraShadowFile,
    refs.cameraMaskFile,
  ].filter((f): f is string => !!f);
}

test("loadProject/designForPlayer: 資産を検証してmedia URLへ変換する", () => {
  const { dir, cfg } = fixture();
  try {
    const design = resolveDesign(cfg.render.design, 1920, 1080, true)!;
    const refs = designAssetRefs({ dir, design, width: 1920, height: 1080 });
    for (const file of assetFiles(refs)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "png");
    }
    const project = loadProject(dir, cfg);
    assert.equal(project.designAssets?.refs.key, refs.key);
    const player = designForPlayer(design, 1920, 1080, project.designAssets)!;
    assert.equal(player.assets?.key, refs.key);
    assert.equal(player.assets?.backdropFile, `media/${refs.backdropFile}`);
    assert.equal(player.backgroundFile, undefined);

    const changed = designForPlayer(
      { ...design, backgroundColor: "#ffffff" },
      1920,
      1080,
      project.designAssets,
    );
    assert.equal(changed?.assets, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProject: partial cache はdesignAssetsを返さない", () => {
  const { dir, cfg } = fixture();
  try {
    const design = resolveDesign(cfg.render.design, 1920, 1080, true)!;
    const refs = designAssetRefs({ dir, design, width: 1920, height: 1080 });
    mkdirSync(dirname(join(dir, refs.backdropFile)), { recursive: true });
    writeFileSync(join(dir, refs.backdropFile), "partial");
    assert.equal(loadProject(dir, cfg).designAssets, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProject: 初回load前にrepo背景をcopyしてmedia一覧へ載せる", () => {
  const { dir, cfg } = fixture("assets/backgrounds/dusk.jpg");
  try {
    const project = loadProject(dir, cfg);
    assert.equal(project.renderCfg.design?.backgroundFile, "render.design/dusk.jpg");
    assert.ok(project.dirFiles.includes("render.design/dusk.jpg"));
    const design = resolveDesign(project.renderCfg.design, 1920, 1080, true)!;
    const player = designForPlayer(design, 1920, 1080, project.designAssets);
    assert.equal(player?.backgroundFile, "media/render.design/dusk.jpg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("designForPlayer: config背景変更後は古いassetを使わず新しいmedia URLへ切り替える", () => {
  const { dir, cfg } = fixture("materials/first.jpg");
  try {
    mkdirSync(join(dir, "materials"), { recursive: true });
    writeFileSync(join(dir, "materials/first.jpg"), "first");
    writeFileSync(join(dir, "materials/second.jpg"), "second");
    const firstDesign = resolveDesign(cfg.render.design, 1920, 1080, true)!;
    const refs = designAssetRefs({ dir, design: firstDesign, width: 1920, height: 1080 });
    for (const file of assetFiles(refs)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "png");
    }
    const prepared = loadProject(dir, cfg).designAssets;
    assert.equal(designForPlayer(firstDesign, 1920, 1080, prepared)?.assets?.key, refs.key);

    const changed = resolveDesign(
      { ...cfg.render.design, backgroundFile: "materials/second.jpg" },
      1920,
      1080,
      true,
    )!;
    const player = designForPlayer(changed, 1920, 1080, prepared);
    assert.equal(player?.assets, undefined);
    assert.equal(player?.backgroundFile, "media/materials/second.jpg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
