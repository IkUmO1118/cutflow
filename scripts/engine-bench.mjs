#!/usr/bin/env node
// scripts/engine-bench.mjs — M3a Phase5 の計測ハーネス(開発スクリプト。
// リポジトリ配布物ではない)。
//
// editor サーバを起動し、chrome-headless-shell(Remotion 同梱。WebGPU には
// --use-angle=metal --ignore-gpu-blocklist --enable-unsafe-webgpu が要る。
// 母艦§9 実測)から /engine-dev(engineDev.ts が公開する window.__engineDev)
// を CDP 経由で操作して、シーク応答・再生ドロップ率・提示間隔・
// decode/blit の per-frame コストを測る。
//
// 使い方: node scripts/engine-bench.mjs --dir <収録フォルダ> [--seeks 10]
//         [--playSec 8] [--port 4398]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureHeadlessShell } from "../src/lib/browser.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const out = { dir: null, seeks: 10, playSec: 8, port: 4398 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--seeks") out.seeks = Number(argv[++i]);
    else if (argv[i] === "--playSec") out.playSec = Number(argv[++i]);
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
  }
  if (!out.dir) {
    console.error("使い方: node scripts/engine-bench.mjs --dir <収録フォルダ> [--seeks 10] [--playSec 8] [--port 4398]");
    process.exit(1);
  }
  out.dir = resolve(out.dir);
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPing(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (res.ok) return;
    } catch {
      // サーバがまだ起動していない
    }
    await sleep(300);
  }
  throw new Error(`editor サーバが ${timeoutMs}ms 以内に起動しませんでした(port ${port})`);
}

function startEditorServer(dir, port) {
  const proc = spawn("node", ["src/cli.ts", "editor", dir], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (c) => { log += c.toString(); });
  proc.stderr.on("data", (c) => { log += c.toString(); });
  proc.getLog = () => log;
  return proc;
}

async function findHeadlessShell() {
  return ensureHeadlessShell();
}

async function launchHeadlessShell(execPath) {
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-engine-bench-chrome-"));
  const proc = spawn(execPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    // WebGPU を headless で有効化する実測済みフラグ(母艦§9「M3a Phase5」)
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolveWs, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`DevTools listening を検出できませんでした(15秒)。stderr:\n${buf}`)), 15000);
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
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`chrome-headless-shell exited early (${code})`)); });
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
  function on(method, cb) {
    const set = listeners.get(method) ?? new Set();
    set.add(cb);
    listeners.set(method, set);
  }
  return { send, on, close: () => ws.close() };
}

async function newPageWs(browserWsUrl) {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = await res.json();
  return info.webSocketDebuggerUrl;
}

async function evalJs(cdp, expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`evalJs failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails)}`);
  }
  return result.result.value;
}

async function waitForReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evalJs(cdp, "!!window.__engineDev");
    if (ready) return;
    await sleep(300);
  }
  const status = await evalJs(cdp, "document.getElementById('status')?.textContent ?? '(no status element)'");
  throw new Error(`engine-dev が ${timeoutMs}ms 以内に準備完了しませんでした。status=${status}`);
}

/** メインスレッド競合の負荷試験(母艦§8発動条件(c))。100ms ごとに数百要素の
 * テキストを書き換える DOM churn を開始する。停止関数を返す */
async function startDomChurn(cdp) {
  await evalJs(
    cdp,
    `(() => {
      const host = document.createElement("div");
      host.style.display = "none";
      host.id = "__churn_host";
      for (let i = 0; i < 400; i++) host.appendChild(document.createElement("span"));
      document.body.appendChild(host);
      window.__churnTimer = setInterval(() => {
        for (const el of host.children) el.textContent = String(Math.random());
      }, 100);
    })()`,
  );
  return async () => {
    await evalJs(cdp, "clearInterval(window.__churnTimer); document.getElementById('__churn_host')?.remove();");
  };
}

async function readClockStats(cdp) {
  return evalJs(
    cdp,
    `(() => {
      const s = window.__engineDev.clock.stats;
      const sorted = [...s.intervalsMs].sort((a,b) => a-b);
      const pct = (p) => sorted.length ? sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))] : 0;
      return {
        presentedFrames: s.presentedFrames,
        droppedFrames: s.droppedFrames,
        dropRate: s.presentedFrames + s.droppedFrames > 0 ? s.droppedFrames / (s.presentedFrames + s.droppedFrames) : 0,
        intervalP50Ms: pct(0.5),
        intervalP95Ms: pct(0.95),
        sampleCount: sorted.length,
      };
    })()`,
  );
}

