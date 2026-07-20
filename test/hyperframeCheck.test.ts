// test/hyperframeCheck.test.ts — src/lib/hyperframeCheck.ts(C2 check
// ゲート)の固定。SAMPLE_HTML(hyperframe.ts)を回帰アンカーに、各ルール
// (root / typed variables / clip discipline / remote-URL ban / seek-safe /
// font embedding)を代表フィクスチャで検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";
import { SAMPLE_HTML } from "../src/lib/hyperframe.ts";

function hasErr(r: ReturnType<typeof checkComposition>, s: string): boolean {
  return r.errors.some((p) => p.message.includes(s));
}
function hasWarn(r: ReturnType<typeof checkComposition>, s: string): boolean {
  return r.warnings.some((p) => p.message.includes(s));
}

test("1: SAMPLE_HTML is clean (regression anchor)", () => {
  const r = checkComposition(SAMPLE_HTML);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("2: missing data-composition-id is an error", () => {
  const r = checkComposition(`<div data-width="1920" data-height="1080"></div>`);
  assert.ok(hasErr(r, "data-composition-id"));
});

test("3: negative data-width is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="-5" data-height="1080"></div>`,
  );
  assert.ok(hasErr(r, "data-width must be a positive integer"));
});

test("4: missing data-width is a warning, not an error", () => {
  const r = checkComposition(`<div data-composition-id="root"></div>`);
  assert.equal(r.errors.length, 0);
  assert.ok(hasWarn(r, "no data-width"));
});

test("5: object-form data-composition-variables is an error", () => {
  const r = checkComposition(
    `<html data-composition-variables='{"title":{"type":"string"}}'><div data-composition-id="root"></div></html>`,
  );
  assert.ok(hasErr(r, "must be a JSON array"));
});

test("6: variable declaration missing id is an error", () => {
  const r = checkComposition(
    `<html data-composition-variables='[{"type":"string"}]'><div data-composition-id="root"></div></html>`,
  );
  assert.ok(hasErr(r, 'missing required "id"'));
});

test("7: data-variable-values as array (not object) is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><div data-composition-src="./x.html" data-variable-values='["a","b"]'></div>`,
  );
  assert.ok(hasErr(r, "data-variable-values must be a JSON object"));
});

test('8: timed element without class="clip" is a warning, not an error', () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><div data-start="0" data-duration="4"></div>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(hasWarn(r, 'no class="clip"'));
});

test("9: negative data-duration on a clip is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><div class="clip" data-start="0" data-duration="-2"></div>`,
  );
  assert.ok(hasErr(r, "data-duration must be a non-negative"));
});

test("10: remote <script src> (CDN, not in pin table) is an error", () => {
  // B2: an un-pinned remote <script src> is still an error, but the message
  // is now the CDN-pin-table message (Rule 4 exception), not the generic
  // "remote URL not allowed" (that generic message is still used for every
  // other remote-URL kind — see test 19 and the non-script cases above).
  const r = checkComposition(
    `<div data-composition-id="root"></div><script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>`,
  );
  assert.ok(hasErr(r, "not in the CDN pin table"));
});

test("11: remote CSS url() is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><style>#b{background:url(https://ex.com/a.png)}</style>`,
  );
  assert.ok(hasErr(r, "remote URL"));
});

test("12: remote data-composition-src is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><div data-composition-src="https://ex.com/intro.html" data-start="0" data-duration="5"></div>`,
  );
  assert.ok(hasErr(r, "remote URL"));
});

test("13: protocol-relative <img src> is an error", () => {
  const r = checkComposition(`<div data-composition-id="root"></div><img src="//ex.com/a.png">`);
  assert.ok(hasErr(r, "remote URL"));
});

test("14: Math.random() breaks seek determinism", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>var x=Math.random();</script>`,
  );
  assert.ok(hasErr(r, "Math.random"));
});

test("15: requestAnimationFrame breaks seek determinism", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>requestAnimationFrame(f);</script>`,
  );
  assert.ok(hasErr(r, "requestAnimationFrame"));
});

test("16: setTimeout is a warning, not a determinism error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>setTimeout(f,0);</script>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(hasWarn(r, "setTimeout"));
});

test("17: Date.now / new Date() error, new Date(2020,0,1) does not", () => {
  const a = checkComposition(
    `<div data-composition-id="root"></div><script>var a=Date.now();</script>`,
  );
  assert.ok(hasErr(a, "Date.now"));

  const b = checkComposition(
    `<div data-composition-id="root"></div><script>var b=new Date();</script>`,
  );
  assert.ok(hasErr(b, "Date"));

  const c = checkComposition(
    `<div data-composition-id="root"></div><script>var c=new Date(2020,0,1);</script>`,
  );
  assert.ok(!hasErr(c, "nondeterministic driver"));
});

