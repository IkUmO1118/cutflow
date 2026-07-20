import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatHyperframeAssetPrompt,
  HYPERFRAME_FONT_MAX_BYTES,
  replaceHyperframeAssetTokens,
  saveHyperframeAssets,
  validateHyperframeAssets,
} from "../src/lib/hyperframeAssets.ts";
import {
  resolveHyperframeAuthorPrompt,
  resolveHyperframeFontConditionals,
} from "../src/stages/hyperframe.ts";

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function woff2(size = 16): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.write("wOF2", 0, "ascii");
  return bytes;
}

const limits = { maxBytes: 1024, maxTotalBytes: 2048 };

test("validateHyperframeAssets: magic bytes・拡張子・寸法を検査して data URL 化する", () => {
  const [asset] = validateHyperframeAssets([{ name: "logo.png", bytes: png(512, 256) }], limits);
  assert.ok(!("kind" in asset));
  assert.equal(asset.index, 1);
  assert.equal(asset.mime, "image/png");
  assert.equal(asset.width, 512);
  assert.equal(asset.height, 256);
  assert.match(asset.dataUrl, /^data:image\/png;base64,/);
});

test("validateHyperframeAssets: woff2 は magic/MIME/固定1MiB と入力順 index を検査する", () => {
  const assets = validateHyperframeAssets(
    [
      { name: "logo.png", bytes: png() },
      { name: "title.woff2", bytes: woff2() },
      { name: "photo.png", bytes: png() },
    ],
    { maxBytes: 2 * 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024 },
  );
  const font = assets[1];
  assert.ok("kind" in font && font.kind === "font");
  assert.equal(font.index, 2);
  assert.equal(font.mime, "font/woff2");
  assert.match(font.dataUrl, /^data:font\/woff2;base64,/);
  assert.throws(
    () => validateHyperframeAssets(
      [{ name: "bad.woff2", bytes: Buffer.from("wOFF") }],
      { maxBytes: 1024, maxTotalBytes: 1024 },
    ),
    /magic bytes が一致しません/,
  );
  assert.throws(
    () => validateHyperframeAssets(
      [{ name: "full.woff2", bytes: woff2(HYPERFRAME_FONT_MAX_BYTES + 1) }],
      { maxBytes: 2 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 },
    ),
    /固定上限 1048576 bytes/,
  );
});

test("validateHyperframeAssets: magic bytes 不明・拡張子不一致・単枚/合計上限を拒否する", () => {
  assert.throws(
    () => validateHyperframeAssets([{ name: "logo.png", bytes: Buffer.from("not-image") }], limits),
    /未対応または不明/,
  );
  assert.throws(
    () => validateHyperframeAssets([{ name: "logo.jpg", bytes: png() }], limits),
    /magic bytes が一致しません/,
  );
  assert.throws(
    () => validateHyperframeAssets([{ name: "large.png", bytes: png().subarray(0, 24) }], { maxBytes: 10, maxTotalBytes: 100 }),
    /1ファイルの上限/,
  );
  assert.throws(
    () => validateHyperframeAssets(
      [{ name: "a.png", bytes: png() }, { name: "b.png", bytes: png() }],
      { maxBytes: 30, maxTotalBytes: 40 },
    ),
    /合計が上限/,
  );
});

test("saveHyperframeAssets: <name>.assets に検査済みbyteを残す", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-assets-"));
  const assets = validateHyperframeAssets([{ name: "logo.png", bytes: png() }], limits);
  const [saved] = saveHyperframeAssets(dir, "intro", assets);
  const expected = join(dir, "hyperframes", "intro.assets", "logo.png");
  assert.equal(saved.storedPath, expected);
  assert.equal(existsSync(expected), true);
  assert.deepEqual(readFileSync(expected), png());
  const provenance = JSON.parse(readFileSync(
    join(dir, "hyperframes", "intro.assets", "assets.json"),
    "utf8",
  )) as { assets: Array<{ name: string; sha256: string }> };
  assert.equal(provenance.assets[0].name, "logo.png");
  assert.match(provenance.assets[0].sha256, /^[a-f0-9]{64}$/);
});

test("saveHyperframeAssets: font entry だけ kind を持ち画像 entry schema は不変", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-font-assets-"));
  const assets = validateHyperframeAssets(
    [{ name: "logo.png", bytes: png() }, { name: "subset.woff2", bytes: woff2() }],
    limits,
  );
  saveHyperframeAssets(dir, "intro", assets);
  const provenance = JSON.parse(readFileSync(
    join(dir, "hyperframes", "intro.assets", "assets.json"),
    "utf8",
  )) as { version: number; assets: Array<Record<string, unknown>> };
  assert.equal(provenance.version, 1);
  assert.deepEqual(Object.keys(provenance.assets[0]), [
    "index", "name", "mime", "width", "height", "bytes", "sha256",
  ]);
  assert.deepEqual(Object.keys(provenance.assets[1]), [
    "kind", "index", "name", "mime", "bytes", "sha256",
  ]);
  assert.equal(provenance.assets[1].kind, "font");
  assert.equal(provenance.assets[1].width, undefined);
});

