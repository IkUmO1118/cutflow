import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreDialogFocus } from "../editor/client/lib/dialogFocus.ts";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P4 checkpoint 1 adds scoped roots without replacing semantic hooks", () => {
  const command = read("editor/client/AiCommand.tsx");
  const visual = read("editor/client/AiVisualReview.tsx");
  const diff = read("editor/client/DiffReview.tsx");
  const settings = read("editor/client/SettingsModal.tsx");
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");

  assert.match(command, /className=\{`aiCommand ocAiCommand\$\{compact/);
  assert.match(visual, /className="aiReviewModal ocAiReview" aria-label="AI 一発編集レビュー"/);
  assert.match(diff, /className="diffModal ocDiffReview" aria-label="外部変更の差分レビュー"/);
  assert.match(settings, /className="settingsModal ocSettings" aria-label="設定"/);
  // HyperFrames の生成フォームはモーダルではなく「AI 生成」タブのパネル本体
  // (Panels.tsx の HyperframeAuthorPanel)。ocHyperframeAuthor は panelBody に付く
  assert.match(panels, /className="panelBody ocHyperframeAuthor"/);
  assert.doesNotMatch(app, /className="aiCommandModal hfAuthorModal ocHyperframeAuthor"/);
  assert.match(app, /className="aiCommandModal ocAiCommandModal" aria-label="AI 一発編集"/);

  for (const hook of [
    "aiCommand", "aiCommandModal", "aiScopeTabs", "aiReviewGrid",
    "aiReviewModeSwitch", "aiReviewDecisionToggle", "diffList", "diffHunk",
    "diffValue", "hfAssetDrop", "hfAssetList", "settingsTabs", "settingsCard",
    "doctorRow",
  ]) assert.ok([command, visual, diff, settings, app, panels].some((source) => source.includes(hook)), `lost hook ${hook}`);
});

test("P4 wrappers use exact-pinned Radix primitives for focus, keys, and scroll mechanics", () => {
  const dialog = read("editor/client/components/ui/dialog.tsx");
  const tabs = read("editor/client/components/ui/tabs.tsx");
  const scroll = read("editor/client/components/ui/scroll-area.tsx");
  const toggle = read("editor/client/components/ui/toggle-group.tsx");
  for (const source of [dialog, tabs, scroll, toggle]) {
    assert.match(source, /from "radix-ui"/);
  }
  for (const primitive of ["Root", "Portal", "Overlay", "Content", "Close", "Title", "Description"]) {
    assert.ok(dialog.includes(`DialogPrimitive.${primitive}`), `missing Dialog primitive ${primitive}`);
  }
  assert.doesNotMatch(dialog, /onCloseAutoFocus/);
  for (const primitive of ["Root", "List", "Trigger", "Content"]) {
    assert.ok(tabs.includes(`TabsPrimitive.${primitive}`), `missing Tabs primitive ${primitive}`);
  }
  for (const primitive of ["Root", "Viewport", "Scrollbar", "Thumb", "Corner"]) {
    assert.ok(scroll.includes(`ScrollAreaPrimitive.${primitive}`), `missing ScrollArea primitive ${primitive}`);
  }
  assert.match(toggle, /ToggleGroupPrimitive\.Root/);
  assert.match(toggle, /ToggleGroupPrimitive\.Item/);
});

test("AI command submit, disabled, busy, and input retention semantics stay native", () => {
  const source = read("editor/client/AiCommand.tsx");
  for (const contract of [
    "const blocked = disabled || busy || instruction.trim().length === 0",
    "e.preventDefault()",
    "if (blocked) return",
    "onSubmit(instruction.trim())",
    "if (clearOnSubmit) setInstruction(\"\")",
    "disabled={disabled || busy}",
    "disabled={blocked}",
    "onChange={(e) => setInstruction(e.target.value)}",
  ]) assert.ok(source.includes(contract), `lost AI command contract: ${contract}`);
});

test("AI propose, review, refine, apply, and warning-fix routing remains intact", () => {
  const app = read("editor/client/App.tsx");
  for (const api of [
    "postAiPropose", "postAiReview", "postAiRefine", "postSave",
  ]) assert.ok(app.includes(api), `lost API client ${api}`);
  for (const contract of [
    "instruction,\n        activeShortName,\n        selection: buildAiSelectionContext(scope)",
    "acceptedHunkLabels: acceptedAiHunkLabels(aiWorkflowReview)",
    'secondaryObservation: withVlm ? "vlm" : "none"',
    "instruction: options.instruction?.trim() || undefined",
    "vlm: options.withVlm",
    "mode,",
    "onGenerateReview={({ withVlm }) => void generateAiReview({ withVlm })}",
    "onRefine={(options) => void refineAiWorkflow(options)}",
    'onFixWarnings={({ withVlm }) => void refineAiWorkflow({ mode: "warning-fix", withVlm })}',
    "onApply={() => void applyAiWorkflow({ save: true, reviewFirst: false })}",
  ]) assert.ok(app.includes(contract), `lost AI workflow route: ${contract}`);
});

test("visual review keeps event selection, preview modes, hunk decisions, and state gates", () => {
  const source = read("editor/client/AiVisualReview.tsx");
  for (const prop of [
    "onSetHunks", "onBulk", "onGenerateReview", "onRefine", "onFixWarnings",
    "onApply", "onCancel", "checkingFrames", "refining", "reviewStale",
  ]) assert.ok(source.includes(prop), `lost visual review prop ${prop}`);
  for (const contract of [
    'useState<PreviewMode>("after")',
    'type="single"',
    'value={previewMode}',
    'onValueChange={(value) => value && setPreviewMode(value as PreviewMode)}',
    'value="after"',
    'value="before"',
    'value="side-by-side"',
    'value="overlay"',
    'onSetHunks(selectedHunks, side)',
    'onBulk("mine")',
    'onBulk("theirs")',
    'aria-label="この変更の採否"',
    'if (value === "skip") setSelectedSide("mine")',
    'if (value === "use") setSelectedSide("theirs")',
    "disabled={actionsDisabled}",
  ]) assert.ok(source.includes(contract), `lost visual review contract: ${contract}`);
});

test("conflict review keeps mine/theirs defaults and hunk-resolution callbacks", () => {
  const source = read("editor/client/DiffReview.tsx");
  for (const contract of [
    'type Side = "theirs" | "mine"',
    'const selected = resolution.get(hunk) ?? "theirs"',
    'onBulk("mine")',
    'onBulk("theirs")',
    'onChoose={() => onSet(hunk, "mine")}',
    'onChoose={() => onSet(hunk, "theirs")}',
    "onOpenChange={(open) => !open && onCancel()}",
    "<DialogClose asChild>",
    "onClick={onApply}",
    'selected ? "採用予定" : "クリックして採用"',
  ]) assert.ok(source.includes(contract), `lost conflict contract: ${contract}`);
});

test("HyperFrames authoring keeps file gates, keyboard drop target, progress, and API routing", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  // 送信ロジック(検証・busy・pending・API 呼び出し)は App.tsx のまま
  for (const contract of [
    "if (hyperframeAuthorBusy) return",
    "if (!HYPERFRAME_NAME_RE.test(name))",
    "/\\.(png|jpe?g|gif|webp|woff2)$/i.test(file.name)",
    "next.reduce((sum, file) => sum + file.size, 0) > hyperframeAssetLimits.maxTotalBytes",
    "addHyperframeAuthorAssets([...event.dataTransfer.files])",
    "setHyperframeAuthorPendingName(name)",
    "await postHyperframeAuthor(name, brief, assets)",
    "setHyperframeAuthorBusy(false)",
    "setHyperframeAuthorPendingName(null)",
    "onAssetDrop={onHyperframeAssetDrop}",
    "clearOnSubmit={false}",
  ]) assert.ok(app.includes(contract), `lost HyperFrames contract: ${contract}`);
  // モーダルの開閉概念は無い(タブなので閉じない)
  assert.ok(!app.includes("setHyperframeAuthorOpen"), "HyperFrames modal open/close state should be gone");
  // 添付ドロップの UI(キーボード操作対象・ファイル種別)は Panels.tsx の
  // HyperframeAuthorPanel(「AI 生成」タブ)へ移った
  for (const contract of [
    "tabIndex={busy ? -1 : 0}",
    'event.key === "Enter" || event.key === " "',
    'accept=".png,.jpg,.jpeg,.gif,.webp,.woff2,image/png,image/jpeg,image/gif,image/webp,font/woff2"',
    "onDrop={onAssetDrop}",
  ]) assert.ok(panels.includes(contract), `lost HyperFrames panel contract: ${contract}`);
});

test("Settings keeps controlled tabs, live patching, snapshot rollback, save, and doctor flow", () => {
  const settings = read("editor/client/SettingsModal.tsx");
  const app = read("editor/client/App.tsx");
  for (const tab of ['["ai", "AI / plan"]', '["look", "見た目"]', '["audio", "音声"]', '["editor", "エディタ"]']) {
    assert.ok(settings.includes(tab), `lost Settings tab ${tab}`);
  }
  for (const contract of [
    '<Tabs className="settingsTabsRoot" value={tab} onValueChange={(value) => setTab(value as typeof tab)}>',
    '<TabsList className="settingsTabs" aria-label="設定カテゴリ">',
    "<TabsTrigger",
    '<TabsContent value="ai" className="settingsTabPanel">',
    '<TabsContent value="look" className="settingsTabPanel">',
    '<TabsContent value="audio" className="settingsTabPanel">',
    '<TabsContent value="editor" className="settingsTabPanel">',
    "<DialogClose asChild>",
    "onClick={onSave}",
    "onAiDoctor()",
    'onAiDoctor("vision")',
  ]) assert.ok(settings.includes(contract), `lost Settings control: ${contract}`);
  for (const contract of [
    "settingsSnapRef.current = structuredClone(cfgValuesOf(proj))",
    "projectWithCfgPatch(p, structuredClone(snap))",
    "const patch = buildConfigPatch(snap, cfgValuesOf(proj))",
    "const res = await postConfig(patch)",
    "if (patchTouchesProxy(patch))",
    "setSettingsOpen(false)",
    "setSettingsError((e as Error).message)",
    "setAiDoctorResult(await postAiDoctor(route ? { route } : {}))",
  ]) assert.ok(app.includes(contract), `lost Settings route: ${contract}`);
});

test("controlled dialogs preserve close routing, focus return, and busy dismissal guards", () => {
  const app = read("editor/client/App.tsx");
  const visual = read("editor/client/AiVisualReview.tsx");
  const diff = read("editor/client/DiffReview.tsx");
  const settings = read("editor/client/SettingsModal.tsx");
  for (const contract of [
    "onOpenChange={(open) => !open && setAiCommandOpen(false)}",
  ]) assert.ok(app.includes(contract), `lost App dialog policy: ${contract}`);
  // HyperFrames はもうモーダルではないので、busy 中の外側クリック/Escape 抑止は不要
  assert.ok(!app.includes("hyperframeAuthorBusy && event.preventDefault()"), "HF-only dialog dismiss guard should be gone");
  for (const contract of [
    "onOpenChange={(open) => !open && !actionsDisabled && onCancel()}",
    "onEscapeKeyDown={preventDialogDismiss}",
    "onPointerDownOutside={preventDialogDismiss}",
    "const preventDialogDismiss = (event: Event) => event.preventDefault()",
  ]) assert.ok(visual.includes(contract), `lost visual-review dialog policy: ${contract}`);
  for (const contract of [
    "onOpenChange={(open) => !open && onCancel()}",
    "onEscapeKeyDown={(event) => event.preventDefault()}",
    "onPointerDownOutside={(event) => event.preventDefault()}",
  ]) assert.ok(diff.includes(contract), `lost diff-review dialog policy: ${contract}`);
  for (const contract of [
    "onOpenChange={(open) => !open && !saving && onCancel()}",
    "onEscapeKeyDown={guardSettingsEscapeDismiss}",
    "onPointerDownOutside={guardSavingDismiss}",
    "isSettingsDraftField(event.target)",
    "isSettingsDraftField(document.activeElement)",
    "if (saving) event.preventDefault()",
  ]) assert.ok(settings.includes(contract), `lost Settings dialog policy: ${contract}`);
  for (const source of [app, visual, diff, settings]) assert.match(source, /<DialogClose asChild>/);
});

test("controlled Dialog teardown restores each launcher or previously focused element", () => {
  const app = read("editor/client/App.tsx");
  const visual = read("editor/client/AiVisualReview.tsx");
  const diff = read("editor/client/DiffReview.tsx");
  const settings = read("editor/client/SettingsModal.tsx");
  for (const contract of [
    "const aiCommandLauncherRef = useRef<HTMLButtonElement | null>(null)",
    "ref={aiCommandLauncherRef}",
    "restoreDialogFocus(event, aiCommandLauncherRef.current)",
  ]) assert.ok(app.includes(contract), `lost App focus-return contract: ${contract}`);
  // HyperFrames はもうモーダルではない(タブに閉じる概念は無い)ので、
  // 返却フォーカス管理は不要になっている
  assert.ok(!app.includes("hyperframeAuthorReturnFocusRef"), "hyperframeAuthorReturnFocusRef should be removed");
  for (const source of [visual, diff, settings]) {
    assert.match(source, /const returnFocusRef = useRef<HTMLElement \| null>/);
    assert.match(source, /onCloseAutoFocus=\{\(event\) => restoreDialogFocus\(event, returnFocusRef\.current\)\}/);
  }
  const aiKeyBranch = app.match(/if \(aiCommandOpen\) \{([\s\S]*?)\n      \}/)?.[1] ?? "";
  assert.ok(aiKeyBranch, "missing AI command keyboard guard");
  assert.doesNotMatch(aiKeyBranch, /setAiCommandOpen\(false\)/);
});

test("restoreDialogFocus prevents native fallback and focuses the target exactly once", () => {
  let prevented = 0;
  let focused = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  const target = { focus: () => { focused += 1; } };
  restoreDialogFocus(event, target);
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
  restoreDialogFocus(event, null);
  assert.equal(prevented, 2);
  assert.equal(focused, 1);
});

test("Settings field Escape keeps the modal open while non-field Escape cancels exactly once", () => {
  const app = read("editor/client/App.tsx");
  const settings = read("editor/client/SettingsModal.tsx");
  assert.match(
    settings,
    /const isSettingsDraftField = \(target: EventTarget \| null\)[\s\S]*?\["INPUT", "SELECT", "TEXTAREA"\]\.includes\(target\.tagName\)/,
  );
  assert.match(
    settings,
    /const guardSettingsEscapeDismiss = \(event: Event\) => \{[\s\S]*?saving[\s\S]*?isSettingsDraftField\(event\.target\)[\s\S]*?isSettingsDraftField\(document\.activeElement\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(settings, /onEscapeKeyDown=\{guardSettingsEscapeDismiss\}/);
  assert.match(settings, /onPointerDownOutside=\{guardSavingDismiss\}/);

  const settingsKeyBranch = [...app.matchAll(/if \(settingsOpen\) \{([\s\S]*?)\n      \}/g)].at(-1)?.[1] ?? "";
  assert.ok(settingsKeyBranch, "missing Settings keyboard guard");
  assert.doesNotMatch(settingsKeyBranch, /cancelSettings\(\)/);
  assert.equal(
    settings.match(/onOpenChange=\{\(open\) => !open && !saving && onCancel\(\)\}/g)?.length,
    1,
  );
  assert.match(
    app,
    /if \(\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === ","\) \{[\s\S]*?if \(settingsOpen\) \{[\s\S]*?if \(!settingsSaving\) cancelSettings\(\)/,
  );
});

test("real Tabs, ToggleGroups, and ScrollAreas mount on every required P4 surface", () => {
  const app = read("editor/client/App.tsx");
  const visual = read("editor/client/AiVisualReview.tsx");
  const diff = read("editor/client/DiffReview.tsx");
  const settings = read("editor/client/SettingsModal.tsx");
  for (const value of ["global", "playhead", "selection"]) {
    assert.match(app, new RegExp(`<TabsTrigger[\\s\\S]*?value="${value}"`));
    assert.ok(app.includes(`<TabsContent value="${value}" className="aiScopePanel">`));
  }
  assert.match(visual, /<ToggleGroup[\s\S]*type="single"[\s\S]*className="aiReviewModeSwitch"/);
  assert.match(visual, /<ToggleGroup[\s\S]*className="aiReviewDecisionToggle"/);
  for (const area of ["aiReviewEventList", "aiReviewPreview", "aiReviewInspector"]) {
    assert.ok(visual.includes(`<ScrollArea className="${area}">`), `missing review ScrollArea ${area}`);
  }
  assert.match(diff, /<ScrollArea className="diffList">/);
  assert.match(read("editor/client/styles.css"), /\.ocDiffReview \.diffList \{[\s\S]*?overflow: hidden;/);
  assert.match(settings, /<ScrollArea className="settingsBody">/);
  // HyperFrames の添付一覧は Panels.tsx の HyperframeAuthorPanel(「AI 生成」タブ)にある
  assert.match(read("editor/client/Panels.tsx"), /<ScrollArea className="hfAssetListScroll">/);
});

test("P4 surface skin covers dialog, tabs, toggles, cards, focus, scroll, and narrow viewports", () => {
  const css = read("editor/client/styles.css");
  for (const selector of [
    ".ocAiCommand", ".ocAiCommand.modalStyle", ".ocAiCommandModal",
    ".ocAiCommandModal .aiScopeTabs", ".ocHyperframeAuthor",
    ".ocHyperframeAuthor .hfAssetDrop", ".ocDiffReview",
    ".ocDiffReview button.diffValue.on", ".ocAiReview",
    ".ocAiReview .aiReviewGrid", ".ocAiReview .aiReviewModeSwitch",
    ".ocAiReview .aiReviewDecisionToggle", ".ocSettings",
    ".ocSettings .settingsTabs", ".ocSettings .settingsCard",
  ]) assert.ok(css.includes(selector), `missing P4 selector ${selector}`);
  assert.match(css, /\.ocAiCommand[\s\S]*:focus-visible/);
  assert.match(css, /\.ocAiReview[\s\S]*scrollbar-width: thin/);
  assert.match(css, /\.ocSettings[\s\S]*scrollbar-width: thin/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.ocAiReview \.aiReviewGrid/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.ocSettings \.field > label/);
});

test("P4 provenance pins primitive and Sonner sources plus behavior adaptations", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  for (const source of ["dialog", "tabs", "scroll-area", "toggle-group"]) {
    assert.match(provenance, new RegExp(`cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/components/ui/${source}\\.tsx`));
  }
  assert.match(provenance, /P4 checkpoint 1 adapts the pinned Dialog, Tabs, ScrollArea, and ToggleGroup/);
  assert.match(provenance, /Radix owns focus trapping, the close-auto-focus lifecycle/);
  assert.match(provenance, /CutFlow explicitly returns focus to each launcher/);
  assert.match(provenance, /Settings outside\/non-field Escape\/cancel still rolls/);
  assert.match(provenance, /HyperFrames blocks[\s\S]*?Escape, allows outside dismissal only while idle/);
  assert.match(provenance, /Visual and diff review block Escape\/outside/);
  assert.match(provenance, /apps\/web\/src\/components\/ui\/sonner\.tsx/);
  assert.match(provenance, /Sonner version \| OpenCut baseline `\^2\.0\.7`; CutFlow exact pin `2\.0\.7`/);
  assert.match(provenance, /P4 checkpoint 2 replaces `toastReducer\.ts`/);
});
