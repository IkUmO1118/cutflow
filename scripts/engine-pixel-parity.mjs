#!/usr/bin/env node
// scripts/engine-pixel-parity.mjs — R1 Phase1: GPU画素parityハーネス(開発スクリプト。
// リポジトリ配布物ではない)。R4 Phase1でタイル別判定を追加(§1.2 是正)。
//
// Remotion オラクル(一時configで engineExport:false に倒した frames)と
// エンジン版(frames 既定)の出力PNGを chrome-headless-shell + CDP で画素比較する。
// 上下反転検出は全体平均(R1 の資産・そのまま残す)。合否判定はタイル別
// (TILE_COLS×TILE_ROWS分割)の輝度差**最大値**で決める(R4 決定2)。全体平均
// (diffNormal)は補助値として出力に残すが、合否には使わない——ワイプのような
// 画面の一部(面積比 3.4%)だけが壊れている欠陥は全体平均にはほぼ出ない
// (R4 §1.2)ため。
//
// 使い方: node scripts/engine-pixel-parity.mjs --dir <収録フォルダ> --t 30,90 [--out <出力先>]
//
// 比較ロジック(定数・pageScript()・CDP/ヘッドレスChrome起動まわり)は
// G1 Phase1 で scripts/lib/pixelCompare.mjs へ抽出済み(engine-pixel-gate.mjs と共有)。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  DIFF_THRESHOLD,
  TILE_DS_W,
  TILE_COLS,
  TILE_ROWS,
  TILE_DIFF_THRESHOLD,
  buildTempConfigWithRemotion,
  copyOutPngs,
  listOutputPngs,
  startServer,
  findHeadlessShell,
  launchHeadlessShell,
  connectCdp,
  newPageWs,
  pageScript,
} from "./lib/pixelCompare.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const out = { dir: null, times: [], outDir: null, strictTopLeft: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--t") out.times = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--strict-topleft") out.strictTopLeft = true;
  }
  if (!out.dir || out.times.length < 1) {
    console.error("使い方: node scripts/engine-pixel-parity.mjs --dir <収録フォルダ> --t 30,90 [--out <出力先>] [--strict-topleft]");
    process.exit(1);
  }
  out.dir = resolve(out.dir);
  out.outDir = resolve(out.outDir ?? join(repoRoot, "scripts", ".pixel-parity-out"));
  return out;
}

function fmtT(t) {
  return t.toFixed(2);
}

function runRemotionFrames(dir, times, configPath) {
  const args = ["src/cli.ts", "frames", dir, "--t", times.map(fmtT).join(","), "--config", configPath];
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
}

function runEngineFrames(dir, times) {
  const args = ["src/cli.ts", "frames", dir, "--t", times.map(fmtT).join(",")];
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
}

