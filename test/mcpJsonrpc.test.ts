// src/mcp/jsonrpc.ts — JSON-RPC 2.0 の最小フレーミング&ディスパッチを固定する。
// T1(docs/plans/2026-07-07-mcp-server-design.md §9)。純関数・I/O なし。
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, parseLine, serializeMessage } from "../src/mcp/jsonrpc.ts";
import { JsonRpcError } from "../src/mcp/types.ts";
import type { MethodHandler } from "../src/mcp/types.ts";

/* ---------------- parseLine ---------------- */

test("parseLine: 正常な request(id あり)をパースする", () => {
  const r = parseLine('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}');
  assert.ok("message" in r);
  if ("message" in r) {
    assert.equal(r.message.method, "ping");
    assert.deepEqual(r.message.params, {});
    assert.ok("id" in r.message);
    if ("id" in r.message) assert.equal(r.message.id, 1);
  }
});

test("parseLine: id の無い notification をパースする", () => {
  const r = parseLine('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.ok("message" in r);
  if ("message" in r) {
    assert.equal(r.message.method, "notifications/initialized");
    assert.ok(!("id" in r.message));
  }
});

test("parseLine: JSON として読めない行は -32700(parse error)", () => {
  const r = parseLine("not json{");
  assert.ok("error" in r);
  if ("error" in r) {
    assert.equal(r.error.error.code, -32700);
    assert.equal(r.error.id, null);
  }
});

test("parseLine: jsonrpc:2.0 でない/method が無いオブジェクトは -32600(invalid request)", () => {
  const r1 = parseLine('{"foo":"bar"}');
  assert.ok("error" in r1);
  if ("error" in r1) assert.equal(r1.error.error.code, -32600);

  const r2 = parseLine('{"jsonrpc":"2.0","id":5}'); // method 無し
  assert.ok("error" in r2);
  if ("error" in r2) {
    assert.equal(r2.error.error.code, -32600);
    // id が読み取れる場合はそれを invalid request の応答に付す
    assert.equal(r2.error.id, 5);
  }
});

test("parseLine: id が string/number/null 以外(オブジェクト/配列/真偽値)は -32600", () => {
  for (const bad of ['{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
                     '{"jsonrpc":"2.0","id":[1],"method":"ping"}',
                     '{"jsonrpc":"2.0","id":true,"method":"ping"}']) {
    const r = parseLine(bad);
    assert.ok("error" in r, `should reject: ${bad}`);
    if ("error" in r) {
      assert.equal(r.error.error.code, -32600);
      // 不正 id は echo しない(null)
      assert.equal(r.error.id, null);
    }
  }
});

test("parseLine: id:null は有効な request としてパースする(仕様: id は null も可)", () => {
  const r = parseLine('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  assert.ok("message" in r);
  if ("message" in r) {
    assert.ok("id" in r.message); // notification ではなく request
    if ("id" in r.message) assert.equal(r.message.id, null);
  }
});

/* ---------------- serializeMessage ---------------- */

test("serializeMessage: 常に単一行(埋め込み改行が出ない)", () => {
  const line = serializeMessage({
    jsonrpc: "2.0",
    id: 1,
    result: { text: "1行目\n2行目\nタブ\tも含む" },
  });
  assert.equal(line.includes("\n"), false);
  assert.equal(line.includes("\r"), false);
  // 直列化を戻せばエスケープが正しく復元されること
  const parsed = JSON.parse(line) as { result: { text: string } };
  assert.equal(parsed.result.text, "1行目\n2行目\nタブ\tも含む");
});

/* ---------------- dispatch ---------------- */

test("dispatch: request→response の id が一致する", async () => {
  const handlers = new Map<string, MethodHandler>([["echo", (p) => p]]);
  const res = await dispatch(
    { jsonrpc: "2.0", id: "abc", method: "echo", params: { x: 1 } },
    handlers,
  );
  assert.ok(res !== null);
  assert.equal(res!.id, "abc");
  assert.ok("result" in res!);
  if (res && "result" in res) assert.deepEqual(res.result, { x: 1 });
});

test("dispatch: 未知メソッドは -32601(method not found)", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "nope" }, new Map());
  assert.ok(res !== null);
  assert.ok("error" in res!);
  if (res && "error" in res) assert.equal(res.error.code, -32601);
});

test("dispatch: handler が通常の Error を投げたら -32603(internal error)", async () => {
  const handlers = new Map<string, MethodHandler>([
    [
      "boom",
      () => {
        throw new Error("kaboom");
      },
    ],
  ]);
  const res = await dispatch({ jsonrpc: "2.0", id: 2, method: "boom" }, handlers);
  assert.ok(res !== null);
  assert.ok("error" in res!);
  if (res && "error" in res) {
    assert.equal(res.error.code, -32603);
    assert.match(res.error.message, /kaboom/);
  }
});

test("dispatch: handler が JsonRpcError を投げたらその code を使う", async () => {
  const handlers = new Map<string, MethodHandler>([
    [
      "invalid",
      () => {
        throw new JsonRpcError(-32602, "bad params");
      },
    ],
  ]);
  const res = await dispatch({ jsonrpc: "2.0", id: 3, method: "invalid" }, handlers);
  assert.ok(res !== null);
  assert.ok("error" in res!);
  if (res && "error" in res) {
    assert.equal(res.error.code, -32602);
    assert.equal(res.error.message, "bad params");
  }
});

test("dispatch: notification(id 無し)は成功でも失敗でも常に null(無応答)", async () => {
  let called = false;
  const handlersOk = new Map<string, MethodHandler>([
    [
      "notify-ok",
      () => {
        called = true;
      },
    ],
  ]);
  const res1 = await dispatch({ jsonrpc: "2.0", method: "notify-ok" }, handlersOk);
  assert.equal(res1, null);
  assert.equal(called, true);

  const handlersThrow = new Map<string, MethodHandler>([
    [
      "notify-throw",
      () => {
        throw new Error("ignored");
      },
    ],
  ]);
  const res2 = await dispatch({ jsonrpc: "2.0", method: "notify-throw" }, handlersThrow);
  assert.equal(res2, null);

  // 未知メソッドの notification も無応答
  const res3 = await dispatch({ jsonrpc: "2.0", method: "unknown-notify" }, new Map());
  assert.equal(res3, null);
});
