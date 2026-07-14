// lib/designStill.ts — design の静的背景・影・mask PNG の内容アドレス式 cache。
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import {
  DESIGN_STILL_GENERATOR_VERSION,
  designAssetRefs,
  designStillKey,
  existingDesignAssets,
  prepareDesignAssetsForProps,
  prepareDesignStillAssets,
} from "../src/lib/designStill.ts";
import { withCaptionStillAssets } from "../src/lib/captionStill.ts";
import type { WarmAssets } from "../src/stages/frames.ts";
import type { DesignStillDesign } from "../remotion/DesignStill.tsx";
import { defaultProps } from "../remotion/props.ts";
import type { RenderProps } from "../remotion/props.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "cutflow-designstill-"));
  writeFileSync(join(dir, "background.png"), "background-a");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

const fakeWarm = {} as WarmAssets;

test("designStillKey: generator version を固定し design 全値・解像度をキーに含める", () => {
  assert.equal(DESIGN_STILL_GENERATOR_VERSION, 1);
  const base = designStillKey({ dir, design: DESIGN, width: 1920, height: 1080 });
  assert.notEqual(
    base,
    designStillKey({
      dir,
      design: { ...DESIGN, backgroundColor: "#334455" },
      width: 1920,
      height: 1080,
    }),
  );
  assert.notEqual(
    base,
    designStillKey({
      dir,
      design: { ...DESIGN, screen: { ...DESIGN.screen, radiusPx: 25 } },
      width: 1920,
      height: 1080,
    }),
  );
  assert.notEqual(
    base,
    designStillKey({
      dir,
      design: { ...DESIGN, camera: { ...DESIGN.camera!, shadow: false } },
      width: 1920,
      height: 1080,
    }),
  );
  assert.notEqual(base, designStillKey({ dir, design: DESIGN, width: 1280, height: 720 }));
});

test("designStillKey: 背景を同じ path のまま差し替えるとキーが変わる", () => {
  writeFileSync(join(dir, "background.png"), "background-before");
  const beforeKey = designStillKey({ dir, design: DESIGN, width: 1920, height: 1080 });
  writeFileSync(join(dir, "background.png"), "background-after");
  const afterKey = designStillKey({ dir, design: DESIGN, width: 1920, height: 1080 });
  assert.notEqual(beforeKey, afterKey);
});

test("designStillKey: generated assets はキーに含めない", () => {
  const args = { dir, design: DESIGN, width: 1920, height: 1080 };
  const key = designStillKey(args);
  const withAssets = {
    ...DESIGN,
    assets: {
      key: "stale",
      backdropFile: "render.fast/design/stale.backdrop.png",
      screenMaskFile: "render.fast/design/stale.screen-mask.png",
    },
  } as DesignStillDesign;
  assert.equal(designStillKey({ ...args, design: withAssets }), key);
});

test("designAssetRefs: camera 有りは4役、camera 無しは2役だけを返す", () => {
  const refs = designAssetRefs({ dir, design: DESIGN, width: 1920, height: 1080 });
  assert.match(refs.backdropFile, /^render\.fast\/design\/[a-f0-9]{16}\.backdrop\.png$/);
  assert.match(refs.screenMaskFile, /\.screen-mask\.png$/);
  assert.match(refs.cameraShadowFile!, /\.camera-shadow\.png$/);
  assert.match(refs.cameraMaskFile!, /\.camera-mask\.png$/);

  const { camera: _camera, ...withoutCamera } = DESIGN;
  const plainRefs = designAssetRefs({ dir, design: withoutCamera, width: 1920, height: 1080 });
  assert.equal(plainRefs.cameraShadowFile, undefined);
  assert.equal(plainRefs.cameraMaskFile, undefined);
});

test("prepareDesignStillAssets: 4役を全て一時出力した後だけ完成名へ公開する", async () => {
  const refs = designAssetRefs({ dir, design: DESIGN, width: 1920, height: 1080 });
  const finalPaths = [
    refs.backdropFile,
    refs.screenMaskFile,
    refs.cameraShadowFile!,
    refs.cameraMaskFile!,
  ].map((file) => join(dir, file));
  let calls = 0;
  await prepareDesignStillAssets({
    dir,
    design: DESIGN,
    width: 1920,
    height: 1080,
    warm: fakeWarm,
    renderer: async ({ output }) => {
      calls += 1;
      assert.ok(output.includes(".tmp-"));
      assert.ok(finalPaths.every((path) => !existsSync(path)));
      writeFileSync(output, `role-${calls}`);
    },
  });
  assert.equal(calls, 4);
  assert.ok(finalPaths.every(existsSync));
});

