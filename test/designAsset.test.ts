import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderCfgWithDesign } from "../src/lib/designAsset.ts";
import type { Config } from "../src/lib/config.ts";

/** renderCfgWithDesign が読むのは render.design と manifest.video.cameraRegion
 * だけなので、Config の他のフィールドは埋めない(型だけ通す) */
function cfgWith(backgroundFile: string | undefined, enabled = true): Config {
  return {
    render: {
      design: { enabled, ...(backgroundFile ? { backgroundFile } : {}) },
    },
  } as unknown as Config;
}

/** obs-canvas 収録(cameraRegion あり)の収録フォルダを作る */
function makeRecording(camera: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-design-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      video: {
        screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
        ...(camera ? { cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 } } : {}),
      },
    }),
  );
  return dir;
}

const warns: string[] = [];
const collect = (m: string) => void warns.push(m);

test("renderCfgWithDesign: リポジトリ同梱の背景(assets/…)を render.design/ へ取り込む", () => {
  const dir = makeRecording(true);
  try {
    const out = renderCfgWithDesign(dir, cfgWith("assets/backgrounds/dusk.jpg"));
    // 収録フォルダ相対に書き換わり、実体がコピーされている
    strictEqual(out.design?.backgroundFile, "render.design/dusk.jpg");
    strictEqual(existsSync(join(dir, "render.design/dusk.jpg")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 収録フォルダ内のファイルは取り込まずそのまま使う", () => {
  const dir = makeRecording(true);
  try {
    mkdirSync(join(dir, "materials"), { recursive: true });
    writeFileSync(join(dir, "materials/bg.jpg"), "x");
    const out = renderCfgWithDesign(dir, cfgWith("materials/bg.jpg"));
    strictEqual(out.design?.backgroundFile, "materials/bg.jpg");
    strictEqual(existsSync(join(dir, "render.design")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 通常動画(plain = cameraRegion なし)には取り込まない", () => {
  const dir = makeRecording(false);
  try {
    const out = renderCfgWithDesign(dir, cfgWith("assets/backgrounds/dusk.jpg"));
    // cfg は素通し。render.design/ も作らない
    strictEqual(out.design?.backgroundFile, "assets/backgrounds/dusk.jpg");
    strictEqual(existsSync(join(dir, "render.design")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: design 無効なら何もしない", () => {
  const dir = makeRecording(true);
  try {
    const cfg = cfgWith("assets/backgrounds/dusk.jpg", false);
    strictEqual(renderCfgWithDesign(dir, cfg), cfg.render); // 同一参照 = 副作用なし
    strictEqual(existsSync(join(dir, "render.design")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 見つからない背景は警告して背景色へ劣化(レンダーは止めない)", () => {
  const dir = makeRecording(true);
  warns.length = 0;
  try {
    const out = renderCfgWithDesign(dir, cfgWith("assets/backgrounds/nope.jpg"), collect);
    strictEqual(out.design?.backgroundFile, "assets/backgrounds/nope.jpg");
    strictEqual(warns.length, 1);
    strictEqual(warns[0].includes("背景画像が見つかりません"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 2回目は再コピーしない(mtime+size が一致)", () => {
  const dir = makeRecording(true);
  try {
    const cfg = cfgWith("assets/backgrounds/dusk.jpg");
    const first = renderCfgWithDesign(dir, cfg);
    const second = renderCfgWithDesign(dir, cfg);
    deepStrictEqual(first.design, second.design);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
