import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P2 header primitives and the later P4 Sonner dependency stay exact-pinned", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies["radix-ui"], "1.6.4");
  assert.equal(pkg.dependencies["lucide-react"], "1.25.0");
  assert.equal(pkg.dependencies.sonner, "2.0.7");

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

  const exportPopoverStart = app.indexOf("<Popover open={exportOpen} onOpenChange={setExportOpen}>");
  const triggerStart = app.indexOf("<PopoverTrigger asChild>", exportPopoverStart);
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

test("P2 panel scopes remain present while Inspector and Timeline advance in later checkpoints", () => {
  const app = read("editor/client/App.tsx");
  const css = read("editor/client/styles.css");
  assert.match(app, /<MaterialsPanel\b/);
  assert.match(app, /<ScriptPanel\b/);
  assert.match(app, /<CaptionsPanel\b/);
  assert.match(app, /<ShortsPanel\b/);
  assert.match(app, /<Inspector\b/);
  assert.match(app, /<Timeline\b/);
  assert.match(app, /<div className="transport ocTransport">/);
  assert.match(css, /P2 checkpoint 1: OpenCut compact header/);
  assert.match(css, /\.ocSidePanel\b/);
  assert.match(css, /\.ocTransport\b/);
  assert.match(css, /\.ocInspector\b/);
  assert.match(css, /\.ocTimeline\b/);

  // P6.5: timecode reads as classic (font-mono + tabular-nums, muted)
  assert.match(css, /\.ocTransport \.tcode \{[\s\S]*font-family:\s*ui-monospace[\s\S]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.ocTransport \.tRight \{ gap: 0\.45rem; \}/);

  // P6.3 left inspector: rail chrome loses its left-bar and tightens to Classic sizing.
  assert.match(css, /\.ocSidePanel \.ocIconRail \[role="tab"\]\s*\{[^}]*width:\s*2rem;/s);
  assert.doesNotMatch(css, /\.ocIconRail \[role="tab"\]::before/);
  assert.match(css, /\.ocSidePanel \.ocPaneAction\s*\{/);

  // P6.3 left inspector: captions tab gains a left-side track-add entry reusing addTrack.
  assert.match(app, /onClick=\{\(\) => addTrack\("caption"\)\}/);
});

test("P2 checkpoint 2 mounts exactly nine accessible CutFlow icon-rail tabs", () => {
  const app = read("editor/client/App.tsx");
  const tabs = app.slice(app.indexOf("const PANEL_TABS"), app.indexOf("] as const", app.indexOf("const PANEL_TABS")));
  for (const entry of [
    '["materials", "素材"]',
    '["script", "スクリプト"]',
    '["captions", "テロップ"]',
    '["shorts", "ショート"]',
    '["adjust", "色調整"]',
    '["effects", "エフェクト"]',
    '["transitions", "トランジション"]',
    '["sounds", "サウンド"]',
    '["stickers", "ステッカー"]',
  ]) assert.ok(tabs.includes(entry), `missing rail capability ${entry}`);
  assert.equal((tabs.match(/^\s*\["/gm) ?? []).length, 9);
  assert.match(app, /<nav className="tabs ocIconRail" role="tablist" aria-label="編集パネル">/);
  assert.match(app, /PANEL_TABS\.map\(\(\[id, label\]\) => \(\s*<Tooltip key=\{id\}>/);
  assert.match(app, /role="tab"[\s\S]*aria-label=\{label\}[\s\S]*aria-selected=\{tab === id\}/);
  assert.match(app, /aria-controls=\{`panel-\$\{id\}`\}/);
  assert.match(app, /onClick=\{\(\) => setTab\(id\)\}/);
  assert.match(app, /<TooltipContent side="right">\{label\}<\/TooltipContent>/);
  assert.match(app, /id=\{`panel-\$\{tab\}`\}[\s\S]*role="tabpanel"/);

  for (const capability of [
    "materials",
    "script",
    "captions",
    "shorts",
    "adjust",
    "effects",
    "transitions",
    "sounds",
    "stickers",
  ]) {
    assert.match(app, new RegExp(`\\{tab === "${capability}" && `));
  }
  assert.match(app, /if \(tab !== "script" \|\| script !== null \|\| scriptFetchingRef\.current\) return;/);
});

test("Materials reskin preserves actions, cards, drag/drop, placement, and context states", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const css = read("editor/client/styles.css");

  for (const prop of [
    "onUploadClick={onUploadClick}",
    "onUploadFiles={(files) => void uploadOnly(files)}",
    "onDelete={(f) => void deleteMaterialFile(f)}",
    "onDeleteCard={(name) => void deleteHyperframeCard(name)}",
    "onRenderHyperframe={(name) => void runHyperframeRender(name)}",
    "onNewHyperframe={openHyperframeAuthor}",
    "onDragBegin={onMaterialDragBegin}",
    "onDragEnd={onMaterialDragEnd}",
  ]) assert.ok(app.includes(prop), `missing MaterialsPanel handler ${prop}`);
  assert.match(app, /void placeMaterial\(f, null, AUDIO_ONLY_RE\.test\(f\) \? "bgm" : "overlay"\)/);

  assert.match(panels, /className=\{`matPanel ocMaterialsPanel\$\{dragOver \? " dragOver" : ""\}`\}/);
  assert.match(panels, /e\.dataTransfer\.types\.includes\("Files"\)/);
  assert.match(panels, /const files = Array\.from\(e\.dataTransfer\.files\);\s+if \(files\.length > 0\) onUploadFiles\(files\);/);
  assert.match(panels, /className="matDropOverlay"/);
  assert.match(panels, /e\.dataTransfer\.setData\(MATERIAL_MIME, file\)/);
  assert.match(panels, /chip\.className = "dragChip"/);
  assert.match(panels, /e\.dataTransfer\.setDragImage\(chip, 12, 12\)/);
  assert.match(panels, /onDragBegin\(file\)/);
  assert.match(panels, /onDoubleClick=\{\(\) => file && !busy && onPlace\(file\)\}/);
  assert.match(panels, /onDoubleClick=\{\(\) => !busy && onPlace\(m\)\}/);
  assert.match(panels, /onContextMenu=\{\(event\) => openMenu/);
  assert.match(panels, /onContextMenu=\{\(e\) => openMenu\(e, \{ file: m \}\)\}/);

  for (const state of [
    "authorPendingName &&",
    "hyperframes.map((card)",
    "materials.map((m)",
    "matThumbUnplayable",
    "hyperframesLoading",
    "hyperframesError",
    "hyperframeAuthorDisabledReason",
    "materialCount === 0",
    "inlineError",
    "needsUpdate",
    "isRendering",
  ]) assert.ok(panels.includes(state), `missing material state ${state}`);
  assert.match(panels, /disabled=\{busy\}[\s\S]*onClick=\{onUploadClick\}/);
  assert.match(panels, /disabled=\{busy \|\| !!hyperframeAuthorDisabledReason\}/);
  assert.match(panels, /onClick=\{onNewHyperframe\}/);
  assert.match(panels, /onRenderHyperframe\(card\.name\)/);
  assert.match(panels, /onPlace\(menu\.file!\)/);
  assert.match(panels, /onDelete\(menu\.file!\)/);
  assert.match(panels, /onDeleteCard\(name\)/);
  for (const selector of [
    ".ocMaterialsPanel .matCard",
    ".ocMaterialsPanel .matThumbUnplayable",
    ".ocMaterialsPanel .aiMaterialPending",
    ".ocMaterialsPanel .aiMaterialPlaceholder",
    ".ocMaterialsPanel .aiMaterialUpdateBadge",
    ".ocMaterialsPanel .aiMaterialBusy",
    ".ocMaterialsPanel .aiMaterialSpinner",
    ".ocMaterialsPanel .matDropOverlay",
    ".ocMaterialsPanel .ctxMenu",
  ]) assert.ok(css.includes(selector), `missing token skin ${selector}`);
});

test("transport reskin preserves every playback control and shortcut title", () => {
  const app = read("editor/client/App.tsx");
  const start = app.indexOf('<div className="transport ocTransport">');
  const end = app.indexOf('<ResizableHandle\n              id="right-handle"', start);
  const transport = app.slice(start, end);
  assert.ok(start >= 0 && end > start);

  assert.match(transport, /onPointerDown=\{\(e\) => \{[\s\S]*scrubTo\(e\);/);
  assert.match(transport, /onPointerMove=\{\(e\) => \{[\s\S]*scrubTo\(e\);/);
  assert.match(transport, /<ScrubProgress duration=\{duration\} \/>/);
  assert.match(transport, /<EditableTimecode seekOut=\{seekOut\} duration=\{duration\} \/>/);
  assert.match(transport, /fmtTime\(duration\)/);
  assert.match(transport, /title=\{`ミュート切替[\s\S]*onClick=\{toggleMute\}/);
  assert.match(transport, /type="range"[\s\S]*value=\{volumePct\}[\s\S]*onChange=\{\(e\) => setVolumePct\(Number\(e\.target\.value\)\)\}/);
  assert.match(transport, /onDoubleClick=\{\(\) => setVolumePct\(100\)\}/);
  assert.match(transport, /title="先頭へ \(Home\)" onClick=\{\(\) => seekOut\(0\)\}/);
  assert.match(transport, /title="1フレーム戻る \(←\)" onClick=\{\(\) => stepFrames\(-1\)\}/);
  assert.match(transport, /title="再生\/停止 \(Space\)" onClick=\{togglePlay\}/);
  assert.match(transport, /title="1フレーム進む \(→\)" onClick=\{\(\) => stepFrames\(1\)\}/);
  assert.match(transport, /title="末尾へ \(End\)" onClick=\{\(\) => seekOut\(duration\)\}/);
  assert.match(transport, /title="ループ再生\(プレビューのみ\)"[\s\S]*setLoop\(\(v\) => !v\)/);
  assert.match(transport, /value=\{activeShortName \?\? ""\}[\s\S]*setActiveShortName\(e\.target\.value \|\| null\)/);
  assert.match(transport, /value=\{playbackRate\}[\s\S]*setPlaybackRate\(Number\(e\.target\.value\)\)/);
  assert.match(transport, /title="1秒戻る \(Shift\+←\)" onClick=\{\(\) => stepFrames\(-fps\)\}/);
  assert.match(transport, /title="1秒進む \(Shift\+→\)" onClick=\{\(\) => stepFrames\(fps\)\}/);
  assert.match(transport, /setMaximized\(\(v\) => !v\)/);
  assert.match(transport, /onClick=\{toggleFullscreen\}/);
});

test("transport has a scoped deterministic 1024px wrap rule", () => {
  const css = read("editor/client/styles.css");
  assert.match(css, /@media \(max-width: 1024px\) \{[\s\S]*\.ocTransport \.tRow \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.ocTransport \.tCenter \{[\s\S]*order: 1;[\s\S]*width: 100%;[\s\S]*justify-content: center;/);
  assert.match(css, /\.ocTransport \.tLeft \{ order: 2; \}/);
  assert.match(css, /\.ocTransport \.tRight \{ order: 3; \}/);
  assert.match(css, /\.ocTransport \.tLeft,[\s\S]*\.ocTransport \.tRight \{[\s\S]*flex: 1 1 100%;[\s\S]*width: 100%;[\s\S]*justify-content: center;[\s\S]*flex-wrap: wrap;[\s\S]*overflow: visible;/);
});

test("P2 checkpoint 1 provenance records exact header primitive sources and adaptations", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "cf5e79e919144200294fb9fed22a222592a0aeea";
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/popover.tsx`));
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/tooltip.tsx`));
  assert.match(provenance, /`radix-ui` 1\.6\.4/);
  assert.match(provenance, /`lucide-react` 1\.25\.0/);
  assert.match(provenance, /native approval\s+checkbox/);
  assert.match(provenance, /controlled\s+Popover/);
});

test("P2 checkpoint 2 provenance records assets rail and transport adaptation boundaries", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "cf5e79e919144200294fb9fed22a222592a0aeea";
  for (const source of [
    "apps/web/src/app/globals.css",
    "apps/web/src/components/ui/button.tsx",
    "apps/web/src/components/ui/native-select.tsx",
    "apps/web/src/components/ui/slider.tsx",
  ]) assert.ok(provenance.includes(`${revision}/${source}`), `missing provenance ${source}`);
  assert.match(provenance, /exactly CutFlow's four existing capabilities \(`materials`,\s+`script`, `captions`, `shorts`\)/);
  assert.match(provenance, /OS-file upload, HyperFrames AI\s+authoring/);
  assert.match(provenance, /scoped 1024px multi-row rule/);
  assert.match(provenance, /dual-axis Timeline and Inspector remain untouched/);
});

test("P7.2 adds click-to-edit timecode and a preview-only zoom control", () => {
  const app = read("editor/client/App.tsx");
  const css = read("editor/client/styles.css");

  assert.match(app, /<NativeSelect[\s\S]*className="zoomSel"[\s\S]*setPreviewZoom\(/);
  assert.match(app, /className="viewerScale"[\s\S]*transform: `scale\(\$\{previewZoom\}\)`/);
  assert.match(css, /\.viewer \.viewerTools \.zoomSel/);
  assert.match(css, /\.ocTransport \.tSlash \{[\s\S]*padding: 0 0\.4rem;/);
});

test("P7.3a Adjustment tab is the first colorFilter UI, global and cleaned to undefined", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const tabsStart = app.indexOf("const PANEL_TABS");
  const tabs = app.slice(tabsStart, app.indexOf("] as const", tabsStart));
  assert.ok(tabs.includes('["adjust", "色調整"]'), "missing adjust PANEL_TABS entry");
  assert.match(app, /const updateColorFilter = \(patch: Partial<ColorFilter>/);
  assert.match(app, /Object\.keys\(merged\)\.length === 0/); // all-default -> drop colorFilter
  assert.match(app, /const resetColorFilter = \(\)/);
  assert.match(app, /<AdjustmentPanel[\s\S]*onChange=\{updateColorFilter\}[\s\S]*onReset=\{resetColorFilter\}/);
  assert.match(panels, /export const AdjustmentPanel = \(/);
  assert.match(panels, /"overlays:colorFilter"/); // coalesce key collapses drag to one undo
});

test("P7.3b-e launcher/picker tabs route to existing add/place handlers at playhead", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const tabsStart = app.indexOf("const PANEL_TABS");
  const tabs = app.slice(tabsStart, app.indexOf("] as const", tabsStart));
  for (const e of ['["effects", "エフェクト"]', '["transitions", "トランジション"]', '["sounds", "サウンド"]', '["stickers", "ステッカー"]'])
    assert.ok(tabs.includes(e), `missing tab ${e}`);
  // shared add-at-playhead converts OUTPUT->SOURCE then reuses addByKind
  assert.match(app, /const addAtPlayhead = \(kind: AddKind\) => \{[\s\S]*srcAt\(outT\)[\s\S]*addByKind\(kind, round2\(s\), round2\(e\)\)/);
  assert.match(app, /<EffectsPanel onAdd=\{[\s\S]*addAtPlayhead/);
  assert.match(app, /addAtPlayhead\("wipeFull"\)/);
  // pickers reuse the existing placeMaterial path with forced kind + audio filter
  assert.match(app, /files=\{materials\.filter\(\(f\) => AUDIO_ONLY_RE\.test\(f\)\)\}[\s\S]*placeMaterial\(f, null, "bgm"\)/);
  assert.match(app, /files=\{materials\.filter\(\(f\) => !AUDIO_ONLY_RE\.test\(f\)\)\}[\s\S]*placeMaterial\(f, null, "overlay"\)/);
  assert.match(panels, /export const EffectsPanel = \(/);
  assert.match(panels, /export const AssetPickerPanel = \(/);
});

test("P7.4b duplicate (⌘D) reuses the vetted paste clone path and adds insert", () => {
  const app = read("editor/client/App.tsx");
  const timeline = read("editor/client/Timeline.tsx");
  // shared clone+place path
  assert.match(app, /const insertClipAt = \(clip: Clipboard, base: number\)/);
  assert.match(app, /const pasteClipboard = \(\) => \{[\s\S]*insertClipAt\(clip, base\)/);
  // duplicate places immediately after the original (source end) via the same path
  assert.match(app, /insertClipAt\(clip, clip\.entry\.end\)/);
  // insert branch (Clipboard-unsupported) duplicates via at+durationSec
  assert.match(app, /at: round2\(ins\.at \+ ins\.durationSec\), id: undefined/);
  // ⌘D keybind
  assert.match(app, /e\.key\.toLowerCase\(\) === "d"[\s\S]*duplicateSelected\(\)/);
  // toolbar button, no context menu
  assert.match(timeline, /aria-label="複製"[\s\S]*onClick=\{onDuplicate\}/);
  assert.doesNotMatch(timeline, /onContextMenu=/);
});