test("prepareDesignStillAssets: cache hit は renderer を呼ばない", async () => {
  let calls = 0;
  await prepareDesignStillAssets({
    dir,
    design: DESIGN,
    width: 1920,
    height: 1080,
    warm: fakeWarm,
    renderer: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
});

test("prepareDesignStillAssets: camera 無しは backdrop/screenMask の2役だけ生成する", async () => {
  const { camera: _camera, ...withoutCameraBase } = DESIGN;
  const withoutCamera = { ...withoutCameraBase, backgroundColor: "#112233" };
  const roles: string[] = [];
  const refs = await prepareDesignStillAssets({
    dir,
    design: withoutCamera,
    width: 1920,
    height: 1080,
    warm: fakeWarm,
    renderer: async ({ props, output }) => {
      roles.push(props.role);
      writeFileSync(output, props.role);
    },
  });
  assert.deepEqual(roles, ["backdrop", "screenMask"]);
  assert.equal(refs.cameraShadowFile, undefined);
  assert.equal(refs.cameraMaskFile, undefined);
});

test("prepareDesignStillAssets: 途中失敗では完成名を公開せず一時fileも残さない", async () => {
  const failedDesign = { ...DESIGN, backgroundColor: "#abcdef" };
  const refs = designAssetRefs({ dir, design: failedDesign, width: 1920, height: 1080 });
  const finalPaths = [
    refs.backdropFile,
    refs.screenMaskFile,
    refs.cameraShadowFile!,
    refs.cameraMaskFile!,
  ].map((file) => join(dir, file));
  let calls = 0;
  await assert.rejects(
    prepareDesignStillAssets({
      dir,
      design: failedDesign,
      width: 1920,
      height: 1080,
      warm: fakeWarm,
      renderer: async ({ output }) => {
        calls += 1;
        if (calls === 3) throw new Error("render failed");
        writeFileSync(output, "temporary");
      },
    }),
    /render failed/,
  );
  assert.ok(finalPaths.every((path) => !existsSync(path)));
  assert.ok(!readdirSync(join(dir, "render.fast/design")).some((file) => file.includes(".tmp-")));
});

test("DesignStill: 実 bundleで4 PNGを生成し、Mainはassets有無でpixel一致する", async () => {
  const renderDir = mkdtempSync(join(tmpdir(), "cutflow-designstill-render-"));
  try {
    const design: DesignStillDesign = { ...DESIGN, backgroundFile: undefined };
    const refs = await withCaptionStillAssets(renderDir, async (warm) => {
      const generated = await prepareDesignStillAssets({
        dir: renderDir,
        design,
        width: 1920,
        height: 1080,
        warm,
      });
      const mainDesign = design as NonNullable<RenderProps["design"]>;
      const baseProps: RenderProps = {
        ...defaultProps,
        cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
        design: mainDesign,
      };
      const renderMain = async (output: string, props: RenderProps) => {
        const inputProps = props as unknown as Record<string, unknown>;
        const composition = await selectComposition({
          serveUrl: warm.serveUrl,
          id: "Main",
          inputProps,
          puppeteerInstance: warm.browser,
          logLevel: "warn",
        });
        await renderStill({
          composition,
          serveUrl: warm.serveUrl,
          output,
          frame: 0,
          inputProps,
          imageFormat: "png",
          puppeteerInstance: warm.browser,
          overwrite: true,
          logLevel: "warn",
        });
      };
      await renderMain(join(renderDir, "main-legacy.png"), baseProps);
      await renderMain(join(renderDir, "main-assets.png"), {
        ...baseProps,
        design: { ...mainDesign, assets: generated },
      });
      return generated;
    });
    const backdrop = readFileSync(join(renderDir, refs.backdropFile));
    const screenMask = readFileSync(join(renderDir, refs.screenMaskFile));
    const cameraShadow = readFileSync(join(renderDir, refs.cameraShadowFile!));
    const cameraMask = readFileSync(join(renderDir, refs.cameraMaskFile!));
    assert.deepEqual([backdrop.readUInt32BE(16), backdrop.readUInt32BE(20)], [1920, 1080]);
    assert.deepEqual([cameraShadow.readUInt32BE(16), cameraShadow.readUInt32BE(20)], [1920, 1080]);
    assert.deepEqual([screenMask.readUInt32BE(16), screenMask.readUInt32BE(20)], [1720, 968]);
    assert.deepEqual([cameraMask.readUInt32BE(16), cameraMask.readUInt32BE(20)], [375, 375]);
    assert.equal(screenMask[25], 6, "screen mask PNG must use RGBA color type");
    assert.equal(cameraMask[25], 6, "camera mask PNG must use RGBA color type");
    assert.deepEqual(
      readFileSync(join(renderDir, "main-assets.png")),
      readFileSync(join(renderDir, "main-legacy.png")),
    );
  } finally {
    rmSync(renderDir, { recursive: true, force: true });
  }
});

test("prepareDesignAssetsForProps: 完備cacheをattachし、design無しは同一参照", async () => {
  const props = { ...defaultProps, design: DESIGN };
  const prepared = await prepareDesignAssetsForProps({ dir, props, warm: fakeWarm });
  assert.equal(prepared.design?.assets?.key, designStillKey({
    dir,
    design: DESIGN,
    width: props.width,
    height: props.height,
  }));
  assert.ok(existingDesignAssets({ dir, design: DESIGN, width: props.width, height: props.height }));
  assert.equal(await prepareDesignAssetsForProps({ dir, props: defaultProps }), defaultProps);
  const shortProps: RenderProps = {
    ...props,
    layout: { panels: [{ source: "screen", fit: "contain" }] },
  };
  assert.equal(await prepareDesignAssetsForProps({ dir, props: shortProps }), shortProps);
});

test("prepareDesignAssetsForProps: 生成失敗はassets無しCSS fallback + warning", async () => {
  const fallbackDesign = { ...DESIGN, backgroundColor: "#fedcba" };
  const warnings: string[] = [];
  const props = { ...defaultProps, design: fallbackDesign };
  const prepared = await prepareDesignAssetsForProps({
    dir,
    props,
    warm: fakeWarm,
    renderer: async () => { throw new Error("still failed"); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(prepared.design?.assets, undefined);
  assert.equal(prepared.design?.backgroundColor, "#fedcba");
  assert.match(warnings[0], /CSS描画へ戻します: still failed/);
});
