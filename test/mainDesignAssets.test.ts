// Main はP1で生成・供給するdesign assetsを参照せず、従来のCSS合成を保つ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "..", "remotion", "Main.tsx"), "utf8");

test("Main design assets: design assetsを一切参照せずlegacy描画を使う", () => {
  assert.doesNotMatch(source, /(?:WebkitM|m)askImage/);
  assert.doesNotMatch(
    source,
    /completeScreenDesignAssets|staticCameraDesignAssets|screenAssets|staticCameraAssets|staticDesignCamera/,
  );
  assert.doesNotMatch(source, /backdropFile|screenMaskFile|cameraShadowFile|cameraMaskFile/);
  assert.match(source, /staticFile\(design\.backgroundFile\)/);
  assert.match(source, /borderRadius: shrunkDesignWipe\.radiusPx/);
  assert.match(source, /borderRadius: design\?\.screen\.radiusPx \?\? 0/);
  assert.match(source, /overflow: "hidden"/);
  assert.match(source, /const designCamera = design\?\.camera/);
  assert.match(source, /const wipeLayer: ReactNode = !props\.cameraRegion \? null/);
  assert.match(source, /props\.layout \|\| !props\.cameraRegion \|\| props\.wipeBurnedIn \? null : wipeLayer/);
  assert.match(source, /designCamera\.shadow \? \{ boxShadow: CAMERA_SHADOW_CSS \} : \{\}/);
  assert.match(source, /design\?\.screen\.shadow \? \{ boxShadow: SCREEN_SHADOW_CSS \} : \{\}/);
});