async function resetClockStats(cdp) {
  await evalJs(cdp, "window.__engineDev.clock.stats.presentedFrames = 0; window.__engineDev.clock.stats.droppedFrames = 0; window.__engineDev.clock.stats.intervalsMs.length = 0;");
}

async function main() {
  const { dir, seeks, playSec, port } = parseArgs(process.argv.slice(2));

  console.log(`[1/6] editor サーバ起動: ${dir} (port ${port})`);
  const serverProc = startEditorServer(dir, port);
  try {
    await waitForPing(port);
    console.log("  ok");

    console.log("[2/6] chrome-headless-shell 起動(WebGPU フラグ付き)");
    const execPath = await findHeadlessShell();
    const { proc, wsUrl: browserWsUrl } = await launchHeadlessShell(execPath);
    console.log(`  ${execPath}`);

    try {
      const pageWsUrl = await newPageWs(browserWsUrl);
      const cdp = connectCdp(pageWsUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      const errors = [];
      cdp.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description ?? JSON.stringify(p)));

      console.log("[3/6] /engine-dev へ navigate、準備完了を待つ");
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/engine-dev?dir=${encodeURIComponent(dir)}` });
      await waitForReady(cdp);
      if (errors.length > 0) throw new Error(`ページ内で例外: ${errors.join("\n")}`);
      const durationSec = await evalJs(cdp, "window.__engineDev.durationSec");
      console.log(`  ok(尺 ${durationSec.toFixed(1)}s)`);

      console.log(`[4/6] シーク応答を計測(${seeks}回・ランダム位置)`);
      const seekMs = [];
      const renderStatsSamples = [];
      for (let i = 0; i < seeks; i++) {
        const t = Math.random() * durationSec;
        const t0 = Date.now();
        const stats = await evalJs(cdp, `window.__engineDev.seekTo(${t})`, true);
        seekMs.push(Date.now() - t0);
        if (stats) renderStatsSamples.push(stats);
      }
      const seekSorted = [...seekMs].sort((a, b) => a - b);
      console.log(`  p50=${percentile(seekSorted, 0.5)}ms p95=${percentile(seekSorted, 0.95)}ms (n=${seeks})`);

      console.log(`[5/6] 再生ドロップ率(無負荷・${playSec}秒)`);
      await evalJs(cdp, "window.__engineDev.seekTo(0)", true);
      await resetClockStats(cdp);
      await evalJs(cdp, "window.__engineDev.play()");
      await sleep(playSec * 1000);
      await evalJs(cdp, "window.__engineDev.pause()");
      const noLoad = await readClockStats(cdp);
      console.log(`  ${JSON.stringify(noLoad)}`);

      console.log(`[6/6] 再生ドロップ率(メインスレッド競合負荷あり・${playSec}秒)`);
      const stopChurn = await startDomChurn(cdp);
      await evalJs(cdp, "window.__engineDev.seekTo(0)", true);
      await resetClockStats(cdp);
      await evalJs(cdp, "window.__engineDev.play()");
      await sleep(playSec * 1000);
      await evalJs(cdp, "window.__engineDev.pause()");
      const withLoad = await readClockStats(cdp);
      await stopChurn();
      console.log(`  ${JSON.stringify(withLoad)}`);

      const decodeMs = renderStatsSamples.map((s) => s.decodeMs).filter((n) => typeof n === "number");
      const blitMs = renderStatsSamples.map((s) => s.blitMs).filter((n) => typeof n === "number");
      const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

      const report = {
        dir,
        durationSec,
        seek: { p50Ms: percentile(seekSorted, 0.5), p95Ms: percentile(seekSorted, 0.95), samples: seeks },
        playback: { noLoad, withLoad },
        perFrame: {
          decodeMsAvg: avg(decodeMs),
          blitMsAvg: avg(blitMs),
          samples: renderStatsSamples.length,
        },
        pageErrors: errors,
      };
      console.log("\n=== レポート ===");
      console.log(JSON.stringify(report, null, 2));
      cdp.close();
      return report;
    } finally {
      proc.kill();
    }
  } finally {
    serverProc.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
