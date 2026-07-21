import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  acceptTailwindCliResult,
  buildEditorClientAssets,
  createEditorClientReloader,
  editorAssetResponse,
  tailwindCliArgs,
} from "../editor/clientBuild.ts";
import type {
  EditorClientAssets,
  MutableEditorClientAssets,
} from "../editor/clientBuild.ts";

const ROOT = process.cwd();
const EDITOR_DIR = join(ROOT, "editor");

function editorFiles(dir = EDITOR_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? editorFiles(path) : [path.slice(EDITOR_DIR.length + 1)];
  }).sort();
}

function assets(revision: number, marker = String(revision)): EditorClientAssets {
  return {
    bundleJs: `js-${marker}`,
    stylesCss: `css-${marker}`,
    indexHtml: `html-${marker}`,
    revision,
  };
}

test("editor client build returns non-empty JS/CSS/HTML without writing build artifacts", async () => {
  const before = editorFiles();
  const built = await buildEditorClientAssets(EDITOR_DIR, 7);
  const after = editorFiles();

  assert.equal(built.revision, 7);
  assert.ok(built.bundleJs.length > 1_000);
  assert.ok(built.stylesCss.length > 100);
  assert.ok(built.indexHtml.length > 100);
  assert.match(built.stylesCss, /--oc-background/);
  assert.match(built.stylesCss, /\.bg-primary/);
  assert.match(built.stylesCss, /\.dark/);
  assert.doesNotMatch(built.stylesCss, /box-sizing:border-box/);
  assert.deepEqual(after, before);
});

test("Tailwind uses its declared CLI entry and portable stdout output", () => {
  const args = tailwindCliArgs(join(EDITOR_DIR, "client/styles.css"));
  assert.match(args[0], /@tailwindcss[/\\]cli[/\\]dist[/\\]index\.mjs$/);
  assert.deepEqual(args.slice(args.indexOf("--output"), args.indexOf("--output") + 2), ["--output", "-"]);
  assert.ok(args.includes("--silent"));
  assert.equal(args.some((arg) => arg.includes("/dev/stdout")), false);
});

test("Tailwind process output rejects exit, signal, stderr, and empty stdout", () => {
  assert.equal(acceptTailwindCliResult({ stdout: "css", stderr: "", code: 0, signal: null }), "css");
  assert.throws(
    () => acceptTailwindCliResult({ stdout: "", stderr: "bad css", code: 1, signal: null }),
    /exit 1.*bad css/,
  );
  assert.throws(
    () => acceptTailwindCliResult({ stdout: "", stderr: "", code: null, signal: "SIGTERM" }),
    /signal SIGTERM/,
  );
  assert.throws(
    () => acceptTailwindCliResult({ stdout: "css", stderr: "warning", code: 0, signal: null }),
    /unexpected stderr/,
  );
  assert.throws(
    () => acceptTailwindCliResult({ stdout: "", stderr: "", code: 0, signal: null }),
    /produced no output/,
  );
});

test("editor asset responses expose CSS with no-store and a coherent revision", () => {
  const current = assets(4);
  const css = editorAssetResponse("/styles.css", current);
  assert.equal(css?.body, "css-4");
  assert.equal(css?.headers["Content-Type"], "text/css; charset=utf-8");
  assert.equal(css?.headers["Cache-Control"], "no-store");
  assert.equal(css?.headers["X-CutFlow-Editor-Revision"], "4");
  assert.equal(editorAssetResponse("/api/project", current), null);
});

test("editor rebuilds debounce bursts and retain the last-known-good revision", async () => {
  const mutable: MutableEditorClientAssets = { current: assets(1) };
  let calls = 0;
  let fail = true;
  const errors: unknown[] = [];
  const reloader = createEditorClientReloader({
    assets: mutable,
    debounceMs: 5,
    build: async (revision) => {
      calls += 1;
      if (fail) throw new Error("broken source");
      return assets(revision, "good");
    },
    onError: (error) => errors.push(error),
  });

  reloader.schedule();
  reloader.schedule();
  reloader.schedule();
  await reloader.flush();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(mutable.current, assets(1));

  fail = false;
  reloader.schedule();
  await reloader.flush();
  assert.equal(calls, 2);
  assert.deepEqual(mutable.current, assets(2, "good"));
  reloader.close();
});

test("editor rebuilds are single-flight and collapse changes during a build", async () => {
  const mutable: MutableEditorClientAssets = { current: assets(1) };
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | undefined;
  let startedFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reloader = createEditorClientReloader({
    assets: mutable,
    debounceMs: 1,
    build: async (revision) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        startedFirst?.();
        await firstGate;
      }
      active -= 1;
      return assets(revision, `call-${calls}`);
    },
  });

  reloader.schedule();
  const flushed = reloader.flush();
  await firstStarted;
  reloader.schedule();
  reloader.schedule();
  releaseFirst?.();
  await flushed;

  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
  assert.equal(mutable.current.revision, 3);
  assert.equal(mutable.current.bundleJs, "js-call-2");
  reloader.close();
});
