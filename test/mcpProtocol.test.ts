// src/mcp/protocol.ts — MCP メソッド(initialize/tools list/tools call/ping)
// の result 組み立てを固定する。T2(docs/plans/2026-07-07-mcp-server-design.md
// §9)。ToolDef[] はここではダミーで足りる(実 tool レジストリは T3)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/mcp/jsonrpc.ts";
import {
  buildMcpHandlers,
  handleInitialize,
  handleToolsCall,
  handleToolsList,
  PROTOCOL_VERSION,
} from "../src/mcp/protocol.ts";
import { JsonRpcError } from "../src/mcp/types.ts";
import type { ToolDef } from "../src/mcp/types.ts";

function dummyTools(): ToolDef[] {
  return [
    {
      name: "cutflow_describe",
      description: "describe the project",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    {
      name: "cutflow_validate",
      description: "validate the project",
      inputSchema: { type: "object", properties: {} },
      handler: async (args) => ({
        content: [{ type: "text", text: JSON.stringify(args) }],
        isError: true,
      }),
    },
  ];
}

/* ---------------- initialize ---------------- */

test("handleInitialize: protocolVersion/capabilities/serverInfo を返す", () => {
  const r = handleInitialize();
  assert.equal(r.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r.serverInfo.name, "cutflow");
  assert.equal(typeof r.serverInfo.version, "string");
});

/* ---------------- tools/list ---------------- */

test("handleToolsList: 渡した ToolDef を name/description/inputSchema だけの形で網羅する", () => {
  const tools = dummyTools();
  const { tools: listed } = handleToolsList(tools);
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((t) => t.name),
    ["cutflow_describe", "cutflow_validate"],
  );
  for (const t of listed) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.inputSchema);
    assert.equal("handler" in t, false); // handler は公開しない
  }
});

/* ---------------- tools/call ---------------- */

test("handleToolsCall: name を引いて正しい handler を呼ぶ(isError をそのまま透過)", async () => {
  const tools = dummyTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  const ok = await handleToolsCall(byName, { name: "cutflow_describe" });
  assert.deepEqual(ok, { content: [{ type: "text", text: "ok" }] });

  const err = await handleToolsCall(byName, { name: "cutflow_validate", arguments: { x: 1 } });
  assert.equal(err.isError, true);
  assert.equal(err.content[0].text, JSON.stringify({ x: 1 }));
});

test("handleToolsCall: 未知の tool name は JsonRpcError(-32602)", async () => {
  const byName = new Map(dummyTools().map((t) => [t.name, t]));
  await assert.rejects(
    () => handleToolsCall(byName, { name: "cutflow_render_not_exposed" }),
    (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
  );
});

test("handleToolsCall: params の形が不正(name 無し/非string)なら JsonRpcError(-32602)", async () => {
  const byName = new Map(dummyTools().map((t) => [t.name, t]));
  await assert.rejects(
    () => handleToolsCall(byName, {}),
    (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
  );
  await assert.rejects(
    () => handleToolsCall(byName, { name: 123 }),
    (e: unknown) => e instanceof JsonRpcError && e.code === -32602,
  );
});

/* ---------------- buildMcpHandlers + dispatch(統合) ---------------- */

test("buildMcpHandlers: initialize/tools/list/tools/call/ping が dispatch 経由で正しく応答する", async () => {
  const handlers = buildMcpHandlers(dummyTools());

  const init = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, handlers);
  assert.ok(init && "result" in init);

  const list = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, handlers);
  assert.ok(list && "result" in list);
  if (list && "result" in list) {
    const result = list.result as { tools: { name: string }[] };
    assert.equal(result.tools.length, 2);
  }

  const call = await dispatch(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cutflow_describe" } },
    handlers,
  );
  assert.ok(call && "result" in call);

  const ping = await dispatch({ jsonrpc: "2.0", id: 4, method: "ping" }, handlers);
  assert.ok(ping && "result" in ping);
  if (ping && "result" in ping) assert.deepEqual(ping.result, {});

  // notification は無応答
  const notif = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, handlers);
  assert.equal(notif, null);
});

test("buildMcpHandlers: tools/call の未知 tool name は dispatch を通しても -32602 として出る", async () => {
  const handlers = buildMcpHandlers(dummyTools());
  const res = await dispatch(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "cutflow_render" } },
    handlers,
  );
  assert.ok(res && "error" in res);
  if (res && "error" in res) assert.equal(res.error.code, -32602);
});
