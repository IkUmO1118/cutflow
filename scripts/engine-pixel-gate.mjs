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
import {
  buildTempConfigWithRemotion,
  startServer,
  findHeadlessShell,
  launchHeadlessShell,
  connectCdp,
  newPageWs,
  pageScript,
  TILE_DS_W,
  TILE_COLS,
  TILE_ROWS,
  TILE_DIFF_THRESHOLD,
  DIFF_THRESHOLD,
} from "./lib/pixelCompare.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const FIXTURE_DIR = join(repoRoot, "test/fixtures/engine/parity-project");
const CONFIG_PATH = join(repoRoot, "test/fixtures/engine/parity.config.yaml");
const GOLDEN_DIR = join(repoRoot, "test/fixtures/engine/pixel-golden");
const GATE_OUT_DIR = join(repoRoot, "scripts/.pixel-gate-out");
const LAST_RUN_PATH = join(GOLDEN_DIR, "last-run.json");
const FIXTURE_FILES = ["cutplan.json", "transcript.json", "overlays.json", "shorts.json"];

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

  const fixtureHashes = {};
  for (const f of FIXTURE_FILES) fixtureHashes[f] = sha256File(join(FIXTURE_DIR, f));

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

/** エンジン既定経路(config の engineExport は触らない)で golden と同じ3系統
 * (本編source axis・#6インサートoutput axis・ショート)を撮り、destDir配下へ
 * golden と同じファイル名でコピーする(比較を単純な同名突き合わせにするため) */
function captureEngineOutputs(destDir) {
  const files = [];
  runFrames(CONFIG_PATH, { times: SCENE_TIMES });
  files.push(...copyFramesTo(destDir, ""));
  runFrames(CONFIG_PATH, { times: [INSERT_CHECK_OUT_TIME], outputAxis: true });
  files.push(...copyFramesTo(destDir, ""));
  runFrames(CONFIG_PATH, { times: [SHORT_TIME], short: SHORT_NAME });
  files.push(...copyFramesTo(destDir, `short-${SHORT_NAME}-`));
  return files;
}

