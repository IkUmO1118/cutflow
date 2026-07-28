#!/usr/bin/env node
// scripts/engine-pixel-parity.mjs — R1 Phase1: GPU画素parityハーネス(開発スクリプト。
// リポジトリ配布物ではない)。
//
// Remotion オラクル(一時configで engineExport:false に倒した frames)と
// エンジン版(frames 既定)の出力PNGを chrome-headless-shell + CDP で画素比較する。
// ダウンサンプル輝度の平均絶対差を出し、反転検出も行う。Phase1 では
// **未修正の上下反転を検出して exit 1 すること**が合格基準。
//
// 使い方: node scripts/engine-pixel-parity.mjs --dir <収録フォルダ> --t 30,90 [--out <出力先>]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

// 画素差分の閾値(ダウンサンプル輝度の平均絶対差、0-255 スケール)。
// 同一画像なら 0。Remotion Chromium と headless-shell Chrome のフォント
// ラスタ微小差で数ポイントは出うる。5.0 はフォントラスタ差を許容しつつ
// 反転(50+)やレイアウト崩れを確実に捕らえる値。
// 根拠: engine-parity.mjs(M2 Phase4)の実測では Remotion vs refPainter の
// 輝度差スコアが 2-4 程度。別Chrome同士+WebGPU差の余裕を加味して 5.0。
const DIFF_THRESHOLD = 5.0;

function parseArgs(argv) {
  const out = { dir: null, times: [], outDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--t") out.times = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (argv[i] === "--out") out.outDir = argv[++i];
  }
  if (!out.dir || out.times.length < 1) {
    console.error("使い方: node scripts/engine-pixel-parity.mjs --dir <収録フォルダ> --t 30,90 [--out <出力先>]");
    process.exit(1);
  }
  out.dir = resolve(out.dir);
  out.outDir = resolve(out.outDir ?? join(repoRoot, "scripts", ".pixel-parity-out"));
  return out;
}

function fmtT(t) {
  return t.toFixed(2);
}

function buildTempConfigWithRemotion(repoConfigPath, tmpDir) {
  const original = readFileSync(repoConfigPath, "utf8");
  const marker = "\nrender:";
  const idx = original.indexOf(marker);
  if (idx === -1) throw new Error("config.yaml に render: セクションが見つかりません");
  const pos = original.indexOf("\n", idx + marker.length);
  if (pos === -1) throw new Error("render: セクションの次の行が見つかりません");
  // render: 行と次の行の間に engineExport: false を挿入
  const modified = original.slice(0, pos) + "\n  engineExport: false" + original.slice(pos);
  if (modified === original) throw new Error("engineExport: false の挿入に失敗しました(元のconfigと同一)");
  const outPath = join(tmpDir, "config.yaml");
  writeFileSync(outPath, modified);
  return outPath;
}

function runRemotionFrames(dir, times, configPath) {
  const args = ["src/cli.ts", "frames", dir, "--t", times.map(fmtT).join(","), "--config", configPath];
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
}

function runEngineFrames(dir, times) {
  const args = ["src/cli.ts", "frames", dir, "--t", times.map(fmtT).join(",")];
  execFileSync("node", args, { cwd: repoRoot, stdio: "inherit" });
}

function copyOutPngs(dir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const framesDir = join(dir, "frames");
  for (const f of readdirSync(framesDir)) {
    if (f.endsWith(".png")) copyFileSync(join(framesDir, f), join(destDir, f));
  }
}

/** frames コマンドが出力した実際の PNG ファイル名の一覧(リクエスト時刻ではなく
 * スナップ後の出力秒がファイル名になる。例: out25.48s.png) */
function listOutputPngs(copyDir) {
  return readdirSync(copyDir).filter((f) => f.endsWith(".png")).sort();
}

