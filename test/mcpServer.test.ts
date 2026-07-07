// src/mcp/server.ts + `mcp <dir>` の CLI 配線を統合テストする。T4
// (docs/plans/2026-07-07-mcp-server-design.md §9)。`node src/cli.ts mcp
// <fixtureDir>` を実プロセスとして spawn し、stdin へ JSON-RPC を書き、
// stdout の改行区切り応答を読んで initialize→notifications/initialized→
// tools/list→tools/call(describe/validate)の往復を検証する。
// stdout に JSON-RPC 以外(postAction の所要時間行など)が混ざらないことも
// 併せて固定する(§design doc §7「stdout 汚染の防止」)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-mcp-server-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
  write("manifest.json", {
    dir,
    source: "raw.mkv",
    durationSec: 100,
    layout: "plain",
    video: { width: 1920, height: 1080, fps: 30, screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-07T00:00:00Z",
  });
  write("cutplan.json", {
    approved: false,
    segments: [
      { start: 0, end: 40, action: "keep", reason: "本編" },
      { start: 40, end: 50, action: "cut", reason: "言い直し" },
      { start: 50, end: 100, action: "keep", reason: "まとめ" },
    ],
  });
  write("transcript.json", { segments: [{ start: 1, end: 3, text: "こんにちは" }] });
  return dir;
}

interface JsonRpcLine {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 子プロセスの stdout を1行ずつ JSON-RPC としてパースし、非 JSON-RPC な
 * 行(万一 timing 行等が混入した場合)が来たら即座に検出できるよう蓄積する */
class McpClient {
  private nextId = 1;
  private pending = new Map<string | number, (msg: JsonRpcLine) => void>();
  private child: ReturnType<typeof spawn>;
  readonly stdoutLines: string[] = [];
  readonly malformedLines: string[] = [];

  constructor(child: ReturnType<typeof spawn>) {
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      this.stdoutLines.push(line);
      let msg: JsonRpcLine;
      try {
        msg = JSON.parse(line) as JsonRpcLine;
      } catch {
        this.malformedLines.push(line);
        return;
      }
      if (msg.jsonrpc !== "2.0") {
        this.malformedLines.push(line);
        return;
      }
      if (msg.id !== undefined) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown): Promise<JsonRpcLine> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} response`)), 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin!.write(line + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

test("mcp <dir>: initialize→notifications/initialized→tools/list→tools/call(describe/validate) を往復する", async () => {
  const dir = makeFixture();
  const child = spawn(process.execPath, [CLI, "mcp", dir], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrChunks: string[] = [];
  child.stderr!.on("data", (d: Buffer) => stderrChunks.push(d.toString("utf8")));

  const client = new McpClient(child);
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.ok(init.result);
    const initResult = init.result as { serverInfo: { name: string } };
    assert.equal(initResult.serverInfo.name, "cutflow");

    client.notify("notifications/initialized");

    const list = await client.request("tools/list");
    assert.ok(list.result);
    const { tools } = list.result as { tools: { name: string }[] };
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cutflow_apply",
      "cutflow_assert",
      "cutflow_describe",
      "cutflow_frames",
      "cutflow_id_stamp",
      "cutflow_materials",
      "cutflow_validate",
    ]);
    // 承認/破壊系は tools/list にも出ない
    assert.equal(names.some((n) => n.includes("render") || n.includes("approve")), false);

    const describeCall = await client.request("tools/call", { name: "cutflow_describe" });
    assert.ok(describeCall.result);
    assert.equal((describeCall.result as { isError?: boolean }).isError, undefined);

    const validateCall = await client.request("tools/call", { name: "cutflow_validate" });
    assert.ok(validateCall.result);
    assert.equal((validateCall.result as { isError?: boolean }).isError, undefined);

    // 未登録 tool(render 等)は tools/call でも呼べない(-32602)
    const renderCall = await client.request("tools/call", { name: "cutflow_render" });
    assert.ok(renderCall.error);
    assert.equal(renderCall.error!.code, -32602);

    // stdout に JSON-RPC 以外の行(timing 行等)が混ざっていない
    assert.deepEqual(client.malformedLines, []);
    for (const line of client.stdoutLines) {
      assert.equal(/所要時間/.test(line), false, `stdout に timing 行が混入: ${line}`);
    }
  } finally {
    child.kill("SIGINT");
    rmSync(dir, { recursive: true, force: true });
  }
});
