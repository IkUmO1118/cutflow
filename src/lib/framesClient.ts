// frames CLI 用の常駐デーモン検出+クライアント(課題2 タスク B3)。
// frames-serve が書く frames/.serve.json(port・pid)を見つけたら ping で
// 生存確認し、生きていれば POST /frames で撮影を委譲する。portfile が無い/
// 応答しない場合は null を返すだけで、呼び出し側(cli.ts)が従来の単発
// frames(...) にフォールバックする。
//
// opt-in の担保: portfile が無いときは existsSync 1回だけの追加コストで
// 即 null を返す(ネットワークには一切触れない)。frames-serve を一度も
// 起動していない収録では frames の挙動・出力が現状と完全に不変であること。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVE_PORT_FILE } from "../stages/framesServe.ts";
import type { ServePortFile } from "../stages/framesServe.ts";
import type { FrameRequest, FrameShot } from "../stages/frames.ts";

/** frames/.serve.json を読む(無い/壊れていれば null) */
export function readServePortFile(dir: string): ServePortFile | null {
  const p = join(dir, "frames", SERVE_PORT_FILE);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as Partial<ServePortFile>;
    if (typeof data.port !== "number" || typeof data.pid !== "number") return null;
    return { port: data.port, pid: data.pid };
  } catch {
    return null;
  }
}

/** FrameRequest + 撮影オプションを POST /frames の body(framesServe.ts の
 * parseFramesServeBody が読む形)へ変換する */
export function toServeRequestBody(
  req: FrameRequest,
  opts: { short?: string; ocr?: boolean; fullRes?: boolean },
): Record<string, unknown> {
  return {
    ...req,
    short: opts.short ?? null,
    ocr: opts.ocr ?? false,
    fullRes: opts.fullRes ?? false,
  };
}

/** ping のタイムアウト(ms)。デーモンが死にかけ/portfile だけ残っている
 * ケースで frames コマンド自体を長く待たせないための歯止め */
const PING_TIMEOUT_MS = 500;

async function pingAlive(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * portfile があり ping に応答する常駐デーモンがあれば、そこへ撮影を委譲して
 * FrameShot[] を返す。portfile が無い、または応答しない(既に落ちている等)
 * ときは null を返す(呼び出し側は現行の単発 frames(...) にフォールバックする)
 */
export async function tryServeFrames(
  dir: string,
  req: FrameRequest,
  opts: { short?: string; ocr?: boolean; fullRes?: boolean },
): Promise<FrameShot[] | null> {
  const portFile = readServePortFile(dir);
  if (!portFile) return null;
  if (!(await pingAlive(portFile.port))) return null;
  const res = await fetch(`http://127.0.0.1:${portFile.port}/frames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toServeRequestBody(req, opts)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`frames-serve がエラーを返しました(${res.status}): ${body}`);
  }
  const { shots } = (await res.json()) as { shots: FrameShot[] };
  return shots;
}
