import { existsSync } from "node:fs";
import { run } from "../lib/exec.ts";
import { resolveVideoEncoder } from "../lib/videoEncode.ts";
import { aiDoctor } from "./aiDoctor.ts";
import type { AiDoctorResult } from "./aiDoctor.ts";
import type { Config } from "../lib/config.ts";

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
