import { test } from "node:test";
import assert from "node:assert/strict";
import { aiDoctor } from "../src/stages/aiDoctor.ts";
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
    } else if (typeof content === "string" && /cutflow-ok/.test(content)) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ choices: [{ message: { content: "cutflow-ok" } }] }),
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
