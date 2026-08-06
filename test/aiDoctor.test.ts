import { test } from "node:test";
import assert from "node:assert/strict";
import { aiDoctor } from "../src/stages/aiDoctor.ts";
import { LEGACY_AI_PROFILE } from "../src/lib/config.ts";
import type { Config } from "../src/lib/config.ts";

test("aiDoctor: openai-compatible profile の text/structured/image を検査できる", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: { content?: string | { type: string; text?: string }[] }[];
    };
    const content = body.messages?.[0]?.content;
    let payload = { ok: true };
    if (Array.isArray(content)) {
      payload = content.some((item) => item.type === "image_url")
        ? { saw: "red-square" }
        : { ok: true };
    } else if (typeof content === "string" && /framewright-ok/.test(content)) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ choices: [{ message: { content: "framewright-ok" } }] }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as Response;
  }) as typeof fetch;
  const cfg = {
    ai: {
      profiles: {
        local: {
          adapter: "openai-compatible",
          protocol: "chat-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
          model: "local-model",
          auth: { type: "none" },
          capabilities: { structuredOutput: "json-object", imageInput: true },
        },
      },
      routes: { text: "local", structured: "local", vision: "local" },
    },
  } as Config;
  try {
    const [result] = await aiDoctor(cfg);
    assert.equal(result.profile, "local");
    assert.equal(result.checks.config.status, "ok");
    assert.equal(result.checks.credential.status, "skip");
    assert.equal(result.checks.text.status, "ok");
    assert.equal(result.checks.structured.status, "ok");
    assert.equal(result.checks.image.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aiDoctor: legacy/既定経路(予約 profile 名)でも検査が走る(合成 config では別名にする)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ output_text: "framewright-ok" }),
  }) as Response) as typeof fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const [result] = await aiDoctor({ ai: { provider: "openai", model: "gpt-x" } } as Config);
    assert.equal(result!.profile, LEGACY_AI_PROFILE);
    // 予約名がそのまま合成 config へ入ると「予約済みです」で全 check が error になる
    assert.equal(result!.checks.text.status, "ok");
    assert.notEqual(result!.checks.structured.status, "error");
    assert.notEqual(result!.checks.image.status, "error");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
