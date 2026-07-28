// src/lib/engineSession.ts — M4 共有: エンジン headless Chrome セッション管理。
// renderEngine / frames / thumbnail のすべてから使う共通実装。
// chrome-headless-shell の起動、CDP 接続、export ページのバンドル・配信・
// 初期化、フレームレンダー→キャプチャを1つの使い捨てセッションとして包む。
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { RenderProps } from "../../remotion/props.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, cb: (params: Record<string, unknown>) => void): void;
  close(): void;
}

function connectCdp(wsUrl: string): CdpConnection {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data as string) as {
      id?: number; method?: string; params?: Record<string, unknown>;
      error?: { message: string }; result?: unknown;
    };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    } else if (msg.method) {
      for (const cb of listeners.get(msg.method) ?? []) cb(msg.params ?? {});
    }
  });
  const ready = new Promise<void>((r) => ws.addEventListener("open", () => r()));

  return {
    async send(method, params = {}) {
      await ready;
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, method, params }));
      return new Promise((res, rej) => pending.set(myId, { resolve: res, reject: rej }));
    },
    on(method, cb) {
      const set = listeners.get(method) ?? new Set();
      set.add(cb);
      listeners.set(method, set);
    },
    close: () => ws.close(),
  };
}

async function evalJs(cdp: CdpConnection, expression: string, awaitPromise = false): Promise<unknown> {
  const result = (await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })) as {
    exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value: unknown };
  };
  if (result.exceptionDetails) throw new Error(`evalJs: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

// ---------------------------------------------------------------------------
// Headless Chrome
// ---------------------------------------------------------------------------

function findHeadlessShell(): string {
  const roots = [
    join(repoRoot, "node_modules/.remotion"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/ms-playwright"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/remotion"),
  ];
  for (const root of roots) {
    try {
      const out = execSync(`find "${root}" -iname "chrome-headless-shell" -type "f" -maxdepth 8 2>/dev/null || true`, {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      const hit = out.trim().split("\n").filter(Boolean)[0];
      if (hit) return hit;
    } catch { /* try next root */ }
  }
  throw new Error("chrome-headless-shell が見つかりません(先に render/frames を1回実行してください)");
}

async function launchHeadlessShell(execPath: string): Promise<{ proc: ReturnType<typeof spawn>; wsUrl: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-engine-"));
  const proc = spawn(execPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise<string>((resolveWs, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`DevTools listening timeout`)), 15000);
    const onData = (chunk: Buffer) => {
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

async function newPageWs(browserWsUrl: string): Promise<string> {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = (await res.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

// ---------------------------------------------------------------------------
// Export ページ(bundle + HTML + HTTP サーバ)
// ---------------------------------------------------------------------------

function bundleExporterFile(outDir: string): string {
  const entry = join(outDir, "_entry.mjs");
  writeFileSync(entry, `import "${join(repoRoot, "src/engine/runtime/exporter.ts").replace(/\\/g, "/")}";\n`);
  const outFile = join(outDir, "export-bundle.js");
  esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: "iife", platform: "browser",
    outfile: outFile, logLevel: "warning", target: "esnext",
  });
  return outFile;
}

function buildExportHtml(outDir: string, configJson: string): void {
  bundleExporterFile(outDir);
  const bundleName = "export-bundle.js";
  if (join(outDir, bundleName) !== join(outDir, bundleName)) {
    // bundle already written by bundleExporterFile, just write html
  }
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CutFlow Engine</title>
<style>body{margin:0;background:#000;overflow:hidden}
#canvas-host{position:absolute;top:0;left:0}
#export-status{position:fixed;top:8px;left:8px;color:#fff;font:12px monospace;z-index:1}
</style></head><body>
<div id="canvas-host"></div>
<div id="export-status">初期化中…</div>
<script>window.__EXPORT_CONFIG__ = ${configJson};</script>
<script src="${bundleName}"></script>
</body></html>`;
  writeFileSync(join(outDir, "export.html"), html);
}

function startExportServer(dir: string, outDir: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const mime = (p: string) =>
    p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "text/javascript" :
    p.endsWith(".mp4") ? "video/mp4" : p.endsWith(".png") ? "image/png" :
    "application/octet-stream";

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === "/export.html") {
        const data = readFileSync(join(outDir, "export.html"));
        res.writeHead(200, { "Content-Type": "text/html" }); res.end(data); return;
      }
      if (url.pathname === "/export-bundle.js") {
        const data = readFileSync(join(outDir, "export-bundle.js"));
        res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(data); return;
      }
      const filePath = join(dir, url.pathname.replace(/^\//, ""));
      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": mime(filePath) }); res.end(data);
      } catch {
        res.writeHead(404); res.end();
      }
    } catch {
      res.writeHead(500); res.end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as { port: number };
    r({ server, port: addr.port });
  }));
}

// ---------------------------------------------------------------------------
// パブリック: EngineSession
// ---------------------------------------------------------------------------

export interface EngineSessionConfig {
  props: RenderProps;
  durationSec: number;
  sourceUrls: Record<string, string>;
}

export interface EngineSession {
  renderAndCapture(tOut: number): Promise<string>;
  close(): Promise<void>;
}

export async function createEngineSession(
  dir: string,
  config: EngineSessionConfig,
): Promise<EngineSession> {
  const outDir = mkdtempSync(join(tmpdir(), "cutflow-engine-session-"));

  buildExportHtml(outDir, JSON.stringify(config));
  const { server, port } = await startExportServer(dir, outDir);
  const execPath = findHeadlessShell();
  const { proc: chromeProc, wsUrl: browserWsUrl } = await launchHeadlessShell(execPath);

  let cdp: CdpConnection | null = null;
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  let closed = false;

  try {
    const pageWsUrl = await newPageWs(browserWsUrl);
    cdp = connectCdp(pageWsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Navigate + wait
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const ready = await evalJs(cdp, "!!window.__cutflowExporter");
      if (ready) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const ready = await evalJs(cdp, "!!window.__cutflowExporter");
    if (!ready) throw new Error("exporter ready timeout");

    await evalJs(cdp, "window.__cutflowExporter.init()", true);
    rect = (await evalJs(cdp, "window.__cutflowExporter.getCanvasRect()")) as {
      x: number; y: number; width: number; height: number;
    };
  } catch (e) {
    cdp?.close();
    chromeProc.kill();
    server.close();
    rmSync(outDir, { recursive: true, force: true });
    throw e;
  }

  return {
    async renderAndCapture(tOut: number): Promise<string> {
      if (closed) throw new Error("session closed");
      if (!cdp || !rect) throw new Error("session not initialized");
      await evalJs(cdp, `window.__cutflowExporter.renderFrame(${tOut})`, true);
      const result = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
        captureBeyondViewport: true,
      })) as { data: string };
      return result.data;
    },

    async close() {
      if (closed) return;
      closed = true;
      try { if (cdp) { await evalJs(cdp, "window.__cutflowExporter.dispose()"); cdp.close(); } } catch { /* ignore */ }
      try { chromeProc.kill(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
