#!/usr/bin/env node
// scripts/engine-parity.mjs — M2 Phase4 の parity ハーネス(開発スクリプト。
// リポジトリ配布物ではない)。
//
// 1) 対象収録で `node src/cli.ts frames <dir> --t <times> --out` を実行
//    (オラクル。frames/props.json に実際に使われた RenderProps も残る)
// 2) 同じ props.json + 同じ時刻で describeFrame() を呼び、参照ペインタ
//    (src/engine/refPainter.ts。esbuild で束ねる)を chrome-headless-shell へ
//    CDP 経由で流し込んで canvas2d に描く
// 3) オラクル PNG と参照ペインタの出力を並べた比較グリッド PNG + ダウンサンプル
//    輝度の平均絶対差を出す
//
// M2 の parity 合格基準は「位置・レイヤ構成の一致」(フォントラスタ差は許容)。
// 差分スコアの閾値はここでは固定しない(コーディネータが目視とあわせて較正する。
// §design doc Phase4)。
//
// 使い方: node scripts/engine-parity.mjs --dir <収録フォルダ> --t 2,20,38 [--out <出力先>]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { ensureHeadlessShell } from "../src/lib/browser.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const out = { dir: null, times: [], outDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--t") out.times = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (argv[i] === "--out") out.outDir = argv[++i];
  }
  if (!out.dir || out.times.length === 0) {
    console.error("使い方: node scripts/engine-parity.mjs --dir <収録フォルダ> --t 2,20,38 [--out <出力先>]");
    process.exit(1);
  }
  out.dir = resolve(out.dir);
  out.outDir = resolve(out.outDir ?? join(repoRoot, "scripts", ".parity-out"));
  return out;
}

function fmtT(t) {
  return t.toFixed(2);
}

/** frames CLI をオラクルとして実行する。frames/props.json に実際に使われた
 * RenderProps が残るので、それをそのまま describeFrame の入力に使い、
 * 「別経路で props を作り直して食い違う」リスクを排除する */
function runOracle(dir, times) {
  const args = ["src/cli.ts", "frames", dir, "--t", times.map(fmtT).join(","), "--out"];
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
  const props = JSON.parse(readFileSync(join(dir, "frames", "props.json"), "utf8"));
  const pngOf = (t) => join(dir, "frames", `out${fmtT(t)}s.png`);
  return { props, pngOf };
}

/** descriptor 内の external item(video)が参照するソース秒ぶんの静止画を
 * ffmpeg で切り出す。videoFile(proxy.mp4)は canvas 解像度へスケールする
 * (sourceRect が canvas 座標系のため。proxy は preview.width 縮小版なので
 * 素のフレームのままだと座標がずれる)。素材(insert/overlay)は実寸のまま
 * (describeFrame の "fit" 配置はペインタ側が実寸から解決するため) */
function extractStills(dir, props, descriptors, stillsDir) {
  mkdirSync(stillsDir, { recursive: true });
  const seen = new Map(); // key -> {url, path}
  for (const d of descriptors) {
    for (const item of d.items) {
      if (item.kind !== "external") continue;
      const key = `${item.sourceId}@${fmtT(item.sourceTimeSec)}`;
      if (seen.has(key)) continue;
      if (item.sourceKind === "image") {
        seen.set(key, { url: `/proj/${item.sourceId}` });
        continue;
      }
      const outFile = join(stillsDir, `${key.replace(/[/@.]/g, "_")}.png`);
      const input = join(dir, item.sourceId);
      const isCanvas = item.sourceId === props.videoFile;
      const scaleArgs = isCanvas ? ["-vf", `scale=${props.canvas.w}:${props.canvas.h}`] : [];
      execFileSync(
        "ffmpeg",
        ["-y", "-ss", String(item.sourceTimeSec), "-i", input, "-frames:v", "1", ...scaleArgs, outFile],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      seen.set(key, { url: `/out/stills/${key.replace(/[/@.]/g, "_")}.png`, path: outFile });
    }
  }
  return seen;
}

function bundlePainter(outDir) {
  const entry = join(outDir, "_entry.mjs");
  writeFileSync(
    entry,
    `import { paintDescriptor } from ${JSON.stringify(join(repoRoot, "src/engine/refPainter.ts"))};\n` +
      `window.__paintDescriptor = paintDescriptor;\n`,
  );
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: join(outDir, "bundle.js"),
    logLevel: "warning",
  });
}

