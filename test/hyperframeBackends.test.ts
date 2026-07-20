import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDN_PINS } from "../src/lib/hyperframeCdn.ts";
import {
  formatHyperframeBackends,
  hyperframeBackends,
  type HyperframeBackendStatus,
} from "../src/lib/hyperframeBackends.ts";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";
import { HYPERFRAME_REQUIRE_TOKENS } from "../src/lib/hyperframeRequirements.ts";
import {
  HYPERFRAME_RENDER_PROFILE_CONFIG,
  isHyperframeRenderProfileWired,
  resolveHyperframeRenderProfile,
} from "../src/lib/hyperframeRenderProfile.ts";

const ROOT = join(import.meta.dirname, "..");

test("backend report has fixed schema, stable order, and the exact four-state assignment", () => {
  const report = hyperframeBackends();
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.backends.map(({ id, status }) => [id, status]), [
    ["css", "usable"],
    ["waapi", "usable"],
    ["svg", "usable"],
    ["dom", "usable"],
    ["canvas-2d", "usable"],
    ["gsap", "usable"],
    ["lottie", "material-routed"],
    ["raw-webgl", "usable"],
    ["three", "not-wired"],
    ["anime-js", "usable"],
    ["d3", "out"],
    ["typegpu", "out"],
    ["maps", "out"],
    ["dotlottie", "out"],
  ] satisfies Array<[string, HyperframeBackendStatus]>);
  assert.deepEqual(new Set(report.backends.map((backend) => backend.status)), new Set([
    "usable", "material-routed", "not-wired", "out",
  ]));
});

test("pin metadata is derived from CDN_PINS and its version cannot drift from the URL", () => {
  const pinned = hyperframeBackends().backends.filter((backend) => backend.pin !== null);
  assert.deepEqual(pinned.map((backend) => backend.id), ["gsap", "lottie", "anime-js"]);
  for (const backend of pinned) {
    const pin = backend.pin!;
    const source = CDN_PINS.find((candidate) => candidate.lib === pin.lib);
    assert.ok(source);
    assert.equal(pin.url, source.url);
    assert.equal(pin.version, /@([^/]+)\//.exec(source.url)?.[1]);
  }
  assert.deepEqual(HYPERFRAME_REQUIRE_TOKENS, ["gsap", "lottie", "anime", "three"]);
});

test("every usable backend names an existing check-valid real render fixture", () => {
  for (const backend of hyperframeBackends().backends) {
    if (backend.status !== "usable") continue;
    assert.ok(backend.renderFixture, `${backend.id} has no render fixture`);
    const path = join(ROOT, backend.renderFixture!);
    assert.ok(existsSync(path), `${backend.id} fixture does not exist: ${path}`);
    const result = checkComposition(readFileSync(path, "utf8"), { file: backend.renderFixture! });
    assert.deepEqual(result.errors, [], `${backend.id}: ${result.summary}`);
    assert.deepEqual(result.warnings, [], `${backend.id}: ${result.summary}`);
  }
});

test("material-routed Lottie exposes the real imported AE fixture", () => {
  const backend = hyperframeBackends().backends.find((candidate) => candidate.id === "lottie");
  assert.equal(backend?.status, "material-routed");
  assert.equal(backend?.renderFixture, "test/fixtures/lottie/hyperframes/card.html");
  const html = readFileSync(join(ROOT, backend!.renderFixture!), "utf8");
  const result = checkComposition(html, { file: backend!.renderFixture! });
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("render profile resolver shares Rule 9's GPU predicate and F2 wires gpu-angle", () => {
  assert.equal(resolveHyperframeRenderProfile("<script>listen('hf-seek')</script>"), "gpu-angle");
  assert.equal(resolveHyperframeRenderProfile('<div data-hf-requires="three"></div>'), "gpu-angle");
  assert.equal(resolveHyperframeRenderProfile('<div data-hf-requires="gsap"></div>'), "default");
  assert.equal(isHyperframeRenderProfileWired("default"), true);
  assert.equal(isHyperframeRenderProfileWired("gpu-angle"), true);
  assert.deepEqual(HYPERFRAME_RENDER_PROFILE_CONFIG, {
    default: { chromiumGl: null },
    "gpu-angle": { chromiumGl: "angle" },
  });
});

test("the 2D-then-WebGL context-null fixture is check-valid and resolves to gpu-angle", () => {
  const path = join(ROOT, "test", "fixtures", "hyperframe-backends", "raw-webgl-context-null.html");
  const html = readFileSync(path, "utf8");
  const result = checkComposition(html, { file: path });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(resolveHyperframeRenderProfile(html), "gpu-angle");
});

test("text format is stable and includes status, tier, pin, authoring route, and fixture", () => {
  const text = formatHyperframeBackends();
  assert.equal(text.split("\n").length, hyperframeBackends().backends.length + 1);
  assert.match(text, /^HyperFrame backends \(schemaVersion 1\)$/m);
  assert.match(text, /^- gsap: usable; determinism=byte; pin=gsap@3\.14\.2 https:\/\//m);
  assert.match(text, /^- lottie: material-routed; determinism=byte,perceptual; .*authoring=material-import; fixture=test\/fixtures\/lottie\/hyperframes\/card\.html$/m);
  assert.match(text, /^- raw-webgl: usable; determinism=perceptual; pin=none;.*fixture=test\/fixtures\/hyperframe-backends\/raw-webgl\.html$/m);
  assert.match(text, /^- anime-js: usable; determinism=byte; pin=anime@3\.2\.2 https:\/\/.*authoring=manual; fixture=test\/fixtures\/hyperframe-backends\/anime-js\.html$/m);
});

test("CLI --json needs no dir, emits pure JSON, and does not write the working directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cutflow-hyperframe-backends-"));
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), "hyperframe-backends", "--json"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), hyperframeBackends());
    assert.match(result.stderr, /^\(所要時間: \d+\.\d秒\)\n$/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("command documentation stays synchronized", () => {
  const agents = readFileSync(join(ROOT, "AGENTS_CONTRACT.md"), "utf8");
  const usage = readFileSync(join(ROOT, "docs", "usage.md"), "utf8");
  const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  assert.ok(agents.includes("| `hyperframe-backends`"));
  assert.ok(usage.includes("node src/cli.ts hyperframe-backends --json"));
  assert.ok(claude.includes("node src/cli.ts hyperframe-backends --json"));
});
