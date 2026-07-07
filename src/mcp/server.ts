// stdio ループ(唯一の副作用境界)。stdin を行分割 → jsonrpc.dispatch →
// stdout へ改行区切りで書く。ログ・診断は必ず stderr(stdout は JSON-RPC
// 専用チャネル。§design doc 論点1・§7)。SIGINT で終了。
// docs/plans/2026-07-07-mcp-server-design.md §7。

import { createInterface } from "node:readline";
import type { Config } from "../lib/config.ts";
import { dispatch, parseLine, serializeMessage } from "./jsonrpc.ts";
import { buildMcpHandlers } from "./protocol.ts";
import { makeTools } from "./tools.ts";
import type { MethodHandler } from "./types.ts";

/** 1行を処理し、応答があれば stdout へ書く(notification は null=無応答) */
async function handleLine(line: string, handlers: Map<string, MethodHandler>): Promise<void> {
  const parsed = parseLine(line);
  if ("error" in parsed) {
    process.stdout.write(serializeMessage(parsed.error) + "\n");
    return;
  }
  const response = await dispatch(parsed.message, handlers);
  if (response !== null) {
    process.stdout.write(serializeMessage(response) + "\n");
  }
}

/**
 * `mcp <dir>` の本体。dir/cfg で tool レジストリを組み立て、stdin を1行ずつ
 * 読んでディスパッチし続ける。プロセスは起動時に指定された1収録フォルダに
 * 束縛され(§design doc 論点3)、SIGINT(Ctrl+C)で終了する。
 */
export async function startMcpServer(dir: string, cfg: Config): Promise<void> {
  const tools = makeTools(dir, cfg);
  const handlers = buildMcpHandlers(tools);

  console.error(
    `cutflow mcp: listening on stdio (dir=${dir}, ${tools.length} tool(s) exposed). Ctrl+C to stop.`,
  );

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line.length === 0) return; // 空行(区切りの飾り)は無視
    // 1行の処理失敗が他行の処理を止めないよう、await せず投げっぱなしにする
    // (エラーは各 handler 内で JSON-RPC error に丸められる。ここで catch が
    // 必要になるのは parseLine/dispatch 自体が予期せず reject した場合のみ)
    handleLine(line, handlers).catch((e: unknown) => {
      console.error(`cutflow mcp: unexpected error handling a line: ${String(e)}`);
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
    process.once("SIGINT", () => {
      rl.close();
    });
  });
}