test("18: custom font-family (no @font-face) is a warning", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><style>#t{font-family:'Comic Sans Custom'}</style>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(hasWarn(r, "Comic Sans Custom"));
});

test("18b: Rule 6 regression — data: WOFF2 @font-face backs a custom family at 0/0", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720"><span id="t">CutFlow</span></div>` +
      `<style>@font-face{font-family:"HFAsset1";src:url("data:font/woff2;base64,d09GMg==") format("woff2");font-display:block}` +
      `#t{font-family:"HFAsset1",sans-serif}</style>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test("18c: X1 real WOFF2 render fixture passes checkComposition at 0/0", () => {
  const html = readFileSync(
    new URL("./fixtures/hyperframe-fonts/embedded-woff2.html", import.meta.url),
    "utf8",
  );
  const r = checkComposition(html, {
    file: "test/fixtures/hyperframe-fonts/embedded-woff2.html",
  });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test('20: data-hf-determinism="perceptual" is clean', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="perceptual"></div>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(!hasErr(r, "data-hf-determinism"));
});

test('21: data-hf-determinism="byte" is clean', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="byte"></div>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(!hasErr(r, "data-hf-determinism"));
});

test("22: invalid data-hf-determinism value is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="frames"></div>`,
  );
  assert.ok(hasErr(r, 'must be "byte" or "perceptual"'));
});

test("23: absent data-hf-determinism does not warn (defaults to byte)", () => {
  // SAMPLE_HTML(rule 1: SAMPLE_HTML is clean)自体が「属性なし→0 warning」の
  // 回帰アンカーなので、ここでは data-hf-determinism 由来の警告/エラーが
  // 無いことだけをピンポイントで確認する(width/height 等の無関係な警告は
  // 別ルールの担当)
  const r = checkComposition(`<div data-composition-id="root"></div>`);
  assert.ok(!hasErr(r, "data-hf-determinism"));
  assert.ok(!hasWarn(r, "data-hf-determinism"));
  assert.ok(!hasWarn(r, "determinism"));
});

test('24: data-hf-requires="gsap" is clean (Rule 8)', () => {
  const r = checkComposition(`<div data-composition-id="root" data-hf-requires="gsap"></div>`);
  assert.equal(r.errors.length, 0);
});

test('25: data-hf-requires="bogus" is an error (Rule 8)', () => {
  const r = checkComposition(`<div data-composition-id="root" data-hf-requires="bogus"></div>`);
  assert.ok(hasErr(r, 'unknown library "bogus"'));
});

test('26: data-hf-requires="" is an error (Rule 8)', () => {
  const r = checkComposition(`<div data-composition-id="root" data-hf-requires=""></div>`);
  assert.ok(hasErr(r, "data-hf-requires is empty"));
});

test("27: hf-seek usage without data-hf-determinism is an error (Rule 9)", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>window.addEventListener('hf-seek', function(e){draw(e.detail.time);});</script>`,
  );
  assert.ok(hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

test('28: hf-seek usage with data-hf-determinism="perceptual" is clean (Rule 9)', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="perceptual"></div><script>window.addEventListener('hf-seek', function(e){draw(e.detail.time);});</script>`,
  );
  assert.ok(!hasErr(r, "data-hf-determinism"));
});

test('29: hf-seek usage with data-hf-determinism="byte" is an error (Rule 9)', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="byte"></div><script>window.addEventListener('hf-seek', function(e){draw(e.detail.time);});</script>`,
  );
  assert.ok(hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

test("29b: Rule 9 explains ANGLE/driver perceptual semantics without SwiftShader", () => {
  const html = `<div data-composition-id="root"></div><script>window.addEventListener('hf-seek', function(){});</script>`;
  const result = checkComposition(html);
  const message = result.errors.find((error) => error.where === "data-hf-determinism")?.message ?? "";
  assert.match(message, /ANGLE/);
  assert.match(message, /driver|ドライバ/);
  assert.doesNotMatch(message, /SwiftShader/);
});

test('30: data-hf-requires="three" with no tier is an error (Rule 9)', () => {
  const r = checkComposition(`<div data-composition-id="root" data-hf-requires="three"></div>`);
  assert.ok(hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

test('31: regression — GSAP (window.__timelines) card declaring byte tier has no Rule 9 error', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="byte" data-hf-requires="gsap"></div><script>window.__timelines={root:gsap.timeline({paused:true})};</script>`,
  );
  assert.ok(!hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
const GSAP_INTEGRITY = "sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2";
const ANIME_URL = "https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js";
const ANIME_INTEGRITY = "sha384-oLmuahJgYYR1aWgZwdMQQ2AClE6A2eEwV2x1Z7cbIHehfkkmommQLH3wX1NDEszb";
const ANIME_SCRIPT_TAG = `<script src="${ANIME_URL}" integrity="${ANIME_INTEGRITY}" crossorigin="anonymous"></script>`;

test("32: pinned <script src> with matching integrity+crossorigin+data-hf-requires is clean (Rule 4/10)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.equal(r.errors.length, 0);
});

