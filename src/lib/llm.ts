import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import { resolveAiCfg } from "./config.ts";
import type { Config } from "./config.ts";

export interface JsonSchemaTextFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export function supportsImageReview(cfg: Config): boolean {
  const provider = resolveAiCfg(cfg).provider;
  return provider === "openai" || provider === "anthropic";
}

export async function completeImageReview(
  prompt: string,
  imageFiles: string[],
  cfg: Config,
  format: JsonSchemaTextFormat,
): Promise<string> {
  const ai = resolveAiCfg(cfg);
  if (ai.provider !== "openai" && ai.provider !== "anthropic") {
    throw new Error(`ai.provider=${ai.provider} は画像review非対応です`);
  }
  const images = imageFiles.map((file) => ({
    mime: file.toLowerCase().endsWith(".jpg") || file.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png",
    data: readFileSync(file).toString("base64"),
  }));
  if (ai.provider === "openai") {
    if (!process.env.OPENAI_API_KEY) loadRepoEnv();
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY が必要です");
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: requireExplicitModel("openai", ai.model),
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...images.map((image) => ({ type: "input_image", image_url: `data:${image.mime};base64,${image.data}` })),
          ],
        }],
        max_output_tokens: 2048,
        text: { format: { type: "json_schema", name: format.name, strict: true, schema: format.schema } },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API エラー: ${res.status} ${await res.text()}`);
    const data = await res.json() as { output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
    return data.output_text ?? (data.output ?? []).flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
  }
  if (!process.env.ANTHROPIC_API_KEY) loadRepoEnv();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が必要です");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: requireExplicitModel("anthropic", ai.model),
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } })),
        ],
      }],
      tools: [{ name: "structured_output", description: "Return observations only.", input_schema: format.schema }],
      tool_choice: { type: "tool", name: "structured_output" },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  const data = await res.json() as { content?: { type?: string; input?: unknown }[] };
  const tool = (data.content ?? []).find((item) => item.type === "tool_use");
  if (!tool) throw new Error("Anthropic API からstructured outputを取得できませんでした");
  return JSON.stringify(tool.input);
}

/**
 * AI provider にプロンプトを送り、one-shot のテキスト応答を返す。
 * `ai.provider` が新しい設定入口。旧 `llm.backend` は resolveAiCfg で互換解決する。
 */
export async function complete(prompt: string, cfg: Config): Promise<string> {
  const ai = resolveAiCfg(cfg);
  if (ai.provider === "claude-code") {
    return completeViaClaudeCode(prompt, ai.model);
  }
  if (ai.provider === "codex") {
    return completeViaCodex(prompt, ai.model);
  }
  if (ai.provider === "anthropic") {
    return completeViaAnthropic(prompt, ai.model);
  }
  if (ai.provider === "openai") {
    return completeViaOpenAi(prompt, ai.model);
  }
  throw new Error(
    `不明な ai.provider です: ${ai.provider}`,
  );
}

export async function completeWithJsonSchema(
  prompt: string,
  cfg: Config,
  format: JsonSchemaTextFormat,
): Promise<string> {
  const ai = resolveAiCfg(cfg);
  if (ai.provider === "claude-code") {
    return completeViaClaudeCodeWithJsonSchema(prompt, ai.model, format);
  }
  if (ai.provider === "anthropic") {
    return completeViaAnthropicWithJsonSchema(prompt, ai.model, format);
  }
  if (ai.provider === "openai") {
    return completeViaOpenAi(prompt, ai.model, format);
  }
  return complete(prompt, cfg);
}

async function completeViaClaudeCode(prompt: string, model: string): Promise<string> {
  const args = ["-p", "--output-format", "text"];
  if (model && model !== "auto") args.push("--model", model);
  const { stdout } = await run("claude", args, { input: prompt });
  return stdout;
}

async function completeViaClaudeCodeWithJsonSchema(
  prompt: string,
  model: string,
  format: JsonSchemaTextFormat,
): Promise<string> {
  const args = ["-p", "--output-format", "text", "--json-schema", JSON.stringify(format.schema)];
  if (model && model !== "auto") args.push("--model", model);
  const { stdout } = await run("claude", args, { input: prompt });
  return stdout;
}

async function completeViaCodex(prompt: string, model: string): Promise<string> {
  const args = ["exec", "--sandbox", "read-only"];
  if (model && model !== "auto") args.push("--model", model);
  args.push("-");
  const { stdout } = await run("codex", args, { input: prompt });
  return stdout;
}

function loadRepoEnv(): void {
  // 環境変数になければリポジトリ直下の .env から読む
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function requireExplicitModel(provider: string, model: string): string {
  if (!model || model === "auto") {
    throw new Error(
      `ai.provider=${provider} には config.yaml の ai.model の指定が必要です`,
    );
  }
  return model;
}

async function completeViaAnthropic(prompt: string, model: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) loadRepoEnv();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ai.provider=anthropic には ANTHROPIC_API_KEY が必要です(.env か環境変数で設定)",
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: requireExplicitModel("anthropic", model),
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  return data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

async function completeViaAnthropicWithJsonSchema(
  prompt: string,
  model: string,
  format: JsonSchemaTextFormat,
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) loadRepoEnv();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ai.provider=anthropic には ANTHROPIC_API_KEY が必要です(.env か環境変数で設定)",
    );
  }

  const toolName = "structured_output";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: requireExplicitModel("anthropic", model),
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          name: toolName,
          description: "Return the response as structured JSON.",
          input_schema: format.schema,
        },
      ],
      tool_choice: { type: "tool", name: toolName },
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content?: { type?: string; text?: string; input?: unknown }[];
  };
  const toolUse = (data.content ?? []).find((c) => c.type === "tool_use");
  if (toolUse && "input" in toolUse) {
    return JSON.stringify(toolUse.input);
  }
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (text) return text;
  throw new Error("Anthropic API から structured output を取得できませんでした");
}

async function completeViaOpenAi(
  prompt: string,
  model: string,
  format?: JsonSchemaTextFormat,
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) loadRepoEnv();
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "ai.provider=openai には OPENAI_API_KEY が必要です(.env か環境変数で設定)",
    );
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: requireExplicitModel("openai", model),
      input: prompt,
      max_output_tokens: 8192,
      ...(format
        ? {
            text: {
              format: {
                type: "json_schema",
                name: format.name,
                strict: format.strict ?? true,
                schema: openAiCompatibleSchema(format.schema),
              },
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    output_text?: string;
    output?: { content?: { type?: string; text?: string }[] }[];
  };
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output ?? [])
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("");
}

/**
 * OpenAI Structured Outputs supports `anyOf` but rejects JSON Schema's
 * equivalent `oneOf`. Keep the provider-neutral schemas expressive and only
 * translate this keyword at the API boundary.
 */
export function openAiCompatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(openAiCompatibleSchema);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    out[key === "oneOf" ? "anyOf" : key] = openAiCompatibleSchema(child);
  }
  return out;
}
