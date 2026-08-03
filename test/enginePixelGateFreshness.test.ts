// G1: 画素ゲート(scripts/engine-pixel-gate.mjs)の陳腐化検知。GPU/ffmpeg/
// headless Chrome を一切使わないミリ秒級の純粋な検査(D6)。
//
// `npm run gate:pixel` が最後に成功したときのフィンガープリント
// (test/fixtures/engine/pixel-golden/last-run.json)と、現在の fixture JSON /
// parity.config.yaml / golden PNG 集合を突き合わせるだけ。last-run.json は
// ゲート実行のたびに書き直される生成物でコミット対象外(.gitignore)なので、
// 未実行の環境(新規開発者・golden 未計算)では何も検査せず pass する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE_DIR = join(ROOT, "test/fixtures/engine/parity-project");
const CONFIG_PATH = join(ROOT, "test/fixtures/engine/parity.config.yaml");
const GOLDEN_DIR = join(ROOT, "test/fixtures/engine/pixel-golden");
const LAST_RUN_PATH = join(GOLDEN_DIR, "last-run.json");
const FIXTURE_FILES = ["cutplan.json", "transcript.json", "overlays.json"];

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("G1 画素ゲート: last-run.json が無ければ何も検査せず pass(未実行環境)", () => {
  if (existsSync(LAST_RUN_PATH)) return; // 別テストが検査する
  assert.ok(true, "未実行(node scripts/engine-pixel-gate.mjs を一度も成功させていない)");
});

test("G1 画素ゲート: fixture / config / golden が last-run.json の記録と食い違っていないか", () => {
  if (!existsSync(LAST_RUN_PATH)) return; // 上のテストが担当

  const lastRun = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8")) as {
    parityConfigSha256: string;
    fixtureFileSha256: Record<string, string>;
    goldenFileSha256: Record<string, string>;
    goldenFiles: string[];
    mainResolution: { w: number; h: number };
  };

  const staleMessage = "fixture/config/golden が last-run.json の記録と食い違っています。" +
    "`npm run gate:pixel` を実行してください。";

  assert.equal(
    sha256File(CONFIG_PATH), lastRun.parityConfigSha256,
    `parity.config.yaml が変わっています。${staleMessage}`,
  );

  for (const f of FIXTURE_FILES) {
    assert.equal(
      sha256File(join(FIXTURE_DIR, f)), lastRun.fixtureFileSha256[f],
      `${f} が変わっています。${staleMessage}`,
    );
  }

  const currentGoldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".png")).sort();
  assert.deepEqual(
    currentGoldenFiles, [...lastRun.goldenFiles].sort(),
    `golden ファイル集合が変わっています。${staleMessage}`,
  );
  for (const f of currentGoldenFiles) {
    assert.equal(
      sha256File(join(GOLDEN_DIR, f)), lastRun.goldenFileSha256[f],
      `golden/${f} が変わっています。${staleMessage}`,
    );
  }

  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8")) as {
    video: { screenRegion: { w: number; h: number } };
  };
  assert.deepEqual(
    { w: manifest.video.screenRegion.w, h: manifest.video.screenRegion.h },
    lastRun.mainResolution,
    `出力解像度が変わっています。${staleMessage}`,
  );
});
