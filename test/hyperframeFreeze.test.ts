// W3: HyperFrames「レシピ凍結」の単体テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkComposition } from "../src/lib/hyperframeCheck.ts";
import { SAMPLE_HTML } from "../src/lib/hyperframe.ts";
import {
  freezeHyperframe,
  loadFrozenSeedMenu,
  maxPatternNumber,
  skeletonizeComposition,
} from "../src/stages/hyperframeFreeze.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const CARD_PATTERNS = readFileSync(
  join(repoRoot, "docs/hyperframes-skills/card-patterns.md"),
  "utf8",
);

function makeRecordingDir(): { channelDir: string; recDir: string } {
  const channelDir = mkdtempSync(join(tmpdir(), "hf-freeze-channel-"));
  const recDir = join(channelDir, "rec1");
  mkdirSync(recDir, { recursive: true });
  return { channelDir, recDir };
}

// ---- skeletonizeComposition ----

test("skeletonizeComposition: string default はラベルへ、color はそのまま", () => {
  const { html, resetVars } = skeletonizeComposition(SAMPLE_HTML);
  assert.deepEqual(resetVars, ["title"]);
  assert.ok(!resetVars.includes("accent"));

  const varsMatch = /data-composition-variables\s*=\s*'([\s\S]*?)'/.exec(html);
  assert.ok(varsMatch, "data-composition-variables が見つからない");
  const decls = JSON.parse(varsMatch[1]) as Array<{ id: string; type: string; default: unknown }>;
  const title = decls.find((d) => d.id === "title");
  const accent = decls.find((d) => d.id === "accent");
  assert.equal(title?.default, "Title");
  assert.equal(accent?.default, "#22c55e");

  const { errors } = checkComposition(html, { file: "skeleton.html" });
  assert.deepEqual(errors, []);
});

test("skeletonizeComposition: label が空文字なら string default は 'Text'", () => {
  const html = `<!doctype html>
<html data-composition-variables='[{"id":"title","type":"string","label":"","default":"Chapter 1"}]'>
<head></head>
<body>
  <div id="root" data-composition-id="root" data-width="1920" data-height="1080">
  </div>
</html>`;
  const { html: out, resetVars } = skeletonizeComposition(html);
  assert.deepEqual(resetVars, ["title"]);
  const varsMatch = /data-composition-variables\s*=\s*'([\s\S]*?)'/.exec(out);
  const decls = JSON.parse(varsMatch![1]) as Array<{ id: string; default: unknown }>;
  assert.equal(decls[0].default, "Text");
});

test("skeletonizeComposition: data-composition-variables が無ければ無変更", () => {
  const html = "<html><body>no vars here</body></html>";
  const { html: out, resetVars } = skeletonizeComposition(html);
  assert.equal(out, html);
  assert.deepEqual(resetVars, []);
});

// ---- maxPatternNumber ----

test("maxPatternNumber: 実物の card-patterns.md は 11", () => {
  assert.equal(maxPatternNumber(CARD_PATTERNS), 11);
});

test("maxPatternNumber: 見出しが無ければ 0", () => {
  assert.equal(maxPatternNumber(""), 0);
  assert.equal(maxPatternNumber("no headers here"), 0);
});

// ---- loadFrozenSeedMenu ----

test("loadFrozenSeedMenu (E6): hyperframe-seeds/ が無ければ patterns とバイト等価", () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    const menu = loadFrozenSeedMenu(recDir, CARD_PATTERNS);
    assert.equal(menu, "");
    assert.equal(CARD_PATTERNS + menu, CARD_PATTERNS);
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

test("loadFrozenSeedMenu: 有効な凍結カード2件が連番12/13で追記される", () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    const seedsDir = join(channelDir, "hyperframe-seeds");
    mkdirSync(seedsDir, { recursive: true });
    writeFileSync(join(seedsDir, "a-seed.html"), SAMPLE_HTML);
    writeFileSync(join(seedsDir, "a-seed.md"), "# ロゴ紹介カード\n\n用途の説明。\n");
    writeFileSync(join(seedsDir, "b-seed.html"), SAMPLE_HTML);

    const menu = loadFrozenSeedMenu(recDir, CARD_PATTERNS);
    assert.match(menu, /## 12\. a-seed/);
    assert.match(menu, /## 13\. b-seed/);
    assert.match(menu, /ロゴ紹介カード/);
    assert.ok(!/## 14\./.test(menu));
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

test("loadFrozenSeedMenu: check に落ちる凍結カードはスキップされ番号は詰まる", () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    const seedsDir = join(channelDir, "hyperframe-seeds");
    mkdirSync(seedsDir, { recursive: true });
    writeFileSync(join(seedsDir, "a-seed.html"), SAMPLE_HTML);
    writeFileSync(join(seedsDir, "m-broken.html"), "<html>not a valid composition</html>");
    writeFileSync(join(seedsDir, "z-seed.html"), SAMPLE_HTML);

    const menu = loadFrozenSeedMenu(recDir, CARD_PATTERNS);
    assert.match(menu, /## 12\. a-seed/);
    assert.match(menu, /## 13\. z-seed/);
    assert.ok(!/m-broken/.test(menu));
    assert.ok(!/## 14\./.test(menu));
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

test("loadFrozenSeedMenu: 全滅(0件生存)なら空文字", () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    const seedsDir = join(channelDir, "hyperframe-seeds");
    mkdirSync(seedsDir, { recursive: true });
    writeFileSync(join(seedsDir, "broken.html"), "<html>nope</html>");

    const menu = loadFrozenSeedMenu(recDir, CARD_PATTERNS);
    assert.equal(menu, "");
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

// ---- freezeHyperframe ----

test("freezeHyperframe: 正常系は DRAFT を書き、approvals.json/cutplan.json には触れない", async () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    mkdirSync(join(recDir, "hyperframes"), { recursive: true });
    writeFileSync(join(recDir, "hyperframes", "intro.html"), SAMPLE_HTML);

    const result = await freezeHyperframe(recDir, { name: "intro" });

    const htmlOut = join(recDir, "hyperframe-freeze.suggested", "intro.html");
    const mdOut = join(recDir, "hyperframe-freeze.suggested", "intro.md");
    assert.ok(existsSync(htmlOut));
    assert.ok(existsSync(mdOut));
    assert.equal(result.outDir, join(recDir, "hyperframe-freeze.suggested"));

    const skel = readFileSync(htmlOut, "utf8");
    const { errors } = checkComposition(skel, { file: htmlOut });
    assert.deepEqual(errors, []);
    assert.ok(result.resetVars.includes("title"));

    assert.ok(!existsSync(join(recDir, "approvals.json")), "approvals.json を作成してはいけない");
    assert.ok(!existsSync(join(recDir, "cutplan.json")), "cutplan.json を作成してはいけない");
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

test("freezeHyperframe: hyperframes/<name>.html が無ければ throw", async () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    await assert.rejects(() => freezeHyperframe(recDir, { name: "missing" }));
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});

test("freezeHyperframe: check に落ちるカードは throw(DRAFT を書かない)", async () => {
  const { channelDir, recDir } = makeRecordingDir();
  try {
    mkdirSync(join(recDir, "hyperframes"), { recursive: true });
    writeFileSync(join(recDir, "hyperframes", "bad.html"), "<html>not valid</html>");

    await assert.rejects(() => freezeHyperframe(recDir, { name: "bad" }));
    assert.ok(!existsSync(join(recDir, "hyperframe-freeze.suggested")));
  } finally {
    rmSync(channelDir, { recursive: true, force: true });
  }
});
