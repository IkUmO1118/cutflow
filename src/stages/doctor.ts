import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../lib/exec.ts";
import { resolveVideoEncoder } from "../lib/videoEncode.ts";
import { aiDoctor } from "./aiDoctor.ts";
import type { AiDoctorResult } from "./aiDoctor.ts";
import { DEFAULT_OBS_WEBSOCKET_HOST, DEFAULT_OBS_WEBSOCKET_PORT, type Config } from "../lib/config.ts";
import { ensureCursorHelperBinary } from "../lib/cursorHelperBinary.ts";
import { isAccessibilityTrusted } from "../lib/displayList.ts";
import { connectObsWebSocket, type ObsWebSocketClient } from "../lib/obsWebsocket.ts";
import { resolveTargetDisplay } from "./record.ts";

/** Node の最低要件(型ストリッピング既定化のフロア)。A3 の bin シムと同じ値。 */
export const MIN_NODE = { major: 23, minor: 6 } as const;

export interface EnvCheck {
  name: string; // "node" | "ffmpeg" | …
  status: "ok" | "warn" | "error" | "skip";
  required: boolean; // true の error だけが exit 1 を導く
  detail: string;
}

export interface DoctorReport {
  ok: boolean; // 必須 error が 0 件か
  exitCode: 0 | 1;
  node: string; // 例 "v23.6.0"
  platform: NodeJS.Platform; // process.platform
  checks: EnvCheck[];
  ai: AiDoctorResult[] | { skipped: string };
}

export interface DoctorOptions {
  cfg?: Config; // loadConfig が成功したときだけ渡す
  cfgError?: string; // loadConfig が投げたメッセージ(config 破損時)
  ai?: boolean; // 既定 true。false で AI 到達性プローブをスキップ
}

/** ffmpeg/ffprobe/whisper の起動可否を探る。ENOENT(コマンドが見つからない)は
 * run() が例外を投げるので、それを「欠落」として扱う。それ以外の非ゼロ終了は
 * allowFailure で吸収する(--version/--help が非ゼロを返す実装があるため)。 */
async function probe(cmd: string, args: string[]): Promise<{ found: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { allowFailure: true });
    const firstLine = (stdout || stderr).split("\n")[0]?.trim() ?? "";
    return { found: true, detail: firstLine };
  } catch {
    return { found: false, detail: "" };
  }
}

function parseNodeVersion(v: string): { major: number; minor: number } {
  const [major, minor] = v.replace(/^v/, "").split(".").map(Number);
  return { major: major ?? 0, minor: minor ?? 0 };
}

/** .env から OBS_WEBSOCKET_PASSWORD 等を読む(src/lib/ai/client.ts の
 * loadRepoEnv と同じ流儀。モジュールごとにこの小さなヘルパーを複製するのが
 * このリポジトリの既存の慣行) */
