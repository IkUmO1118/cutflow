import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P1 pins react-resizable-panels and adapts the thin wrapper to its v4 API", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  const wrapper = read("editor/client/components/ui/resizable.tsx");

  assert.equal(pkg.dependencies["react-resizable-panels"], "4.12.2");
  assert.match(wrapper, /ResizablePrimitive\.Group/);
  assert.match(wrapper, /ResizablePrimitive\.Panel/);
  assert.match(wrapper, /ResizablePrimitive\.Separator/);
  assert.doesNotMatch(wrapper, /ResizablePrimitive\.(?:PanelGroup|PanelResizeHandle)/);
});

test("P1 shell is nested vertical then horizontal with the required pixel constraints", () => {
  const app = read("editor/client/App.tsx");
  const outerAt = app.indexOf('id="cutflow-shell"');
  const mainAt = app.indexOf('id="main"', outerAt);
  const innerAt = app.indexOf('id="cutflow-stage"', mainAt);
  const leftAt = app.indexOf('id="left"', innerAt);
  const viewerAt = app.indexOf('id="viewer"', leftAt);
  const rightAt = app.indexOf('id="right"', viewerAt);
  const timelineAt = app.indexOf('id="timeline"', rightAt);

  assert.ok(outerAt >= 0 && mainAt > outerAt && innerAt > mainAt);
  assert.ok(leftAt > innerAt && viewerAt > leftAt && rightAt > viewerAt);
  assert.ok(timelineAt > rightAt);
  assert.match(app.slice(outerAt, mainAt), /orientation="vertical"/);
  assert.match(app.slice(innerAt, leftAt), /orientation="horizontal"/);
  assert.match(app, /const PANEL_MIN = 280;/);
  assert.match(app, /const INSP_MIN = 300;/);
  assert.match(app, /const VIEWER_MIN = 360;/);
  assert.match(app, /const TIMELINE_MIN = 140;/);
  assert.match(app, /const STAGE_MIN = 200;/);
  assert.equal((app.match(/groupResizeBehavior="preserve-pixel-size"/g) ?? []).length, 3);
  assert.equal((app.match(/groupResizeBehavior="preserve-relative-size"/g) ?? []).length, 2);
  assert.equal((app.match(/collapsedSize=\{0\}/g) ?? []).length, 3);
  assert.equal((app.match(/\bcollapsible\b/g) ?? []).length, 3);
  assert.doesNotMatch(app.slice(mainAt, innerAt), /defaultSize="100%"/);
});

test("P1 retains existing storage and mounted children while removing manual split drag", () => {
  const app = read("editor/client/App.tsx");
  for (const key of [
    "cutflow.editor.panelW",
    "cutflow.editor.inspW",
    "cutflow.editor.timelineH",
    "cutflow.editor.panelOpen",
    "cutflow.editor.inspOpen",
    "cutflow.editor.timelineOpen",
  ]) {
    assert.ok(app.includes(key), `missing persistence key: ${key}`);
  }

  assert.doesNotMatch(app, /beginSplitDrag|onSplitterDown|onInspSplitterDown|onHSplitterDown|stageRef/);
  assert.match(app, /<MaterialsPanel\b/);
  assert.match(app, /<ScriptPanel\b/);
  assert.match(app, /<CaptionsPanel\b/);
  assert.match(app, /<ShortsPanel\b/);
  assert.match(app, /<Inspector\b/);
  assert.match(app, /<Timeline\b/);
  assert.match(app, /className="viewerCol panel shellSurface" ref=\{viewerColRef\}/);
});

test("P1 collapse and maximize synchronize through panel refs without persistence feedback", () => {
  const app = read("editor/client/App.tsx");

  assert.match(app, /panelRef=\{sidePanelRef\}/);
  assert.match(app, /panelRef=\{inspectorPanelRef\}/);
  assert.match(app, /panelRef=\{timelinePanelRef\}/);
  assert.match(app, /if \(maximized \|\| !open\) panel\.collapse\(\);/);
  assert.match(app, /panel\.expand\(\);\s+panel\.resize\(sizePx\);/);
  assert.match(app, /const panelPixelSpan =/);
  assert.match(app, /setPanelW\(Math\.round\(span \* left \/ 100\)\)/);
  assert.match(app, /setTimelineH\(Math\.round\(span \* timeline \/ 100\)\)/);
  assert.doesNotMatch(app, /getSize\(\)\.inPixels/);
  assert.equal((app.match(/if \(!meta\.isUserInteraction \|\| maximized\) return;/g) ?? []).length, 2);
  assert.equal((app.match(/disableDoubleClick/g) ?? []).length, 3);
  assert.equal((app.match(/onDoubleClick=\{\(\) => set(?:PanelOpen|InspOpen|TimelineOpen)/g) ?? []).length, 3);
  assert.match(app, /else void viewerColRef\.current\?\.requestFullscreen\(\);/);
});

test("P1 shell styling uses OpenCut's compact separator gap, px-3 padding, rounded token surfaces, and token handles", () => {
  const css = read("editor/client/styles.css");

  assert.match(css, /\.editorShell\s*\{[^}]*padding:\s*0 12px 12px;/s);
  assert.match(css, /\.resizableHandle\s*\{[^}]*width:\s*0\.18rem;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.resizableHandle\[aria-orientation="horizontal"\]\s*\{[^}]*height:\s*0\.18rem;/s);
  assert.match(css, /\.shellSurface\s*\{[^}]*background:\s*hsl\(var\(--oc-card\)\);/s);
  assert.match(css, /border-radius:\s*var\(--oc-radius\);/);
  assert.match(css, /\.resizableHandle:focus-visible\s*\{[^}]*box-shadow:[^}]*hsl\(var\(--oc-ring\)\)/s);
  assert.match(css, /\.app\.max \.resizableHandle \{ display: none; \}/);
  assert.doesNotMatch(css, /\.splitter(?:\s|\.|\{|,)/);
});

test("P1 provenance records OpenCut layout and resizable sources plus the v4 adaptation", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");

  assert.match(provenance, /app\/editor\/%5Bproject_id%5D\/page\.tsx/);
  assert.match(provenance, /components\/ui\/resizable\.tsx/);
  assert.match(provenance, /react-resizable-panels` 4\.12\.2/);
  assert.match(provenance, /`Group`\/`Panel`\/`Separator` API/);
});