test("33: pinned <script src> with wrong version is not-in-table (Rule 4)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasErr(r, "not in the CDN pin table"));
});

test("34: pinned <script src> without integrity is an error (Rule 4)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasErr(r, "matching integrity attribute"));
});

test("35: pinned <script src> with mismatched integrity is an error (Rule 4)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasErr(r, "did you hand-write the sha384"));
});

test("36: pinned <script src> matched but no crossorigin is an error (Rule 4)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}"></script>`,
  );
  assert.ok(hasErr(r, 'crossorigin="anonymous"'));
});

test("37: pinned <script src> matched+crossorigin but missing data-hf-requires=\"gsap\" is an error (Rule 10)", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasErr(r, 'data-hf-requires="gsap"'));
});

test("38: GSAP API used but no window.__timelines registration is an error (Rule 11)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>var tl = gsap.to('#x',{x:1});</script>`,
  );
  assert.ok(hasErr(r, "no paused timeline is registered"));
});

test("39: GSAP timeline registered via window.__timelines.<id> = tl (dot form) is clean (Rule 11)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = window.__timelines || {}; var tl = gsap.timeline({paused:true}); window.__timelines.root = tl; tl.to('#x',{x:1});</script>`,
  );
  assert.ok(!hasErr(r, "no paused timeline is registered"));
});

test("40: GSAP timeline registered via object-literal window.__timelines={...} is clean (Rule 11)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = {root: gsap.timeline({paused:true})}; window.__timelines.root.to('#x',{x:1});</script>`,
  );
  assert.ok(!hasErr(r, "no paused timeline is registered"));
});

test("41: CSS/WAAPI-only card whose only 'gsap.' mention is inside a comment triggers no Rule 11 (false-positive guard)", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>// see gsap.to docs\nvar el = document.querySelector('#x'); el.animate([{opacity:0},{opacity:1}],{duration:500});</script>`,
  );
  assert.equal(r.errors.length, 0);
  assert.ok(!hasErr(r, "no paused timeline is registered"));
});

test("42: gsap.ticker.add usage is an error even with a registered timeline (Rule 12)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = {root: gsap.timeline({paused:true})}; gsap.ticker.add(function(){});</script>`,
  );
  assert.ok(hasErr(r, "gsap.ticker runs on wall-clock"));
});

test("43: gsap.ticker.fps usage is an error (Rule 12)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = {root: gsap.timeline({paused:true})}; gsap.ticker.fps(30);</script>`,
  );
  assert.ok(hasErr(r, "gsap.ticker runs on wall-clock"));
});

test("44: registered timeline with no ticker usage has no Rule 12 error", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = {root: gsap.timeline({paused:true})}; window.__timelines.root.to('#x',{x:1});</script>`,
  );
  assert.equal(r.errors.length, 0);
});

test("45: regression — test 31's GSAP (window.__timelines) card still has 0 errors with Rule 11/12 added", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="byte" data-hf-requires="gsap"></div><script>window.__timelines={root:gsap.timeline({paused:true})};</script>`,
  );
  assert.equal(r.errors.length, 0);
});

test("46: regression — test 32's pinned-gsap clean card (no inline script) still has 0 errors with Rule 11/12 added", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.equal(r.errors.length, 0);
});

test("47: regression — SAMPLE_HTML (no GSAP) is unaffected by Rule 11/12", () => {
  const r = checkComposition(SAMPLE_HTML);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

const LOTTIE_URL = "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js";
const LOTTIE_INTEGRITY = "sha384-J8C0MvgX4WP58J4N2W99vCKd2J6z99ynOJ5bEfE6jeP7kVTW1drYtv/jzrxM5jbm";
const LOTTIE_SCRIPT_TAG = `<script src="${LOTTIE_URL}" integrity="${LOTTIE_INTEGRITY}" crossorigin="anonymous"></script>`;

test("F1-1: distinct valid GSAP and Lottie pins produce one deterministic runtime warning", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap lottie"></div>${LOTTIE_SCRIPT_TAG}<script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.filter((w) => w.message.includes("multiple pinned animation runtimes")).length, 1);
  assert.ok(hasWarn(r, "gsap, lottie"));
});

test("F1-2: duplicate tags for the same valid pin do not produce a runtime warning", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.ok(!hasWarn(r, "multiple pinned animation runtimes"));
});

