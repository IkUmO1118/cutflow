import { deepStrictEqual, strictEqual, match } from "node:assert";
import test from "node:test";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserRenderingArgs,
  CHROME_BUILD_ID,
  chromeCacheDir,
  ensureHeadlessShell,
} from "../src/lib/browser.ts";

test("CHROME_BUILD_ID is pinned as a four-part version", () => {
  match(CHROME_BUILD_ID, /^\d+\.\d+\.\d+\.\d+$/);
});

test("chromeCacheDir uses HOME/.framewright/chrome", () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "framewright-browser-home-"));
  try {
    process.env.HOME = home;
    strictEqual(chromeCacheDir(), join(home, ".framewright", "chrome"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("ensureHeadlessShell returns existing FRAMEWRIGHT_CHROME_PATH without download", async () => {
  const originalPath = process.env.FRAMEWRIGHT_CHROME_PATH;
  const dir = mkdtempSync(join(tmpdir(), "framewright-browser-path-"));
  const chromePath = join(dir, "chrome-headless-shell");
  closeSync(openSync(chromePath, "w"));
  try {
    process.env.FRAMEWRIGHT_CHROME_PATH = chromePath;
    strictEqual(await ensureHeadlessShell(), chromePath);
  } finally {
    if (originalPath === undefined) {
      delete process.env.FRAMEWRIGHT_CHROME_PATH;
    } else {
      process.env.FRAMEWRIGHT_CHROME_PATH = originalPath;
    }
  }
});

test("browserRenderingArgs: engine の既定 GPU flags を維持する", () => {
  deepStrictEqual(browserRenderingArgs(), [
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-webgpu",
  ]);
});

test("browserRenderingArgs: DesignStill 互換 capture は sRGB と既定 GL を使う", () => {
  deepStrictEqual(browserRenderingArgs({ forceSrgb: true, useEngineGpuFlags: false }), [
    "--force-color-profile=srgb",
  ]);
});
