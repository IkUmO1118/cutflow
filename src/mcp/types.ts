// JSON-RPC 2.0 のメッセージ型(純・fs/プロセス非依存)。
// docs/plans/2026-07-07-mcp-server-design.md §論点1。
//
// ここでは stdio transport が実際に使う最小の形だけを定義する:
// request(id あり)/ notification(id なし)/ response(成功 result または
// error)。ToolDef/ToolResult(MCP tool レジストリの型)は T2(src/mcp/protocol.ts
// 導入時)にここへ追記する。

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** サーバが受信するメッセージ(サーバはリクエストを発行しない=受信専用) */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * dispatch(jsonrpc.ts)に登録する1メソッドぶんのハンドラ。async 可
 * (tools/call が内部で frames/materials/assert 等 Promise を返す tool
 * handler を await するため)。
 */
export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * handler が「-32603(internal error)以外の特定の JSON-RPC エラーコード」を
 * 明示したいときに throw する専用エラー型。dispatch はこれを見つけたら
 * その code/message/data をそのまま使い、それ以外の例外は -32603 に丸める
 * (例: protocol.ts の tools/call が「未知 tool name」を -32602 として返す)。
 */
export class JsonRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}
