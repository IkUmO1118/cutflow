// test/hyperframe.test.ts — src/lib/hyperframe.ts の純関数を固定する
// (P-1〜P-9)。ブラウザ不使用の高速テスト。ヘビーな実描画検証は
// scripts/hyperframe-verify.ts(node --test では自動実行しない)側。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildIframeSrcdoc,
  mergeVariables,
  parseComposition,
  SAMPLE_HTML as EXPORTED_SAMPLE_HTML,
} from "../src/lib/hyperframe.ts";

const SAMPLE_HTML = `<!doctype html>
<html data-composition-variables='[
  {"id":"title","type":"string","label":"Title","default":"CutFlow"},
  {"id":"accent","type":"color","label":"Accent","default":"#22c55e"}
]'>
<head><style>
  html,body{margin:0;padding:0}
  #root{position:relative;width:1920px;height:1080px;background:#0b0f1a;overflow:hidden;font-family:sans-serif}
  #box{position:absolute;top:480px;left:0;width:120px;height:120px;border-radius:12px;animation:slide 4s linear both;animation-play-state:paused}
  @keyframes slide{from{transform:translateX(0)}to{transform:translateX(800px)}}
  #title{position:absolute;top:200px;left:120px;font-size:96px;font-weight:800;color:#fff;opacity:0}
</style></head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
    <div id="box" class="clip" data-start="0" data-duration="4"></div>
    <h1 id="title"></h1>
    <script>
      var v = window.__hyperframes.getVariables();
      var t = document.getElementById('title');
      t.textContent = v.title;
      document.getElementById('box').style.background = v.accent;
      t.animate([{opacity:0},{opacity:1}], {duration:2000, easing:'linear', fill:'both'});
    </script>
  </div>
</html>`;

/* ---------------- P-1 ---------------- */

test("P-1: parseComposition は compositionId/width/height を読む", () => {
  const parsed = parseComposition(SAMPLE_HTML);
  assert.equal(parsed.compositionId, "root");
  assert.equal(parsed.width, 1920);
  assert.equal(parsed.height, 1080);
});

/* ---------------- P-2 ---------------- */

test("P-2: parseComposition は variables を JSON.parse する", () => {
  const parsed = parseComposition(SAMPLE_HTML);
  assert.equal(parsed.variables.length, 2);
  assert.deepEqual(parsed.variables[0], {
    id: "title",
    type: "string",
    label: "Title",
    default: "CutFlow",
  });
  assert.deepEqual(parsed.variables[1], {
    id: "accent",
    type: "color",
    label: "Accent",
    default: "#22c55e",
  });
});

test("P-2b: data-composition-variables が無ければ variables は []", () => {
  const html = `<html data-composition-id="root"><body></body></html>`;
  const parsed = parseComposition(html);
  assert.deepEqual(parsed.variables, []);
});

/* ---------------- P-3 ---------------- */

test("P-3: data-composition-id が文書中に無ければ throw する", () => {
  const html = `<html><body><div class="clip" data-start="0" data-duration="4"></div></body></html>`;
  assert.throws(() => parseComposition(html), /composition root missing data-composition-id/);
});

/* ---------------- P-4 ---------------- */

test("P-4: intrinsicDurationSec は data-start+data-duration の max", () => {
  const parsed = parseComposition(SAMPLE_HTML);
  assert.equal(parsed.intrinsicDurationSec, 4);

  const html = `<html data-composition-id="root">
    <div class="clip" data-start="0" data-duration="4"></div>
    <div class="clip" data-start="2" data-duration="3"></div>
  </html>`;
  const parsed2 = parseComposition(html);
  assert.equal(parsed2.intrinsicDurationSec, 5);
});

/* ---------------- P-4b (determinismTier) ---------------- */

test('P-4b: determinismTier is "perceptual" when data-hf-determinism="perceptual"', () => {
  const html = `<html data-composition-id="root" data-hf-determinism="perceptual"></html>`;
  const parsed = parseComposition(html);
  assert.equal(parsed.determinismTier, "perceptual");
});

test('P-4c: determinismTier defaults to "byte" when data-hf-determinism is absent', () => {
  const parsed = parseComposition(SAMPLE_HTML);
  assert.equal(parsed.determinismTier, "byte");
});

test('P-4d: determinismTier falls back to "byte" for an invalid value (lenient parser never throws)', () => {
  const html = `<html data-composition-id="root" data-hf-determinism="frames"></html>`;
  const parsed = parseComposition(html);
  assert.equal(parsed.determinismTier, "byte");
});

