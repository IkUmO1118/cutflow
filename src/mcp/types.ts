// JSON-RPC 2.0 のメッセージ型 + MCP tool レジストリの型(純・fs/プロセス
// 非依存)。docs/plans/2026-07-07-mcp-server-design.md §論点1・§論点5。
//
// ここでは stdio transport が実際に使う最小の形だけを定義する:
// request(id あり)/ notification(id なし)/ response(成功 result または
// error)。

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  // 仕様上 id は string | number | null(null も応答を返す有効なリクエスト)。
  // オブジェクト/配列/真偽値の id は parseLine が Invalid Request に落とす
  id: string | number | null;
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

/**
 * MCP tool の `inputSchema` はツール引数オブジェクトの discovery 用ヒントで
 * あり、cutflow の編集ファイルスキーマ(schemas/*.schema.json)そのものでは
 * ない(§design doc 論点2)。二重化せず、ここでは構造を固定しない緩い
 * JSON 値として扱う(`cutflow_apply` は schemas/apply-patch.schema.json を
 * そのまま差し込むだけ)。
 */
export type JsonSchema = Record<string, unknown>;

export interface ToolResultContent {
  type: "text";
  text: string;
}

/** `tools/call` の成功 result。`isError: true` はプロトコル異常ではなく
 * ドメイン層の失敗(validate エラー検出・apply 拒否 等)を表す
 * (§design doc 論点4)。 */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

/**
 * tool レジストリの1件。`makeTools(dir, cfg)`(src/mcp/tools.ts)が
 * dir/cfg を closure 捕捉した配列として組み立てる。handler は async 可
 * (frames/materials/assert が Promise を返すため)。
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: unknown) => ToolResult | Promise<ToolResult>;
}
