// chrome-headless-shell の取得・起動・CDP 接続の唯一の出所。
// Remotion の ensureBrowser() へは依存しない。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, computeExecutablePath, install } from "@puppeteer/browsers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Pixel golden は Chrome の描画差分に敏感なため、実行時の stable 解決ではなく
// ソース内で buildId を pin して再現性を保つ。
export const CHROME_BUILD_ID = "149.0.7790.0";

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, cb: (params: Record<string, unknown>) => void): void;
  close(): void;
}

export interface LaunchedBrowser {
  proc: ChildProcess;
  wsUrl: string;
  close(): void;
}

export function chromeCacheDir(): string {
  return join(process.env.HOME ?? tmpdir(), ".cutflow", "chrome");
}

function pinnedExecutablePath(): string {
  return computeExecutablePath({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId: CHROME_BUILD_ID,
    cacheDir: chromeCacheDir(),
  });
}

function findLegacyHeadlessShell(): string | null {
  const roots = [
    join(repoRoot, "node_modules/.remotion"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/ms-playwright"),
    join(process.env.HOME ?? "/tmp", "Library/Caches/remotion"),
  ];
  for (const root of roots) {
    try {
      const out = execFileSync("find", [
        root,
        "-maxdepth",
        "8",
        "-iname",
        "chrome-headless-shell",
        "-type",
        "f",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const hit = out.trim().split("\n").filter(Boolean)[0];
      if (hit) return hit;
    } catch {
      // try next root
    }
  }
  return null;
}

/** pin した chrome-headless-shell の実行ファイル絶対パスを返す。
 *  優先順: CUTFLOW_CHROME_PATH（実在時） → ~/.cutflow/chrome の既存 →
 *  ダウンロード → （移行期の砦）node_modules/.remotion 等の旧経路 */
export async function ensureHeadlessShell(): Promise<string> {
  const envPath = process.env.CUTFLOW_CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const existing = pinnedExecutablePath();
  if (existsSync(existing)) return existing;

  try {
    console.log("chrome-headless-shell を取得します（初回のみ・約200MB）…");
    const installed = await install({
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId: CHROME_BUILD_ID,
      cacheDir: chromeCacheDir(),
    });
    return installed.executablePath;
  } catch (e) {
    const legacy = findLegacyHeadlessShell();
    if (legacy) {
      console.warn(`警告: 取得に失敗したため既存の Remotion 由来 Chrome を使います: ${legacy}`);
      return legacy;
    }
    throw new Error(
      "chrome-headless-shell を取得できませんでした（ネットワークを確認するか、" +
      `CUTFLOW_CHROME_PATH で実行ファイルを指定してください）: ${(e as Error).message}`,
    );
  }
}

/** headless Chrome を起動し、DevTools の browser WebSocket URL を返す。
 *  フラグは engineSession.ts の現行実装と完全に同一。 */
export async function launchHeadlessShell(execPath?: string): Promise<LaunchedBrowser> {
  const resolvedExecPath = execPath ?? await ensureHeadlessShell();
  const userDataDir = mkdtempSync(join(tmpdir(), "cutflow-engine-"));
  const proc = spawn(resolvedExecPath, [
    "--headless", "--remote-debugging-port=0", "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    const wsUrl = await new Promise<string>((resolveWs, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("DevTools listening timeout")), 15000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); proc.stderr?.off("data", onData); proc.stdout?.off("data", onData); resolveWs(m[1]); }
      };
      proc.stderr?.on("data", onData);
      proc.stdout?.on("data", onData);
      proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`chrome-headless-shell exited early (${code})`)); });
    });
    return {
      proc,
      wsUrl,
      close() {
        try { proc.kill(); } catch { /* ignore */ }
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  } catch (e) {
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** CDP の WebSocket に接続する（現行 connectCdp と同一実装の移設）。 */
export function connectCdp(wsUrl: string): CdpConnection {
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

export async function newPageWs(browserWsUrl: string): Promise<string> {
  const httpBase = browserWsUrl.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "");
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const info = (await res.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

export async function evalJs(cdp: CdpConnection, expression: string, awaitPromise = false): Promise<unknown> {
  const result = (await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })) as {
    exceptionDetails?: { exception?: { description?: string }; text?: string }; result?: { value: unknown };
  };
  if (result.exceptionDetails) throw new Error(`evalJs: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}
