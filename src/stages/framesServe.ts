// 常駐フレームサーバ(frames-serve <dir>)。
//
// frames() は1回の CLI 呼び出しの中で bundle(webpack)+headless Chrome を
// 使い回しているが、AI の編集ループ(JSON 編集 → frames --t … → 確認 → …)は
// 毎回別プロセスの CLI 起動なので、そのコールドコストをまたいで再利用できない。
// このデーモンは bundle+browser を起動時に1回だけ暖め、`frames <dir> --t …` が
// portfile(frames/.serve.json)を見つけたら POST /frames でここへ委譲する。
//
// 暖めるのは remotion コード(bundle)と無依存の browser だけで、config・
// 編集 JSON・props は毎リクエスト読み直す(renderFrames が単発と同じ経路で
// 行う)。したがってデーモン経由でも単発でも出る絵は同一(設計 §課題2 論点2-B)。
//
// editor/server.ts の localhost サーバ骨格(node:http・127.0.0.1・Host/Origin
// 検査・requestTimeout=0)を流用。1 デーモン = 1 収録(bundle が publicDir=dir
// に依存するため、別 dir を捌くには再バンドルが要る)。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { loadConfig } from "../lib/config.ts";
import { renderFrames } from "./frames.ts";
import type { FrameRequest, FrameShot, WarmAssets } from "./frames.ts";

/** frames/ 内、常駐サーバの待受情報を書くファイル(中間生成物。frames/*.png
 * の全消しループ(.png/.ocr.json のみ対象)には含まれない) */
export const SERVE_PORT_FILE = ".serve.json";

/** frames.serve.port(config.yaml)未指定時の既定ポート。editor(4310)と別 */
export const DEFAULT_SERVE_PORT = 4311;

/** frames/.serve.json の中身 */
export interface ServePortFile {
  port: number;
  pid: number;
}

/** POST /frames の body(FrameRequest を JSON 化したもの+撮影オプション) */
interface ServeRequestBody {
  mode?: unknown;
  times?: unknown;
  axis?: unknown;
  stepSec?: unknown;
  short?: unknown;
  ocr?: unknown;
  fullRes?: unknown;
}

/** パース済みの撮影リクエスト(renderFrames にそのまま渡せる形) */
export interface ParsedFramesRequest {
  req: FrameRequest;
  opts: { short?: string; ocr?: boolean; fullRes?: boolean };
}

/**
 * POST /frames の body(JSON.parse 済みの unknown)を FrameRequest+opts に
 * 変換・検査する純関数(unit test 対象)。frames CLI の --t/--captions/--every
 * と同じ組み立てルールを HTTP body 向けに素直に写したもの。不正な body は
 * 分かりやすいメッセージで例外を投げる(handle 側が 400 で返す)
 */
export function parseFramesServeBody(body: unknown): ParsedFramesRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("body が JSON オブジェクトではありません");
  }
  const b = body as ServeRequestBody;
  let req: FrameRequest;
  if (b.mode === "captions") {
    req = { mode: "captions" };
  } else if (b.mode === "every") {
    if (typeof b.stepSec !== "number" || !(b.stepSec > 0)) {
      throw new Error(
        `every モードには正の数値 stepSec が必要です: ${JSON.stringify(b.stepSec)}`,
      );
    }
    req = { mode: "every", stepSec: b.stepSec };
  } else if (b.mode === "times") {
    if (!Array.isArray(b.times) || b.times.some((t) => typeof t !== "number")) {
      throw new Error("times モードには数値配列 times が必要です");
    }
    if (b.axis !== undefined && b.axis !== "source" && b.axis !== "output") {
      throw new Error(`axis が不正です: ${JSON.stringify(b.axis)}(source/output のいずれか)`);
    }
    req = { mode: "times", times: b.times as number[], axis: b.axis === "output" ? "output" : "source" };
  } else {
    throw new Error(
      `mode が不正です: ${JSON.stringify(b.mode)}(times/captions/every のいずれか)`,
    );
  }
  const opts = {
    short: typeof b.short === "string" ? b.short : undefined,
    ocr: b.ocr === true,
    fullRes: b.fullRes === true,
  };
  return { req, opts };
}

/**
 * remotion/ 配下の全ファイルの最大 mtime(ms)。bundle 陳腐化の判定に使う
 * (MEMORY.md「Remotion の webpack バンドルキャッシュが陳腐化する」を踏まない
 * ため、remotion ソース編集をここで検知したら再バンドルする)
 */
