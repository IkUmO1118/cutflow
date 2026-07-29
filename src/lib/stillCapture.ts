// src/lib/stillCapture.ts — HTML 文書を headless Chrome + CDP で PNG 化する。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectCdp,
  evalJs,
  launchHeadlessShell,
  newPageWs,
  type CdpConnection,
  type LaunchedBrowser,
} from "./browser.ts";
import { startStaticServer, type StaticServer } from "./staticServer.ts";

export interface StillCaptureSession {
  /** HTML 文書を読み込み、clip サイズで PNG を撮って絶対パスへ書く */
  capture(args: { html: string; width: number; height: number; outFile: string }): Promise<void>;
  close(): Promise<void>;
}

function waitForEvent(cdp: CdpConnection, method: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
    cdp.on(method, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function closeServer(server: StaticServer["server"]): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** publicRoot を HTTP で配る使い捨てサーバ + headless Chrome を1つ起動する。
 * publicRoot 配下のファイルは `/<相対パス>` で参照できる。 */
export async function createStillCaptureSession(publicRoot: string): Promise<StillCaptureSession> {
  const outDir = mkdtempSync(join(tmpdir(), "cutflow-still-capture-"));
  const stillFile = join(outDir, "still.html");
  const staticServer = await startStaticServer(publicRoot, [
    { path: "/__still.html", file: stillFile, contentType: "text/html" },
  ]);

  let browser: LaunchedBrowser | null = null;
  let cdp: CdpConnection | null = null;
  let closed = false;

  try {
    browser = await launchHeadlessShell();
    const pageWsUrl = await newPageWs(browser.wsUrl);
    cdp = connectCdp(pageWsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
  } catch (error) {
    cdp?.close();
    browser?.close();
    await closeServer(staticServer.server);
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }

  return {
    async capture({ html, width, height, outFile }) {
      if (closed) throw new Error("session closed");
      if (!cdp) throw new Error("session not initialized");
      writeFileSync(stillFile, html);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenOrientation: {
          angle: 0,
          type: "portraitPrimary",
        },
      });
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
      const loaded = waitForEvent(cdp, "Page.loadEventFired", 30000);
      await cdp.send("Page.navigate", {
        url: `http://127.0.0.1:${staticServer.port}/__still.html?nonce=${Date.now()}`,
      });
      await loaded;
      await evalJs(cdp, `Promise.all([
        document.fonts?.ready ?? Promise.resolve(),
        ...Array.from(document.images).map((img) => img.decode().catch(() => undefined)),
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      ])`, true);
      await evalJs(cdp, "document.body.style.background = 'transparent'");
      const result = (await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: true,
        optimizeForSpeed: true,
        fromSurface: true,
      })) as { data: string };
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, Buffer.from(result.data, "base64"));
    },

    async close() {
      if (closed) return;
      closed = true;
      try { cdp?.close(); } catch { /* ignore */ }
      try { browser?.close(); } catch { /* ignore */ }
      try { await closeServer(staticServer.server); } catch { /* ignore */ }
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
