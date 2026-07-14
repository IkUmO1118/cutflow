import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderCfgWithDesign } from "../src/lib/designAsset.ts";
import type { Config } from "../src/lib/config.ts";

/** renderCfgWithDesign が読むのは render.design だけなので、Config の他の
 * フィールドは埋めない(型だけ通す) */
function cfgWith(backgroundFile: string | undefined, enabled = true): Config {
  return {
    render: {
      design: { enabled, backgroundColor: "#123456", ...(backgroundFile ? { backgroundFile } : {}) },
    },
  } as unknown as Config;
}

function makeRecording(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-design-"));
  return dir;
}

const warns: string[] = [];
const collect = (m: string) => void warns.push(m);

test("renderCfgWithDesign: plainでもリポジトリ同梱背景を render.design/ へ取り込む", () => {
  const dir = makeRecording();
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
  const dir = makeRecording();
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

test("renderCfgWithDesign: 絶対パス背景をplainでも取り込み、変更時だけcacheを更新する", () => {
  const dir = makeRecording();
  const sourceDir = mkdtempSync(join(tmpdir(), "cutflow-design-source-"));
  const source = join(sourceDir, "custom.jpg");
  try {
    writeFileSync(source, "first");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(source, fixedTime, fixedTime);
    const cfg = cfgWith(source);
    const first = renderCfgWithDesign(dir, cfg);
    strictEqual(first.design?.backgroundFile, "render.design/custom.jpg");
    const dest = join(dir, "render.design/custom.jpg");
    strictEqual(readFileSync(dest, "utf8"), "first");

    // 同じsize+mtimeなら再コピーしない。destだけを書き換えてmtimeをsourceへ
    // 合わせることで、cache hitならその内容が維持されることを観測する。
    writeFileSync(dest, "local");
    const sourceStat = statSync(source);
    utimesSync(dest, sourceStat.atime, sourceStat.mtime);
    deepStrictEqual(renderCfgWithDesign(dir, cfg).design, first.design);
    strictEqual(readFileSync(dest, "utf8"), "local");

    // source変更(size差)はcacheをinvalidateして新しい内容を取り込む。
    writeFileSync(source, "changed-source");
    renderCfgWithDesign(dir, cfg);
    strictEqual(readFileSync(dest, "utf8"), "changed-source");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: design 無効なら何もしない", () => {
  const dir = makeRecording();
  try {
    const cfg = cfgWith("assets/backgrounds/dusk.jpg", false);
    strictEqual(renderCfgWithDesign(dir, cfg), cfg.render); // 同一参照 = 副作用なし
    strictEqual(existsSync(join(dir, "render.design")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 見つからない背景は警告して背景色へ劣化(レンダーは止めない)", () => {
  const dir = makeRecording();
  warns.length = 0;
  try {
    const out = renderCfgWithDesign(dir, cfgWith("assets/backgrounds/nope.jpg"), collect);
    strictEqual(out.design?.backgroundFile, "assets/backgrounds/nope.jpg");
    strictEqual(out.design?.backgroundColor, "#123456");
    strictEqual(warns.length, 1);
    strictEqual(warns[0].includes("背景画像が見つかりません"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCfgWithDesign: 背景なしは同一参照を返し副作用がない", () => {
  const dir = makeRecording();
  try {
    const cfg = cfgWith(undefined);
    strictEqual(renderCfgWithDesign(dir, cfg), cfg.render);
    strictEqual(existsSync(join(dir, "render.design")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