export function remotionMaxMtimeMs(remotionDir: string): number {
  let max = 0;
  for (const e of readdirSync(remotionDir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath ?? remotionDir, e.name);
    const m = statSync(p).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

/** DNS rebinding・CSRF 対策(editor/server.ts と同じ正規表現・同じ判断) */
const LOCAL_HOST = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 常駐フレームサーバを起動する(Ctrl+C まで終了しない)。
 * - 起動時に ensureBrowser + bundle + openBrowser を1回だけ実行
 * - POST /frames: body を FrameRequest+opts にパースし、loadConfig()(毎回)
 *   → renderFrames(dir, req, cfg, opts, warm) → { shots } を返す
 * - remotion/ の最大 mtime を記録し、リクエスト時に変化していれば再バンドル
 *   (念のため node_modules/.cache/webpack も消してから。陳腐化回避)
 * - browser がレンダー中に落ちた場合、1回だけ作り直してそのリクエストを再試行
 * - GET /ping: 生存確認(B3 の frames CLI 検出用)
 */
export async function startFramesServe(
  dir: string,
  explicitConfigPath: string | undefined,
  port: number,
): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const remotionDir = join(repoRoot, "remotion");
  const webpackCacheDir = join(repoRoot, "node_modules", ".cache", "webpack");

  console.log("frames-serve 起動準備中(bundle+headless Chrome を暖機。数十秒かかることがあります)...");
  await ensureBrowser();
  let bundleMtime = remotionMaxMtimeMs(remotionDir);
  let serveUrl = await bundle({
    entryPoint: join(remotionDir, "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  let browser = await openBrowser("chrome");

  async function rebundle(): Promise<void> {
    console.log("remotion ソースの変更を検知したので再バンドルします...");
    rmSync(webpackCacheDir, { recursive: true, force: true });
    serveUrl = await bundle({
      entryPoint: join(remotionDir, "index.ts"),
      publicDir: dir,
      symlinkPublicDir: true,
    });
    bundleMtime = remotionMaxMtimeMs(remotionDir);
  }

  async function handleFrames(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: ParsedFramesRequest;
    try {
      parsed = parseFramesServeBody(body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const currentMtime = remotionMaxMtimeMs(remotionDir);
    if (currentMtime > bundleMtime) await rebundle();

    // config・編集 JSON は毎リクエスト読み直す(論点2-B。デーモンが暖めるのは
    // bundle+browser だけ=単発実行と出る絵は同一)
    const cfg = loadConfig(explicitConfigPath);
    const warm: WarmAssets = { serveUrl, browser };
    let shots: FrameShot[];
    try {
      shots = await renderFrames(dir, parsed.req, cfg, parsed.opts, warm);
    } catch (e) {
      // browser クラッシュ等を疑い、1回だけ作り直してリトライ(恒常化はしない)
      console.warn(`レンダーに失敗したため browser を作り直して1回だけ再試行します: ${(e as Error).message}`);
      try {
        await browser.close({ silent: true });
      } catch {
        // 既に落ちている browser の close は失敗しても無視
      }
      browser = await openBrowser("chrome");
      shots = await renderFrames(dir, parsed.req, cfg, parsed.opts, { serveUrl, browser });
    }
    sendJson(res, 200, { shots });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: err.message });
    });
  });
  // frames のレンダーは proxy 生成・複数枚撮影で数十秒かかることがあるので、
  // Node 既定の requestTimeout(5分)で切れないよう無効化(editor と同じ判断)
  server.requestTimeout = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!LOCAL_HOST.test(req.headers.host ?? "")) {
      sendJson(res, 403, { error: `forbidden host: ${req.headers.host ?? "(none)"}` });
      return;
    }
    if (
      req.method !== "GET" &&
      req.headers.origin !== undefined &&
      !LOCAL_HOST.test(req.headers.origin)
    ) {
      sendJson(res, 403, { error: `forbidden origin: ${req.headers.origin}` });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ping") {
      sendJson(res, 200, { ok: true, pid: process.pid });
      return;
    }
    if (req.method === "POST" && url.pathname === "/frames") {
      await handleFrames(req, res);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }

  await new Promise<void>((ok, ng) => {
    server.once("error", ng);
    server.listen(port, "127.0.0.1", ok);
  });

  const framesDir = join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const portFilePath = join(framesDir, SERVE_PORT_FILE);
  const portFile: ServePortFile = { port, pid: process.pid };
  writeFileSync(portFilePath, JSON.stringify(portFile, null, 2));

  console.log(`frames-serve 起動: 127.0.0.1:${port}(対象: ${dir})`);
  console.log("frames <dir> --t ... 等がこのデーモンを自動検出して使います。終了は Ctrl+C");

  // 終了時の portfile 削除。@remotion/renderer の openBrowser は SIGINT で
  // browser を kill して process.exit(130) を同期的に呼ぶ独自リスナーを
  // 登録済み(このリスナーが先に登録されているため先に発火し、process.exit は
  // 後続リスナーの実行を止めるので、SIGINT に自前ハンドラを足しても届かない)。
  // "exit" イベントはどの経路(SIGINT/SIGTERM/例外)で終了しても最終段で必ず
  // 発火するので、ここで同期的に portfile を消す(async 処理は exit 中は
  // 走らないため rmSync のみ)。SIGTERM は remotion 側が browser を kill する
  // だけでプロセスは終了させない(closeProcess が exit を呼ばない)ので、
  // デーモンとして確実に終了するよう明示的に exit する
  process.on("exit", () => {
    if (existsSync(portFilePath)) rmSync(portFilePath, { force: true });
  });
  process.on("SIGTERM", () => process.exit(0));
}
