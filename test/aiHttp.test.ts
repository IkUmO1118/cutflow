import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithPolicy, normalizeBaseUrl } from "../src/lib/ai/http.ts";
import type { ResolvedAiProfile } from "../src/lib/config.ts";

const profile: ResolvedAiProfile = {
  name: "local",
  adapter: "openai-compatible",
  model: "local-model",
  protocol: "chat-completions",
  baseUrl: "http://127.0.0.1:8000/v1",
  auth: { type: "none" },
  capabilities: {
    textInput: true,
    textOutput: true,
    structuredOutput: "json-object",
    imageInput: true,
    maxImages: 4,
  },
  timeoutMs: 5_000,
  maxRetries: 1,
  maxOutputTokens: 512,
  maxResponseBytes: 1024 * 1024,
};

test("normalizeBaseUrl: loopback http を許可し、remote http/query/hash を拒否", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/v1/").toString(), "http://127.0.0.1:8000/v1");
  assert.throws(() => normalizeBaseUrl("http://192.168.0.10:8000/v1"), /https|loopback/);
  assert.throws(() => normalizeBaseUrl("https://example.com/v1?q=1"), /query\/hash/);
});

test("fetchJsonWithPolicy: 429 を retry して成功する", async () => {
  let hits = 0;
  const fakeFetch = (async () => {
    hits += 1;
    if (hits === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "content-type": "application/json", "retry-after": "0" }),
        text: async () => JSON.stringify({ error: "slow down" }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
    } as Response;
  }) as typeof fetch;
  const { data } = await fetchJsonWithPolicy<{ ok: boolean }>(
    profile,
    fakeFetch,
    "http://127.0.0.1:9999/v1/test",
    { method: "POST", body: "{}" },
  );
  assert.equal(data.ok, true);
  assert.equal(hits, 2);
});
