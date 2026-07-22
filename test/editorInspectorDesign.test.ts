import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaptionAnimPatch } from "../editor/client/lib/inspectorHelpers.ts";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("Inspector retains all twelve selection kinds and every special rendering branch", () => {
  const inspector = read("editor/client/Inspector.tsx");
  const model = read("editor/client/model.ts");
  const kinds = [
    "cut", "insert", "caption", "captionTrack", "overlays", "wipeFull",
    "wipe", "bgm", "short", "zoom", "blur", "annotation",
  ];
  for (const kind of kinds) {
    assert.ok(model.includes(`| "${kind}"`), `model lost selection kind ${kind}`);
    if (kind === "wipe") {
      assert.match(model, /wipe \/ bgm は表示専用/);
      assert.doesNotMatch(inspector, /selection\.kind === "wipe"/);
    } else {
      assert.ok(inspector.includes(`selection.kind === "${kind}"`), `Inspector lost branch ${kind}`);
    }
  }
  assert.match(inspector, /if \(selection === null\) \{[\s\S]*<ProjectPanel/);
  assert.match(inspector, /selection\.kind === "caption" && capMulti\.length > 1[\s\S]*<BatchCaptionPanel/);
  assert.match(inspector, /selection\.kind === "caption" && shortMode[\s\S]*<ShortCaptionPanel/);
  assert.ok((inspector.match(/className="insp ocInspector"/g) ?? []).length >= 14);
});

test("App-to-Inspector callback surface and write destinations remain complete", () => {
  const app = read("editor/client/App.tsx");
  const start = app.indexOf("<Inspector");
  const end = app.indexOf("/>", start);
  const mount = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  for (const prop of [
    "setCaptionTrackDefault", "updateCutSeg", "cutKeepSeg", "restoreCutSeg",
    "updateCaption", "removeCaption", "updateCaptionsStyle", "updateCaptionsTrack",
    "removeCaptions", "updateSpan", "removeSpan", "updateZoom", "removeZoom",
    "updateBlur", "removeBlur", "updateAnnotation", "removeAnnotation", "updateInsert",
    "removeInsert", "updateBgm", "removeBgm", "setShortCaptionTrackDefault",
    "updateShortRange", "removeShortRange", "updateActiveShort", "removeShort",
    "getPlayheadSrc", "seekToSrc", "seekOut",
  ]) assert.match(mount, new RegExp(`\\b${prop}=`), `missing Inspector prop ${prop}`);

  const inspector = read("editor/client/Inspector.tsx");
  assert.match(inspector, /shortMode[\s\S]*setShortCaptionTrackDefault=\{setShortCaptionTrackDefault\}/);
  assert.match(inspector, /文言・タイミングは本編と共有[\s\S]*updateCaption=\{updateCaption\}/);
  assert.match(inspector, /詳細\(元収録の秒\)/);
  assert.match(inspector, /onStart\(round2\(Math\.min\(p, end - MIN_SPAN\)\)\)/);
  assert.match(inspector, /onEnd\(round2\(Math\.max\(p, start \+ MIN_SPAN\)\)\)/);
});

test("caption design keeps typography, paint, band, position, animation, and karaoke fields", () => {
  const inspector = read("editor/client/Inspector.tsx");
  for (const field of [
    "fontFamily", "fontWeight", "fontSizePx", "color", "outlineColor",
    "outlineWidthPx", "background", "paddingPx", "radiusPx", "pos", "anchor",
    "durationSec", "activeColor", "inactiveColor", "inactiveOpacity", "mode",
  ]) assert.match(inspector, new RegExp(`\\b${field}\\b`), `missing caption field ${field}`);
  assert.match(inspector, /CAPTION_ANIM_OPTIONS\.map/);
  assert.match(inspector, /patchKaraoke\(/);
  assert.match(inspector, /resolveCaptionBackground\(ownBg, base\.background\)/);
  assert.match(inspector, /splitColor\(effBg\.color\)/);
  assert.match(inspector, /joinColor\(e\.target\.value, bgColor\.alpha\)/);
  assert.match(inspector, /`\$\{keyPrefix\}:bgAlpha`/);
});

test("effects, BGM, inserts, overlays, and shorts retain patches and coalesce keys", () => {
  const inspector = read("editor/client/Inspector.tsx");
  for (const token of [
    "updateInsert(selection.index", "updateBgm(selection.index", "updateSpan(\"overlays\"",
    "updateZoom(selection.index", "updateBlur(selection.index", "updateAnnotation(i",
    "updateShortRange(selection.index", "setShortCaptionTrackDefault(track",
  ]) assert.ok(inspector.includes(token), `missing mutation route ${token}`);
  for (const key of [
    "insert:${selection.index}:volume", "bgm:${selection.index}:vol",
    "ov:${selection.index}:volume", "ov:${selection.index}:opacity",
    "zoom:${selection.index}:rect", "blur:${selection.index}:rect",
    "blur:${selection.index}:strength", "annotation:${i}:color",
    "annotation:${i}:fill", "caption:${selection.index}:text",
  ]) assert.ok(inspector.includes(key), `missing coalesce key ${key}`);
  assert.match(inspector, /const checked = e\.target\.checked;[\s\S]*approved: checked/);
  assert.match(inspector, /<input\s+type="checkbox"\s+checked=\{activeShort\.approved\}/);
});

test("Inspector uses thin native OpenCut adapters without changing control events", () => {
  const inspector = read("editor/client/Inspector.tsx");
  const adapters = ["input", "native-select", "slider", "switch", "color-input"];
  for (const name of adapters) {
    const source = read(`editor/client/components/ui/${name}.tsx`);
    assert.match(source, /forwardRef/);
    assert.match(source, /data-slot=/);
  }
  assert.doesNotMatch(inspector, /<select\b/);
  assert.doesNotMatch(inspector, /<input\s+type="color"/);
  assert.equal((inspector.match(/<input\s+type="checkbox"/g) ?? []).length, 1, "only approval remains a checkbox");
  assert.match(inspector, /<Slider[\s\S]*onChange=\{\(event\) => onChange\(Number\(event\.target\.value\)\)\}/);
});

test("number draft commit semantics remain unchanged", () => {
  const widgets = read("editor/client/widgets.tsx");
  assert.match(widgets, /const \[text, setText\] = useState<string \| null>\(null\)/);
  assert.match(widgets, /shown\.trim\(\) === "" \? \(allowEmpty \? undefined : NaN\)/);
  assert.match(widgets, /onBlur=\{commit\}/);
  assert.match(widgets, /if \(e\.key === "Enter"\) \(e\.target as HTMLInputElement\)\.blur\(\)/);
  assert.match(widgets, /if \(e\.key === "Escape"\) setText\(null\)/);
  assert.match(widgets, /else if \(e\.key === "ArrowUp"\)/);
  assert.match(widgets, /e\.shiftKey \? 10 : 1/);
});

test("caption animation helper cleans inherited empty subkeys directly", () => {
  assert.deepEqual(
    buildCaptionAnimPatch({ in: "", out: "", durationSec: undefined }),
    { anim: undefined },
  );
  assert.deepEqual(
    buildCaptionAnimPatch({ in: "fade", out: "slide-down", durationSec: 0.25 }),
    { anim: { in: "fade", out: "slide-down", durationSec: 0.25 } },
  );
  assert.deepEqual(
    buildCaptionAnimPatch({ in: "none", out: "", durationSec: 0 }),
    { anim: { in: "none", durationSec: 0 } },
  );
});

test("Inspector token skin stays scoped while Timeline advances in P3", () => {
  const css = read("editor/client/styles.css");
  for (const selector of [
    ".ocInspector", ".ocInspector .inspSec", ".ocInspector .capField",
    ".ocInspector .numStepper", ".ocInspector [data-slot=\"slider\"]",
    ".ocInspector [data-slot=\"switch\"]", ".ocInspector [data-slot=\"color-input\"]",
    ".ocInspector .seg", ".ocInspector .inspDetails",
  ]) assert.ok(css.includes(selector), `missing Inspector skin ${selector}`);
  assert.match(css, /\.ocInspector[\s\S]*scrollbar-color/);
  assert.match(css, /\.ocInspector[\s\S]*:focus-visible/);
  assert.match(css, /\.ocTimeline\b/);
});

test("P2 checkpoint 3 provenance pins sources and records adaptation boundaries", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "cf5e79e919144200294fb9fed22a222592a0aeea";
  for (const source of ["input", "native-select", "slider", "switch"]) {
    assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/${source}.tsx`));
  }
  assert.match(provenance, /All twelve CutFlow selection kinds/);
  assert.match(provenance, /short approval control intentionally remains a native checkbox/);
  assert.match(provenance, /Settings,[\s\S]*Timeline,[\s\S]*AI,[\s\S]*server\/API/);
});
