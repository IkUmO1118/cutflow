import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatHyperframeAssetPrompt,
  replaceHyperframeAssetTokens,
  saveHyperframeAssets,
  validateHyperframeAssets,
} from "../src/lib/hyperframeAssets.ts";
import { resolveHyperframeAuthorPrompt } from "../src/stages/hyperframe.ts";

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const limits = { maxBytes: 1024, maxTotalBytes: 2048 };

test("validateHyperframeAssets: magic bytes・拡張子・寸法を検査して data URL 化する", () => {
  const [asset] = validateHyperframeAssets([{ name: "logo.png", bytes: png(512, 256) }], limits);
  assert.equal(asset.index, 1);
  assert.equal(asset.mime, "image/png");
  assert.equal(asset.width, 512);
  assert.equal(asset.height, 256);
  assert.match(asset.dataUrl, /^data:image\/png;base64,/);
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

test("format/replaceHyperframeAssetTokens: prompt はtokenだけを渡し HTML へ data URL を焼き込む", () => {
  const assets = validateHyperframeAssets([{ name: "logo.png", bytes: png(512, 512) }], limits);
  const prompt = formatHyperframeAssetPrompt(assets);
  assert.match(prompt, /logo\.png \(512×512 PNG\)/);
  assert.match(prompt, /__HF_ASSET_1__/);
  assert.doesNotMatch(prompt, /data:image/);
  assert.equal(
    replaceHyperframeAssetTokens('<img src="__HF_ASSET_1__">', assets),
    `<img src="${assets[0].dataUrl}">`,
  );
});

test("replaceHyperframeAssetTokens: 捏造番号と部分トークンを失敗にする", () => {
  const assets = validateHyperframeAssets([{ name: "logo.png", bytes: png() }], limits);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_ASSET_2__", assets), /存在しない/);
  assert.throws(() => replaceHyperframeAssetTokens("__HF_ASSET_1", assets), /置換できない/);
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
