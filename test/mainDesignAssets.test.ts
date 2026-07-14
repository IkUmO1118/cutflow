// Main のP2 hybrid構造を固定する。mask PNGはP1 ffmpeg用に生成・供給を続けるが、
// Main の動的動画へCSS mask-imageとして適用しない(§7実測で5.2%遅化)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "..", "remotion", "Main.tsx"), "utf8");

test("Main design assets: 動画clipはnative borderRadiusで、CSS mask-imageを使わない", () => {
  assert.doesNotMatch(source, /(?:WebkitM|m)askImage/);
  assert.doesNotMatch(source, /screenMaskFile|cameraMaskFile/);
  assert.match(source, /borderRadius: designWipe\.radiusPx/);
  assert.match(source, /borderRadius: design\?\.screen\.radiusPx \?\? 0/);
  assert.match(source, /overflow: "hidden"/);
});

test("Main design assets: backdropと通常cameraShadow PNGを継続利用する", () => {
  assert.match(source, /staticFile\(screenAssets\.backdropFile\)/);
  assert.match(source, /staticFile\(staticCameraAssets\.cameraShadowFile!\)/);
  assert.match(source, /!staticDesignCamera && design\.camera\.shadow/);
  assert.match(source, /!screenAssets && design\?\.screen\.shadow/);
});