test("F1-3: a single valid pinned runtime does not produce a runtime warning", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}`,
  );
  assert.ok(!hasWarn(r, "multiple pinned animation runtimes"));
});

test("F1-4: inline library-like code is not counted as a second pinned runtime", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var GSAP = {name:'not a pinned runtime'};</script>`,
  );
  assert.ok(!hasWarn(r, "multiple pinned animation runtimes"));
});

test("F1-5: an invalid second pin keeps its Rule 4 error without a runtime warning", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script src="${LOTTIE_URL}" integrity="sha384-invalid" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasErr(r, "did you hand-write the sha384"));
  assert.ok(!hasWarn(r, "multiple pinned animation runtimes"));
});

test("F1-6: multiple-runtime warning coexists with Rule 10 declaration errors", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div>${LOTTIE_SCRIPT_TAG}<script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script>`,
  );
  assert.ok(hasWarn(r, "multiple pinned animation runtimes"));
  assert.ok(hasErr(r, 'data-hf-requires="gsap"'));
  assert.ok(hasErr(r, 'data-hf-requires="lottie"'));
});

test("48: full Lottie card (pinned tag + animationData + __hfLottie push + svg renderer) is clean (Rule 13/14)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var anim = lottie.loadAnimation({container:document.getElementById('x'), renderer:'svg', loop:false, autoplay:false, animationData:{v:"5.7.4"}}); window.__hfLottie = window.__hfLottie || []; window.__hfLottie.push(anim);</script>`,
  );
  assert.equal(r.errors.length, 0);
});

test("49: Lottie loadAnimation with path: instead of animationData is an error (Rule 13a)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var anim = lottie.loadAnimation({container:document.getElementById('x'), renderer:'svg', path:"./anim.json"}); window.__hfLottie = window.__hfLottie || []; window.__hfLottie.push(anim);</script>`,
  );
  assert.ok(hasErr(r, "animationData"));
});

test("50: Lottie loadAnimation with neither animationData nor path is an error (Rule 13b)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var anim = lottie.loadAnimation({container:document.getElementById('x'), renderer:'svg'}); window.__hfLottie = window.__hfLottie || []; window.__hfLottie.push(anim);</script>`,
  );
  assert.ok(hasErr(r, "animationData"));
});

test("51: Lottie renderer:'canvas' with animationData and no perceptual tier is a warning, not an error (Rule 14)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var anim = lottie.loadAnimation({container:document.getElementById('x'), renderer:'canvas', animationData:{v:"5.7.4"}}); window.__hfLottie = window.__hfLottie || []; window.__hfLottie.push(anim);</script>`,
  );
  assert.ok(!hasErr(r, "canvas"));
  assert.ok(hasWarn(r, "canvas"));
});

test('52: Lottie renderer:\'canvas\' with data-hf-determinism="perceptual" has no canvas warning (Rule 14)', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie" data-hf-determinism="perceptual"></div>${LOTTIE_SCRIPT_TAG}<script>var anim = lottie.loadAnimation({container:document.getElementById('x'), renderer:'canvas', animationData:{v:"5.7.4"}}); window.__hfLottie = window.__hfLottie || []; window.__hfLottie.push(anim);</script>`,
  );
  assert.ok(!hasWarn(r, "canvas"));
});

test("53: data-hf-requires=\"lottie\" + pinned tag but no loadAnimation( call has 0 errors (Rule 13 false-positive guard)", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}`,
  );
  assert.equal(r.errors.length, 0);
});

test("54: regression — a GSAP card (no loadAnimation) is unaffected by Rule 13/14; SAMPLE_HTML still 0/0", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script src="${GSAP_URL}" integrity="${GSAP_INTEGRITY}" crossorigin="anonymous"></script><script>window.__timelines = {root: gsap.timeline({paused:true})}; window.__timelines.root.to('#x',{x:1});</script>`,
  );
  assert.equal(r.errors.length, 0);

  const sample = checkComposition(SAMPLE_HTML);
  assert.equal(sample.errors.length, 0);
  assert.equal(sample.warnings.length, 0);
});