/* ---------------- P-5 ---------------- */

test("P-5: mergeVariables の優先度は default < instance < cli", () => {
  const decls = [
    { id: "title", type: "string", default: "CutFlow" },
    { id: "accent", type: "color", default: "#22c55e" },
  ];

  // instance が default に勝つ
  const merged1 = mergeVariables(decls, { title: "Instance" });
  assert.equal(merged1.title, "Instance");
  assert.equal(merged1.accent, "#22c55e");

  // cli が instance に勝つ
  const merged2 = mergeVariables(decls, { title: "Instance" }, { title: "Cli" });
  assert.equal(merged2.title, "Cli");

  // override 側にしか無いキーはそのまま素通し
  const merged3 = mergeVariables(decls, undefined, { extra: 42 });
  assert.equal(merged3.extra, 42);

  // どちらにも無いキーは default のまま
  const merged4 = mergeVariables(decls, { accent: "#000000" });
  assert.equal(merged4.title, "CutFlow");
  assert.equal(merged4.accent, "#000000");
});

/* ---------------- P-6 ---------------- */

test("P-6: buildIframeSrcdoc は bootstrap script を author script より前に置く", () => {
  const out = buildIframeSrcdoc(SAMPLE_HTML, { title: "CutFlow", accent: "#22c55e" });
  const bootstrapIdx = out.indexOf("window.__hyperframes");
  const authorIdx = out.indexOf("window.__hyperframes.getVariables()");
  assert.ok(bootstrapIdx >= 0, "bootstrap script not found");
  assert.ok(authorIdx >= 0, "author script not found");
  assert.ok(bootstrapIdx < authorIdx, "bootstrap must come before author script");
});

/* ---------------- P-7 ---------------- */

test("P-7: buildIframeSrcdoc は決定論(同じ引数→同じ文字列)", () => {
  const vars = { title: "CutFlow", accent: "#22c55e" };
  const out1 = buildIframeSrcdoc(SAMPLE_HTML, vars);
  const out2 = buildIframeSrcdoc(SAMPLE_HTML, vars);
  assert.equal(out1, out2);
});

test("P-7b: default srcdoc is byte-identical to the pre-F2 baseline", () => {
  const out = buildIframeSrcdoc(EXPORTED_SAMPLE_HTML, {});
  assert.equal(out.length, 4887);
  assert.equal(
    createHash("sha256").update(out).digest("hex"),
    "db89d42780703020a53207ae5f3bef89f1c6c538f0b11dd49e931c86ed40073e",
  );
  assert.equal(buildIframeSrcdoc(EXPORTED_SAMPLE_HTML, {}, "default"), out);
  assert.doesNotMatch(out, /__hfGlStats|checkWebglContext|HTMLCanvasElement\.prototype\.getContext/);
});

test("P-7c: gpu-angle srcdoc tracks WebGL context requests without changing author script", () => {
  const authorScript = "var canvas=document.querySelector('canvas');canvas.getContext('webgl');";
  const html = `<html data-composition-id="root"><head></head><body><canvas></canvas><script>${authorScript}</script></body></html>`;
  const out = buildIframeSrcdoc(html, {}, "gpu-angle");
  assert.ok(out.includes(authorScript));
  assert.match(out, /HTMLCanvasElement\.prototype\.getContext=function/);
  assert.match(out, /name==='webgl'\|\|name==='webgl2'\|\|name==='experimental-webgl'/);
  assert.match(out, /requests>0&&__hfGlStats\.successes===0/);
  assert.match(out, /WebGL context creation failed/);
  assert.equal((out.match(/checkWebglContext\(\);/g) || []).length, 3);
});

/* ---------------- P-8 ---------------- */

test("P-8: buildIframeSrcdoc は </script> を含む値をエスケープする", () => {
  const out = buildIframeSrcdoc(SAMPLE_HTML, { title: "</script><script>alert(1)</script>" });
  // ブートストラップの JSON リテラル内の </script> は <\/script> にエスケープされ、
  // 生の "</script>" として本文中に出現しないこと(author の </script> タグ自体は除く)
  const bootstrapStart = out.indexOf("window.__hyperframes");
  const bootstrapEnd = out.indexOf("</script>", bootstrapStart);
  const bootstrapSegment = out.slice(bootstrapStart, bootstrapEnd);
  assert.ok(!bootstrapSegment.includes("</script>"), "raw </script> leaked into bootstrap segment");
  assert.ok(out.includes("<\\/script>"), "expected escaped <\\/script> in output");
});