async function verify() {
  if (!existsSync(join(FIXTURE_DIR, "raw.mp4"))) {
    console.error("✖ フィクスチャがありません。先に  bash scripts/make-parity-fixture.sh  を実行してください。");
    process.exit(1);
  }
  if (!existsSync(GOLDEN_DIR) || readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".png")).length === 0) {
    console.error("✖ golden がありません(test/fixtures/engine/pixel-golden/)。リポジトリの golden が壊れています。");
    process.exit(1);
  }

  rmSync(GATE_OUT_DIR, { recursive: true, force: true });
  mkdirSync(GATE_OUT_DIR, { recursive: true });
  const capturedDir = join(GATE_OUT_DIR, "captured");
  const goldenCopyDir = join(GATE_OUT_DIR, "golden");
  mkdirSync(capturedDir, { recursive: true });
  mkdirSync(goldenCopyDir, { recursive: true });

  console.log("[1/4] エンジン既定経路で撮影(本編source axis + #6インサートoutput axis + ショート)");
  const capturedFiles = captureEngineOutputs(capturedDir);
  console.log(`  ${capturedFiles.length}枚を撮影`);

  const goldenPngs = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".png")).sort();
  for (const f of goldenPngs) copyFileSync(join(GOLDEN_DIR, f), join(goldenCopyDir, f));

  const missing = goldenPngs.filter((f) => !existsSync(join(capturedDir, f)));
  if (missing.length > 0) {
    console.error(`✖ エンジン撮影に golden と対応するファイルがありません: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log("[2/4] HTTPサーバ起動 + chrome-headless-shell 起動");
  const server = await startServer(GATE_OUT_DIR);
  const port = server.address().port;
  const execPath = findHeadlessShell();
  const { proc: chromeProc, wsUrl: browserWsUrl } = await launchHeadlessShell(execPath);

  let anyFlipped = false;
  let anyMismatch = false;
  const results = [];
  try {
    const pageWsUrl = await newPageWs(browserWsUrl);
    const cdp = connectCdp(pageWsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const harnessUrl = `http://127.0.0.1:${port}/`;
    writeFileSync(join(GATE_OUT_DIR, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`);
    const loadDone = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url: harnessUrl });
    await loadDone;

    console.log(`[3/4] ${goldenPngs.length}枚を golden と比較(TILE_DIFF_THRESHOLD=${TILE_DIFF_THRESHOLD})`);
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const pngName of goldenPngs) {
      const remotionUrl = `${baseUrl}/golden/${pngName}`;
      const engineUrl = `${baseUrl}/captured/${pngName}`;
      const expr = pageScript({
        remotionUrl, engineUrl, label: pngName, outDir: GATE_OUT_DIR, strictTopLeft: false,
        tileDsW: TILE_DS_W, tileCols: TILE_COLS, tileRows: TILE_ROWS,
      });
      const evalResult = await cdp.send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (evalResult.exceptionDetails) {
        throw new Error(`${pngName}: ${JSON.stringify(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails)}`);
      }
      const { diffNormal, diffFlipped, tileDiffMax, worstTile, gridDataUrl } = evalResult.result.value;
      const flippedFlag = diffFlipped < diffNormal;
      const tileMismatch = tileDiffMax > TILE_DIFF_THRESHOLD;
      const status = flippedFlag ? "上下反転を検出" : tileMismatch ? "不一致" : "一致";
      const worstStr = `tileDiffMax=${tileDiffMax.toFixed(2)}(タイル[${worstTile.tx},${worstTile.ty}] ` +
        `= 出力px矩形 x=${worstTile.rect.x},y=${worstTile.rect.y},w=${worstTile.rect.w},h=${worstTile.rect.h})`;
      console.log(`  ${pngName}: diffNormal=${diffNormal.toFixed(2)}(参考) ${worstStr} → ${status}`);
      results.push({ pngName, diffNormal, tileDiffMax, status });
      if (flippedFlag || tileMismatch) {
        const gridPath = join(GATE_OUT_DIR, `diff-${pngName}`);
        writeFileSync(gridPath, Buffer.from(gridDataUrl.split(",")[1], "base64"));
        console.log(`    差分グリッド(golden|captured|captured反転): ${gridPath}`);
      }
      if (flippedFlag) anyFlipped = true;
      if (tileMismatch) anyMismatch = true;
    }
    cdp.close();
  } finally {
    chromeProc.kill();
    server.close();
  }

  if (anyFlipped || anyMismatch) {
    console.log(`\n結果: ${anyFlipped ? "上下反転" : "不一致"}を検出しました(exit 1)`);
    process.exit(1);
  }

  console.log("[4/4] 全一致。last-run.json を書きます(陳腐化検知の基準)");
  const fixtureHashes = {};
  for (const f of FIXTURE_FILES) fixtureHashes[f] = sha256File(join(FIXTURE_DIR, f));
  const goldenHashes = {};
  for (const f of goldenPngs) goldenHashes[f] = sha256File(join(GOLDEN_DIR, f));
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));
  const lastRun = {
    ranAt: new Date().toISOString(),
    parityConfigSha256: sha256File(CONFIG_PATH),
    fixtureFileSha256: fixtureHashes,
    goldenFileSha256: goldenHashes,
    goldenFiles: goldenPngs,
    mainResolution: { w: manifest.video.screenRegion.w, h: manifest.video.screenRegion.h },
  };
  writeFileSync(LAST_RUN_PATH, JSON.stringify(lastRun, null, 2));
  console.log(`\n結果: 全フレーム一致(exit 0)。${results.length}枚。last-run.json: ${LAST_RUN_PATH}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--capture-oracle")) {
    await captureOracle();
    return;
  }
  await verify();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
