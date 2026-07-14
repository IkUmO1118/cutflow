// lib/designStill.ts — design の背景・影・角丸 mask を内容アドレス式で生成する。
// Node 専用。browser-safe な描画本体は remotion/DesignStill.tsx に置く。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { WarmAssets } from "../stages/frames.ts";
import { withCaptionStillAssets } from "./captionStill.ts";
import type { RenderProps } from "../../remotion/props.ts";
import type { DesignAssetRefs, DesignProps, PreparedDesignAssets } from "./design.ts";
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

function stillDesign(design: DesignProps): Omit<DesignProps, "assets"> {
  const { assets: _assets, ...source } = design;
  return source;
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

function assetFiles(refs: DesignAssetRefs): string[] {
  return [
    refs.backdropFile,
    refs.screenMaskFile,
    ...(refs.cameraShadowFile ? [refs.cameraShadowFile] : []),
    ...(refs.cameraMaskFile ? [refs.cameraMaskFile] : []),
  ];
}

/** 現在の resolved design から key を再計算し、必要な全fileが存在するときだけ
 * bundleを返す。背景欠落・partial cache は未準備扱い */
export function existingDesignAssets(args: DesignStillKeyArgs): PreparedDesignAssets | undefined {
  try {
    const refs = designAssetRefs(args);
    if (!assetFiles(refs).every((file) => existsSync(join(args.dir, file)))) return undefined;
    return {
      width: args.width,
      height: args.height,
      design: args.design as Omit<DesignProps, "assets">,
      refs,
    };
  } catch {
    return undefined;
  }
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

export async function prepareDesignAssetsForProps(args: {
  dir: string;
  props: RenderProps;
  warm?: WarmAssets;
  warn?: (message: string) => void;
  renderer?: DesignStillRenderer;
}): Promise<RenderProps> {
  const { dir, props, warm, renderer, warn = () => {} } = args;
  if (!props.design || props.layout) return props;
  const design = stillDesign(props.design);
  const keyArgs = { dir, design, width: props.width, height: props.height };
  const cached = existingDesignAssets(keyArgs);
  if (cached) return { ...props, design: { ...design, assets: cached.refs } };
  try {
    const refs = warm
      ? await prepareDesignStillAssets({ ...keyArgs, warm, ...(renderer ? { renderer } : {}) })
      : await withCaptionStillAssets(dir, (assets) =>
          prepareDesignStillAssets({ ...keyArgs, warm: assets, ...(renderer ? { renderer } : {}) })
        );
    return { ...props, design: { ...design, assets: refs } };
  } catch (error) {
    warn(`design 静的資産を生成できませんでした。CSS描画へ戻します: ${(error as Error).message}`);
    return { ...props, design };
  }
}

export async function prepareDesignAssetBundle(args: DesignStillKeyArgs & {
  warn?: (message: string) => void;
}): Promise<PreparedDesignAssets | undefined> {
  const cached = existingDesignAssets(args);
  if (cached) return cached;
  try {
    const refs = await withCaptionStillAssets(args.dir, (warm) =>
      prepareDesignStillAssets({ ...args, warm })
    );
    return {
      width: args.width,
      height: args.height,
      design: args.design as Omit<DesignProps, "assets">,
      refs,
    };
  } catch (error) {
    args.warn?.(`design 静的資産を生成できませんでした。CSS描画へ戻します: ${(error as Error).message}`);
    return undefined;
  }
}