/* ---------------- P-9 ---------------- */

test("P-9: 埋め込まれた JSON リテラルは渡した variables と deep-equal", () => {
  const vars = { title: "CutFlow", accent: "#22c55e", nested: { a: 1, b: [1, 2, 3] } };
  const out = buildIframeSrcdoc(SAMPLE_HTML, vars);
  const m = /var __vars = (.*?);function seek/.exec(out.replace(/\n/g, ""));
  assert.ok(m, "could not locate embedded __vars JSON literal");
  const parsedBack = JSON.parse(m![1].replace(/<\\\//g, "</"));
  assert.deepEqual(parsedBack, vars);
});

/* ---------------- P-10 (B1: seek conventions) ---------------- */

test("P-10: bootstrap は GSAP/Lottie/hf-seek/readiness/error 規約の全マーカーを含む", () => {
  const out = buildIframeSrcdoc(SAMPLE_HTML, { title: "CutFlow", accent: "#22c55e" });
  assert.ok(out.includes("window.__timelines"), "GSAP window.__timelines marker missing");
  const totalTimeCount = (out.match(/\.totalTime\(/g) || []).length;
  assert.equal(totalTimeCount, 2, "expected exactly two .totalTime( calls (GSAP same-time-seek nudge)");
  assert.ok(out.includes("window.__hfLottie"), "Lottie window.__hfLottie marker missing");
  assert.ok(out.includes("goToAndStop"), "Lottie goToAndStop marker missing");
  assert.ok(out.includes("new CustomEvent('hf-seek'"), "hf-seek CustomEvent dispatch missing");
  assert.ok(out.includes("__isReady"), "__isReady marker missing");
  assert.ok(out.includes("__failed"), "__failed marker missing");
  assert.ok(out.includes("addEventListener('error'"), "error listener missing");
  assert.ok(out.includes("typeof window["), "data-hf-requires library existence check missing");
});

/* ---------------- P-12 (B2: CSP injection) ---------------- */

test("P-12: buildIframeSrcdoc injects a CSP <meta> before the bootstrap script", () => {
  const out = buildIframeSrcdoc(SAMPLE_HTML, { title: "CutFlow", accent: "#22c55e" });
  const cspIdx = out.indexOf('<meta http-equiv="Content-Security-Policy"');
  const bootstrapIdx = out.indexOf("window.__hyperframes");
  assert.ok(cspIdx >= 0, "CSP meta not found");
  assert.ok(bootstrapIdx >= 0, "bootstrap script not found");
  assert.ok(cspIdx < bootstrapIdx, "CSP meta must precede the bootstrap script");

  const cspEnd = out.indexOf(">", cspIdx);
  const cspTag = out.slice(cspIdx, cspEnd);
  assert.ok(cspTag.includes("connect-src 'none'"), "CSP must include connect-src 'none'");
  assert.ok(
    cspTag.includes("https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"),
    "CSP must include the exact GSAP pin URL",
  );
  assert.ok(
    cspTag.includes("https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js"),
    "CSP must include the exact Lottie pin URL",
  );
  assert.ok(
    !/script-src[^;]*https:\/\/cdn\.jsdelivr\.net(?:\s|;)/.test(cspTag),
    "CSP must not allow the whole jsdelivr origin",
  );
});

test("P-11: byte-anchor — clip 可視性ループと WAAPI シークループは verbatim のまま", () => {
  const out = buildIframeSrcdoc(SAMPLE_HTML, { title: "CutFlow", accent: "#22c55e" });
  const clipLoop =
    "var clips = document.querySelectorAll('.clip');" +
    "for (var i=0;i<clips.length;i++){" +
    "var el = clips[i];" +
    "var s = parseFloat(el.getAttribute('data-start')||'0')*1000;" +
    "var draw = el.getAttribute('data-duration');" +
    "var dur = (draw==null) ? Infinity : parseFloat(draw)*1000;" +
    "el.style.visibility = (tMs >= s && tMs < s+dur) ? '' : 'hidden';" +
    "}";
  assert.ok(out.includes(clipLoop), "clip visibility loop is not byte-verbatim");

  const waapiLoop =
    "var anims = document.getAnimations();" +
    "for (var j=0;j<anims.length;j++){ var a=anims[j]; try{ a.pause(); a.currentTime=tMs; }catch(e){} }";
  assert.ok(out.includes(waapiLoop), "getAnimations()/currentTime loop is not byte-verbatim");
});
