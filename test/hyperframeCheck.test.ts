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

test("10: remote <script src> (CDN) is an error", () => {
  const r = checkComposition(
    `<div data-composition-id="root"></div><script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>`,
  );
  assert.ok(hasErr(r, "remote URL"));
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