test("format/replaceHyperframeAssetTokens: prompt はtokenだけを渡し HTML へ data URL を焼き込む", () => {
  const assets = validateHyperframeAssets([{ name: "logo.png", bytes: png(512, 512) }], limits);
  const prompt = formatHyperframeAssetPrompt(assets);
  assert.equal(
    prompt,
    "\n\n## 添付素材\n\n" +
      "- 添付素材1: logo.png (512×512 PNG)。使う場合は src に __HF_ASSET_1__ とだけ書くこと\n\n" +
      "画像バイト列や data URL は自分で書かないでください。使う画像の src には、" +
      "上記の対応するトークンを一字も変えずに書いてください。",
    "画像だけの prompt は X1 導入前と byte-equivalent",
  );
  assert.match(prompt, /logo\.png \(512×512 PNG\)/);
  assert.match(prompt, /__HF_ASSET_1__/);
  assert.doesNotMatch(prompt, /data:image/);
  assert.equal(
    replaceHyperframeAssetTokens('<img src="__HF_ASSET_1__">', assets),
    `<img src="${assets[0].dataUrl}">`,
  );
});

test("format/replaceHyperframeAssetTokens: font prompt はmetadataと正確な例だけを渡す", () => {
  const assets = validateHyperframeAssets(
    [{ name: "logo.png", bytes: png() }, { name: "title.woff2", bytes: woff2() }],
    limits,
  );
  const prompt = formatHyperframeAssetPrompt(assets);
  assert.match(prompt, /title\.woff2 \(font\/woff2, 16 bytes\)/);
  assert.match(
    prompt,
    /@font-face \{ font-family: "HFAsset2"; src: url\("__HF_FONT_2__"\) format\("woff2"\); font-display: block; \}/,
  );
  assert.doesNotMatch(prompt, /data:font\/woff2|d09GMg/);
  const html = '<style>@font-face{font-family:"HFAsset2";src:url("__HF_FONT_2__") format("woff2")}</style>';
  assert.equal(
    replaceHyperframeAssetTokens(html, assets),
    html.replace("__HF_FONT_2__", assets[1].dataUrl),
  );
});

test("replaceHyperframeAssetTokens: 捏造番号と部分トークンを失敗にする", () => {
  const assets = validateHyperframeAssets([{ name: "logo.png", bytes: png() }], limits);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_ASSET_2__", assets), /存在しない/);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_ASSET_1", assets), /置換できない/);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_FONT_1__", assets), /存在しない/);
  const fonts = validateHyperframeAssets([{ name: "title.woff2", bytes: woff2() }], limits);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_FONT_1", fonts), /置換できない/);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_ASSET_1__", fonts), /存在しない/);
});

test("resolveHyperframeFontConditionals: font 無しは旧文面、font 有りだけ新契約を選ぶ", () => {
  const source = "A{{#fontAssets}}provided HFAsset1{{/fontAssets}}{{^fontAssets}}generic only{{/fontAssets}}B";
  assert.equal(resolveHyperframeFontConditionals(source, false), "Ageneric onlyB");
  assert.equal(resolveHyperframeFontConditionals(source, true), "Aprovided HFAsset1B");
  assert.throws(() => resolveHyperframeFontConditionals("{{#fontAssets}}broken", true), /形式が不正/);
});

test("font未添付の実 author template/patterns はX1前のbyte hashを保つ", () => {
  const cases = [
    [new URL("../prompts/hyperframe.md", import.meta.url), "d91c52024db997a20356e6d2458afc16b39256fd5787879e512b1179f0b0991d"],
    [new URL("../docs/hyperframes-skills/card-patterns.md", import.meta.url), "8841258b5e5ba4824b61ec867d3fc7ca8189847a1771c97ba79a8e6baca50002"],
  ] as const;
  for (const [url, expected] of cases) {
    const resolved = resolveHyperframeFontConditionals(readFileSync(url, "utf8"), false);
    assert.equal(createHash("sha256").update(resolved).digest("hex"), expected);
  }
});

test("resolveHyperframeAuthorPrompt: 添付ゼロは従来 template とバイト等価", () => {
  const common = {
    brief: "brief",
    rules: "rules",
    patterns: "patterns",
    width: 1920,
    height: 1080,
    durationSec: 4,
  };
  const before = resolveHyperframeAuthorPrompt({ template: "A{{brief}}B", ...common });
  const after = resolveHyperframeAuthorPrompt({ template: "A{{brief}}{{assets}}B", ...common });
  assert.equal(after, before);
});
