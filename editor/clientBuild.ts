import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export interface EditorClientAssets {
  bundleJs: string;
  stylesCss: string;
  indexHtml: string;
  revision: number;
}

export interface MutableEditorClientAssets {
  current: EditorClientAssets;
}

export interface EditorAssetResponse {
  body: string;
  headers: Record<string, string>;
}

const EDITOR_DIR = dirname(fileURLToPath(import.meta.url));

function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`${name} build produced no output`);
  return value;
}

/** Resolve the package's declared public executable instead of assuming .bin layout. */
export function resolveTailwindCliEntry(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@tailwindcss/cli/package.json");
  const packageJson = JSON.parse(requireNonEmpty(
    "@tailwindcss/cli package metadata",
    // The metadata is tiny and only read once for each editor asset build.
    readFileSync(packageJsonPath, "utf8"),
  )) as { bin?: string | Record<string, string> };
  const declaredBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.tailwindcss;
  if (!declaredBin) throw new Error("@tailwindcss/cli does not declare the tailwindcss executable");
  return resolve(dirname(packageJsonPath), declaredBin);
}

export function tailwindCliArgs(inputPath: string): string[] {
  return [
    resolveTailwindCliEntry(),
    "--input",
    inputPath,
    "--output",
    "-",
    "--minify",
    "--silent",
  ];
}

export function acceptTailwindCliResult({
  stdout,
  stderr,
  code,
  signal,
}: {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  if (code !== 0 || signal !== null) {
    throw new Error(
      `Tailwind CLI failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${stderr.trim() || "no stderr"}`,
    );
  }
  if (stderr.trim().length > 0) {
    throw new Error(`Tailwind CLI wrote unexpected stderr: ${stderr.trim()}`);
  }
  return requireNonEmpty("Tailwind CSS", stdout);
}

export async function compileEditorStyles(
  inputPath: string,
  cwd = dirname(inputPath),
): Promise<string> {
  const args = tailwindCliArgs(inputPath);
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        resolvePromise(acceptTailwindCliResult({ stdout, stderr, code, signal }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function buildEditorClientAssets(
  editorDir = EDITOR_DIR,
  revision = 1,
): Promise<EditorClientAssets> {
  const clientDir = join(editorDir, "client");
  const [bundle, stylesCss, indexHtml] = await Promise.all([
    build({
      entryPoints: [join(clientDir, "index.tsx")],
      bundle: true,
      write: false,
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      sourcemap: "inline",
      target: "es2022",
      loader: { ".woff2": "dataurl", ".woff": "dataurl" },
    }),
    compileEditorStyles(join(clientDir, "styles.css"), editorDir),
    readFile(join(clientDir, "index.html"), "utf8"),
  ]);
  const bundleJs = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text
    ?? bundle.outputFiles[0]?.text
    ?? "";
  return {
    bundleJs: requireNonEmpty("editor JavaScript", bundleJs),
    stylesCss: requireNonEmpty("editor CSS", stylesCss),
    indexHtml: requireNonEmpty("editor HTML", indexHtml),
    revision,
  };
}

export function editorAssetResponse(
  path: string,
  assets: EditorClientAssets,
): EditorAssetResponse | null {
  const common = {
    "Cache-Control": "no-store",
    "X-CutFlow-Editor-Revision": String(assets.revision),
  };
  if (path === "/") {
    return {
      body: assets.indexHtml,
      headers: { ...common, "Content-Type": "text/html; charset=utf-8" },
    };
  }
  if (path === "/bundle.js") {
    return {
      body: assets.bundleJs,
      headers: { ...common, "Content-Type": "text/javascript; charset=utf-8" },
    };
  }
  if (path === "/styles.css") {
    return {
      body: assets.stylesCss,
      headers: { ...common, "Content-Type": "text/css; charset=utf-8" },
    };
  }
  return null;
}

interface EditorClientReloaderOptions {
  assets: MutableEditorClientAssets;
  build: (revision: number) => Promise<EditorClientAssets>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
  onSwap?: (assets: EditorClientAssets) => void;
}

export interface EditorClientReloader {
  schedule(): void;
  flush(): Promise<void>;
  close(): void;
}

/** Debounced rebuilds are serialized; a failed build leaves every prior asset intact. */
export function createEditorClientReloader({
  assets,
  build: rebuild,
  debounceMs = 90,
  onError = () => {},
  onSwap = () => {},
}: EditorClientReloaderOptions): EditorClientReloader {
  let timer: NodeJS.Timeout | null = null;
  let pending = false;
  let closed = false;
  let running: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      do {
        pending = false;
        try {
          const next = await rebuild(assets.current.revision + 1);
          requireNonEmpty("editor JavaScript", next.bundleJs);
          requireNonEmpty("editor CSS", next.stylesCss);
          requireNonEmpty("editor HTML", next.indexHtml);
          // This single assignment is the publish point for a complete revision.
          assets.current = next;
          onSwap(next);
        } catch (error) {
          onError(error);
        }
      } while (pending && !closed);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (): void => {
    if (closed) return;
    pending = true;
    if (running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending && !running && !closed) void run();
    while (running) await running;
  };

  return {
    schedule,
    flush,
    close() {
      closed = true;
      pending = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
