// lib/designStill.ts — design の背景・影・角丸 mask を内容アドレス式で生成する。
// Node 専用。browser-safe な描画本体は remotion/DesignStill.tsx に置く。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { WarmAssets } from "../stages/frames.ts";
import type { DesignAssetRefs } from "./design.ts";
import type {
  DesignStillDesign,
  DesignStillProps,
  DesignStillRole,
} from "../../remotion/DesignStill.tsx";

export const DESIGN_STILL_DIR = "render.fast/design";
export const DESIGN_STILL_GENERATOR_VERSION = 1;

const roleSuffix: Record<DesignStillRole, string> = {
  backdrop: "backdrop",
  screenMask: "screen-mask",
  cameraShadow: "camera-shadow",
  cameraMask: "camera-mask",
};

export type DesignStillKeyArgs = {
  dir: string;
  design: DesignStillDesign;
  width: number;
  height: number;
};

/** generator version、解決済み design、出力解像度、背景 path + bytes を含むキー。
 * generated な assets は DesignStillDesign の型から除外されている */
export function designStillKey({ dir, design, width, height }: DesignStillKeyArgs): string {
  const backgroundBytesHash = design.backgroundFile
    ? createHash("sha256").update(readFileSync(join(dir, design.backgroundFile))).digest("hex")
    : null;
  const canon = {
    version: DESIGN_STILL_GENERATOR_VERSION,
    width,
    height,
    design: {
      backgroundFile: design.backgroundFile ?? null,
      backgroundColor: design.backgroundColor,
      screen: design.screen,
      camera: design.camera ?? null,
    },
    backgroundBytesHash,
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

function rolesFor(design: DesignStillDesign): DesignStillRole[] {
  return design.camera
    ? ["backdrop", "screenMask", "cameraShadow", "cameraMask"]
    : ["backdrop", "screenMask"];
}

function relativePath(key: string, role: DesignStillRole): string {
  return join(DESIGN_STILL_DIR, `${key}.${roleSuffix[role]}.png`);
}

export function designAssetRefs(args: DesignStillKeyArgs): DesignAssetRefs {
  const key = designStillKey(args);
  const refs: DesignAssetRefs = {
    key,
    backdropFile: relativePath(key, "backdrop"),
    screenMaskFile: relativePath(key, "screenMask"),
  };
  if (args.design.camera) {
    refs.cameraShadowFile = relativePath(key, "cameraShadow");
    refs.cameraMaskFile = relativePath(key, "cameraMask");
  }
  return refs;
}

export type DesignStillRenderRequest = {
  warm: WarmAssets;
  props: DesignStillProps;
  output: string;
};

export type DesignStillRenderer = (request: DesignStillRenderRequest) => Promise<void>;

const defaultRenderer: DesignStillRenderer = async ({ warm, props, output }) => {
  const inputProps = props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl: warm.serveUrl,
    id: "DesignStill",
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

/** 全 role が揃っていれば Chrome に触れず refs を返す。miss 時は全 PNG を
 * 一時名へ生成し、すべて成功してから rename で完成名を公開する */
export async function prepareDesignStillAssets(args: DesignStillKeyArgs & {
  warm: WarmAssets;
  renderer?: DesignStillRenderer;
}): Promise<DesignAssetRefs> {
  const { dir, design, width, height, warm, renderer = defaultRenderer } = args;
  const refs = designAssetRefs({ dir, design, width, height });
  const roles = rolesFor(design);
  const finalPaths = roles.map((role) => join(dir, relativePath(refs.key, role)));
  if (finalPaths.every(existsSync)) return refs;

  mkdirSync(dirname(finalPaths[0]), { recursive: true });
  const nonce = `${process.pid}-${randomUUID()}`;
  const tempPaths = finalPaths.map((path) => `${path}.tmp-${nonce}`);
  try {
    for (let i = 0; i < roles.length; i += 1) {
      await renderer({
        warm,
        props: { width, height, role: roles[i], design },
        output: tempPaths[i],
      });
      if (!existsSync(tempPaths[i])) {
        throw new Error(`DesignStill が出力を生成しませんでした: ${tempPaths[i]}`);
      }
    }
    for (let i = 0; i < finalPaths.length; i += 1) renameSync(tempPaths[i], finalPaths[i]);
    return refs;
  } finally {
    for (const path of tempPaths) rmSync(path, { force: true });
  }
}
