import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";
import { hyperframeCacheKey } from "../src/stages/hyperframe.ts";
import {
  buildLottieCard,
  embedLottieHyperframe,
} from "../src/stages/hyperframeLottie.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

function animation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: "5.12.2",
    fr: 30,
    ip: 0,
    op: 60,
    w: 640,
    h: 360,
    assets: [],
    layers: [],
    ...overrides,
  };
}

function writeAnimation(
  root: string,
  value: Record<string, unknown>,
  name = "animation.json",
): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
}

function extractAnimationData(html: string): Record<string, unknown> {
  const match = /var DATA = (.*);\n      var anim =/.exec(html);
  assert.ok(match, "generated card must contain canonical DATA assignment");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("embedLottieHyperframe embeds a concrete AE external-image export and passes check 0/0", () => {
  const recording = mkdtempSync(join(tmpdir(), "hf-lottie-fixture-"));
  const source = join(import.meta.dirname, "fixtures", "lottie", "source", "animation.json");
  const result = embedLottieHyperframe(recording, { name: "card", lottiePath: source });
  const html = readFileSync(result.sourcePath, "utf8");
  const fixtureHtml = readFileSync(
    join(import.meta.dirname, "fixtures", "lottie", "hyperframes", "card.html"),
    "utf8",
  );
  const data = extractAnimationData(html);
  const assets = data.assets as Record<string, unknown>[];

  assert.equal(result.width, 640);
  assert.equal(result.height, 360);
  assert.equal(result.frameRate, 30);
  assert.equal(result.durationSec, 2);
  assert.equal(result.imageAssetCount, 1);
  assert.equal(html, fixtureHtml);
  assert.match(html, /data-hf-determinism="byte"/);
  assert.match(assets[0].p as string, /^data:image\/jpeg;base64,/);
  assert.equal(assets[0].u, "");
  assert.equal(assets[0].e, 1);
  assert.deepEqual(assets[1], { id: "precomp_0", layers: [] });
  const checked = checkComposition(html);
  assert.equal(checked.errors.length, 0);
  assert.equal(checked.warnings.length, 0);
});

test("existing data:image URLs are preserved and duplicate image assets are normalized independently", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-data-"));
  const preserved = "data:image/png;base64,AA==";
  const source = writeAnimation(root, animation({
    assets: [
      { id: "a", p: preserved, u: "ignored/", e: 0 },
      { id: "b", p: preserved },
      { id: "precomp", layers: [{ ty: 4 }] },
    ],
  }));
  const recording = join(root, "recording");
  mkdirSync(recording);
  const result = embedLottieHyperframe(recording, { name: "data", lottiePath: source });
  const assets = extractAnimationData(readFileSync(result.sourcePath, "utf8")).assets as Record<string, unknown>[];
  assert.equal(result.imageAssetCount, 2);
  assert.deepEqual(assets.slice(0, 2).map((asset) => ({ p: asset.p, u: asset.u, e: asset.e })), [
    { p: preserved, u: "", e: 1 },
    { p: preserved, u: "", e: 1 },
  ]);
  assert.deepEqual(assets[2], { id: "precomp", layers: [{ ty: 4 }] });
});

test("an omitted assets field stays omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-no-assets-"));
  const value = animation();
  delete value.assets;
  const source = writeAnimation(root, value);
  const recording = join(root, "recording");
  mkdirSync(recording);
  const result = embedLottieHyperframe(recording, { name: "card", lottiePath: source });
  assert.equal("assets" in extractAnimationData(readFileSync(result.sourcePath, "utf8")), false);
});

test("external asset path policy rejects missing, remote, protocol, absolute, and lexical escape paths", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-path-"));
  const outside = join(dirname(root), `${basename(root)}-outside.jpg`);
  writeFileSync(outside, jpegBytes());
  const cases = [
    ["missing", "", "missing.jpg", /読めません/],
    ["remote", "https://example.com/", "image.jpg", /remote\/protocol\/absolute/],
    ["protocol", "file:", "image.jpg", /remote\/protocol\/absolute/],
    ["absolute", "", outside, /remote\/protocol\/absolute/],
    ["escape", "../", basename(outside), /外を参照/],
  ] as const;

  for (const [label, u, p, expected] of cases) {
    const sourceDir = join(root, label);
    const source = writeAnimation(sourceDir, animation({ assets: [{ id: "image", u, p }] }));
    const recording = join(root, `recording-${label}`);
    mkdirSync(recording);
    assert.throws(
      () => embedLottieHyperframe(recording, { name: "card", lottiePath: source }),
      expected,
      label,
    );
    assert.equal(existsSync(join(recording, "hyperframes", "card.html")), false, label);
  }
});

