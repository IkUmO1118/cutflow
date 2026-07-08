import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorAiError,
  buildEditorAiPrompt,
  parseAiPatchResponse,
  planEditorAiPatch,
} from "../src/stages/editorAi.ts";
import type { Config } from "../src/lib/config.ts";
import { completeWithJsonSchema } from "../src/lib/llm.ts";

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-editor-ai-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 30,
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      layout: "plain",
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-08T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }],
    });
    write("overlays.json", {});
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cfg = {
  llm: { backend: "claude-cli", model: "" },
  describe: {},
} as Config;

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("parseAiPatchResponse: JSON だけの AI 応答を parse できる", () => {
  const parsed = parseAiPatchResponse(
    JSON.stringify({
      title: "字幕短縮",
      summary: ["冗長語を削る"],
      patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      review: { frames: ["1.2"], notes: ["字幕を確認"] },
    }),
  );
  assert.equal(parsed.title, "字幕短縮");
  assert.equal(parsed.summary[0], "冗長語を削る");
  assert.equal(parsed.patch.ops?.length, 1);
  assert.deepEqual(parsed.review.frames, ["1.2"]);
});

test("parseAiPatchResponse: markdown fenced JSON は rejected", () => {
  assert.throws(
    () => parseAiPatchResponse("```json\n{\"patch\":{\"ops\":[]}}\n```"),
    /AI 応答を JSON として読めません/,
  );
});

test("parseAiPatchResponse: patch 欠落を error にする", () => {
  assert.throws(() => parseAiPatchResponse("{\"title\":\"x\"}"), /patch オブジェクト/);
});

test("planEditorAiPatch: planApply 結果から proposedDocs を作るが書き込まない", () => {
  withTmpProject((dir) => {
    const parsed = parseAiPatchResponse(
      JSON.stringify({
        title: "字幕短縮",
        patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      }),
    );
    const res = planEditorAiPatch(dir, parsed);
    assert.equal(res.proposedDocs.transcript.segments[0].text, "こんにちは世界");
    assert.equal(res.applyPlan.changedFiles.includes("transcript.json"), true);
  });
});

test("planEditorAiPatch: approved 変更 patch は planApply errors として 400", () => {
  withTmpProject((dir) => {
    const parsed = parseAiPatchResponse(
      JSON.stringify({
        patch: {
          replace: {
            cutplan: {
              approved: true,
              segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }],
            },
          },
        },
      }),
    );
    assert.throws(
      () => planEditorAiPatch(dir, parsed),
      (e) => e instanceof EditorAiError && e.status === 400 && /approved/.test(e.message),
    );
  });
});

test("buildEditorAiPrompt: 指示と選択文脈と project projection を含める", () => {
  withTmpProject((dir) => {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "ja",
        model: "test",
        segments: [
          { id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" },
          { id: "cap_bbbbbb", start: 24, end: 27, text: "遠い字幕です" },
        ],
      }, null, 2),
      "utf8",
    );
    const prompt = buildEditorAiPrompt(dir, cfg, {
      instruction: "この字幕を短く",
      activeShortName: null,
      selection: {
        scope: "selection",
        selectedRange: { startSec: 1, endSec: 3 },
        selectedKind: "caption",
        selectedIds: ["cap_aaaaaa"],
        selectedText: "こんにちは",
      },
    });
    assert.match(prompt, /この字幕を短く/);
    assert.match(prompt, /"scope": "selection"/);
    assert.match(prompt, /cap_aaaaaa/);
    assert.doesNotMatch(prompt, /遠い字幕です/);
    assert.match(prompt, /Current project projection/);
    assert.match(prompt, /"required": \[\s*"title",\s*"summary",\s*"patch",\s*"review"\s*\]/s);
    assert.match(prompt, /"op": \{\s*"const": "set"\s*\}/s);
  });
});

test("buildEditorAiPrompt: global scope は project-level summary に圧縮する", () => {
  withTmpProject((dir) => {
    const prompt = buildEditorAiPrompt(dir, cfg, {
      instruction: "全体のBGMを調整",
      activeShortName: null,
      selection: { scope: "global", activeShortName: null },
    });
    assert.match(prompt, /"scope": "global"/);
    assert.match(prompt, /"counts"/);
    assert.doesNotMatch(prompt, /こんにちは、ええと、世界/);
  });
});

test("completeWithJsonSchema: openai provider は text.format=json_schema を送る", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let body: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ ok: true }) }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      const res = await completeWithJsonSchema(
        "hello",
        { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
        { name: "test_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      );
      assert.equal(res, '{"ok":true}');
    });
    const req = body as { text?: { format?: { type?: string; name?: string; strict?: boolean; schema?: { properties?: Record<string, unknown> } } } };
    assert.equal(req.text?.format?.type, "json_schema");
    assert.equal(req.text?.format?.name, "test_schema");
    assert.equal(req.text?.format?.strict, true);
    assert.ok("ok" in (req.text?.format?.schema?.properties ?? {}));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeWithJsonSchema: anthropic provider は tool schema を送る", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let body: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "tool_use",
              input: { ok: true },
            },
          ],
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ ANTHROPIC_API_KEY: "test-anthropic" }, async () => {
      const res = await completeWithJsonSchema(
        "hello",
        { ...cfg, ai: { provider: "anthropic", model: "claude-x" } } as Config,
        { name: "test_schema", schema: { type: "object" } },
      );
      assert.equal(res, '{"ok":true}');
    });
    const req = body as {
      tools?: { name?: string; input_schema?: { type?: string } }[];
      tool_choice?: { type?: string; name?: string };
    };
    assert.equal(req.tools?.[0]?.name, "structured_output");
    assert.equal(req.tools?.[0]?.input_schema?.type, "object");
    assert.equal(req.tool_choice?.type, "tool");
    assert.equal(req.tool_choice?.name, "structured_output");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeWithJsonSchema: claude-code provider は --json-schema を付ける", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cutflow-claude-code-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const argsFile = join(dir, "args.txt");
  const script = join(binDir, "claude");
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
cat >/dev/null
printf '%s' '{"ok":true}'
`,
    "utf8",
  );
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH ?? "";
  try {
    process.env.PATH = `${binDir}:${originalPath}`;
    const res = await completeWithJsonSchema(
      "hello",
      { ...cfg, ai: { provider: "claude-code", model: "sonnet" } } as Config,
      { name: "test_schema", schema: { type: "object" } },
    );
    assert.equal(res, '{"ok":true}');
    const got = readFileSync(argsFile, "utf8");
    assert.match(got, /--json-schema/);
    assert.match(got, /--output-format/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
