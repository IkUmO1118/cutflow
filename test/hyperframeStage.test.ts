// test/hyperframeStage.test.ts — src/stages/hyperframe.ts(C4: HyperFrames
// カードの生成・render ステージ)の純関数+決定論的な部分を固定する。
// ブラウザ不使用の高速テスト(実 render は scripts/hyperframe-verify.ts 側/
// coordinator の重い実測に委ねる)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseComposition, SAMPLE_HTML } from "../src/lib/hyperframe.ts";
import type { ParsedComposition } from "../src/lib/hyperframe.ts";
import {
  hyperframeCacheKey,
  renderHyperframe,
  resolveHyperframeBuild,
} from "../src/stages/hyperframe.ts";

/* ------------------------------------------------------------------ */
/* hyperframeCacheKey                                                  */
/* ------------------------------------------------------------------ */

function baseKeyInputs() {
  return {
    htmlSha256: "a".repeat(64),
    variables: { title: "CutFlow", accent: "#22c55e" },
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 4,
    codec: "h264",
    hardwareAcceleration: "none",
  };
}

test("hyperframeCacheKey: 同じ入力は同じキーになる", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey(baseKeyInputs());
  assert.equal(a, b);
});

test("hyperframeCacheKey: htmlSha256 が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({ ...baseKeyInputs(), htmlSha256: "b".repeat(64) });
  assert.notEqual(a, b);
});

test("hyperframeCacheKey: variables の値が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({
    ...baseKeyInputs(),
    variables: { title: "Other", accent: "#22c55e" },
  });
  assert.notEqual(a, b);
});

test("hyperframeCacheKey: width が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({ ...baseKeyInputs(), width: 1280 });
  assert.notEqual(a, b);
});

test("hyperframeCacheKey: height が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({ ...baseKeyInputs(), height: 720 });
  assert.notEqual(a, b);
});

test("hyperframeCacheKey: fps が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({ ...baseKeyInputs(), fps: 24 });
  assert.notEqual(a, b);
});

test("hyperframeCacheKey: durationSec が変われば別キー", () => {
  const a = hyperframeCacheKey(baseKeyInputs());
  const b = hyperframeCacheKey({ ...baseKeyInputs(), durationSec: 6 });
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* resolveHyperframeBuild                                              */
/* ------------------------------------------------------------------ */

function parsedFixture(overrides?: Partial<ParsedComposition>): ParsedComposition {
  return {
    compositionId: "root",
    width: 1920,
    height: 1080,
    variables: [
      { id: "title", type: "string", default: "CutFlow" },
      { id: "accent", type: "color", default: "#22c55e" },
    ],
    intrinsicDurationSec: 4,
    ...overrides,
  };
}

test("resolveHyperframeBuild: fps は既定 30", () => {
  const r = resolveHyperframeBuild({ parsed: parsedFixture(), cliVars: {} });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.fps, 30);
});

test("resolveHyperframeBuild: overrides.fps は既定 30 に勝つ", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture(),
    cliVars: {},
    overrides: { fps: 24 },
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.fps, 24);
});

test("resolveHyperframeBuild: overrides.width/height/durationSec は parsed(data-*) に勝つ", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture(),
    cliVars: {},
    overrides: { width: 1280, height: 720, durationSec: 8 },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.width, 1280);
    assert.equal(r.height, 720);
    assert.equal(r.durationSec, 8);
  }
});

test("resolveHyperframeBuild: overrides が無ければ parsed(data-*) の値を使う", () => {
  const r = resolveHyperframeBuild({ parsed: parsedFixture(), cliVars: {} });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.width, 1920);
    assert.equal(r.height, 1080);
    assert.equal(r.durationSec, 4);
  }
});

test("resolveHyperframeBuild: --var(cliVars) は宣言済み default の上に merge される", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture(),
    cliVars: { title: "Override" },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.variables.title, "Override");
    assert.equal(r.variables.accent, "#22c55e");
  }
});

test("resolveHyperframeBuild: width/height/durationSec がどこにも無ければ ok:false", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture({ width: undefined, height: undefined, intrinsicDurationSec: undefined }),
    cliVars: {},
  });
  assert.equal(r.ok, false);
});

test("resolveHyperframeBuild: width が無い(height/durationSec はある)場合も ok:false", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture({ width: undefined }),
    cliVars: {},
  });
  assert.equal(r.ok, false);
});

test("resolveHyperframeBuild: width<=0 は ok:false", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture(),
    cliVars: {},
    overrides: { width: 0 },
  });
  assert.equal(r.ok, false);
});

