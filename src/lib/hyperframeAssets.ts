import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export const DEFAULT_HYPERFRAME_ASSET_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface HyperframeAssetInput {
  name: string;
  bytes: Buffer;
}

export interface HyperframeAsset {
  index: number;
  name: string;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  dataUrl: string;
  storedPath?: string;
}

export interface HyperframeAssetLimits {
  maxBytes: number;
  maxTotalBytes: number;
}

export function detectHyperframeImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return undefined;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

export function hyperframeImageSize(bytes: Buffer, mime: string): { width: number; height: number } {
  let size: { width: number; height: number } | undefined;
  if (mime === "image/png" && bytes.length >= 24) {
    size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (mime === "image/gif" && bytes.length >= 10) {
    size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else if (mime === "image/jpeg") {
    size = jpegSize(bytes);
  } else if (mime === "image/webp") {
    size = webpSize(bytes);
  }
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new Error("画像の寸法を読み取れません");
  }
  return size;
}

/** Lottie import と brief 添付の両方が使う画像形式検査の単一実装。 */
export function validateHyperframeImage(
  name: string,
  bytes: Buffer,
  options: { requireDimensions?: boolean } = {},
): { mime: string; width?: number; height?: number } {
  const mime = detectHyperframeImageMime(bytes);
  if (!mime) throw new Error(`未対応または不明な画像形式です: ${name}`);
  const declared = MIME_BY_EXTENSION[extname(name).toLowerCase()];
  if (!declared) throw new Error(`画像の拡張子が未対応です: ${name}`);
  if (declared !== mime) {
    throw new Error(`画像の拡張子と magic bytes が一致しません: ${name}`);
  }
  return options.requireDimensions === false
    ? { mime }
    : { mime, ...hyperframeImageSize(bytes, mime) };
}

export function validateHyperframeAssets(
  inputs: readonly HyperframeAssetInput[],
  limits: HyperframeAssetLimits,
): HyperframeAsset[] {
  const names = new Set<string>();
  let totalBytes = 0;
  return inputs.map((input, itemIndex) => {
    const index = itemIndex + 1;
    if (
      input.name.length === 0 || input.name.length > 200 ||
      basename(input.name) !== input.name || input.name.includes("/") || input.name.includes("\\")
    ) {
      throw new Error(`添付素材${index}のファイル名が不正です`);
    }
    const key = input.name.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error(`同じ名前の添付素材があります: ${input.name}`);
    names.add(key);
    if (input.bytes.length > limits.maxBytes) {
      throw new Error(
        `添付素材「${input.name}」が1ファイルの上限 ${limits.maxBytes} bytes を超えています`,
      );
    }
    totalBytes += input.bytes.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`添付素材の合計が上限 ${limits.maxTotalBytes} bytes を超えています`);
    }
    const image = validateHyperframeImage(input.name, input.bytes);
    if (image.width === undefined || image.height === undefined) {
      throw new Error(`画像の寸法を読み取れません: ${input.name}`);
    }
    const { mime, width, height } = image;
    return {
      index,
      name: input.name,
      bytes: input.bytes,
      mime,
      width,
      height,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      dataUrl: `data:${mime};base64,${input.bytes.toString("base64")}`,
    };
  });
}

export function loadHyperframeAssetInputs(paths: readonly string[]): HyperframeAssetInput[] {
  return paths.map((path) => {
    const requested = resolve(path);
    let realPath: string;
    try {
      realPath = realpathSync(requested);
    } catch (error) {
      throw new Error(`添付素材を読めません: ${requested}: ${(error as Error).message}`);
    }
    return { name: basename(requested), bytes: readFileSync(realPath) };
  });
}

export function saveHyperframeAssets(
  dir: string,
  name: string,
  assets: readonly HyperframeAsset[],
): HyperframeAsset[] {
  if (assets.length === 0) return [];
  const assetsDir = join(dir, "hyperframes", `${name}.assets`);
  mkdirSync(assetsDir, { recursive: true });
  const saved = assets.map((asset) => {
    const storedPath = join(assetsDir, asset.name);
    const tempPath = join(assetsDir, `.${asset.name}.${process.pid}.tmp`);
    writeFileSync(tempPath, asset.bytes);
    renameSync(tempPath, storedPath);
    return { ...asset, storedPath };
  });
  const provenancePath = join(assetsDir, "assets.json");
  const provenanceTempPath = join(assetsDir, `.assets.${process.pid}.tmp`);
  writeFileSync(provenanceTempPath, `${JSON.stringify({
    version: 1,
    assets: saved.map((asset) => ({
      index: asset.index,
      name: asset.name,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes.length,
      sha256: asset.sha256,
    })),
  }, null, 2)}\n`);
  renameSync(provenanceTempPath, provenancePath);
  return saved;
}

export function formatHyperframeAssetPrompt(assets: readonly HyperframeAsset[]): string {
  if (assets.length === 0) return "";
  const lines = assets.map((asset) =>
    `- 添付素材${asset.index}: ${asset.name} (${asset.width}×${asset.height} ${asset.mime.slice(6).toUpperCase()})。` +
      `使う場合は src に __HF_ASSET_${asset.index}__ とだけ書くこと`,
  );
  return `\n\n## 添付素材\n\n${lines.join("\n")}\n\n` +
    "画像バイト列や data URL は自分で書かないでください。使う画像の src には、" +
    "上記の対応するトークンを一字も変えずに書いてください。";
}

export function replaceHyperframeAssetTokens(
  html: string,
  assets: readonly Pick<HyperframeAsset, "index" | "dataUrl">[],
): string {
  const byIndex = new Map(assets.map((asset) => [asset.index, asset.dataUrl]));
  const replaced = html.replace(/__HF_ASSET_(\d+)__/g, (token, rawIndex: string) => {
    const dataUrl = byIndex.get(Number(rawIndex));
    if (!dataUrl) throw new Error(`生成結果が存在しない添付素材トークンを参照しています: ${token}`);
    return dataUrl;
  });
  if (replaced.includes("__HF_ASSET_")) {
    throw new Error("生成結果に置換できない添付素材トークンが残っています");
  }
  return replaced;
}
