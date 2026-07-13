// lib/overlayStill.ts — render 高速パスが使う、素材オーバーレイ1件を
// 「時間不変なレイヤー画」として焼くためのキャッシュキー・剥がし処理を固定する。
// overlayStillKey は実ファイルの mtime/size を読む(statSync)ので、一時ファイルを
// scratchpad ではなく os.tmpdir() に作って測る(収録フォルダは触らない)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  overlayStillItem as reexportedOverlayStillItem,
  overlayStillKey,
  overlayStillPath,
} from "../src/lib/overlayStill.ts";
// overlayStillItem の定義はブラウザ安全な overlayFade.ts 側(remotion/OverlayStill.tsx が
// import するため。overlayStill.ts は node 専用でブラウザバンドルに入れられない)
import { overlayStillItem } from "../src/lib/overlayFade.ts";
import type { OverlayItem } from "../remotion/props.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "cutflow-overlaystill-"));
  writeFileSync(join(dir, "a.png"), "aaaa");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FULL_ITEM: OverlayItem = {
  start: 10,
  end: 12.5,
  file: "materials/a.png",
  track: 1,
  fit: "contain",
  startFrom: 3,
  volume: 1,
  opacity: 0.5,
  fadeInSec: 0.5,
  fadeOutSec: 0.5,
  rect: { x: 10, y: 20, w: 100, h: 200 },
  keyframes: [{ at: 0, easing: "linear", values: { opacity: 0 } }],
};

test("overlayStillItem: overlayStill.ts の re-export は overlayFade.ts の定義そのもの(二重定義しない)", () => {
  assert.equal(reexportedOverlayStillItem, overlayStillItem);
});

test("overlayStillItem: fade/opacity/keyframes/startFrom を落とし、rect を保つ", () => {
  const stripped = overlayStillItem(FULL_ITEM);
  assert.deepEqual(stripped, {
    start: 10,
    end: 12.5,
    file: "materials/a.png",
    track: 1,
    fit: "contain",
    rect: { x: 10, y: 20, w: 100, h: 200 },
  });
  assert.equal("fadeInSec" in stripped, false);
  assert.equal("fadeOutSec" in stripped, false);
  assert.equal("opacity" in stripped, false);
  assert.equal("volume" in stripped, false);
  assert.equal("startFrom" in stripped, false);
  assert.equal("keyframes" in stripped, false);
});

test("overlayStillItem: rect 無しなら出力にも rect キー自体が無い", () => {
  const { rect: _rect, ...noRect } = FULL_ITEM;
  const stripped = overlayStillItem(noRect as OverlayItem);
  assert.equal("rect" in stripped, false);
});

test("overlayStillKey: mtime 変化でキーが変わる(内容アドレス)", () => {
  const item: OverlayItem = { start: 0, end: 1, file: "a.png", track: 1, fit: "contain" };
  const args = { dir, item, width: 1920, height: 1080 };
  const keyBefore = overlayStillKey(args);

  const future = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "a.png"), future, future);

  const keyAfter = overlayStillKey(args);
  assert.notEqual(keyBefore, keyAfter);
});

test("overlayStillKey: size 変化でキーが変わる", () => {
  const item: OverlayItem = { start: 0, end: 1, file: "a.png", track: 1, fit: "contain" };
  const keyBefore = overlayStillKey({ dir, item, width: 1920, height: 1080 });

  writeFileSync(join(dir, "a.png"), "aaaaaaaaaa");
  const keyAfter = overlayStillKey({ dir, item, width: 1920, height: 1080 });
  assert.notEqual(keyBefore, keyAfter);
});

test("overlayStillKey: start/end/fadeInSec の変化ではキーが変わらない(出力に影響しないため)", () => {
  writeFileSync(join(dir, "a.png"), "stable-content");
  const base: OverlayItem = { start: 0, end: 1, file: "a.png", track: 1, fit: "contain" };
  const varied: OverlayItem = {
    ...base,
    start: 99,
    end: 120,
    fadeInSec: 2,
    fadeOutSec: 3,
    volume: 1,
    opacity: 0.3,
  };
  const keyBase = overlayStillKey({ dir, item: base, width: 1920, height: 1080 });
  const keyVaried = overlayStillKey({ dir, item: varied, width: 1920, height: 1080 });
  assert.equal(keyBase, keyVaried);
});

test("overlayStillKey: fit / rect / 出力解像度の変化ではキーが変わる", () => {
  writeFileSync(join(dir, "a.png"), "stable-content-2");
  const base: OverlayItem = { start: 0, end: 1, file: "a.png", track: 1, fit: "contain" };
  const keyBase = overlayStillKey({ dir, item: base, width: 1920, height: 1080 });

  const keyFit = overlayStillKey({
    dir, item: { ...base, fit: "cover" }, width: 1920, height: 1080,
  });
  assert.notEqual(keyBase, keyFit);

  const keyRect = overlayStillKey({
    dir, item: { ...base, rect: { x: 0, y: 0, w: 10, h: 10 } }, width: 1920, height: 1080,
  });
  assert.notEqual(keyBase, keyRect);

  const keyRes = overlayStillKey({ dir, item: base, width: 1280, height: 720 });
  assert.notEqual(keyBase, keyRes);
});

test("overlayStillPath: render.fast/overlays/<key>.png を返す", () => {
  writeFileSync(join(dir, "a.png"), "path-test");
  const item: OverlayItem = { start: 0, end: 1, file: "a.png", track: 1, fit: "contain" };
  const args = { dir, item, width: 1920, height: 1080 };
  const path = overlayStillPath(args);
  const key = overlayStillKey(args);
  assert.equal(path, join(dir, "render.fast", "overlays", `${key}.png`));
});
