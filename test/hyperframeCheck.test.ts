// test/hyperframeCheck.test.ts — src/lib/hyperframeCheck.ts(C2 check
// ゲート)の固定。SAMPLE_HTML(hyperframe.ts)を回帰アンカーに、各ルール
// (root / typed variables / clip discipline / remote-URL ban / seek-safe /
// font embedding)を代表フィクスチャで検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
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

test('30: data-hf-requires="three" with no tier is an error (Rule 9)', () => {
  const r = checkComposition(`<div data-composition-id="root" data-hf-requires="three"></div>`);
  assert.ok(hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

test('31: regression — GSAP (window.__timelines) card declaring byte tier has no Rule 9 error', () => {
  const r = checkComposition(
    `<div data-composition-id="root" data-hf-determinism="byte" data-hf-requires="gsap"></div><script>window.__timelines={main:gsap.timeline({paused:true})};</script>`,
  );
  assert.ok(!hasErr(r, 'requires data-hf-determinism="perceptual"'));
});

const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
const GSAP_INTEGRITY = "sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2";

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
    `<div data-composition-id="root" data-hf-determinism="byte" data-hf-requires="gsap"></div><script>window.__timelines={main:gsap.timeline({paused:true})};</script>`,
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
