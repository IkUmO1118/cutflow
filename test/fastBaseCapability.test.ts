import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlainIdentityBase,
  resolveFastBaseCapability,
} from "../src/lib/fastBaseCapability.ts";
import type { DesignProps } from "../src/lib/design.ts";
import type { RenderProps } from "../remotion/props.ts";

const ASSETS = {
  key: "0123456789abcdef",
  backdropFile: "render.fast/design/key.backdrop.png",
  screenMaskFile: "render.fast/design/key.screen-mask.png",
  cameraShadowFile: "render.fast/design/key.camera-shadow.png",
  cameraMaskFile: "render.fast/design/key.camera-mask.png",
};

const DESIGN: DesignProps = {
  backgroundColor: "#001122",
  screen: { rect: { x: 100, y: 22, w: 1720, h: 968 }, radiusPx: 24, shadow: true },
  camera: { rect: { x: 1517, y: 677, w: 375, h: 375 }, radiusPx: 96, shadow: true },
  assets: ASSETS,
};

function propsWith(design: DesignProps | null = DESIGN): RenderProps {
  return {
    videoFile: "cut.mp4",
    bgm: [],
    durationSec: 20,
    fps: 30,
    width: 1920,
    height: 1080,
    canvas: { w: 3840, h: 1080 },
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
    wipe: { widthPx: 480, marginPx: 32 },
    caption: { fontSizePx: 44 },
    captions: [],
    overlays: [],
    wipeFull: [],
    hideCaption: [],
    ...(design ? { design } : {}),
  };
}

test("resolveFastBaseCapability: compositeを従来どおり許可する", () => {
  assert.deepEqual(
    resolveFastBaseCapability({ props: propsWith(null), composite: true }),
    { ok: true, mode: "composite" },
  );
});

test("resolveFastBaseCapability: compositeを不完全designより優先する", () => {
  const props = propsWith({ ...DESIGN, assets: undefined });
  assert.deepEqual(resolveFastBaseCapability({ props, composite: true }), {
    ok: true,
    mode: "composite",
  });
});

test("resolveFastBaseCapability: asset完備のOBS designを解決する", () => {
  assert.deepEqual(
    resolveFastBaseCapability({ props: propsWith(), composite: false }),
    { ok: true, mode: "design", design: ASSETS },
  );
});

test("resolveFastBaseCapability: design asset不足を拒否する", () => {
  const design = { ...DESIGN, assets: { ...ASSETS, cameraMaskFile: undefined } } as DesignProps;
  const result = resolveFastBaseCapability({ props: propsWith(design), composite: false });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /asset不足/);
});

test("resolveFastBaseCapability: source regionのcanvas範囲外を拒否する", () => {
  const props = propsWith();
  props.cameraRegion = { x: 3000, y: 0, w: 1920, h: 1080 };
  const result = resolveFastBaseCapability({ props, composite: false });
  assert.deepEqual(result, { ok: false, reason: "design基底のcameraRegionがcanvas範囲外" });
});

test("resolveFastBaseCapability: output panelの範囲外と0幅を拒否する", () => {
  for (const rect of [
    { x: 100, y: 22, w: 1900, h: 968 },
    { x: 100, y: 22, w: 0, h: 968 },
  ]) {
    const design = { ...DESIGN, screen: { ...DESIGN.screen, rect } };
    const result = resolveFastBaseCapability({ props: propsWith(design), composite: false });
    assert.deepEqual(result, { ok: false, reason: "design基底のscreen panelが出力範囲外" });
  }
});

test("resolveFastBaseCapability: design cameraに対応するcameraRegionを要求する", () => {
  const props = propsWith();
  delete props.cameraRegion;
  const result = resolveFastBaseCapability({ props, composite: false });
  assert.deepEqual(result, { ok: false, reason: "design基底にcameraRegionがない" });
});

test("isPlainIdentityBase: landscape/portraitの実geometryを証明してactivateする", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const props = propsWith(null);
    delete props.cameraRegion;
    Object.assign(props, {
      width,
      height,
      canvas: { w: width, h: height },
      screenRegion: { x: 0, y: 0, w: width, h: height },
    });
    assert.equal(isPlainIdentityBase(props), true);
    assert.deepEqual(resolveFastBaseCapability({ props, composite: false }), {
      ok: true,
      mode: "plain-identity",
    });
  }
});

test("isPlainIdentityBase: layout/design/cameraとcanvas/screen不一致を全て拒否する", () => {
  const identity = propsWith(null);
  delete identity.cameraRegion;
  identity.canvas = { w: 1920, h: 1080 };
  const variants: RenderProps[] = [
    { ...identity, layout: { panels: [{ source: "screen", fit: "cover" }] } },
    { ...identity, design: DESIGN },
    { ...identity, cameraRegion: { x: 0, y: 0, w: 1, h: 1 } },
    { ...identity, canvas: { w: 1919, h: 1080 } },
    { ...identity, canvas: { w: 1920, h: 1079 } },
    { ...identity, screenRegion: { x: 1, y: 0, w: 1920, h: 1080 } },
    { ...identity, screenRegion: { x: 0, y: 1, w: 1920, h: 1080 } },
    { ...identity, screenRegion: { x: 0, y: 0, w: 1919, h: 1080 } },
    { ...identity, screenRegion: { x: 0, y: 0, w: 1920, h: 1079 } },
  ];
  for (const props of variants) {
    assert.equal(isPlainIdentityBase(props), false);
    assert.equal(resolveFastBaseCapability({ props, composite: false }).ok, false);
  }
});