test("19: false-positive guards for remote-URL scan", () => {
  const a = checkComposition(
    `<div data-composition-id="root"></div><!-- see https://example.com -->`,
  );
  assert.ok(!hasErr(a, "remote URL"));

  const b = checkComposition(
    `<div data-composition-id="root"></div><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ">`,
  );
  assert.ok(!hasErr(b, "remote URL"));

  const c = checkComposition(
    `<div data-composition-id="root"></div><img src="./materials/a.png">`,
  );
  assert.ok(!hasErr(c, "remote URL"));
});

test("55: raw-WebGL hf-seek card with data-hf-determinism=\"perceptual\" is check-valid (0 errors); the same card with the attribute removed is a Rule 9 error (B5)", () => {
  const clean = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720" data-hf-determinism="perceptual"><canvas class="clip" data-start="0" data-duration="4"></canvas><script>window.addEventListener('hf-seek', function(e){});</script></div>`,
  );
  assert.equal(clean.errors.length, 0, JSON.stringify(clean.errors, null, 2));

  const noTier = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720"><canvas class="clip" data-start="0" data-duration="4"></canvas><script>window.addEventListener('hf-seek', function(e){});</script></div>`,
  );
  assert.ok(hasErr(noTier, 'requires data-hf-determinism="perceptual"'));
});

test("56: GSAP timeline without paused:true is rejected", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script>window.__timelines={root:gsap.timeline()};window.__timelines.root.to('#x',{x:1});</script>`,
  );
  assert.ok(hasErr(r, "no paused timeline is registered"));
});

test("57: GSAP timeline registered under a key different from data-composition-id is rejected", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script>window.__timelines={other:gsap.timeline({paused:true})};window.__timelines.other.to('#x',{x:1});</script>`,
  );
  assert.ok(hasErr(r, 'window.__timelines["root"]'));
});

test("58: direct gsap.to remains rejected even when an unrelated paused timeline is registered", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script>window.__timelines={root:gsap.timeline({paused:true})};gsap.to('#x',{x:1});</script>`,
  );
  assert.ok(hasErr(r, "direct gsap.to"));
});

test("59: Lottie loadAnimation must use autoplay:false, loop:false, and __hfLottie registration", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>lottie.loadAnimation({renderer:'svg',autoplay:true,animationData:{v:'5.7.4'}});</script>`,
  );
  assert.ok(hasErr(r, "autoplay:false"));
  assert.ok(hasErr(r, "loop:false"));
  assert.ok(hasErr(r, "__hfLottie.push"));
});

test("60: Lottie external image filename/directory assets are rejected", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var DATA={v:'5.7.4',assets:[{u:'images/',p:'img_0.png'}]};var anim=lottie.loadAnimation({renderer:'svg',autoplay:false,loop:false,animationData:DATA});window.__hfLottie=[];window.__hfLottie.push(anim);</script>`,
  );
  assert.ok(hasErr(r, "data: URLs"));
  assert.ok(hasErr(r, "asset directories"));
});

test("61: Lottie data: image asset is accepted", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var DATA={v:'5.7.4',assets:[{u:'',p:'data:image/png;base64,AA=='}]};var anim=lottie.loadAnimation({renderer:'svg',autoplay:false,loop:false,animationData:DATA});window.__hfLottie=[];window.__hfLottie.push(anim);</script>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
});

test("62: dynamic script construction is rejected before CSP", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script>var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/animejs@4.1.3/dist/bundles/anime.umd.min.js';document.head.appendChild(s);</script>`,
  );
  assert.ok(hasErr(r, "dynamic script loading"));
});

