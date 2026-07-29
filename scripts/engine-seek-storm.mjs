#!/usr/bin/env node
// scripts/engine-seek-storm.mjs — R4 Phase6: シーク嵐(スクラブ相当)の
// headless 計測(開発スクリプト。リポジトリ配布物ではない)。
//
// /engine-dev(engineDev.ts。PresentationClock/AudioScheduler/FrameSource は
// EnginePreview.tsx と同じ実装)を chrome-headless-shell + CDP で開き、
// 再生開始 → ランダムな位置へ連続シーク(#seek 要素へ input イベントを
// 直接発火してスクラブを模す。これが「音声引き直しの原本」である
// seekBar handler(clock.seek + 再生中なら audioScheduler.start)を通る)
// → 最後に再生を続けて、以下を実測する:
//   - clock.stats.presentedFrames がシーク後も増え続けるか(停止しない)
//   - clock.stats.forcedResets / lastStallMs(R4 Phase5の強制復帰計測)
//   - sourcePool 経由の FrameSource.stats.timeouts(R4 Phase5)
//   - audioScheduler.scheduledOutputSec()/queuedNodeCount()(音声の予約状況。
//     R2の計測 getter)
//
// 使い方: node scripts/engine-seek-storm.mjs --dir <収録フォルダ> [--seeks 30] [--port 4502]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureHeadlessShell } from "../src/lib/browser.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const out = { dir: null, seeks: 30, port: 4502 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--seeks") out.seeks = Number(argv[++i]);
    else if (argv[i] === "--port") out.port = Number(argv[++i]);
  }
  if (!out.dir) {
    console.error("使い方: node scripts/engine-seek-storm.mjs --dir <収録フォルダ> [--seeks 30] [--port 4502]");
    process.exit(1);
  }
  out.dir = resolve(out.dir);
  return out;
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
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-seek-storm-chrome-"));
  const proc = spawn(execPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
    // headless では playBtn.click() が信頼済みユーザー操作と扱われず
    // AudioContext.resume() が実際には running へ遷移しない(currentTime が
    // 進まない)ことがある。計測目的でオートプレイ制限を外す
    "--autoplay-policy=no-user-gesture-required",
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
  throw new Error(`engine-dev が ${timeoutMs}ms 以内に準備完了しませんでした`);
}

/** #seek(range input)へ input イベントを直接発火する。これが
 * engineDev.ts のスクラブハンドラ(clock.seek + 再生中なら
 * audioScheduler.start)を通る「音声引き直しの原本」経路 */
async function scrubTo(cdp, sec) {
  await evalJs(cdp, `(() => {
    const bar = document.getElementById("seek");
    bar.value = String(${sec});
    bar.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

async function readStats(cdp) {
  return evalJs(
    cdp,
    `(() => {
      const d = window.__engineDev;
      const s = d.clock.stats;
      const base = d.sourcePool.acquire("media/proxy.mp4");
      return {
        currentSec: d.clock.currentOutputSec(),
        presentedFrames: s.presentedFrames,
        droppedFrames: s.droppedFrames,
        forcedResets: s.forcedResets,
        lastStallMs: s.lastStallMs,
        baseSourceStats: { ...base.stats },
        audioQueuedNodeCount: d.audioScheduler.queuedNodeCount(),
        audioScheduledOutputSec: d.audioScheduler.scheduledOutputSec(),
      };
    })()`,
  );
}

async function main() {
  const { dir, seeks, port } = parseArgs(process.argv.slice(2));

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
      const durationSec = await evalJs(cdp, "window.__engineDev.durationSec");
      console.log(`  ok(尺 ${durationSec.toFixed(1)}s)`);

      console.log("[4/6] 再生開始");
      await evalJs(cdp, "window.__engineDev.play()");
      await sleep(300);

      console.log(`[5/6] ランダムな位置へ${seeks}回連続シーク(スクラブ相当)`);
      const beforeStorm = await readStats(cdp);
      for (let i = 0; i < seeks; i++) {
        const t = Math.random() * durationSec;
        await scrubTo(cdp, t);
        // スクラブ相当: 次の入力までごく短い間隔(pointermoveの典型的な頻度)
        await sleep(20);
      }
      const afterStorm = await readStats(cdp);

      console.log("[6/6] 最後に再生を続け、presentedFramesが増え続けるか確認");
      await sleep(2000);
      const afterContinuedPlay = await readStats(cdp);

      cdp.close();

      const report = {
        dir,
        durationSec,
        seeks,
        beforeStorm,
        afterStorm,
        afterContinuedPlay,
        presentedFramesGrewAfterStorm: afterContinuedPlay.presentedFrames > afterStorm.presentedFrames,
        pageErrors: errors,
      };
      console.log("\n=== レポート ===");
      console.log(JSON.stringify(report, null, 2));
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
