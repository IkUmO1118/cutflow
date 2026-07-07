// JSON-RPC 2.0 の最小フレーミング&ディスパッチ(純関数・I/O なし)。
// docs/plans/2026-07-07-mcp-server-design.md §論点1。
//
// stdio transport が実際に要求するのは「改行区切り UTF-8 JSON、1メッセージ
// 1行」だけ。ここではその1行ぶんの変換(parseLine/serializeMessage)と、
// パース済みメッセージ+メソッドハンドラ表からレスポンスを組む dispatch を
// 提供する。実際の stdin 行分割・stdout 書き込みは server.ts(I/O 層)の責務。

import { JsonRpcError } from "./types.ts";
import type {
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcResponse,
  MethodHandler,
} from "./types.ts";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON-RPC の id として有効か(仕様: string | number | null)。
 * オブジェクト/配列/真偽値は無効=Invalid Request にする */
function isValidId(v: unknown): v is string | number | null {
  return typeof v === "string" || typeof v === "number" || v === null;
}

function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * 1行(改行を含まない文字列)を JSON-RPC メッセージへパースする。
 * - JSON として読めない → `{ error }`(-32700 parse error)
 * - `jsonrpc: "2.0"` かつ `method` が string、という最低限の形を満たさない
 *   → `{ error }`(-32600 invalid request。id が読み取れればそれを付す)
 * - `id` があれば request、無ければ notification として `{ message }` を返す
 */
export function parseLine(
  line: string,
): { message: JsonRpcMessage } | { error: JsonRpcErrorResponse } {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { error: makeError(null, -32700, "Parse error") };
  }
  // エラー応答にエコーする id は「有効な id が付いていればそれ、無ければ null」。
  // 不正な id(オブジェクト等)は echo せず null にする(仕様準拠)
  const echoId = isObj(json) && isValidId(json.id) ? json.id : null;
  if (!isObj(json) || json.jsonrpc !== "2.0" || typeof json.method !== "string") {
    return { error: makeError(echoId, -32600, "Invalid Request") };
  }
  const { method, params } = json as { method: string; params?: unknown };
  if ("id" in json) {
    // id キーはあるが型が不正(オブジェクト/配列/真偽値)→ Invalid Request
    if (!isValidId(json.id)) {
      return { error: makeError(null, -32600, "Invalid Request: id must be a string, number, or null") };
    }
    return { message: { jsonrpc: "2.0", id: json.id, method, params } };
  }
  return { message: { jsonrpc: "2.0", method, params } };
}

/**
 * response(または error response)を1行の文字列へ直列化する。
 * `JSON.stringify`(pretty 無し)は文字列内の実改行を `\n` の2文字へ
 * エスケープするため、content に改行入りの全文(テロップ・概要欄等)が
 * 入っていても常に単一行を生む(埋め込み改行が出ないことの保証)。
 */
export function serializeMessage(message: JsonRpcResponse): string {
  return JSON.stringify(message);
}

/**
 * 1メッセージをディスパッチする。
 * - notification(id 無し)は handler を実行はするが**必ず null を返す**
 *   (処理に失敗しても応答しない=通知には応答が無いという JSON-RPC の規約)
 * - request で該当メソッドが無ければ -32601(method not found)
 * - handler が `JsonRpcError` を投げればその code/message/data をそのまま
 *   使う。それ以外の例外は -32603(internal error)に丸める
 */
export async function dispatch(
  message: JsonRpcMessage,
  handlers: Map<string, MethodHandler>,
): Promise<JsonRpcResponse | null> {
  const handler = handlers.get(message.method);

  if (!("id" in message)) {
    // notification: 実行はするが応答は返さない(失敗も黙って握りつぶす)
    if (handler !== undefined) {
      try {
        await handler(message.params);
      } catch {
        /* notification は失敗しても応答しない */
      }
    }
    return null;
  }

  const { id } = message;
  if (handler === undefined) {
    return makeError(id, -32601, `Method not found: ${message.method}`);
  }
  try {
    const result = await handler(message.params);
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    if (e instanceof JsonRpcError) {
      return makeError(id, e.code, e.message, e.data);
    }
    return makeError(id, -32603, e instanceof Error ? e.message : "Internal error");
  }
}
