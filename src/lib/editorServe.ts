// GUI エディタの常駐(デタッチ)状態。`editor <dir> --detach` / `--stop` /
// `--status` が読み書きする portfile と、その生存確認。
//
// frames-serve(frames/.serve.json)と同じ portfile 方式だが、置き場所が違う:
// こちらは収録フォルダの**外**(~/.cutflow/editor/)に書く。理由は2つ。
//   1. 収録フォルダ内のファイルは files.ts の分類(編集ファイル / 中間生成物 /
//      承認レコード)のどれかに属さねばならないが、「起動中のサーバの pid」は
//      そのどれでもない(プロジェクトの成果ではなく実行時の状態)
//   2. `clean <dir>` は中間生成物を消す。portfile がそこにあると、起動中の
//      エディタの portfile を clean が消して stop できなくなる
// ログ(デタッチしたサーバの stdout/stderr)も同じ理由で同じ場所へ置く。
//
// 収録フォルダごとに1つ(slug = 実パスの sha256 先頭12桁)。同じ dir を二重に
// デタッチ起動することは検出して拒否する。

import { cliCmd } from "./cliName.ts";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** portfile / ログの置き場(収録フォルダの外) */
export function editorStateDir(): string {
  return join(homedir(), ".cutflow", "editor");
}

/** 収録フォルダのパスから状態ファイル名の slug を作る(実パス基準) */
export function slugForDir(dir: string): string {
  return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 12);
}

export function editorPortFilePath(dir: string): string {
  return join(editorStateDir(), `${slugForDir(dir)}.json`);
}

export function editorLogFilePath(dir: string): string {
  return join(editorStateDir(), `${slugForDir(dir)}.log`);
}

/** ~/.cutflow/editor/<slug>.json の中身 */
export interface EditorServeFile {
  /** 対象の収録フォルダ(絶対パス)。slug 衝突・取り違えの検出に使う */
  dir: string;
  port: number;
  pid: number;
  /** ISO8601。status の表示用 */
  startedAt: string;
}

/** 壊れた/欠けたフィールドがあれば null(portfile は常に「あるか無いか」で扱う) */
export function parseEditorServeFile(text: string): EditorServeFile | null {
  try {
    const data = JSON.parse(text) as Partial<EditorServeFile>;
    if (typeof data.dir !== "string") return null;
    if (typeof data.port !== "number" || typeof data.pid !== "number") return null;
    if (typeof data.startedAt !== "string") return null;
    return { dir: data.dir, port: data.port, pid: data.pid, startedAt: data.startedAt };
  } catch {
    return null;
  }
}

export function readEditorServeFile(dir: string): EditorServeFile | null {
  const p = editorPortFilePath(dir);
  if (!existsSync(p)) return null;
  return parseEditorServeFile(readFileSync(p, "utf8"));
}

/** サーバ(editor/server.ts)が listen 直後に呼ぶ。デタッチでもフォアグラウンド
 * でも書く(= --status はどちらの起動でも見える) */
export function writeEditorServeFile(entry: EditorServeFile): void {
  mkdirSync(editorStateDir(), { recursive: true });
  writeFileSync(editorPortFilePath(entry.dir), JSON.stringify(entry, null, 2));
}

export function removeEditorServeFile(dir: string): void {
  const p = editorPortFilePath(dir);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** ping のタイムアウト(ms)。死にかけ/portfile だけ残っているケースで
 * stop/status を長く待たせないための歯止め(framesClient と同じ判断) */
const PING_TIMEOUT_MS = 500;

export interface EditorPing {
  pid: number;
  dir: string;
}

/** GET /api/ping。応答が無い/形が違うときは null(= 生きていない) */
export async function pingEditor(port: number): Promise<EditorPing | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<EditorPing>;
    if (typeof data.pid !== "number" || typeof data.dir !== "string") return null;
    return { pid: data.pid, dir: data.dir };
  } catch {
    return null;
  }
}

/**
 * portfile があり、その port の /api/ping が同じ dir を名乗るなら、その entry を返す。
 *
 * portfile が残っているのに応答が無い(SIGKILL 等で exit フックが走らなかった)
 * ときは stale とみなして portfile を消し、null を返す。したがって呼び出し側は
 * 「null なら起動していない」とだけ考えればよい。
 */
export async function liveEditor(dir: string): Promise<EditorServeFile | null> {
  const entry = readEditorServeFile(dir);
  if (!entry) return null;
  const ping = await pingEditor(entry.port);
  if (!ping || resolve(ping.dir) !== resolve(dir)) {
    removeEditorServeFile(dir);
    return null;
  }
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

/** 起動待ちの上限(ms)。esbuild のバンドルを挟むので数秒かかることがある */
const START_TIMEOUT_MS = 30_000;
/** SIGTERM 後、諦めて SIGKILL するまでの上限(ms) */
const STOP_TIMEOUT_MS = 5_000;

/** 起動失敗時にログの末尾を添えて原因(ポート使用中など)を見せる */
function logTail(dir: string, lines: number): string {
  const p = editorLogFilePath(dir);
  if (!existsSync(p)) return "(ログなし)";
  const all = readFileSync(p, "utf8").trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

/**
 * エディタをバックグラウンド(デタッチ)で起動する。
 *
 * 自分自身(src/cli.ts)を `editor <dir>` で子プロセスとして起動し、stdout/stderr
 * を ~/.cutflow/editor/<slug>.log へ流して親は抜ける。portfile はサーバ自身が
 * listen 直後に書くので、親は「portfile が現れて ping が通る」まで待つだけ
 * (親が書くと、子が起動に失敗しても portfile が残る)。
 */
export async function startDetachedEditor(
  dir: string,
  opts: { layout?: string; configPath?: string },
): Promise<EditorServeFile> {
  const running = await liveEditor(dir);
  if (running) {
    throw new Error(
      `エディタは既に起動しています(http://127.0.0.1:${running.port} pid=${running.pid})。`
        + ` 止めるには: ${cliCmd()} editor ${dir} --stop`,
    );
  }
  mkdirSync(editorStateDir(), { recursive: true });
  const logPath = editorLogFilePath(dir);
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  // --config は program レベルのオプションなのでサブコマンドより前に置く
  const args = [
    cliPath,
    ...(opts.configPath ? ["--config", opts.configPath] : []),
    "editor",
    dir,
    ...(opts.layout ? ["--layout", opts.layout] : []),
  ];
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally {
    closeSync(fd);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const entry = await liveEditor(dir);
    if (entry) return entry;
  }
  throw new Error(
    `エディタの起動を ${START_TIMEOUT_MS / 1000} 秒待ちましたが応答しません。`
      + `ログ(${logPath})の末尾:\n${logTail(dir, 10)}`,
  );
}

/**
 * デタッチ起動中のエディタを止める。起動していなければ null(冪等)。
 * SIGTERM → ping が落ちるまで待つ → 期限切れなら SIGKILL + portfile 掃除。
 */
export async function stopEditor(dir: string): Promise<EditorServeFile | null> {
  const entry = await liveEditor(dir);
  if (!entry) return null;
  try {
    process.kill(entry.pid, "SIGTERM");
  } catch {
    // 既に居ない(portfile だけ残っていた)。下の掃除に任せる
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!(await pingEditor(entry.port))) {
      removeEditorServeFile(dir);
      return entry;
    }
  }
  try {
    process.kill(entry.pid, "SIGKILL");
  } catch {
    // 既に居ない
  }
  removeEditorServeFile(dir);
  return entry;
}