test("external asset symlinks cannot escape the JSON directory", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-symlink-"));
  const sourceDir = join(root, "source");
  const images = join(sourceDir, "images");
  mkdirSync(images, { recursive: true });
  const outside = join(root, "outside.jpg");
  writeFileSync(outside, jpegBytes());
  symlinkSync(outside, join(images, "linked.jpg"));
  const source = writeAnimation(sourceDir, animation({
    assets: [{ id: "image", u: "images/", p: "linked.jpg" }],
  }));
  const recording = join(root, "recording");
  mkdirSync(recording);
  assert.throws(
    () => embedLottieHyperframe(recording, { name: "card", lottiePath: source }),
    /symlink.*外/,
  );
});

test("unsupported and extension/magic-mismatched image bytes are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-mime-"));
  for (const [filename, bytes, expected] of [
    ["unknown.bmp", Buffer.from("BM-not-supported"), /未対応または不明/],
    ["wrong.png", jpegBytes(), /magic bytes が一致しません/],
    ["no-extension", jpegBytes(), /拡張子が未対応/],
  ] as const) {
    const sourceDir = join(root, filename.replaceAll(".", "-"));
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, filename), bytes);
    const source = writeAnimation(sourceDir, animation({ assets: [{ p: filename, u: "" }] }));
    const recording = join(sourceDir, "recording");
    mkdirSync(recording);
    assert.throws(
      () => embedLottieHyperframe(recording, { name: "card", lottiePath: source }),
      expected,
    );
  }
});

test("invalid JSON shape, .lottie containers, and invalid timing/dimensions are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-invalid-"));
  const recording = join(root, "recording");
  mkdirSync(recording);
  const invalidJson = join(root, "invalid.json");
  writeFileSync(invalidJson, "[");
  assert.throws(
    () => embedLottieHyperframe(recording, { name: "invalid", lottiePath: invalidJson }),
    /parse に失敗/,
  );
  const container = join(root, "animation.lottie");
  writeFileSync(container, "zip");
  assert.throws(
    () => embedLottieHyperframe(recording, { name: "container", lottiePath: container }),
    /.lottie container は未対応/,
  );

  for (const [label, value] of [
    ["width", animation({ w: 0 })],
    ["height", animation({ h: -1 })],
    ["fr", animation({ fr: 0 })],
    ["ip", animation({ ip: null })],
    ["op", animation({ ip: 20, op: 20 })],
  ] as const) {
    const source = writeAnimation(root, value, `${label}.json`);
    assert.throws(
      () => embedLottieHyperframe(recording, { name: label, lottiePath: source }),
      /Lottie JSON/,
      label,
    );
  }
  assert.throws(
    () => buildLottieCard({
      animation: animation({ fr: Number.NaN }),
      sourceBasename: "x.json",
      sourceSha256: "a".repeat(64),
    }),
    /fr は有限の正数/,
  );
});

test("failed imports never publish and --force failures preserve existing HTML bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-atomic-"));
  const recording = join(root, "recording");
  const output = join(recording, "hyperframes", "card.html");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, "existing-card-bytes");
  const invalid = writeAnimation(root, animation({ op: 0 }));

  assert.throws(
    () => embedLottieHyperframe(recording, { name: "card", lottiePath: invalid }),
    /--force/,
  );
  assert.equal(readFileSync(output, "utf8"), "existing-card-bytes");
  assert.throws(
    () => embedLottieHyperframe(recording, { name: "card", lottiePath: invalid, force: true }),
    /op.*ip/,
  );
  assert.equal(readFileSync(output, "utf8"), "existing-card-bytes");

  const valid = writeAnimation(root, animation(), "valid.json");
  embedLottieHyperframe(recording, { name: "card", lottiePath: valid, force: true });
  assert.notEqual(readFileSync(output, "utf8"), "existing-card-bytes");
  assert.equal(checkComposition(readFileSync(output, "utf8")).errors.length, 0);
});

