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

  const materialEmpty = panels.slice(panels.indexOf("materialCount === 0"), panels.indexOf("sortedHyperframes.map"));
  assert.match(materialEmpty, /className="ocMaterialEmptyDrop"/);
  assert.match(materialEmpty, /disabled=\{busy\}/);
  assert.match(materialEmpty, /onClick=\{onUploadClick\}/);
  assert.match(materialEmpty, /Drag and drop videos, photos, and audio files here/);

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

test("ProjectPanel shows the OpenCut-style empty state and still injects the short section", () => {
  const inspector = read("editor/client/Inspector.tsx");
  const at = inspector.indexOf("const ProjectPanel");
  const project = inspector.slice(at, inspector.indexOf("export const Inspector", at));
  assert.match(project, /\{shortSection\}/);
  assert.match(project, /className="inspEmpty"/);
  assert.match(project, /className="inspEmptyIcon"/);
  assert.match(project, /<SlidersHorizontal /);
  assert.match(project, /<h3>ここには何もありません<\/h3>/);
});

test("P5 theme bootstrap, provider, picker, and Toaster use one resolved contract", () => {
  const html = read("editor/client/index.html");
  const index = read("editor/client/index.tsx");
  const theme = read("editor/client/theme.tsx");
  const rules = read("editor/client/themeRules.ts");
  const app = read("editor/client/App.tsx");

  assert.doesNotMatch(html, /<html[^>]+class="dark"/);
  assert.match(html, /<meta name="color-scheme" content="light dark"/);
  assert.ok(html.indexOf("data-cutflow-theme-bootstrap") < html.indexOf('href="/styles.css"'));
  assert.match(html, /cutflow\.editor\.theme/);
  assert.match(html, /value === "light" \|\| value === "dark" \|\| value === "system"/);
  assert.match(html, /preference === "dark" \|\| \(preference === "system" && matchMedia\(media\)\.matches\)/);
  assert.match(html, /classList\.toggle\("dark", dark\)/);
  assert.match(html, /style\.colorScheme = dark \? "dark" : "light"/);
  assert.match(rules, /value === "light" \|\| value === "dark" \|\| value === "system"/);
  assert.match(rules, /preference === "system" \? \(systemDark \? "dark" : "light"\) : preference/);
  assert.match(theme, /addEventListener\("change", onChange\)/);
  assert.match(theme, /addEventListener\("storage", onStorage\)/);
  assert.match(theme, /classList\.toggle\("dark", theme === "dark"\)/);
  assert.match(theme, /root\.style\.colorScheme = theme/);
  assert.match(index, /<ThemeProvider>[\s\S]*<MobileGate><App \/><\/MobileGate>[\s\S]*<\/ThemeProvider>/);

  const settingsAt = app.indexOf('aria-label="設定"');
  const themeAt = app.indexOf('className="themeBtn"');
  const exportAt = app.indexOf('className="exportTrigger"');
  assert.ok(settingsAt >= 0 && themeAt > settingsAt && exportAt > themeAt);
  assert.match(app, /<Sun size=\{15\}/);
  assert.match(app, /<Moon size=\{15\}/);
  assert.match(app, /<Monitor size=\{15\}/);
  assert.match(app, /aria-label=\{`テーマ: \$\{themePreferenceLabel\(themePreference\)\}`\}/);
  assert.match(app, /<fieldset>[\s\S]*<legend>テーマ<\/legend>[\s\S]*type="radio"/);
  assert.match(app, /<Toaster theme=\{effectiveTheme\} \/>/);
  assert.equal((app.match(/aria-pressed=\{/g) ?? []).length, 4);
});

test("P5 mobile gate prevents App mount until viewport or explicit persisted acknowledgement", () => {
  const gate = read("editor/client/MobileGate.tsx");
  const rules = read("editor/client/mobileGateRules.ts");
  const index = read("editor/client/index.tsx");
  const css = read("editor/client/styles.css");
  assert.match(rules, /MOBILE_GATE_BREAKPOINT = 1024/);
  assert.match(rules, /width < MOBILE_GATE_BREAKPOINT/);
  assert.match(rules, /!mounted && !acknowledged/);
  assert.match(gate, /MOBILE_GATE_STORAGE_KEY/);
  assert.match(gate, /window\.innerWidth >= MOBILE_GATE_BREAKPOINT/);
  assert.match(gate, /localStorage\.setItem\(MOBILE_GATE_STORAGE_KEY, "true"\)/);
  assert.match(gate, /それでも表示/);
  assert.match(gate, /JSON データにも影響しません/);
  assert.match(gate, /if \(mounted \|\| acknowledged\) return children/);
  assert.match(index, /<MobileGate><App \/><\/MobileGate>/);
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*\.mobileGate/);
  assert.doesNotMatch(gate, /\/api\/|getProject|EventSource|Player/);
});

