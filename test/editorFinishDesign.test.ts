import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P5 has one CSS source, OpenCut palette only, and the required cascade sections", () => {
  const html = read("editor/client/index.html");
  const css = read("editor/client/styles.css");
  assert.doesNotMatch(html, /<style\b/);
  assert.equal((html.match(/href="\/styles\.css"/g) ?? []).length, 1);
  assert.doesNotMatch(
    read("editor/client/styles.css") + read("editor/client/widgets.tsx") + read("editor/client/Timeline.tsx"),
    /var\(--(?:bg|panel2?|border|text|dim|accent|warn|danger)(?:,|\))|^\s*--(?:bg|panel2?|border|text|dim|accent|warn|danger):/m,
  );
  for (const token of ["warning", "warning-foreground", "success", "success-foreground"]) {
    assert.match(css, new RegExp(`--oc-${token}:`));
  }
  const importsAt = css.indexOf('@import "tailwindcss/theme.css"');
  const tokensAt = css.indexOf(":root {");
  const nativeAt = css.indexOf("Native fallback and shell structure");
  const skinsAt = css.indexOf("P2 checkpoint 1");
  const responsiveAt = css.lastIndexOf("@media");
  assert.ok(importsAt >= 0 && tokensAt > importsAt && nativeAt > tokensAt);
  assert.ok(skinsAt > nativeAt && responsiveAt > skinsAt);
});

test("P5 removes the verified dead legacy selectors", () => {
  const css = read("editor/client/styles.css");
  const dead = [
    "header .exportMenu", ".diffFrameChecks", ".reviewBundle h4",
    ".reviewBundle section + section", ".reviewChecks", ".status-",
    ".reviewStillGrid", ".reviewStillCard", ".reviewStillMeta", ".reviewStillPair",
    ".reviewClipPair", ".posRow", ".posGrid", ".posFields", ".presetField",
    ".materialPresetGrid", ".zoomPresetGrid", ".rectPresets",
  ];
  for (const selector of dead) assert.equal(css.includes(selector), false, selector);
});

test("shared empty and app states preserve panel callbacks and state boundaries", () => {
  const component = read("editor/client/components/EmptyState.tsx");
  const panels = read("editor/client/Panels.tsx");
  const app = read("editor/client/App.tsx");
  assert.match(component, /export const EmptyState/);
  assert.match(component, /export const AppStateView/);
  assert.match(app, /<AppStateView kind="error"[^>]+description=\{error\}/);
  assert.match(app, /<AppStateView kind="loading"/);

  const materialEmpty = panels.slice(panels.indexOf("materialCount === 0"), panels.indexOf("<div className=\"matGrid\""));
  assert.match(materialEmpty, /<EmptyState/);
  assert.match(materialEmpty, /disabled=\{busy\}/);
  assert.match(materialEmpty, /onClick=\{onUploadClick\}/);
  assert.match(materialEmpty, /disabled=\{busy \|\| !!hyperframeAuthorDisabledReason\}/);
  assert.match(materialEmpty, /authorPendingName[\s\S]*hyperframeAuthorDisabledReason/);
  assert.match(materialEmpty, /onClick=\{onNewHyperframe\}/);

  const captionsEmpty = panels.slice(panels.indexOf("transcript.segments.length === 0"), panels.indexOf('return (\n    <div className="capList">'));
  assert.match(captionsEmpty, /<EmptyState/);
  assert.doesNotMatch(captionsEmpty, /onClick=/);
  const shortsEmpty = panels.slice(panels.indexOf("list.length === 0"), panels.indexOf('<div className="capList">', panels.indexOf("list.length === 0")));
  assert.match(shortsEmpty, /<EmptyState[\s\S]*onClick=\{onAdd\}/);
  assert.ok((panels.match(/onClick=\{onAdd\}/g) ?? []).length >= 2);
  const scriptEmptyAt = panels.indexOf("rows.length === 0");
  assert.ok(panels.indexOf("if (error)") < panels.indexOf("if (!script)") && panels.indexOf("if (!script)") < scriptEmptyAt);
  assert.match(panels.slice(scriptEmptyAt, panels.indexOf('className="scriptPanel"')), /<EmptyState/);
});

test("ProjectPanel onboarding keeps summaries, guide, approval/config sections, and short injection", () => {
  const inspector = read("editor/client/Inspector.tsx");
  const at = inspector.indexOf("const ProjectPanel");
  const project = inspector.slice(at, inspector.indexOf("export const Inspector", at));
  assert.match(project, /className="projectIntro"/);
  assert.match(project, /\{shortSection\}/);
  assert.ok((project.match(/className="projRows"/g) ?? []).length >= 2);
  assert.match(project, /操作ガイド/);
  assert.match(project, /project\.approved/);
  assert.match(project, /project\.bgmTracks/);
});
