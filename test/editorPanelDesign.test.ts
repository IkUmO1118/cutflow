import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P2 checkpoint 1 exact-pins only the header primitive dependencies", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies["radix-ui"], "1.6.4");
  assert.equal(pkg.dependencies["lucide-react"], "1.25.0");
  assert.equal(pkg.dependencies.sonner, undefined);

  const tooltip = read("editor/client/components/ui/tooltip.tsx");
  const popover = read("editor/client/components/ui/popover.tsx");
  assert.match(tooltip, /import \{ Tooltip as TooltipPrimitive \} from "radix-ui"/);
  assert.match(tooltip, /TooltipPrimitive\.Provider/);
  assert.match(tooltip, /TooltipPrimitive\.Portal/);
  assert.match(popover, /import \{ Popover as PopoverPrimitive \} from "radix-ui"/);
  assert.match(popover, /PopoverPrimitive\.Portal/);
});

test("header owns one TooltipProvider and lets the controlled Radix Popover own trigger interaction", () => {
  const app = read("editor/client/App.tsx");
  assert.equal((app.match(/<TooltipProvider\b/g) ?? []).length, 1);
  assert.match(app, /<TooltipProvider delayDuration=\{350\}>/);
  assert.match(app, /<header className="ocHeader">/);
  assert.match(app, /<Popover open=\{exportOpen\} onOpenChange=\{setExportOpen\}>/);
  assert.match(app, /<PopoverTrigger asChild>/);
  assert.match(app, /<PopoverContent className="exportPanel" aria-label="書き出し">/);
  assert.match(app, /aria-expanded=\{exportOpen\}/);

  const triggerStart = app.indexOf("<PopoverTrigger asChild>");
  const triggerEnd = app.indexOf("</PopoverTrigger>", triggerStart);
  const trigger = app.slice(triggerStart, triggerEnd);
  assert.ok(triggerStart >= 0 && triggerEnd > triggerStart);
  assert.match(trigger, /<Button[\s\S]*className="exportTrigger"/);
  assert.doesNotMatch(trigger, /onClick=/);
  assert.doesNotMatch(app, /setExportOpen\(\(o\) => !o\)/);

  // Radix Trigger must remain the sole pointer/Enter/Space toggle owner. Its
  // controlled Root also owns Escape dismissal and focus return to this child.
  assert.match(app, /<Popover open=\{exportOpen\} onOpenChange=\{setExportOpen\}>/);
  assert.match(trigger, /aria-expanded=\{exportOpen\}/);
});

test("header migration preserves AI, layout, settings, save, approval, and export behavior", () => {
  const app = read("editor/client/App.tsx");

  assert.match(app, /disabled=\{aiWorkflowLocked\}/);
  assert.match(app, /title=\{aiWorkflowLocked \? aiWorkflowTitle : anyDirty \? "保存してから AI 一発編集" : "AI 一発編集を開く"\}/);
  assert.match(app, /setAiCommandScope\("global"\);\s+setAiCommandOpen\(true\);/);
  assert.match(app, /className=\{anyDirty \? "saveStatus dirty" : "saveStatus"\}/);
  assert.match(app, /busy === "save" \? "保存中…" : anyDirty \? "● 未保存 \(⌘S\)" : "保存済み"/);

  for (const [label, handler] of [
    ["左パネルの表示切替", "setPanelOpen"],
    ["タイムラインの表示切替", "setTimelineOpen"],
    ["右パネルの表示切替", "setInspOpen"],
  ]) {
    assert.ok(app.includes(`aria-label="${label}"`));
    assert.match(app, new RegExp(`onClick=\\{\\(\\) => ${handler}\\(\\(v\\) => !v\\)\\}`));
  }
  assert.match(app, /title=\{`左パネル\(素材\/テロップ\)を\$\{panelOpen \? "隠す" : "表示"\}/);
  assert.match(app, /title=\{`タイムラインを\$\{timelineOpen \? "隠す" : "表示"\}`\}/);
  assert.match(app, /title=\{`右パネル\(プロパティ\)を\$\{inspOpen \? "隠す" : "表示"\}/);
  assert.match(app, /onClick=\{\(\) => \(settingsOpen \? cancelSettings\(\) : openSettings\(\)\)\}/);

  assert.match(app, /type="checkbox"\s+checked=\{cutplan\.approved\}/);
  assert.match(app, /pushHistory\(\);\s+setCutplan\(\(p\) => p && \{ \.\.\.p, approved: e\.target\.checked \}\);/);
  assert.match(app, /!cutplan\.approved \|\| job\?\.status === "running" \|\| busy !== null/);
  assert.match(app, /cutplan\.approved\s+\? "最終レンダー\(final\.mp4\)を生成する。完了すると Finder で開く"/);
  assert.match(app, /setExportOpen\(false\);\s+void runExport\("render"\);/);
  assert.match(app, /disabled=\{job\?\.status === "running" \|\| busy !== null\}/);
  assert.match(app, /setExportOpen\(false\);\s+void runExport\("preview"\);/);
});

test("checkpoint 1 stays scoped away from panels, inspector, transport, and timeline", () => {
  const app = read("editor/client/App.tsx");
  const css = read("editor/client/styles.css");
  assert.match(app, /<MaterialsPanel\b/);
  assert.match(app, /<ScriptPanel\b/);
  assert.match(app, /<CaptionsPanel\b/);
  assert.match(app, /<ShortsPanel\b/);
  assert.match(app, /<Inspector\b/);
  assert.match(app, /<Timeline\b/);
  assert.match(app, /<div className="transport">/);
  assert.match(css, /P2 checkpoint 1: OpenCut compact header/);
  assert.doesNotMatch(css, /\.oc(?:SidePanel|Inspector|Transport|Timeline)\b/);
});

test("P2 checkpoint 1 provenance records exact header primitive sources and adaptations", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "5e0696bc9b921dcbaf2f42bdf3e96891a30c1e9e";
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/popover.tsx`));
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/tooltip.tsx`));
  assert.match(provenance, /`radix-ui` 1\.6\.4/);
  assert.match(provenance, /`lucide-react` 1\.25\.0/);
  assert.match(provenance, /native approval\s+checkbox/);
  assert.match(provenance, /controlled\s+Popover/);
});