function startServer(dir, outDir) {
  const mime = (p) =>
    extname(p) === ".png" ? "image/png"
    : extname(p) === ".js" ? "text/javascript"
    : extname(p) === ".html" ? "text/html"
    : extname(p) === ".mp4" ? "video/mp4"
    : extname(p) === ".jpg" || extname(p) === ".jpeg" ? "image/jpeg"
    : "application/octet-stream";
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let filePath;
      if (url.pathname.startsWith("/proj/")) filePath = join(dir, decodeURIComponent(url.pathname.slice("/proj/".length)));
      else if (url.pathname.startsWith("/out/")) filePath = join(outDir, decodeURIComponent(url.pathname.slice("/out/".length)));
      else if (url.pathname === "/oracle") filePath = join(dir, "frames", url.searchParams.get("f"));
      else { res.writeHead(404); res.end(); return; }
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime(filePath) });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

async function findHeadlessShell() {
  return ensureHeadlessShell();
}

async function launchHeadlessShell(execPath) {
  // --user-data-dir を毎回ユニークにする(同じプロファイルへ複数起動すると
  // SingletonLock で新しいプロセスが無言のまま固まることがある実測を踏まえた対策)
  const userDataDir = mkdtempSync(join(tmpdir(), "framewright-parity-chrome-"));
  const proc = spawn(execPath, [
    "--headless", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0",
    "--hide-scrollbars", `--user-data-dir=${userDataDir}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolveWs, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`DevTools listening を検出できませんでした(15秒)。stderr so far:\n${buf}`));
    }, 15000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        proc.stderr.off("data", onData);
        proc.stdout.off("data", onData);
        resolveWs(m[1]);
      }
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome-headless-shell exited early (${code})`));
    });
  });
  return { proc, wsUrl };
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
    }
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  async function send(method, params = {}) {
    await ready;
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    return new Promise((res, rej) => pending.set(myId, { resolve: res, reject: rej }));
  }
  function once(method) {
    return new Promise((res) => {
      const set = listeners.get(method) ?? new Set();
      const cb = (params) => { set.delete(cb); res(params); };
      set.add(cb);
      listeners.set(method, set);
    });
  }
  return { send, once, close: () => ws.close() };
}

