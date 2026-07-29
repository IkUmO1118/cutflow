import { strictEqual, match } from "node:assert";
import test from "node:test";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_BUILD_ID, chromeCacheDir, ensureHeadlessShell } from "../src/lib/browser.ts";

test("CHROME_BUILD_ID is pinned as a four-part version", () => {
  match(CHROME_BUILD_ID, /^\d+\.\d+\.\d+\.\d+$/);
});

test("chromeCacheDir uses HOME/.cutflow/chrome", () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "cutflow-browser-home-"));
  try {
    process.env.HOME = home;
    strictEqual(chromeCacheDir(), join(home, ".cutflow", "chrome"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test("ensureHeadlessShell returns existing CUTFLOW_CHROME_PATH without download", async () => {
  const originalPath = process.env.CUTFLOW_CHROME_PATH;
  const dir = mkdtempSync(join(tmpdir(), "cutflow-browser-path-"));
  const chromePath = join(dir, "chrome-headless-shell");
  closeSync(openSync(chromePath, "w"));
  try {
    process.env.CUTFLOW_CHROME_PATH = chromePath;
    strictEqual(await ensureHeadlessShell(), chromePath);
  } finally {
    if (originalPath === undefined) {
      delete process.env.CUTFLOW_CHROME_PATH;
    } else {
      process.env.CUTFLOW_CHROME_PATH = originalPath;
    }
  }
});
