import { test } from "node:test";
import assert from "node:assert/strict";
import {
  designStillCanvas,
  designStillHtml,
  type DesignStillDesign,
} from "../src/lib/designAssetHtml.ts";

const DESIGN: DesignStillDesign = {
  backgroundFile: "background.png",
  backgroundColor: "#001122",
  screen: {
    rect: { x: 100, y: 22, w: 1720, h: 968 },
    radiusPx: 24,
    shadow: true,
  },
  camera: {
    rect: { x: 1517, y: 677, w: 375, h: 375 },
    radiusPx: 96,
    shadow: true,
  },
};

test("designStillCanvas: role ごとの旧 DesignStill composition サイズを返す", () => {
  assert.deepEqual(designStillCanvas("backdrop", DESIGN, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(designStillCanvas("screenMask", DESIGN, 1920, 1080), { width: 1720, height: 968 });
  assert.deepEqual(designStillCanvas("cameraShadow", DESIGN, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(designStillCanvas("cameraMask", DESIGN, 1920, 1080), { width: 375, height: 375 });
});

test("designStillHtml: screenMask は白背景と角丸を持つ", () => {
  const html = designStillHtml({ role: "screenMask", design: DESIGN, width: 1920, height: 1080 });
  assert.match(html, /width:1720px;height:968px;background-color:white;border-radius:24px/);
});

test("designStillHtml: cameraShadow は shadow false で box-shadow を出さない", () => {
  const html = designStillHtml({
    role: "cameraShadow",
    design: { ...DESIGN, camera: { ...DESIGN.camera, shadow: false } },
    width: 1920,
    height: 1080,
  });
  assert.match(html, /background-color:transparent/);
  assert.equal(html.includes("box-shadow"), false);
});

test("designStillHtml: backdrop は背景画像なしなら img を出さない", () => {
  const html = designStillHtml({
    role: "backdrop",
    design: { ...DESIGN, backgroundFile: undefined },
    width: 1920,
    height: 1080,
  });
  assert.equal(html.includes("<img"), false);
});

test("designStillHtml: backdrop の img は cover と出力サイズを持つ", () => {
  const html = designStillHtml({
    role: "backdrop",
    design: DESIGN,
    width: 1920,
    height: 1080,
    backgroundSrc: "/background.png?x=&quot;",
  });
  assert.match(html, /<img src="\/background\.png\?x=&amp;quot;"/);
  assert.match(html, /style="position:absolute;inset:0;width:1920px;height:1080px;object-fit:cover"/);
});

test("designStillHtml: remotion の文字列を含まない", () => {
  const html = designStillHtml({ role: "backdrop", design: DESIGN, width: 1920, height: 1080 });
  assert.equal(html.toLowerCase().includes("remotion"), false);
});