async function newPageWs(browserWsUrl) {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

function pageScript({ descriptor, oracleUrl, stillUrls, width, height }) {
  return `(async () => {
    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("failed to load " + url));
        img.src = url;
      });
    }
    const oracleImg = await loadImage(${JSON.stringify(oracleUrl)});
    const stillEntries = ${JSON.stringify(stillUrls)};
    const stillImgs = {};
    for (const [key, url] of Object.entries(stillEntries)) {
      stillImgs[key] = await loadImage(url);
    }
    const descriptor = ${JSON.stringify(descriptor)};
    const W = ${width}, H = ${height};
    const oracleCanvas = document.getElementById("oracle");
    const oursCanvas = document.getElementById("ours");
    const gridCanvas = document.getElementById("grid");
    oracleCanvas.width = W; oracleCanvas.height = H;
    oursCanvas.width = W; oursCanvas.height = H;
    gridCanvas.width = W * 2; gridCanvas.height = H;
    oracleCanvas.getContext("2d").drawImage(oracleImg, 0, 0, W, H);
    const uctx = oursCanvas.getContext("2d");
    window.__paintDescriptor(uctx, descriptor, (item) => {
      const key = item.sourceId + "@" + item.sourceTimeSec.toFixed(2);
      return stillImgs[key] ?? null;
    });
    const gctx = gridCanvas.getContext("2d");
    gctx.drawImage(oracleCanvas, 0, 0);
    gctx.drawImage(oursCanvas, W, 0);
    const dsW = 96, dsH = Math.round((dsW * H) / W);
    const dsA = document.createElement("canvas"); dsA.width = dsW; dsA.height = dsH;
    const dsB = document.createElement("canvas"); dsB.width = dsW; dsB.height = dsH;
    dsA.getContext("2d").drawImage(oracleCanvas, 0, 0, dsW, dsH);
    dsB.getContext("2d").drawImage(oursCanvas, 0, 0, dsW, dsH);
    const dataA = dsA.getContext("2d").getImageData(0, 0, dsW, dsH).data;
    const dataB = dsB.getContext("2d").getImageData(0, 0, dsW, dsH).data;
    let sum = 0;
    for (let i = 0; i < dataA.length; i += 4) {
      const lumA = 0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2];
      const lumB = 0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2];
      sum += Math.abs(lumA - lumB);
    }
    const score = sum / (dsW * dsH);
    return { score, gridDataUrl: gridCanvas.toDataURL("image/png") };
  })()`;
}

async function main() {
  const { dir, times, outDir } = parseArgs(process.argv.slice(2));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`[1/5] オラクル実行: node src/cli.ts frames ${dir} --t ${times.map(fmtT).join(",")} --out`);
  const { props, pngOf } = runOracle(dir, times);

  console.log("[2/5] describeFrame で descriptor を生成");
  const { describeFrame } = await import(join(repoRoot, "src/engine/describeFrame.ts"));
  const descriptors = times.map((t) => describeFrame(props, t));

  console.log("[3/5] 静止画の切り出し(ffmpeg)+ペインタのbundle(esbuild)");
  const stillsDir = join(outDir, "stills");
  const stills = extractStills(dir, props, descriptors, stillsDir);
  bundlePainter(outDir);
  writeFileSync(
    join(outDir, "harness.html"),
    `<!doctype html><html><body>` +
      `<canvas id="oracle"></canvas><canvas id="ours"></canvas><canvas id="grid"></canvas>` +
      `<script src="/out/bundle.js"></script></body></html>`,
  );

  console.log("[4/5] chrome-headless-shell を起動");
  const server = await startServer(dir, outDir);
  const port = server.address().port;
  console.log(`  static server: 127.0.0.1:${port}`);
  const execPath = await findHeadlessShell();
  console.log(`  headless shell: ${execPath}`);
  const { proc, wsUrl: browserWsUrl } = await launchHeadlessShell(execPath);
  console.log(`  browser ws: ${browserWsUrl}`);

  try {
    const pageWsUrl = await newPageWs(browserWsUrl);
    console.log(`  page ws: ${pageWsUrl}`);
    const cdp = connectCdp(pageWsUrl);
    await cdp.send("Page.enable");
    console.log("  Page.enable ok");
    await cdp.send("Runtime.enable");
    console.log("  Runtime.enable ok");
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/out/harness.html` });
    console.log("  Page.navigate sent, waiting for load event...");
    await loaded;
    console.log("  loaded");

    console.log("[5/5] 各時刻を描画してオラクルと比較");
    const results = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const descriptor = descriptors[i];
      const stillUrls = {};
      for (const item of descriptor.items) {
        if (item.kind !== "external") continue;
        const key = `${item.sourceId}@${fmtT(item.sourceTimeSec)}`;
        stillUrls[key] = stills.get(key).url;
      }
      const oracleUrl = `/oracle?f=${encodeURIComponent(`out${fmtT(t)}s.png`)}`;
      const expr = pageScript({ descriptor, oracleUrl, stillUrls, width: props.width, height: props.height });
      const evalResult = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (evalResult.exceptionDetails) {
        throw new Error(`t=${t}: ${JSON.stringify(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails)}`);
      }
      const { score, gridDataUrl } = evalResult.result.value;
      const gridPath = join(outDir, `grid-t${fmtT(t)}.png`);
      writeFileSync(gridPath, Buffer.from(gridDataUrl.split(",")[1], "base64"));
      results.push({ t, score, gridPath });
      console.log(`  t=${fmtT(t)}s: 輝度差スコア=${score.toFixed(2)} → ${gridPath}`);
    }
    cdp.close();
    return results;
  } finally {
    proc.kill();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
