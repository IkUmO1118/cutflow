import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HttpError,
  createProjectDirectory,
  listProjects,
  normalizeProjectName,
  resolveLauncherProject,
} from "../editor/server.ts";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("project launcher: 直下ディレクトリを列挙し共有/hiddenを除外する", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-"));
  try {
    for (const name of ["empty", "ready", "hyperframe-seeds", "style.probe", ".hidden"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "ready", "manifest.json"), JSON.stringify({ durationSec: 42, canvas: "portrait" }));
    writeFileSync(join(root, "ready", "final.mp4"), "done");
    const projects = listProjects(root);
    assert.deepEqual(projects.map((p) => p.name).sort(), ["empty", "ready"]);
    const empty = projects.find((p) => p.name === "empty")!;
    assert.equal(empty.hasManifest, false);
    assert.equal(empty.durationSec, null);
    assert.equal(empty.canvas, "landscape");
    const ready = projects.find((p) => p.name === "ready")!;
    assert.equal(ready.hasManifest, true);
    assert.equal(ready.durationSec, 42);
    assert.equal(ready.canvas, "portrait");
    assert.equal(ready.rendered, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project launcher: 新規作成は正規化し、衝突と traversal を拒否する", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-create-"));
  try {
    assert.equal(normalizeProjectName("../bad:name"), "bad_name");
    const created = createProjectDirectory(root, { name: "../bad:name", canvas: "square", layout: "plain" });
    assert.equal(created.name, "bad_name");
    assert.throws(() => createProjectDirectory(root, { name: "bad_name", canvas: "square" }), (e) => e instanceof HttpError && e.status === 409);
    for (const name of ["../outside", "/tmp/outside", "a/b", ".hidden"]) {
      assert.throws(() => resolveLauncherProject(root, name), HttpError);
    }
    assert.equal(resolveLauncherProject(root, "safe"), join(root, "safe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project creation UI hides baseLayout inputs while API helpers keep defaulted signatures", () => {
  const app = read("editor/client/App.tsx");
  const widgets = read("editor/client/widgets.tsx");
  const panels = read("editor/client/Panels.tsx");

  assert.doesNotMatch(app, /aria-label="ベース配置"/);
  assert.doesNotMatch(app, /window\.prompt\("ベース配置/);
  assert.doesNotMatch(app, /initialBaseLayoutFromSearch/);
  assert.doesNotMatch(app, /baseLayout=\$\{encodeURIComponent\(baseLayout\)\}/);
  assert.match(app, /createProject\(name\.trim\(\), canvas\)/);
  assert.match(app, /postBaseMedia\(file, baseCanvas\)/);
  assert.match(app, /uploadBaseMedia\(file, baseCanvas\)/);
  assert.match(app, /postDerive\(name, canvas, \[\{ start: segment\.start, end: segment\.end \}\]\)/);

  assert.match(widgets, /createProject\(name: string, canvas: string, baseLayout = "auto", layout = "plain"\)/);
  assert.match(widgets, /postDerive\(name: string, canvas: string, ranges: Array<\{ start: number; end: number \}>, baseLayout = "auto"\)/);
  assert.match(widgets, /postBaseMedia\(file: string, canvas: string, baseLayout = "auto"\)/);
  assert.match(widgets, /uploadBaseMedia\(file: File, canvas: string, baseLayout = "auto"\)/);

  assert.match(app, /baseLayout=\{proj\.manifest\.baseLayout \?\? "auto"\}/);
  assert.match(panels, /<span className="ocSettingsLabel">ベース配置<\/span>/);
  assert.match(panels, /<span className="ocSettingsValue mono">\{baseLayout\}<\/span>/);
});
