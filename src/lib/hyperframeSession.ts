// lib/hyperframeSession.ts — HyperFrames カード HTML を Remotion なしで
// headless Chrome + CDP に読み込み、任意時刻へ seek して PNG を撮る。
import {
  connectCdp,
  evalJs,
  launchHeadlessShell,
  newPageWs,
  type CdpConnection,
  type LaunchedBrowser,
} from "./browser.ts";
import { buildIframeSrcdoc } from "./hyperframe.ts";
import type { HyperframeRenderProfile } from "./hyperframeRenderProfile.ts";

export type HyperFrameProps = {
  html: string;
  variables: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  profile: HyperframeRenderProfile;
};

export interface HyperframeSession {
  /** tSec の絵を撮って PNG(base64) を返す。fatal な __failed があれば throw */
  seekAndCapture(tSec: number): Promise<string>;
  close(): Promise<void>;
}

export interface HyperframeCdpSession {
  cdp: CdpConnection;
  close(): Promise<void>;
}

export function seekTimeMs(tSec: number): number {
  return tSec * 1000;
}

export function fatalHyperframeMessage(
  failed: unknown,
): string | null {
  if (!Array.isArray(failed)) return null;
  const messages: string[] = [];
  for (const item of failed) {
    if (!item || typeof item !== "object") continue;
    const failure = item as { message?: unknown; fatal?: unknown };
    if (failure.fatal !== true) continue;
    messages.push(typeof failure.message === "string" ? failure.message : String(failure.message ?? "unknown error"));
  }
  return messages.length > 0 ? messages.join("; ") : null;
}

export function throwIfFatalHyperframeFailure(failed: unknown): void {
  const msg = fatalHyperframeMessage(failed);
  if (msg) throw new Error(`HyperFrame card failed / カードが失敗しました: ${msg}`);
}

function dataUrlForHyperframe(
  html: string,
  variables: Record<string, unknown>,
  profile: HyperframeRenderProfile,
): string {
  const srcdoc = buildIframeSrcdoc(html, variables, profile);
  return "data:text/html;charset=utf-8;base64," + Buffer.from(srcdoc, "utf8").toString("base64");
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

export async function navigateHyperframeCdp(
  cdp: CdpConnection,
  args: {
    html: string;
    variables: Record<string, unknown>;
    profile: HyperframeRenderProfile;
    width: number;
    height: number;
  },
): Promise<void> {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: args.width,
    height: args.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  const loaded = waitForEvent(cdp, "Page.loadEventFired", 30000);
  await cdp.send("Page.navigate", {
    url: dataUrlForHyperframe(args.html, args.variables, args.profile),
  });
  await loaded;
}

export async function createHyperframeCdpSession(args: {
  html: string;
  variables: Record<string, unknown>;
  profile: HyperframeRenderProfile;
  width: number;
  height: number;
}): Promise<HyperframeCdpSession> {
  let browser: LaunchedBrowser | null = null;
  let cdp: CdpConnection | null = null;
  try {
    browser = await launchHeadlessShell();
    const pageWsUrl = await newPageWs(browser.wsUrl);
    cdp = connectCdp(pageWsUrl);
    await navigateHyperframeCdp(cdp, args);
  } catch (error) {
    try { cdp?.close(); } catch { /* ignore */ }
    try { browser?.close(); } catch { /* ignore */ }
    throw error;
  }

  return {
    cdp,
    async close() {
      try { cdp?.close(); } catch { /* ignore */ }
      try { browser?.close(); } catch { /* ignore */ }
    },
  };
}

export async function readHyperframeFailures(cdp: CdpConnection): Promise<unknown> {
  return await evalJs(cdp, "window.__hyperframes?.__failed ?? []");
}

export async function waitForHyperframeReady(cdp: CdpConnection): Promise<void> {
  await evalJs(cdp, "window.__hyperframes?.__isReady?.() ?? Promise.resolve()", true);
}

export async function seekHyperframe(cdp: CdpConnection, tSec: number): Promise<void> {
  await evalJs(cdp, `
    (() => {
      try { window.__hyperframes?.__seek?.(${JSON.stringify(seekTimeMs(tSec))}); } catch (_) {}
      return true;
    })()
  `);
}

export async function waitTwoAnimationFrames(cdp: CdpConnection): Promise<void> {
  await evalJs(
    cdp,
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
    true,
  );
}

export async function createHyperframeSession(args: {
  html: string;
  variables: Record<string, unknown>;
  profile: HyperframeRenderProfile;
  width: number;
  height: number;
}): Promise<HyperframeSession> {
  const session = await createHyperframeCdpSession(args);
  let closed = false;

  return {
    async seekAndCapture(tSec: number): Promise<string> {
      if (closed) throw new Error("session closed");
      throwIfFatalHyperframeFailure(await readHyperframeFailures(session.cdp));
      await waitForHyperframeReady(session.cdp);
      await seekHyperframe(session.cdp, tSec);
      await waitTwoAnimationFrames(session.cdp);
      throwIfFatalHyperframeFailure(await readHyperframeFailures(session.cdp));
      const result = (await session.cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: args.width, height: args.height, scale: 1 },
        captureBeyondViewport: true,
        optimizeForSpeed: true,
        fromSurface: true,
      })) as { data: string };
      return result.data;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await session.close();
    },
  };
}
