// src/lib/engineSession.ts — M4 共有: エンジン headless Chrome セッション管理。
// renderEngine / frames / thumbnail のすべてから使う共通実装。
// export ページのバンドル・配信・
// 初期化、フレームレンダー→キャプチャを1つの使い捨てセッションとして包む。
import { createServer } from "node:http";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { RenderProps } from "./renderPropsTypes.ts";
import {
  connectCdp,
  evalJs,
  launchHeadlessShell,
  newPageWs,
  type CdpConnection,
  type LaunchedBrowser,
} from "./browser.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  copyFileSync(join(repoRoot, "remotion/fonts/NotoSansJP.woff2"), join(outDir, "NotoSansJP.woff2"));
  const bundleName = "export-bundle.js";
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CutFlow Engine</title>
<style>@font-face{font-family:"Noto Sans JP";src:url("/NotoSansJP.woff2") format("woff2");font-weight:100 900;font-display:block}
body{margin:0;background:#000;overflow:hidden}
#canvas-host{position:absolute;top:0;left:0}
#export-status{position:fixed;top:8px;left:8px;color:#fff;font:12px monospace}
</style></head><body>
<div id="canvas-host"></div>
<div id="export-status">初期化中…</div>
<script>window.__EXPORT_CONFIG__ = ${configJson};</script>
<script src="${bundleName}"></script>
</body></html>`;
  writeFileSync(join(outDir, "export.html"), html);
}

function startExportServer(dir: string, outDir: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  const mime = (p: string) => MIME[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

  const absDir = resolve(dir);

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === "/export.html") {
        const data = readFileSync(join(outDir, "export.html"));
        res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(data.length) });
        res.end(data); return;
      }
      if (url.pathname === "/export-bundle.js") {
        const data = readFileSync(join(outDir, "export-bundle.js"));
        res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": String(data.length) });
        res.end(data); return;
      }
      if (url.pathname === "/NotoSansJP.woff2") {
        const data = readFileSync(join(outDir, "NotoSansJP.woff2"));
        res.writeHead(200, { "Content-Type": "font/woff2", "Content-Length": String(data.length) });
        res.end(data); return;
      }
      const rel = url.pathname.replace(/^\//, "");
      const filePath = join(dir, rel);
      const abs = normalize(filePath);
      if (!abs.startsWith(absDir + sep)) {
        res.writeHead(403); res.end();
        return;
      }
      if (!existsSync(abs)) {
        res.writeHead(404); res.end();
        return;
      }
      const st = statSync(abs);
      const size = st.size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${size}` });
          res.end(); return;
        }
        res.writeHead(206, {
          "Content-Type": mime(filePath),
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        });
        createReadStream(abs, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Type": mime(filePath),
          "Accept-Ranges": "bytes",
          "Content-Length": String(size),
        });
        createReadStream(abs).pipe(res);
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

  let browser: LaunchedBrowser | null = null;
  let cdp: CdpConnection | null = null;
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  let closed = false;

  try {
    browser = await launchHeadlessShell();
    const pageWsUrl = await newPageWs(browser.wsUrl);
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
    browser?.close();
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
      try { browser?.close(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
