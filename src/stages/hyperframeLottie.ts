import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { CDN_PINS } from "../lib/hyperframeCdn.ts";
import { checkComposition } from "../lib/hyperframeCheck.ts";
import { validateHyperframeImage } from "../lib/hyperframeAssets.ts";

type JsonObject = Record<string, unknown>;

export interface EmbedLottieResult {
  sourcePath: string;
  sourceSha256: string;
  width: number;
  height: number;
  frameRate: number;
  durationSec: number;
  imageAssetCount: number;
  summary: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function safeJavaScriptJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function requirePositiveNumber(input: JsonObject, key: "w" | "h" | "fr"): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Lottie JSON の ${key} は有限の正数である必要があります`);
  }
  return value;
}

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

function resolveImageAsset(jsonDir: string, u: string, p: string): string {
  const raw = `${u}${p}`;
  const portable = raw.replaceAll("\\", "/");
  if (
    portable.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(portable) ||
    /^[A-Za-z]:\//.test(portable) ||
    isAbsolute(portable)
  ) {
    throw new Error(`Lottie image asset は remote/protocol/absolute path を使えません: ${raw}`);
  }

  const lexical = resolve(jsonDir, portable);
  const realRoot = realpathSync(jsonDir);
  if (isOutside(realRoot, lexical)) {
    throw new Error(`Lottie image asset が JSON directory の外を参照しています: ${raw}`);
  }

  let realAsset: string;
  try {
    realAsset = realpathSync(lexical);
  } catch (error) {
    throw new Error(`Lottie image asset を読めません: ${raw}: ${(error as Error).message}`);
  }
  if (isOutside(realRoot, realAsset)) {
    throw new Error(`Lottie image asset の symlink が JSON directory の外を参照しています: ${raw}`);
  }
  return realAsset;
}

function embedImageAssets(animation: JsonObject, jsonDir: string): number {
  const assets = animation.assets;
  if (assets === undefined) return 0;
  if (!Array.isArray(assets)) throw new Error("Lottie JSON の assets は配列である必要があります");

  let count = 0;
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    if (!isObject(asset)) throw new Error(`Lottie JSON の assets[${index}] は object である必要があります`);
    if (!("p" in asset)) continue;
    if (typeof asset.p !== "string" || asset.p.length === 0) {
      throw new Error(`Lottie JSON の assets[${index}].p は空でない文字列である必要があります`);
    }

    let dataUrl = asset.p;
    if (!/^data:image(?:\/|;)/i.test(dataUrl)) {
      const u = asset.u === undefined ? "" : asset.u;
      if (typeof u !== "string") {
        throw new Error(`Lottie JSON の assets[${index}].u は文字列である必要があります`);
      }
      const assetPath = resolveImageAsset(jsonDir, u, asset.p);
      const bytes = readFileSync(assetPath);
      const { mime: detected } = validateHyperframeImage(asset.p, bytes, { requireDimensions: false });
      dataUrl = `data:${detected};base64,${bytes.toString("base64")}`;
    }
    asset.p = dataUrl;
    asset.u = "";
    asset.e = 1;
    count += 1;
  }
  return count;
}

export function buildLottieCard(args: {
  animation: JsonObject;
  sourceBasename: string;
  sourceSha256: string;
}): { html: string; width: number; height: number; frameRate: number; durationSec: number } {
  const width = requirePositiveNumber(args.animation, "w");
  const height = requirePositiveNumber(args.animation, "h");
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error("Lottie JSON の w/h は render 可能な正の整数である必要があります");
  }
  const frameRate = requirePositiveNumber(args.animation, "fr");
  const ip = args.animation.ip;
  const op = args.animation.op;
  if (typeof ip !== "number" || !Number.isFinite(ip)) {
    throw new Error("Lottie JSON の ip は有限の数である必要があります");
  }
  if (typeof op !== "number" || !Number.isFinite(op) || op <= ip) {
    throw new Error("Lottie JSON の op は有限で ip より大きい必要があります");
  }
  const durationSec = (op - ip) / frameRate;
  const pin = CDN_PINS.find((candidate) => candidate.lib === "lottie");
  if (!pin) throw new Error("lottie CDN pin がありません");

  const provenance = escapeHtmlAttribute(`${args.sourceBasename}; sha256=${args.sourceSha256}`);
  const animationData = safeJavaScriptJson(args.animation);
  const html = `<!doctype html>
<html data-composition-variables='[]'>
<head>
  <meta charset="utf-8">
  <meta name="cutflow-lottie-source" content="${provenance}">
  <script src="${pin.url}" integrity="${pin.integrity}" crossorigin="anonymous"></script>
  <style>
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
    #root{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
    #lottie{position:absolute;inset:0}
  </style>
</head>
<body>
  <div id="root" data-composition-id="root" data-width="${width}" data-height="${height}" data-hf-requires="lottie" data-hf-determinism="byte">
    <div id="lottie" class="clip" data-start="0" data-duration="${durationSec}"></div>
    <script>
      var DATA = ${animationData};
      var anim = lottie.loadAnimation({
        container: document.getElementById('lottie'),
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: DATA
      });
      window.__hfLottie = window.__hfLottie || [];
      window.__hfLottie.push(anim);
    </script>
  </div>
</body>
</html>
`;
  return { html, width, height, frameRate, durationSec };
}

export function embedLottieHyperframe(
  dir: string,
  opts: { name: string; lottiePath: string; force?: boolean },
): EmbedLottieResult {
  const sourcePath = join(dir, "hyperframes", `${opts.name}.html`);
  if (existsSync(sourcePath) && opts.force !== true) {
    throw new Error(
      `${sourcePath} は既にあります。Lottie import で置き換える場合は --force を付けてください`,
    );
  }

  const requestedPath = resolve(opts.lottiePath);
  if (extname(requestedPath).toLowerCase() === ".lottie") {
    throw new Error(".lottie container は未対応です。AE/bodymovin の JSON を指定してください");
  }
  let sourceBytes: Buffer;
  try {
    sourceBytes = readFileSync(requestedPath);
  } catch (error) {
    throw new Error(`Lottie JSON を読めません: ${requestedPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Lottie JSON の parse に失敗しました: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error("Lottie JSON の top-level は object である必要があります");

  const imageAssetCount = embedImageAssets(parsed, dirname(realpathSync(requestedPath)));
  const sourceSha256 = sha256Hex(sourceBytes);
  const built = buildLottieCard({
    animation: parsed,
    sourceBasename: basename(requestedPath),
    sourceSha256,
  });
  const check = checkComposition(built.html, { file: `hyperframes/${opts.name}.html` });
  if (check.errors.length > 0 || check.warnings.length > 0) {
    const problems = [...check.errors, ...check.warnings].map((problem) =>
      `  ${problem.where}: ${problem.message}`,
    );
    throw new Error(
      `Lottie import の composition が check ゲート(0 errors / 0 warnings)に失敗しました:\n${problems.join("\n")}`,
    );
  }

  const outputDir = dirname(sourcePath);
  mkdirSync(outputDir, { recursive: true });
  const tempDir = mkdtempSync(join(outputDir, ".lottie-import-"));
  const tempPath = join(tempDir, `${opts.name}.html`);
  try {
    writeFileSync(tempPath, built.html, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, sourcePath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    sourcePath,
    sourceSha256,
    width: built.width,
    height: built.height,
    frameRate: built.frameRate,
    durationSec: built.durationSec,
    imageAssetCount,
    summary: check.summary,
  };
}
