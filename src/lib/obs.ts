import { basename } from "node:path";

/** ログの詳細度。quiet=ほぼ無音 / normal=AI+ステージ(既定) /
 *  verbose=外部ツール(ffmpeg/whisper/remotion)まで1行ずつ */
export type LogLevel = "quiet" | "normal" | "verbose";

export type LogKind = "ai" | "tool" | "stage";

export interface ToolEvent {
  kind: LogKind;
  /** tool basename / ステージ名。ai のときは未使用(detail が全文) */
  label: string;
  /** 引数ヒント / route+model / マイルストーン。ai のときは "AI: purpose=..." 全文 */
  detail?: string;
  /** 経過ミリ秒。あれば "(1.8秒)" として末尾に付く */
  durationMs?: number;
}

const GLYPH: Record<LogKind, string> = { ai: "✦", tool: "⚙", stage: "▸" };
// ANSI(色は TTY かつ NO_COLOR 未設定のときだけ emit 側が color:true を渡す)
const COLOR: Record<LogKind, string> = { ai: "\x1b[36m", tool: "\x1b[90m", stage: "\x1b[35m" };
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const LABEL_WIDTH = 8;

function fmtDur(ms: number): string {
  return `(${(ms / 1000).toFixed(1)}秒)`;
}

/** 純関数:副作用なし・env/tty を見ない(color は呼び出し側が決めて渡す)。
 *  単体テスト対象。末尾改行は付けない(emit 側で付ける) */
export function formatToolEvent(ev: ToolEvent, opts: { color: boolean } = { color: false }): string {
  const glyph = opts.color ? `${COLOR[ev.kind]}${GLYPH[ev.kind]}${RESET}` : GLYPH[ev.kind];
  if (ev.kind === "ai") {
    // detail は "AI: purpose=..." 全文。文字列は改変しない(grep 互換)
    return `${glyph} ${ev.detail ?? ""}`.trimEnd();
  }
  const label = ev.label.padEnd(LABEL_WIDTH);
  const detail = ev.detail ? ` ${ev.detail}` : "";
  const durRaw = ev.durationMs !== undefined ? ` ${fmtDur(ev.durationMs)}` : "";
  const dur = ev.durationMs !== undefined && opts.color ? ` ${DIM}${fmtDur(ev.durationMs)}${RESET}` : durRaw;
  return `${glyph} ${label}${detail}${dur}`.trimEnd();
}

/** どの kind をこのレベルで出すか。純関数・テスト対象。
 *  quiet=何も出さない / normal=ai・stage / verbose=全 kind(tool を追加) */
export function shouldEmitAt(level: LogLevel, kind: LogKind): boolean {
  if (level === "quiet") return false;
  if (kind === "tool") return level === "verbose";
  return true; // ai / stage は normal 以上で出す
}

// --- 実行時のシングルトン(cli.ts が設定、run/client が参照) ---
let currentLevel: LogLevel = "normal";
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function useColor(): boolean {
  return process.stderr.isTTY === true && !process.env.NO_COLOR;
}

/** ゲートを見て stderr に1行書く。stdout には絶対に書かない */
export function emitEvent(ev: ToolEvent): void {
  if (!shouldEmitAt(currentLevel, ev.kind)) return;
  process.stderr.write(formatToolEvent(ev, { color: useColor() }) + "\n");
}

/** run() 用。無効時は basename/detail の計算前に即 return(hot loop で安価)。
 *  cmd/args から label(既定 basename(cmd))と detail(最初の非フラグ引数)を導く */
export function emitToolEvent(cmd: string, args: string[], label: string | undefined, durationMs: number): void {
  if (!shouldEmitAt(currentLevel, "tool")) return; // ← ゲートを最初に。安価
  const lbl = label ?? basename(cmd);
  const detail = label ? undefined : firstMeaningfulArg(args);
  emitEvent({ kind: "tool", label: lbl, detail, durationMs });
}

/** args からファイル名らしいトークン(パス区切り "/" を含む、または拡張子付き)を
 *  1つ選んで basename を返す純関数。フラグ値("-v error" の "error")・数値・
 *  コーデック名を detail に拾わないよう、ファイルらしさを条件にする。
 *  該当が無ければ undefined(detail なし=無意味な値を出さない) */
export function firstMeaningfulArg(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith("-")) continue;
    if (a.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(a)) return basename(a);
  }
  return undefined;
}

export function logAi(summary: string): void {
  emitEvent({ kind: "ai", label: "AI", detail: summary });
}

export function logStage(label: string, detail?: string, durationMs?: number): void {
  emitEvent({ kind: "stage", label, detail, durationMs });
}