function loadRepoEnv(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  process.loadEnvFile?.(join(repoRoot, ".env"));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} がタイムアウトしました(${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** record.obsWebsocket 設定から接続を試みる(未設定でも既定値で接続を試す) */
async function tryConnectObs(cfg: Config): Promise<ObsWebSocketClient> {
  const host = cfg.record?.obsWebsocket?.host ?? DEFAULT_OBS_WEBSOCKET_HOST;
  const port = cfg.record?.obsWebsocket?.port ?? DEFAULT_OBS_WEBSOCKET_PORT;
  const passwordEnv = cfg.record?.obsWebsocket?.passwordEnv;
  if (passwordEnv) loadRepoEnv();
  const password = passwordEnv ? process.env[passwordEnv] : undefined;
  return withTimeout(connectObsWebSocket({ host, port, password }), 3000, "obs-websocket 接続");
}

export async function envDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: EnvCheck[] = [];
  const nodeVersion = process.versions.node;

  // node
  {
    const { major, minor } = parseNodeVersion(nodeVersion);
    const okNode = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
    checks.push({
      name: "node",
      status: okNode ? "ok" : "error",
      required: true,
      detail: `v${nodeVersion} (>= ${MIN_NODE.major}.${MIN_NODE.minor})`,
    });
  }

  // ffmpeg
  {
    const { found, detail } = await probe("ffmpeg", ["-hide_banner", "-version"]);
    checks.push({
      name: "ffmpeg",
      status: found ? "ok" : "error",
      required: true,
      detail: found ? detail : "'ffmpeg' がPATHに見つかりません",
    });
  }

  // ffprobe
  {
    const { found, detail } = await probe("ffprobe", ["-hide_banner", "-version"]);
    checks.push({
      name: "ffprobe",
      status: found ? "ok" : "error",
      required: true,
      detail: found ? detail : "'ffprobe' がPATHに見つかりません",
    });
  }

  // config
  checks.push({
    name: "config",
    status: opts.cfgError ? "error" : "ok",
    required: true,
    detail: opts.cfgError ? opts.cfgError : "loaded",
  });

  // encoder(有効エンコーダの整合)
  {
    if (!opts.cfg) {
      checks.push({ name: "encoder", status: "skip", required: false, detail: "config 未ロード" });
    } else {
      const effective = resolveVideoEncoder(opts.cfg);
      const codecName = effective === "libx264" ? "libx264" : "h264_videotoolbox";
      let encodersOut: string | null = null;
      try {
        const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"], { allowFailure: true });
        encodersOut = stdout;
      } catch {
        encodersOut = null;
      }
      if (encodersOut === null) {
        checks.push({ name: "encoder", status: "skip", required: false, detail: "ffmpeg が見つからず検査不可" });
      } else {
        const present = encodersOut.includes(codecName);
        checks.push({
          name: "encoder",
          status: present ? "ok" : "warn",
          required: false,
          detail: present
            ? `${codecName} present (effective on ${process.platform})`
            : `${codecName} が ffmpeg -encoders に見つかりません (effective on ${process.platform})`,
        });
      }
    }
  }

  // whisper.bin
  {
    if (!opts.cfg) {
      checks.push({ name: "whisper.bin", status: "skip", required: false, detail: "config 未ロード" });
    } else {
      const { found } = await probe(opts.cfg.whisper.bin, ["--help"]);
      checks.push({
        name: "whisper.bin",
        status: found ? "ok" : "warn",
        required: false,
        detail: found ? `起動可: ${opts.cfg.whisper.bin}` : `'${opts.cfg.whisper.bin}' がPATHに見つかりません`,
      });
    }
  }

  // whisper.model
  {
    if (!opts.cfg) {
      checks.push({ name: "whisper.model", status: "skip", required: false, detail: "config 未ロード" });
    } else {
      const present = existsSync(opts.cfg.whisper.model);
      checks.push({
        name: "whisper.model",
        status: present ? "ok" : "warn",
        required: false,
        detail: present ? opts.cfg.whisper.model : `不在: ${opts.cfg.whisper.model}`,
      });
    }
  }

  // cursor-helper(D9。record --watch が使う vendor バイナリのビルド可否)
  {
    if (process.platform !== "darwin") {
      checks.push({ name: "cursor-helper", status: "skip", required: false, detail: "macOS 専用" });
    } else {
      try {
        const binPath = await ensureCursorHelperBinary();
        checks.push({ name: "cursor-helper", status: "ok", required: false, detail: `ビルド済み: ${binPath}` });
      } catch (e) {
        checks.push({
          name: "cursor-helper",
          status: "warn",
          required: false,
          detail: `ビルドできません: ${(e as Error).message}`,
        });
      }
    }
  }

  // obs-websocket(D9。record --watch の接続先の到達性)
  {
    if (!opts.cfg) {
      checks.push({ name: "obs-websocket", status: "skip", required: false, detail: "config 未ロード" });
    } else {
      try {
        const client = await tryConnectObs(opts.cfg);
        client.close();
        const host = opts.cfg.record?.obsWebsocket?.host ?? DEFAULT_OBS_WEBSOCKET_HOST;
        const port = opts.cfg.record?.obsWebsocket?.port ?? DEFAULT_OBS_WEBSOCKET_PORT;
        checks.push({ name: "obs-websocket", status: "ok", required: false, detail: `到達可能: ${host}:${port}` });
      } catch (e) {
        checks.push({
          name: "obs-websocket",
          status: "warn",
          required: false,
          detail: `到達不可(OBS が起動していない可能性): ${(e as Error).message}`,
        });
      }
    }
  }

  // accessibility(D9。位置は権限不要・形状/クリックだけがこの許可に依存するため未許可は warn)
  {
    if (process.platform !== "darwin") {
      checks.push({ name: "accessibility", status: "skip", required: false, detail: "macOS 専用" });
    } else {
      try {
        const trusted = await isAccessibilityTrusted();
        checks.push({
          name: "accessibility",
          status: trusted ? "ok" : "warn",
          required: false,
          detail: trusted
            ? "許可済み(カーソル形状/クリックも取得できます)"
            : "未許可(カーソル位置は取得できますが形状/クリックは取れません。" +
              "システム設定 > プライバシーとセキュリティ > アクセシビリティ)",
        });
      } catch (e) {
        checks.push({ name: "accessibility", status: "warn", required: false, detail: (e as Error).message });
      }
    }
  }

  // capture-display(D9。D4 の対象ディスプレイ自動一致を録画無しで可視化する)
  {
    if (!opts.cfg) {
      checks.push({ name: "capture-display", status: "skip", required: false, detail: "config 未ロード" });
    } else if (process.platform !== "darwin") {
      checks.push({ name: "capture-display", status: "skip", required: false, detail: "macOS 専用" });
    } else {
      let client: ObsWebSocketClient | undefined;
      try {
        client = await tryConnectObs(opts.cfg);
        const resolution = await resolveTargetDisplay(client, undefined);
        checks.push({
          name: "capture-display",
          status: resolution.displayId !== null ? "ok" : "warn",
          required: false,
          detail:
            resolution.displayId !== null
              ? `解決済み: id=${resolution.displayId}(${resolution.resolvedBy})`
              : "録画開始前には解決できません(録画中のテレメトリ推論に委ねられます。" +
                "record --watch --display <id> での明示指定も可)",
        });
      } catch (e) {
        checks.push({
          name: "capture-display",
          status: "skip",
          required: false,
          detail: `obs-websocket 未到達のため検査不可: ${(e as Error).message}`,
        });
      } finally {
        client?.close();
      }
    }
  }

  // AI 到達性
  let ai: AiDoctorResult[] | { skipped: string };
  if (opts.ai === false) {
    ai = { skipped: "--no-ai" };
  } else if (!opts.cfg) {
    ai = { skipped: "config 未ロード" };
  } else {
    try {
      ai = await aiDoctor(opts.cfg);
    } catch (e) {
      ai = { skipped: (e as Error).message };
    }
  }

  const exitCode: 0 | 1 = checks.some((c) => c.required && c.status === "error") ? 1 : 0;
  return {
    ok: exitCode === 0,
    exitCode,
    node: `v${nodeVersion}`,
    platform: process.platform,
    checks,
    ai,
  };
}

const STATUS_RANK: Record<"ok" | "warn" | "error" | "skip", number> = {
  skip: 0,
  ok: 1,
  warn: 2,
  error: 3,
};

/** AI profile 1件の text/structured/image のうち最も悪い status を代表値にする
 * (doctor の exit code には寄与しない。表示上のまとめ判定専用)。 */
function worstAiStatus(item: AiDoctorResult): "ok" | "warn" | "error" | "skip" {
  return [item.checks.text.status, item.checks.structured.status, item.checks.image.status].reduce(
    (worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst),
    "skip" as "ok" | "warn" | "error" | "skip",
  );
}

/** 人間可読テーブル(タブ区切り。cli.ts が console.log で流す) */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  lines.push("CHECK\tSTATUS\tREQUIRED\tDETAIL");
  for (const c of report.checks) {
    lines.push(`${c.name}\t${c.status}\t${c.required ? "yes" : "no"}\t${c.detail}`);
  }
  if (Array.isArray(report.ai)) {
    for (const item of report.ai) {
      lines.push(
        `ai:${item.profile}\t${worstAiStatus(item)}\tno\t` +
          `text=${item.checks.text.status} structured=${item.checks.structured.status} image=${item.checks.image.status}`,
      );
    }
  } else {
    lines.push(`ai\tskip\tno\t${report.ai.skipped}`);
  }
  lines.push("—");
  const requiredErrors = report.checks.filter((c) => c.required && c.status === "error").length;
  const warnCount =
    report.checks.filter((c) => c.status === "warn").length +
    (Array.isArray(report.ai)
      ? report.ai.filter((item) => worstAiStatus(item) === "warn" || worstAiStatus(item) === "error").length
      : 0);
  if (requiredErrors > 0) {
    lines.push(`✖ 必須チェック ${requiredErrors}件が失敗(exit 1)`);
  } else {
    lines.push(`✔ 必須チェックはすべて通過(warn ${warnCount}件。exit 0)`);
  }
  return lines;
}