test("P5 onboarding is local-only, conflict-prioritized, dismissible, and guarded", () => {
  const dialog = read("editor/client/OnboardingDialog.tsx");
  const rules = read("editor/client/onboardingRules.ts");
  const app = read("editor/client/App.tsx");
  assert.match(rules, /cutflow\.editor\.onboarding\.v1/);
  assert.match(rules, /projectReady[\s\S]*!hasDraftOffer[\s\S]*!hasExternalChange[\s\S]*!diffPanelOpen/);
  assert.match(dialog, /localStorage\.setItem\(ONBOARDING_STORAGE_KEY, "true"\)/);
  assert.match(dialog, /onOpenChange=\{\(next\) => !next && dismiss\(\)\}/);
  assert.ok((dialog.match(/<DialogClose asChild>/g) ?? []).length >= 2);
  assert.match(dialog, /タイムラインで選択/);
  assert.match(dialog, /⌘S で JSON を保存/);
  assert.match(dialog, /プレビュー → 承認 → レンダー/);
  assert.match(dialog, /編集を始める/);
  assert.doesNotMatch(dialog, /\/api\/|postSave|postDraft|fetch\(/);
  assert.match(app, /draftOffer === null && !externalChange && !diffPanelOpen/);
  assert.match(app, /onboardingOpen && onboardingEligible/);
  assert.match(app, /hyperframeAuthorOpen \|\|[\s\S]*diffReview !== null && diffPanelOpen[\s\S]*aiWorkflowReview !== null \|\|[\s\S]*onboardingVisible/);
  assert.ok(app.indexOf('e.key === "s"') < app.indexOf("hyperframeAuthorOpen ||"));
  assert.ok(app.indexOf('e.key === ","') < app.indexOf("hyperframeAuthorOpen ||"));
  assert.match(app, /t\.closest\("button,\[role=button\]"\)/);
});

test("P5 semantic state skins keep readable light and dark theme colors", () => {
  const css = read("editor/client/styles.css");
  const rule = (selector: string): string => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, selector);
    const end = css.indexOf("}", start);
    assert.ok(end > start, selector);
    return css.slice(start, end + 1);
  };
  const hasToken = (selector: string, token: string) =>
    assert.match(rule(selector), new RegExp(`hsl\\(var\\(--oc-${token}\\)`), selector);

  hasToken(".ocHeader .saveStatus.dirty", "warning");
  hasToken(".ocHyperframeAuthor .hfAuthorDisabled", "warning");
  hasToken(".ocHyperframeAuthor .hfAuthorError", "destructive");
  hasToken(".ocDiffReview .diffWarnings", "warning");
  hasToken(".ocAiReview .aiReviewWarningSummary {", "warning");
  hasToken(".ocAiReview .aiReviewBadge.pending", "warning");
  hasToken(".ocAiReview .aiReviewBadge.use", "success");
  hasToken(".ocAiReview .aiReviewBadge.skip", "destructive");
  hasToken(".ocAiReview .aiReviewBadge.mixed", "info");
  hasToken(".ocAiReview .aiReviewDecisionToggle button.on.use", "success");
  hasToken(".ocAiReview .aiReviewDecisionToggle button.on.skip", "destructive");
  hasToken(".ocSettings .warnText", "warning");
  hasToken(".ocSettings .foot .error", "destructive");

  for (const fixed of [
    "hsl(38 92% 64%)",
    "hsl(40 92% 70%)",
    "hsl(40 92% 72%)",
    "hsl(0 86% 78%)",
    "hsl(145 68% 70%)",
    "hsl(215 92% 78%)",
  ]) {
    assert.equal(css.includes(fixed), false, fixed);
  }

  type Rgb = [number, number, number];
  const hslToRgb = ([h, sRaw, lRaw]: [number, number, number]): Rgb => {
    const s = sRaw / 100;
    const l = lRaw / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    const base: Rgb =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
      h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return base.map((value) => value + m) as Rgb;
  };
  const luminance = (rgb: Rgb): number =>
    rgb
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a: Rgb, b: Rgb): number => {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const mix = (foreground: Rgb, background: Rgb, alpha: number): Rgb =>
    foreground.map((value, index) => value * alpha + background[index] * (1 - alpha)) as Rgb;
  const themeBlock = (selector: ":root" | ".dark"): string => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf("}", start));
  };
  const token = (block: string, name: string): Rgb => {
    const match = block.match(new RegExp(`--oc-${name}:\\s*(\\d+)\\s+(\\d+)%\\s+(\\d+)%`));
    assert.ok(match, `${name} token`);
    return hslToRgb([Number(match[1]), Number(match[2]), Number(match[3])]);
  };
  const checks = [["warning", 0.1], ["success", 0.14], ["destructive", 0.12], ["info", 0.09]] as const;
  for (const [selector, baseName] of [[":root", "card"], [".dark", "card"]] as const) {
    const block = themeBlock(selector);
    const base = token(block, baseName);
    for (const [name, alpha] of checks) {
      const foreground = token(block, name);
      assert.ok(
        contrast(foreground, mix(foreground, base, alpha)) >= 4.5,
        `${selector} ${name} contrast`,
      );
    }
  }
});
