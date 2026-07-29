// src/lib/engineSession.ts — M4 共有: エンジン headless Chrome セッション管理。
// renderEngine / frames / thumbnail のすべてから使う共通実装。
// export ページのバンドル・配信・
// 初期化、フレームレンダー→キャプチャを1つの使い捨てセッションとして包む。
import {
  copyFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { startStaticServer } from "./staticServer.ts";

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
  copyFileSync(join(repoRoot, "assets/fonts/NotoSansJP.woff2"), join(outDir, "NotoSansJP.woff2"));
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

function startExportServer(dir: string, outDir: string) {
  return startStaticServer(dir, [
    { path: "/", file: join(outDir, "export.html"), contentType: "text/html" },
    { path: "/export.html", file: join(outDir, "export.html"), contentType: "text/html" },
    { path: "/export-bundle.js", file: join(outDir, "export-bundle.js"), contentType: "text/javascript" },
    { path: "/NotoSansJP.woff2", file: join(outDir, "NotoSansJP.woff2"), contentType: "font/woff2" },
  ]);
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