function startServer(outDir) {
  const mime = (p) =>
    extname(p) === ".png" ? "image/png" :
    extname(p) === ".js" ? "text/javascript" :
    extname(p) === ".html" ? "text/html" :
    "application/octet-stream";

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = join(outDir, decodeURIComponent(url.pathname.slice(1)));
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

function findHeadlessShell() {
  const roots = [
    join(repoRoot, "node_modules/.remotion"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/ms-playwright"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/remotion"),
  ];
  for (const root of roots) {
    try {
      const out = execFileSync("find", [root, "-iname", "chrome-headless-shell", "-type", "f", "-maxdepth", "8"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      const hit = out.trim().split("\n").filter(Boolean)[0];
      if (hit) return hit;
    } catch { /* try next root */ }
  }
  throw new Error("chrome-headless-shell が見つかりません(先に render/frames を1回実行してください)");
}

async function launchHeadlessShell(execPath) {
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-pixel-parity-chrome-"));
  const proc = spawn(execPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolveWs, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`DevTools listening timeout`)), 15000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); proc.stderr.off("data", onData); proc.stdout.off("data", onData); resolveWs(m[1]); }
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", onData);
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`chrome-headless-shell exited early (${code})`)); });
  });
  return { proc, wsUrl };
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const eventListeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result ?? msg); }
    } else if (msg.method) {
      for (const cb of eventListeners.get(msg.method) ?? []) cb(msg.params);
    }
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  return {
    async send(method, params = {}) {
      await ready;
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, method, params }));
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 30000);
        pending.set(myId, {
          resolve: (v) => { clearTimeout(timer); res(v); },
          reject: (e) => { clearTimeout(timer); rej(e); },
        });
      });
    },
    on(method, cb) {
      const set = eventListeners.get(method) ?? new Set();
      set.add(cb);
      eventListeners.set(method, set);
    },
    close: () => ws.close(),
  };
}

async function newPageWs(browserWsUrl) {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

function pageScript({ remotionUrl, engineUrl, label, outDir }) {
  return `
(async () => {
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load " + url));
      img.src = url;
    });
  }
  const remotionImg = await loadImage(${JSON.stringify(remotionUrl)});
  const engineImg = await loadImage(${JSON.stringify(engineUrl)});
  const W = remotionImg.naturalWidth, H = remotionImg.naturalHeight;

  // 念のため canvas サイズは engine 側に合わせる(remotion を基準に)
  const rc = document.createElement("canvas"); rc.width = W; rc.height = H;
  const ec = document.createElement("canvas"); ec.width = W; ec.height = H;
  rc.getContext("2d").drawImage(remotionImg, 0, 0, W, H);
  ec.getContext("2d").drawImage(engineImg, 0, 0, W, H);

  // engine flipped
  const efc = document.createElement("canvas");
  efc.width = W; efc.height = H;
  const efctx = efc.getContext("2d");
  efctx.save();
  efctx.scale(1, -1);
  efctx.drawImage(ec, 0, -H);
  efctx.restore();

  // グリッド(remotion | engine | engine-flipped)
  const gc = document.createElement("canvas"); gc.width = W * 3; gc.height = H;
  const gctx = gc.getContext("2d");
  gctx.drawImage(rc, 0, 0);
  gctx.drawImage(ec, W, 0);
  gctx.drawImage(efc, W * 2, 0);

  function downsample(c) {
    const dsW = 96, dsH = Math.round((dsW * H) / W);
    const ds = document.createElement("canvas"); ds.width = dsW; ds.height = dsH;
    ds.getContext("2d").drawImage(c, 0, 0, dsW, dsH);
    return ds.getContext("2d").getImageData(0, 0, dsW, dsH).data;
  }

  function lumDiff(dataA, dataB) {
    let sum = 0;
    for (let i = 0; i < dataA.length; i += 4) {
      const la = 0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2];
      const lb = 0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2];
      sum += Math.abs(la - lb);
    }
    const dsW = 96, dsH = Math.round((dsW * H) / W);
    return sum / (dsW * dsH);
  }

  const dataR = downsample(rc);
  const dataE = downsample(ec);
  const dataEF = downsample(efc);
  const diffNormal = lumDiff(dataR, dataE);
  const diffFlipped = lumDiff(dataR, dataEF);

  return { diffNormal, diffFlipped, gridDataUrl: gc.toDataURL("image/png") };
})()`;
}

async function main() {
  const { dir, times, outDir } = parseArgs(process.argv.slice(2));
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
      const expr = pageScript({ remotionUrl, engineUrl, label, outDir });
      const evalResult = await cdp.send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (evalResult.exceptionDetails) {
        throw new Error(`t=${label}: ${JSON.stringify(evalResult.exceptionDetails.exception?.description ?? evalResult.exceptionDetails)}`);
      }
      const { diffNormal, diffFlipped, gridDataUrl } = evalResult.result.value;
      const gridPath = join(outDir, `grid-t${label}.png`);
      writeFileSync(gridPath, Buffer.from(gridDataUrl.split(",")[1], "base64"));

      const flippedFlag = diffFlipped < diffNormal;
      const mismatchFlag = diffNormal > DIFF_THRESHOLD;
      const status = flippedFlag ? "上下反転を検出" : mismatchFlag ? "不一致" : "一致";
      console.log(`  t=${label}s: diffNormal=${diffNormal.toFixed(2)} diffFlipped=${diffFlipped.toFixed(2)} → ${status}`);
      if (flippedFlag) anyFlipped = true;
      if (mismatchFlag) anyMismatch = true;
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
