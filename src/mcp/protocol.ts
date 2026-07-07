// MCP メソッド(initialize / tools/list / tools/call / ping)の result を、
// tool レジストリ(ToolDef[])を引数に組む純ロジック(fs/プロセス非依存)。
// docs/plans/2026-07-07-mcp-server-design.md §論点1・§論点5。
//
// jsonrpc.ts の dispatch() が要求する `Map<string, MethodHandler>` を
// buildMcpHandlers(tools) で組み立てる。「1コマンド=1 tool を後から足す」
// 拡張は tools.ts(makeTools)側に閉じ、ここは不変。

import { JsonRpcError } from "./types.ts";
import type { MethodHandler, ToolDef, ToolResult } from "./types.ts";

/**
 * MCP のプロトコルリビジョン文字列。仕様改訂時はここだけ更新すればよい
 * (§design doc 論点1 の緩和策 a)。package.json の "version" とは独立の値。
 */
export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "cutflow";
export const SERVER_VERSION = "0.1.0";

export interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

/** `initialize` の result。client の protocolVersion は見ない(単一の
 * サーバ対応版を返すだけの MVP。将来複数版対応する場合はここに分岐を足す) */
export function handleInitialize(): InitializeResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: ToolDef["inputSchema"];
}

/** `tools/list` の result。handler は公開しない(discovery 用の形だけ) */
export function handleToolsList(tools: ToolDef[]): { tools: ToolListing[] } {
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `tools/call` の result。params から `{ name, arguments? }` を読み、
 * レジストリ(name→ToolDef の Map)から引いて `handler(arguments)` を呼ぶ。
 * tool の `isError` セマンティクスはそのまま透過する(dispatch はこの
 * ToolResult を `result` フィールドへそのまま入れる=ドメイン層の失敗は
 * JSON-RPC error にしない、§design doc 論点4)。
 *
 * params の形が不正、または name がレジストリに無い場合は
 * `JsonRpcError(-32602)` を投げる(dispatch が拾って invalid params 応答に
 * 変換する)。approve/render 等はそもそもレジストリに存在しないので、
 * この経路で呼ぼうとしても常にここへ落ちる(§design doc 論点6)。
 */
export async function handleToolsCall(
  toolsByName: Map<string, ToolDef>,
  params: unknown,
): Promise<ToolResult> {
  if (!isObj(params) || typeof params.name !== "string") {
    throw new JsonRpcError(-32602, "tools/call requires { name: string, arguments?: object }");
  }
  const tool = toolsByName.get(params.name);
  if (tool === undefined) {
    throw new JsonRpcError(-32602, `Unknown tool: ${params.name}`);
  }
  return await tool.handler(params.arguments);
}

/**
 * jsonrpc.ts の dispatch() へ渡す method→handler map を、tool レジストリを
 * closure 捕捉して組み立てる。扱うメソッドは4つ+ping
 * (§design doc 論点1 の表): initialize / notifications/initialized /
 * tools/list / tools/call / ping。
 */
export function buildMcpHandlers(tools: ToolDef[]): Map<string, MethodHandler> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  return new Map<string, MethodHandler>([
    ["initialize", () => handleInitialize()],
    ["notifications/initialized", () => undefined],
    ["tools/list", () => handleToolsList(tools)],
    ["tools/call", (params: unknown) => handleToolsCall(toolsByName, params)],
    ["ping", () => ({})],
  ]);
}