async function main() {
  const { dir, times, outDir, strictTopLeft } = parseArgs(process.argv.slice(2));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tmpConfigDir = mkdtempSync(join(tmpdir(), "cutflow-parity-config-"));
  const configPath = buildTempConfigWithRemotion(join(repoRoot, "config.yaml"), tmpConfigDir);
  console.log(`[1/6] 一時config生成: engineExport: false → ${configPath}`);

  console.log(`[2/6] Remotionオラクル: node src/cli.ts frames ${dir} --t ${times.map(fmtT).join(",")} --config ${configPath}`);
  runRemotionFrames(dir, times, configPath);
  rmSync(tmpConfigDir, { recursive: true, force: true });
  const remotionDir = join(outDir, "remotion");
  copyOutPngs(dir, remotionDir);
  console.log(`  PNGを ${remotionDir}/ へコピーしました`);

  console.log(`[3/6] エンジン版: node src/cli.ts frames ${dir} --t ${times.map(fmtT).join(",")}`);
  runEngineFrames(dir, times);
  const engineDir = join(outDir, "engine");
  copyOutPngs(dir, engineDir);
  console.log(`  PNGを ${engineDir}/ へコピーしました`);

  // 同一オリジン比較用のハーネスページ
  const pngs = listOutputPngs(remotionDir);
  const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Pixel Parity</title></head><body>
<script>
window.__PNGS = ${JSON.stringify(pngs)};
</script></body></html>`;
  writeFileSync(join(outDir, "index.html"), harnessHtml);

  console.log("[4/6] HTTPサーバ起動");
  const server = await startServer(outDir);
  const port = server.address().port;
  console.log(`  http://127.0.0.1:${port}`);

  console.log("[5/6] chrome-headless-shell 起動");
  const execPath = findHeadlessShell();
  console.log(`  shell: ${execPath}`);
  const { proc: chromeProc, wsUrl: browserWsUrl } = await launchHeadlessShell(execPath);

  try {
    const pageWsUrl = await newPageWs(browserWsUrl);
    const cdp = connectCdp(pageWsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // 同一オリジンの harness ページへ遷移(canvas tainting 回避)
    const harnessUrl = `http://127.0.0.1:${port}/`;
    const loadDone = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
    await cdp.send("Page.navigate", { url: harnessUrl });
    await loadDone;

    console.log("[6/6] 各時刻を比較");
    if (pngs.length === 0) throw new Error("比較する PNG がありません");
    let anyFlipped = false;
    let anyMismatch = false;
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const pngName of pngs) {
      const remotionUrl = `${baseUrl}/remotion/${pngName}`;
      const engineUrl = `${baseUrl}/engine/${pngName}`;
      const label = pngName.replace(/^out/, "").replace(/s\.png$/, "");
      const expr = pageScript({
        remotionUrl, engineUrl, label, outDir, strictTopLeft,
        tileDsW: TILE_DS_W, tileCols: TILE_COLS, tileRows: TILE_ROWS,
      });
      const evalResult = await cdp.send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (evalResult.exceptionDetails) {
        throw new Error(`t=${label}: ${JSON.stringify(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails)}`);
      }
      const { diffNormal, diffFlipped, topleftDiff, tileDiffMax, worstTile, gridDataUrl } = evalResult.result.value;
      const gridPath = join(outDir, `grid-t${label}.png`);
      writeFileSync(gridPath, Buffer.from(gridDataUrl.split(",")[1], "base64"));

      const flippedFlag = diffFlipped < diffNormal;
      // 合否はタイル最大差で決める(R4 決定3。全体平均は参考値のみ)
      const tileMismatch = tileDiffMax > TILE_DIFF_THRESHOLD;
      const tlMismatch = topleftDiff !== null && topleftDiff > DIFF_THRESHOLD;
      const status = flippedFlag ? "上下反転を検出" : (tileMismatch || tlMismatch) ? "不一致" : "一致";
      const tlStr = topleftDiff !== null ? ` topleftDiff=${topleftDiff.toFixed(2)}` : "";
      const worstStr = ` tileDiffMax=${tileDiffMax.toFixed(2)}(タイル[${worstTile.tx},${worstTile.ty}] ` +
        `= 出力px矩形 x=${worstTile.rect.x},y=${worstTile.rect.y},w=${worstTile.rect.w},h=${worstTile.rect.h})`;
      console.log(`  t=${label}s: diffNormal=${diffNormal.toFixed(2)}(参考) diffFlipped=${diffFlipped.toFixed(2)}${tlStr}${worstStr} → ${status}`);
      if (flippedFlag) anyFlipped = true;
      if (tileMismatch || tlMismatch) anyMismatch = true;
    }

    cdp.close();
    if (anyFlipped) {
      console.log("\n結果: 上下反転を検出しました(exit 1)");
      process.exit(1);
    }
    if (anyMismatch) {
      console.log("\n結果: 不一致を検出しました(exit 1)");
      process.exit(1);
    }
    console.log("\n結果: 全フレーム一致(exit 0)");
  } finally {
    chromeProc.kill();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