test("output is deterministic, safely serialized, and records only basename plus source sha", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-safe-"));
  const special = "</script><script>alert('&')\u2028\u2029";
  const source = writeAnimation(join(root, "source"), animation({ nm: special }));
  const firstRecording = join(root, "first");
  const secondRecording = join(root, "second");
  mkdirSync(firstRecording);
  mkdirSync(secondRecording);
  const first = embedLottieHyperframe(firstRecording, { name: "card", lottiePath: source });
  const second = embedLottieHyperframe(secondRecording, { name: "card", lottiePath: source });
  const firstHtml = readFileSync(first.sourcePath, "utf8");
  const secondHtml = readFileSync(second.sourcePath, "utf8");

  assert.equal(firstHtml, secondHtml);
  assert.equal(firstHtml.includes(special), false);
  assert.match(firstHtml, /\\u003c\/script\\u003e/);
  assert.match(firstHtml, /\\u0026/);
  assert.match(firstHtml, /\\u2028\\u2029/);
  assert.equal(extractAnimationData(firstHtml).nm, special);
  assert.match(firstHtml, new RegExp(`content="animation.json; sha256=${first.sourceSha256}"`));
  assert.equal(firstHtml.includes(dirname(source)), false);
});

test("source JSON changes rewrite HTML and invalidate the render cache key", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-cache-"));
  const recording = join(root, "recording");
  mkdirSync(recording);
  const source = writeAnimation(root, animation({ nm: "first" }));
  const first = embedLottieHyperframe(recording, { name: "card", lottiePath: source });
  const firstHtml = readFileSync(first.sourcePath, "utf8");
  writeFileSync(source, JSON.stringify(animation({ nm: "second" }), null, 2));
  embedLottieHyperframe(recording, { name: "card", lottiePath: source, force: true });
  const secondHtml = readFileSync(first.sourcePath, "utf8");
  assert.notEqual(firstHtml, secondHtml);

  const keyFor = (html: string) => hyperframeCacheKey({
    htmlSha256: createHash("sha256").update(html).digest("hex"),
    variables: {},
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 2,
    codec: "h264",
    hardwareAcceleration: "none",
    profile: "default",
  });
  assert.notEqual(keyFor(firstHtml), keyFor(secondHtml));
});

test("image byte changes rewrite HTML and invalidate the render cache key", () => {
  const root = mkdtempSync(join(tmpdir(), "hf-lottie-image-cache-"));
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  const image = join(sourceDir, "asset.jpg");
  writeFileSync(image, jpegBytes());
  const source = writeAnimation(sourceDir, animation({ assets: [{ p: "asset.jpg", u: "" }] }));
  const recording = join(root, "recording");
  mkdirSync(recording);

  const first = embedLottieHyperframe(recording, { name: "card", lottiePath: source });
  const firstHtml = readFileSync(first.sourcePath, "utf8");
  writeFileSync(image, Buffer.concat([jpegBytes(), Buffer.from([0x01])]));
  embedLottieHyperframe(recording, { name: "card", lottiePath: source, force: true });
  const secondHtml = readFileSync(first.sourcePath, "utf8");

  assert.notEqual(firstHtml, secondHtml);
  const htmlSha = (html: string) => createHash("sha256").update(html).digest("hex");
  assert.notEqual(htmlSha(firstHtml), htmlSha(secondHtml));
});

test("CLI routes --embed-lottie without config and rejects conflicting author/render flags", () => {
  const recording = mkdtempSync(join(tmpdir(), "hf-lottie-cli-"));
  const source = join(import.meta.dirname, "fixtures", "lottie", "source", "animation.json");
  const success = spawnSync(process.execPath, [
    CLI, "hyperframe", recording, "--name", "card", "--embed-lottie", source,
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Lottie composition を書きました/);
  assert.equal(existsSync(join(recording, "hyperframes", "card.html")), true);

  const image = join(import.meta.dirname, "fixtures", "lottie", "source", "images", "card.jpg");
  for (const extra of [["--from-brief"], ["--width", "640"], ["--var", "x=y"], ["--asset", image]]) {
    const args = [CLI, "hyperframe", recording, "--name", "other", "--embed-lottie", source];
    args.push(...extra);
    const failed = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(failed.status, 0, extra.join(" "));
    assert.match(failed.stderr, /同時に指定できません|指定できません/, extra.join(" "));
    assert.equal(existsSync(join(recording, "hyperframes", "other.html")), false);
  }

  const assetWithoutAuthor = spawnSync(process.execPath, [
    CLI, "hyperframe", recording, "--name", "other", "--asset", image,
  ], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(assetWithoutAuthor.status, 0);
  assert.match(assetWithoutAuthor.stderr, /--asset は --from-brief/);
});