test("63: the composition timeline itself must be paused, not a different registered timeline", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-requires="gsap"></div><script>window.__timelines={root:gsap.timeline(),other:gsap.timeline({paused:true})};window.__timelines.root.to('#x',{x:1});</script>`,
  );
  assert.ok(hasErr(r, 'window.__timelines["root"]'));
});

test("64: Lottie asset p/u checks ignore unrelated properties outside animationData assets", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720" data-hf-requires="lottie"></div>${LOTTIE_SCRIPT_TAG}<script>var unrelated={p:'not-an-asset.png',u:'not-an-asset-directory/'};var DATA={v:'5.7.4',assets:[]};var anim=lottie.loadAnimation({renderer:'svg',autoplay:false,loop:false,animationData:DATA});window.__hfLottie=[];window.__hfLottie.push(anim);</script>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
});

function animeCard(script: string): string {
  return `<div data-composition-id="root" data-width="1280" data-height="720" data-hf-requires="anime"><div id="box"></div></div>` +
    ANIME_SCRIPT_TAG + `<script>${script}</script>`;
}

test("65: Anime.js direct factory and timeline register cleanly at byte tier", () => {
  for (const script of [
    `var anim=anime({targets:'#box',opacity:[0,1],duration:800,autoplay:false});window.__hfAnime=window.__hfAnime||[];window.__hfAnime.push(anim);`,
    `var tl=anime.timeline({autoplay:false,loop:2});tl.add({targets:'#box',translateX:[0,400],duration:600});window.__hfAnime=[];__hfAnime.push(tl);`,
    `window.__hfAnime=[];window.__hfAnime.push(anime({targets:'#box',duration:500,loop:false,autoplay:false}));`,
  ]) {
    const r = checkComposition(animeCard(script));
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
    assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
  }
});

test("66: Anime.js every factory requires autoplay:false and registration", () => {
  const missingAutoplay = checkComposition(animeCard(
    `var anim=anime({targets:'#box',duration:500});window.__hfAnime=[];window.__hfAnime.push(anim);`,
  ));
  assert.ok(hasErr(missingAutoplay, "autoplay:false"));
  const unregistered = checkComposition(animeCard(
    `var anim=anime({targets:'#box',duration:500,autoplay:false});window.__hfAnime=[];`,
  ));
  assert.ok(hasErr(unregistered, "every anime()/anime.timeline() result"));
});

test("67: Anime.js loop and explicit infinite factory timing are rejected", () => {
  for (const loop of ["true", "-1", "Infinity", "1.5"]) {
    const r = checkComposition(animeCard(
      `var anim=anime({targets:'#box',autoplay:false,loop:${loop}});window.__hfAnime=[];window.__hfAnime.push(anim);`,
    ));
    assert.ok(hasErr(r, "loop must be omitted"), loop);
  }
  for (const key of ["duration", "delay", "endDelay"]) {
    const r = checkComposition(animeCard(
      `var anim=anime({targets:'#box',autoplay:false,${key}:Infinity});window.__hfAnime=[];window.__hfAnime.push(anim);`,
    ));
    assert.ok(hasErr(r, `${key} must be finite`), key);
  }
});

test("68: Anime.js registry must exist before push and receive a defined factory result", () => {
  const noInit = checkComposition(animeCard(
    `var anim=anime({targets:'#box',autoplay:false});window.__hfAnime.push(anim);`,
  ));
  assert.ok(hasErr(noInit, "initialized to an array"));
  const unknown = checkComposition(animeCard(
    `var anim=anime({targets:'#box',autoplay:false});window.__hfAnime=[];window.__hfAnime.push(missing);`,
  ));
  assert.ok(hasErr(unknown, "previously created anime instance"));
});

test("69: Anime.js play/restart/reverse are rejected for factory instances", () => {
  for (const method of ["play", "restart", "reverse"]) {
    const r = checkComposition(animeCard(
      `var anim=anime({targets:'#box',autoplay:false});window.__hfAnime=[];window.__hfAnime.push(anim);anim.${method}();`,
    ));
    assert.ok(hasErr(r, "play()/restart()/reverse()"), method);
  }
});

test("70: comments and normal/template strings containing Anime.js pseudo-calls do not trigger Rule 16", () => {
  const r = checkComposition(animeCard(
    `// anime({autoplay:true}).play()\n` +
      `var a="anime({autoplay:true})";var b='anim.restart()';var c=\`anime.timeline({loop:true}).reverse()\`;`,
  ));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test("71: Anime.js factory calls require the anime capability token", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="1280" data-height="720"><div id="box"></div></div>` +
      `<script>var anim=anime({targets:'#box',autoplay:false});window.__hfAnime=[];window.__hfAnime.push(anim);</script>`,
  );
  assert.ok(hasErr(r, 'data-hf-requires="anime"'));
});

test("72: assigned Anime.js factories require distinct variable names", () => {
  const r = checkComposition(animeCard(
    `var anim=anime({targets:'#box',autoplay:false});` +
      `var anim=anime.timeline({autoplay:false});` +
      `window.__hfAnime=[];window.__hfAnime.push(anim);`,
  ));
  assert.ok(hasErr(r, "distinct variable name"));
});

const THREE_PIN_TAG = `<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js" integrity="sha384-qOkzR5Ke/XkQxuGVJ9hpFEpDlcoLtWwVYhnJf06cLIZa2vaIptSqaubivErzmD5O" crossorigin="anonymous"></script>`;

function threeCard(script: string, requires = true, pin = true): string {
  return `<div data-composition-id="root" data-width="640" data-height="360" data-hf-determinism="perceptual"${requires ? ` data-hf-requires="three"` : ""}>` +
    `<canvas class="clip" data-start="0" data-duration="4"></canvas></div>` +
    (pin ? THREE_PIN_TAG : "") + `<script>${script}</script>`;
}

const CLEAN_THREE_SCRIPT = `
const renderer=new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera();
window.addEventListener('hf-seek',function(event){
  const time=Math.min(4,Math.max(0,event.detail.time));
  scene.rotation.y=time*0.4;
  renderer.render(scene,camera);
});`;

test("73: Three.js pinned core card with absolute hf-seek render is clean", () => {
  const r = checkComposition(threeCard(CLEAN_THREE_SCRIPT));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test("74: executable THREE usage and the matched pin require the three capability token", () => {
  assert.ok(hasErr(checkComposition(threeCard(CLEAN_THREE_SCRIPT, false, false)), 'data-hf-requires="three"'));
  assert.ok(hasErr(checkComposition(threeCard(``, false, true)), 'data-hf-requires="three"'));
});

test("75: Three.js cards require a synchronous hf-seek listener that reads absolute seconds and renders", () => {
  const noListener = checkComposition(threeCard(
    `const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});renderer.render({},{});`,
  ));
  assert.ok(hasErr(noListener, "synchronously subscribe"));

  const noTime = checkComposition(threeCard(
    `const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});window.addEventListener('hf-seek',function(event){renderer.render({},{});});`,
  ));
  assert.ok(hasErr(noTime, "event.detail.time"));

  const noRender = checkComposition(threeCard(
    `new THREE.Scene();window.addEventListener('hf-seek',function(event){const time=event.detail.time;});`,
  ));
  assert.ok(hasErr(noRender, "renderer.render"));

  const renderOutsideListener = checkComposition(threeCard(
    `const renderer=new THREE.WebGLRenderer({preserveDrawingBuffer:true});` +
      `renderer.render({},{});` +
      `window.addEventListener('hf-seek',function(event){const time=event.detail.time;});`,
  ));
  assert.ok(hasErr(renderOutsideListener, "renderer.render"));
});

test("76: Three.js WebGLRenderer literal options require preserved frame buffers", () => {
  for (const options of ["{}", "{preserveDrawingBuffer:false}"]) {
    const r = checkComposition(threeCard(
      `const renderer=new THREE.WebGLRenderer(${options});window.addEventListener('hf-seek',function(event){const time=event.detail.time;renderer.render({},{});});`,
    ));
    assert.ok(hasErr(r, "preserveDrawingBuffer:true"), options);
  }
  const dynamicOptions = checkComposition(threeCard(
    `const options={preserveDrawingBuffer:true};const renderer=new THREE.WebGLRenderer(options);` +
      `window.addEventListener('hf-seek',function(event){const time=event.detail.time;renderer.render({},{});});`,
  ));
  assert.ok(hasErr(dynamicOptions, "literal object"));
});

test("77: Three.js core-only route rejects self clocks, loaders, workers, and blob URLs", () => {
  for (const [source, label] of [
    ["renderer.setAnimationLoop(function(){});", "renderer.setAnimationLoop"],
    ["const clock=new THREE.Clock();", "new THREE.Clock"],
    ["clock.getDelta();", "Clock.getDelta/getElapsedTime"],
    ["const loader=new THREE.TextureLoader();", "THREE loaders"],
    ["const worker=new Worker('worker.js');", "workers"],
    ["const url=URL.createObjectURL(new Blob());", "blob URLs"],
  ] as const) {
    const r = checkComposition(threeCard(`${CLEAN_THREE_SCRIPT}\n${source}`));
    assert.ok(hasErr(r, label), label);
  }
});

test("78: comments and normal/template strings containing Three.js pseudo-code do not trigger Rule 17", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="640" data-height="360"></div><script>` +
      `// new THREE.Clock(); renderer.setAnimationLoop(fn)\n` +
      `const a="THREE.TextureLoader";const b='window.addEventListener(\\'hf-seek\\', fn)';` +
      `const c=\`THREE.WebGLRenderer({preserveDrawingBuffer:false})\`;` +
      `</script>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test("79: raw WebGL hf-seek cards do not enter the Three-specific gate", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="640" data-height="360" data-hf-determinism="perceptual">` +
      `<canvas class="clip" data-start="0" data-duration="4"></canvas></div>` +
      `<script>const gl={drawArrays:function(){}};window.addEventListener('hf-seek',function(event){const time=event.detail.time;gl.drawArrays(time);});</script>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

const WEBGPU_FIXTURE = readFileSync(
  new URL("./fixtures/hyperframe-backends/raw-webgpu.html", import.meta.url),
  "utf8",
);

test("80: formal raw WebGPU WGSL fixture passes Rule 18 at 0/0", () => {
  const r = checkComposition(WEBGPU_FIXTURE);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});

test("81: executable navigator.gpu or literal webgpu context requires the webgpu token", () => {
  const withoutToken = WEBGPU_FIXTURE.replace(' data-hf-requires="webgpu"', "");
  assert.ok(hasErr(checkComposition(withoutToken), 'data-hf-requires="webgpu"'));

  const contextOnly =
    `<div data-composition-id="root"></div><script>canvas.getContext('webgpu');</script>`;
  assert.ok(hasErr(checkComposition(contextOnly), 'data-hf-requires="webgpu"'));
});

test("82: raw WebGPU listener must be installed before the first await", () => {
  const listener = `window.addEventListener('hf-seek',function(event){\n` +
    `  latestTime = Math.min(DURATION_SEC,Math.max(0,event.detail.time));\n` +
    `  if(drawFrame)drawFrame(latestTime);\n` +
    `});\n`;
  const afterAwait = WEBGPU_FIXTURE.replace(listener, "").replace(
    "  const adapter = await navigator.gpu.requestAdapter();\n",
    "  const adapter = await navigator.gpu.requestAdapter();\n" + listener,
  );
  assert.ok(hasErr(checkComposition(afterAwait), "before the first await"));
});

test("83: raw WebGPU listener reads absolute seconds and stays synchronous", () => {
  const noTime = WEBGPU_FIXTURE.replace("event.detail.time", "0");
  assert.ok(hasErr(checkComposition(noTime), "event.detail.time"));

  const asyncListener = WEBGPU_FIXTURE.replace(
    "window.addEventListener('hf-seek',function(event){",
    "window.addEventListener('hf-seek',async function(event){await Promise.resolve();",
  );
  assert.ok(hasErr(checkComposition(asyncListener), "must be synchronous"));
});

test("84: raw WebGPU async setup is connected to the readiness Promise", () => {
  const noReady = WEBGPU_FIXTURE.replace(
    "window.__hyperframes.__ready = (async function(){",
    "(async function(){",
  );
  assert.ok(hasErr(checkComposition(noReady), "window.__hyperframes.__ready"));

  const functionInsteadOfPromise = WEBGPU_FIXTURE.replace(
    "window.__hyperframes.__ready = (async function(){",
    "window.__hyperframes.__ready = async function(){",
  ).replace(/\}\)\(\);\s*<\/script>/, `};\n</script>`);
  assert.ok(hasErr(checkComposition(functionInsteadOfPromise), "window.__hyperframes.__ready"));
});

test("85: raw WebGPU route requires adapter, device, and literal canvas context acquisition", () => {
  const cases = [
    ["navigator.gpu.requestAdapter()", "navigator.gpu.adapter()", "requestAdapter()"],
    ["adapter.requestDevice()", "adapter.device()", "requestDevice()"],
    ["canvas.getContext('webgpu')", "canvas.getContext(kind)", "getContext('webgpu')"],
  ] as const;
  for (const [from, to, expected] of cases) {
    assert.ok(hasErr(checkComposition(WEBGPU_FIXTURE.replace(from, to)), expected), expected);
  }
});

test("86: raw WebGPU device loss must reach the fatal error channel", () => {
  const nonFatal = WEBGPU_FIXTURE.replace("fatal:true", "fatal:false");
  assert.ok(hasErr(checkComposition(nonFatal), "GPUDevice.lost"));
});

test("87: raw WebGPU validates WGSL, creates a pipeline, and submits each frame", () => {
  const cases = [
    ["shaderModule.getCompilationInfo()", "shaderModule.info()", "getCompilationInfo()"],
    ["device.createRenderPipeline({", "device.makePipeline({", "createRenderPipeline()"],
    ["device.queue.submit([encoder.finish()]);", "encoder.finish();", "device.queue.submit(...)"],
  ] as const;
  for (const [from, to, expected] of cases) {
    assert.ok(hasErr(checkComposition(WEBGPU_FIXTURE.replace(from, to)), expected), expected);
  }
});

test("88: comments and normal/template strings containing WebGPU pseudo-code do not trigger Rule 18", () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-width="640" data-height="360"></div><script>` +
      `// navigator.gpu.requestAdapter(); canvas.getContext('webgpu')\n` +
      `const a="navigator.gpu";const b='getContext(\\'webgpu\\')';` +
      `const c=\`device.queue.submit([])\`;` +
      `</script>`,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings, null, 2));
});