test("resolveHyperframeBuild: durationSec<=0 は ok:false", () => {
  const r = resolveHyperframeBuild({
    parsed: parsedFixture(),
    cliVars: {},
    overrides: { durationSec: -1 },
  });
  assert.equal(r.ok, false);
});

/* ------------------------------------------------------------------ */
/* renderHyperframe: check ゲートで abort(0バイト書込み)                */
/* ------------------------------------------------------------------ */

const INVALID_HTML = `<!doctype html>
<html data-composition-id="root" data-width="1920" data-height="1080" data-composition-variables='[]'>
<body>
  <div id="root"></div>
  <script>
    var x = Math.random();
  </script>
</body>
</html>`;

test("renderHyperframe: check ゲートで落ちたら produce を呼ばず何も書き込まない", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hf-stage-gate-"));
  mkdirSync(join(tmp, "hyperframes"), { recursive: true });
  writeFileSync(join(tmp, "hyperframes", "x.html"), INVALID_HTML);

  let called = false;
  await assert.rejects(() =>
    renderHyperframe(
      tmp,
      { name: "x", cliVars: {}, overrides: { width: 1920, height: 1080, durationSec: 4 } },
      {
        produce: async () => {
          called = true;
        },
      },
    ),
  );

  assert.equal(called, false, "produce は呼ばれてはいけない");
  assert.equal(existsSync(join(tmp, "materials", "hyperframes", "x.mp4")), false);
  assert.equal(existsSync(join(tmp, "hyperframe.x.key.json")), false);
});

/* ------------------------------------------------------------------ */
/* renderHyperframe: キャッシュキー一致で produce をスキップ            */
/* ------------------------------------------------------------------ */

test("renderHyperframe: キャッシュキーが一致すれば produce を呼ばず再利用する", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hf-stage-skip-"));
  mkdirSync(join(tmp, "hyperframes"), { recursive: true });
  writeFileSync(join(tmp, "hyperframes", "y.html"), SAMPLE_HTML);

  const parsed = parseComposition(SAMPLE_HTML);
  const build = resolveHyperframeBuild({ parsed, cliVars: {} });
  assert.equal(build.ok, true);
  if (!build.ok) return;

  const key = hyperframeCacheKey({
    htmlSha256: createHash("sha256").update(SAMPLE_HTML).digest("hex"),
    variables: build.variables,
    width: build.width,
    height: build.height,
    fps: build.fps,
    durationSec: build.durationSec,
    codec: "h264",
    hardwareAcceleration: "none",
  });

  mkdirSync(join(tmp, "materials", "hyperframes"), { recursive: true });
  writeFileSync(join(tmp, "materials", "hyperframes", "y.mp4"), "stub-mp4-bytes");
  writeFileSync(join(tmp, "hyperframe.y.key.json"), JSON.stringify({ key }, null, 2));

  let called = false;
  const result = await renderHyperframe(
    tmp,
    { name: "y", cliVars: {} },
    {
      produce: async () => {
        called = true;
      },
    },
  );

  assert.equal(called, false, "produce は呼ばれてはいけない(キャッシュ再利用)");
  assert.equal(result.skipped, true);
  assert.equal(result.outPath, join(tmp, "materials", "hyperframes", "y.mp4"));
  assert.equal(
    readFileSync(result.outPath, "utf8"),
    "stub-mp4-bytes",
    "既存ファイルがそのまま再利用されているはず",
  );
});

test("renderHyperframe: キャッシュキーが不一致なら produce を呼ぶ(drift)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hf-stage-drift-"));
  mkdirSync(join(tmp, "hyperframes"), { recursive: true });
  writeFileSync(join(tmp, "hyperframes", "z.html"), SAMPLE_HTML);

  mkdirSync(join(tmp, "materials", "hyperframes"), { recursive: true });
  writeFileSync(join(tmp, "materials", "hyperframes", "z.mp4"), "stale-mp4-bytes");
  writeFileSync(join(tmp, "hyperframe.z.key.json"), JSON.stringify({ key: "stale-key" }, null, 2));

  let called = false;
  // produce に渡された偽 mp4 は ffprobe 検査(verify)を通らないため
  // publishAsTransaction は throw する。ここで確認したいのは「キーが不一致なら
  // produce が呼ばれる(=単純に再利用しない)」ことだけなので、reject 自体は
  // 想定内として無視する
  await assert.rejects(() =>
    renderHyperframe(
      tmp,
      { name: "z", cliVars: {} },
      {
        produce: async (tempPath: string) => {
          called = true;
          writeFileSync(tempPath, "fresh-mp4-bytes");
        },
      },
    ),
  );

  assert.equal(called, true, "キーが一致しないので produce が呼ばれるはず");
});
