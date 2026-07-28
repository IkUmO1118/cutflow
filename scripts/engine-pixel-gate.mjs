#!/usr/bin/env node
// scripts/engine-pixel-gate.mjs — G1: 画素ゲート本体(npm run gate:pixel)。
//
// --capture-oracle: Remotion オラクル(config で engineExport:false に倒した frames)
//   から test/fixtures/engine/pixel-golden/ へ golden PNG を捕獲する。
//   **やり直し不能**(M4 Phase5 で Remotion 本編 composition を削除すると二度と
//   撮れない)。通常の開発フローでは使わない(golden 更新は人間の判断で実行する)。
//
// 既定(引数なし): エンジン版の frames 出力を golden と画素比較して合否判定する
//   (npm test には入れない独立ゲート。D1)。
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync, copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildTempConfigWithRemotion } from "./lib/pixelCompare.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const FIXTURE_DIR = join(repoRoot, "test/fixtures/engine/parity-project");
const CONFIG_PATH = join(repoRoot, "test/fixtures/engine/parity.config.yaml");
const GOLDEN_DIR = join(repoRoot, "test/fixtures/engine/pixel-golden");

// シーン表(§4 Phase2)の検証時刻(元収録の秒。本編11点のうち10点はそのまま
// source axis でスナップして撮れる)。#6(インサート)だけは別枠(下記)。
const SCENE_TIMES = [1.0, 2.5, 4.0, 5.5, 7.0, 13.0, 15.0, 17.0, 19.0, 21.0];
// #6 インサート(overlays.json inserts[0]: at=8.5, durationSec=1.2)。
// 挿入区間は出力秒(output axis)専用のスパンで元収録秒からは原理的に
// 到達できない(toOutputTime(8.5) は挿入「後」= 出力9.7へ解決される。
// src/lib/timeline.ts の buildTimelineModel 参照)。「ベース差し替え」を
// 実際に検証するため、この1点だけ出力軸(--out)で挿入区間内(8.5–9.7)の
// 出力9.0秒(=挿入クリップ自身の0.5秒地点)を直接指定する
const INSERT_CHECK_OUT_TIME = 9.0;
// ショート(shorts.json の s1)の検証時刻(元収録の秒。ranges [1,9] 内)
const SHORT_NAME = "s1";
const SHORT_TIME = 2.5;

function fmtT(t) {
  return t.toFixed(2);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runFrames(configPath, opts) {
  const args = ["src/cli.ts", "--config", configPath, "frames", FIXTURE_DIR, "--t", opts.times.map(fmtT).join(",")];
  if (opts.short) args.push("--short", opts.short);
  if (opts.outputAxis) args.push("--out");
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
}

/** frames/ が書いた PNG を destDir へコピーする(prefix があれば衝突回避のため
 * ファイル名の前に付ける。frames は本編・ショートで同じ出力秒名を付けうる) */
function copyFramesTo(destDir, prefix) {
  mkdirSync(destDir, { recursive: true });
  const framesDir = join(FIXTURE_DIR, "frames");
  const copied = [];
  for (const f of readdirSync(framesDir).sort()) {
    if (!f.endsWith(".png")) continue;
    const destName = prefix ? `${prefix}${f}` : f;
    copyFileSync(join(framesDir, f), join(destDir, destName));
    copied.push(destName);
  }
  return copied;
}

function ffmpegVersionLine() {
  try {
    return execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0].trim();
  } catch {
    return "unknown";
  }
}

function gitHeadSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function captureOracle() {
  if (!existsSync(join(FIXTURE_DIR, "raw.mp4"))) {
    console.error("✖ フィクスチャがありません。先に  bash scripts/make-parity-fixture.sh  を実行してください。");
    process.exit(1);
  }

  rmSync(GOLDEN_DIR, { recursive: true, force: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });

  const tmpConfigDir = mkdtempSync(join(tmpdir(), "cutflow-g1-oracle-config-"));
  const configPath = buildTempConfigWithRemotion(CONFIG_PATH, tmpConfigDir);
  console.log(`[1/4] 一時config生成(engineExport:false 挿入): ${configPath}`);

  console.log(`[2/4] 本編 golden 捕獲(Remotionオラクル・source axis): --t ${SCENE_TIMES.map(fmtT).join(",")}`);
  runFrames(configPath, { times: SCENE_TIMES });
  const mainFiles = copyFramesTo(GOLDEN_DIR, "");
  console.log(`  ${mainFiles.length}枚を ${GOLDEN_DIR}/ へコピー: ${mainFiles.join(", ")}`);

  console.log(`[3/4] #6 インサート golden 捕獲(output axis): --t ${fmtT(INSERT_CHECK_OUT_TIME)} --out`);
  runFrames(configPath, { times: [INSERT_CHECK_OUT_TIME], outputAxis: true });
  const insertFiles = copyFramesTo(GOLDEN_DIR, "");
  console.log(`  ${insertFiles.length}枚を ${GOLDEN_DIR}/ へコピー: ${insertFiles.join(", ")}`);

  console.log(`[4/4] ショート golden 捕獲(--short ${SHORT_NAME}): --t ${fmtT(SHORT_TIME)}`);
  runFrames(configPath, { times: [SHORT_TIME], short: SHORT_NAME });
  const shortFiles = copyFramesTo(GOLDEN_DIR, `short-${SHORT_NAME}-`);
  console.log(`  ${shortFiles.length}枚を ${GOLDEN_DIR}/ へコピー: ${shortFiles.join(", ")}`);

  rmSync(tmpConfigDir, { recursive: true, force: true });

  // manifest.json から本編出力解像度を読む(obs-canvas の screenRegion=出力解像度)
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));
  const mainResolution = { w: manifest.video.screenRegion.w, h: manifest.video.screenRegion.h };
  // ショート(vertical profile)の出力解像度は src/lib/profile.ts の組み込み定数
  const shortResolution = { w: 1080, h: 1920 };

  const goldenFiles = [...mainFiles, ...insertFiles, ...shortFiles].sort();
  const goldenHashes = {};
  for (const f of goldenFiles) goldenHashes[f] = sha256File(join(GOLDEN_DIR, f));

  const fixtureFiles = ["cutplan.json", "transcript.json", "overlays.json", "shorts.json"];
  const fixtureHashes = {};
  for (const f of fixtureFiles) fixtureHashes[f] = sha256File(join(FIXTURE_DIR, f));

  const provenance = {
    capturedAtCommit: gitHeadSha(),
    capturedAt: new Date().toISOString(),
    ffmpegVersion: ffmpegVersionLine(),
    parityConfigSha256: sha256File(CONFIG_PATH),
    fixtureFileSha256: fixtureHashes,
    goldenFileSha256: goldenHashes,
    mainResolution,
    shortResolution,
    sceneTimes: SCENE_TIMES,
    insertCheckOutTime: INSERT_CHECK_OUT_TIME,
    shortName: SHORT_NAME,
    shortTime: SHORT_TIME,
  };
  writeFileSync(join(GOLDEN_DIR, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(`\n✅ golden 捕獲完了: ${GOLDEN_DIR}/ (${goldenFiles.length}枚 + provenance.json)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--capture-oracle")) {
    await captureOracle();
    return;
  }
  console.error(
    "既定モード(エンジン版との比較検証)は T-6 で実装予定です。" +
      "golden を捕獲するには --capture-oracle を付けてください。",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
