// stages/bgmFit.ts のゲート挙動を固定する(FIX 2)。
// - plan-bgm 由来の id 無し bgm.json + monotone を誘発する sound.json →
//   id-stamp を要求せずレポートを書いて exit 0(B4 誘導のみ)。
// - id 無しトラックに B2 補正が出るとき → 「先に id-stamp」で例外(exit 1)。
// - av.probe/sound.json 欠如 → 「先に av」で例外(exit 1)。
// §docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bgmFit, BGM_FIT_PATCH_FILE, BGM_FIT_REPORT_FILE } from "../src/stages/bgmFit.ts";
import { loadConfig } from "../src/lib/config.ts";
import type { SoundReport } from "../src/stages/av.ts";

const cfg = loadConfig();

function makeSound(overrides: Partial<SoundReport> = {}): SoundReport {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-11T00:00:00.000Z",
    key: {},
    range: { startSec: 0, endSec: 100 },
    short: null,
    mix: { integratedLufs: -20, loudnessRangeLu: 5, truePeakDbtp: -3, clipping: { peakDbfs: -3, clippedSamples: 0 }, envelope: [] },
    silences: [],
    tracks: { windowSec: 1, samples: [] },
    bgm: { spans: [], duckSpans: [] },
    ...overrides,
  };
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-bgm-fit-"));
  mkdirSync(join(dir, "av.probe"), { recursive: true });
  return dir;
}

function writeSound(dir: string, sound: SoundReport): void {
  writeFileSync(join(dir, "av.probe", "sound.json"), JSON.stringify(sound));
}

test("bgmFit: id無しbgm.json + monotone誘発 → id-stampを要求せずexit0でB4誘導レポートを書く", () => {
  const dir = makeDir();
  try {
    // 出力秒で単一 file が総尺の 95% を覆う → monotone。ただし B2 補正は出ない
    // (発話サンプル無し・無音無し・mix 目標以下・fadeOutSec 有りで no-fade も無し)
    writeSound(
      dir,
      makeSound({
        bgm: {
          spans: [
            { startOutSec: 0, endOutSec: 95, volumeDb: -22, file: "one.mp3" },
            { startOutSec: 95, endOutSec: 100, volumeDb: -22, file: "sting.mp3" },
          ],
          duckSpans: [],
        },
      }),
    );
    // plan-bgm 出力そのもの: id 無し {start,end,file}。fadeOutSec を付けて no-fade も抑止
    writeFileSync(
      join(dir, "bgm.json"),
      JSON.stringify({
        tracks: [
          { start: 0, end: 95, file: "one.mp3", fadeOutSec: 2 },
          { start: 95, end: 100, file: "sting.mp3", fadeOutSec: 2 },
        ],
      }),
    );
    writeFileSync(join(dir, "chapters.json"), JSON.stringify({ chapters: [
      { start: 0, title: "A" }, { start: 30, title: "B" }, { start: 60, title: "C" },
    ] }));

    // 例外を投げない(exit 0 相当)
    const result = bgmFit(dir, cfg);
    assert.equal(result.monotone.monotone, true, "monotone 判定が出ていない");
    assert.match(result.monotone.message, /plan-bgm/);
    // B2 補正は無いのでパッチは書かれない
    assert.equal(result.patchPath, null);
    assert.equal(existsSync(join(dir, BGM_FIT_PATCH_FILE)), false);
    // レポートは書かれる
    assert.ok(existsSync(join(dir, BGM_FIT_REPORT_FILE)));
    const report = JSON.parse(readFileSync(join(dir, BGM_FIT_REPORT_FILE), "utf8"));
    assert.equal(report.monotone.monotone, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgmFit: id無しトラックにB2補正が出るとき → 先にid-stampで例外(exit1)", () => {
  const dir = makeDir();
  try {
    // 動画終端まで続く+fadeOutSec無し → no-fade の補正が出る id 無しトラック
    writeSound(
      dir,
      makeSound({
        bgm: { spans: [{ startOutSec: 0, endOutSec: 100, volumeDb: -22, file: "bgm.mp3" }], duckSpans: [] },
      }),
    );
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 100, file: "bgm.mp3" }] }));

    assert.throws(() => bgmFit(dir, cfg), /id-stamp/);
    // 例外時はレポートも書かれない
    assert.equal(existsSync(join(dir, BGM_FIT_REPORT_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgmFit: av.probe/sound.json 欠如 → 先にav で例外(exit1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-bgm-fit-"));
  try {
    writeFileSync(join(dir, "bgm.json"), JSON.stringify({ tracks: [{ start: 0, end: 100, file: "bgm.mp3" }] }));
    assert.throws(() => bgmFit(dir, cfg), /av /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgmFit: bgm.json無し + 検出なし → 例外なく exit0(検出なしレポート)", () => {
  const dir = makeDir();
  try {
    writeSound(dir, makeSound({ bgm: { spans: [], duckSpans: [] } }));
    // bgm.json 無し・fallback も無い(bgm.* 不在)→ monotone false・findings 空
    const result = bgmFit(dir, cfg);
    assert.equal(result.findings.length, 0);
    assert.equal(result.monotone.monotone, false);
    assert.equal(result.patchPath, null);
    assert.ok(existsSync(join(dir, BGM_FIT_REPORT_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
