import type {
  AiAdapter,
  AiAgenticToolResult,
  AiImagePart,
  AiRequest,
  AiResponse,
  JsonSchemaTextFormat,
} from "./types.ts";
import { fetchJsonWithPolicy, normalizeBaseUrl, resolveCredential } from "./http.ts";
import { openAiCompatibleSchema, promptJsonSchemaSuffix } from "./structured.ts";

function requireExplicitModel(provider: string, model: string): string {
  if (!model || model === "auto") {
    throw new Error(`ai.provider=${provider} には config.yaml の ai.model の指定が必要です`);
  }
  return model;
}

function extractOpenAiOutput(data: {
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
}): string {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
}

function extractAnthropicOutput(data: {
  content?: { type?: string; text?: string; input?: unknown }[];
}): string {
  const tool = (data.content ?? []).find((item) => item.type === "tool_use");
  if (tool && "input" in tool) return JSON.stringify(tool.input);
  return (data.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

function textPartsOf(request: AiRequest): string[] {
  return request.parts.filter((part): part is Extract<AiRequest["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text);
}

function imagePartsOf(request: AiRequest): AiImagePart[] {
  return request.parts.filter((part): part is AiImagePart => part.type === "image");
}

function renderPromptWithSchema(text: string, format: JsonSchemaTextFormat): string {
  return `${text}\n\n${promptJsonSchemaSuffix(format.schema)}`;
}

function toDataUrl(image: AiImagePart, readFile: (path: string) => Buffer): string {
  return `data:${image.mediaType};base64,${readFile(image.file).toString("base64")}`;
}

function imageLabelPart(image: AiImagePart): { type: "text"; text: string } {
  return { type: "text", text: `[${image.label}]` };
}

/* ------------------------ agentic(tool-use)ループ用の最小限の型 ------------------------
 * anthropic /v1/messages の content block を必要な分だけ緩く型付けする
 * (完全な公式型を持ち込まない。既存 complete() の extractAnthropicOutput と同じ姿勢) */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | { type: "text"; text: string }[] | (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  )[];
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

function toAnthropicToolResult(
  toolUseId: string,
  result: AiAgenticToolResult,
  context: { readFile: (path: string) => Buffer },
): AnthropicToolResultBlock {
  const blocks: (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  )[] = [];
  if (result.text) blocks.push({ type: "text", text: result.text });
  for (const image of result.images ?? []) {
    blocks.push({ type: "text", text: `[${image.label}]` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: context.readFile(image.file).toString("base64") },
    });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "(no output)" });
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: blocks,
    ...(result.isError ? { is_error: true } : {}),
  };
}

export const claudeCodeAdapter: AiAdapter = {
  kind: "claude-code",
  async complete(request, profile, context) {
    const text = textPartsOf(request).join("\n\n");
    const args = ["-p", "--output-format", "text"];
    if (request.output?.kind === "json-schema") args.push("--json-schema", JSON.stringify(request.output.format.schema));
    if (profile.model && profile.model !== "auto") args.push("--model", profile.model);
    const { stdout } = await context.run("claude", args, { input: text });
    return { text: stdout, profile: profile.name, adapter: profile.adapter, model: profile.model };
  },
};

export const codexAdapter: AiAdapter = {
  kind: "codex",
  async complete(request, profile, context) {
    let text = textPartsOf(request).join("\n\n");
    if (request.output?.kind === "json-schema") text = renderPromptWithSchema(text, request.output.format);
    const args = ["exec", "--sandbox", "read-only"];
    if (profile.model && profile.model !== "auto") args.push("--model", profile.model);
    args.push("-");
    const { stdout } = await context.run("codex", args, { input: text });
    return { text: stdout, profile: profile.name, adapter: profile.adapter, model: profile.model };
  },
};

export const openAiAdapter: AiAdapter = {
  kind: "openai",
  async complete(request, profile, context) {
    if (profile.auth.type !== "bearer") throw new Error(`AI profile "${profile.name}" の auth.type が不正です`);
    const token = resolveCredential(profile.auth, process.env);
    if (!token) throw new Error(`${profile.auth.apiKeyEnv} が必要です`);
    const images = imagePartsOf(request);
    const text = textPartsOf(request).join("\n\n");
    const body = images.length === 0
      ? {
          model: requireExplicitModel("openai", profile.model),
          input: text,
          max_output_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
          ...(request.output?.kind === "json-schema"
            ? {
                text: {
                  format: {
                    type: "json_schema",
                    name: request.output.format.name,
                    strict: request.output.format.strict ?? true,
                    schema: openAiCompatibleSchema(request.output.format.schema),
                  },
                },
              }
            : {}),
        }
      : {
          model: requireExplicitModel("openai", profile.model),
          input: [{
            role: "user",
            content: [
              ...textPartsOf(request).map((part) => ({ type: "input_text" as const, text: part })),
              ...images.flatMap((image) => [
                { type: "input_text" as const, text: `[${image.label}]` },
                { type: "input_image" as const, image_url: toDataUrl(image, context.readFile) },
              ]),
            ],
          }],
          max_output_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
          ...(request.output?.kind === "json-schema"
            ? {
                text: {
                  format: {
                    type: "json_schema",
                    name: request.output.format.name,
                    strict: request.output.format.strict ?? true,
                    schema: openAiCompatibleSchema(request.output.format.schema),
                  },
                },
              }
            : {}),
        };
    const { data, requestId } = await fetchJsonWithPolicy<{
      output_text?: string;
      output?: { content?: { type?: string; text?: string }[] }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      id?: string;
    }>(profile, context.fetch, "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    return {
      text: extractOpenAiOutput(data),
      profile: profile.name,
      adapter: profile.adapter,
      model: profile.model,
      ...((data.id ?? requestId) ? { requestId: data.id ?? requestId } : {}),
      ...(data.usage ? { usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } } : {}),
    };
  },
};

export const anthropicAdapter: AiAdapter = {
  kind: "anthropic",
  async complete(request, profile, context) {
    if (profile.auth.type !== "x-api-key") throw new Error(`AI profile "${profile.name}" の auth.type が不正です`);
    const token = resolveCredential(profile.auth, process.env);
    if (!token) throw new Error(`${profile.auth.apiKeyEnv} が必要です`);
    const body = {
      model: requireExplicitModel("anthropic", profile.model),
      max_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
      messages: [{
        role: "user",
        content: [
          ...textPartsOf(request).map((part) => ({ type: "text" as const, text: part })),
          ...imagePartsOf(request).flatMap((image) => [
            imageLabelPart(image),
            {
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: context.readFile(image.file).toString("base64") },
            },
          ]),
        ],
      }],
      ...(request.output?.kind === "json-schema"
        ? {
            tools: [{
              name: "structured_output",
              description: "Return the response as structured JSON.",
              input_schema: request.output.format.schema,
            }],
            tool_choice: { type: "tool", name: "structured_output" },
          }
        : {}),
    };
    const { data, requestId } = await fetchJsonWithPolicy<{
      content?: { type?: string; text?: string; input?: unknown }[];
      id?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(profile, context.fetch, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    return {
      text: extractAnthropicOutput(data),
      profile: profile.name,
      adapter: profile.adapter,
      model: profile.model,
      ...((data.id ?? requestId) ? { requestId: data.id ?? requestId } : {}),
      ...(data.usage ? { usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } } : {}),
    };
  },
  async completeAgentic(request, profile, context, handleTool) {
    if (profile.auth.type !== "x-api-key") throw new Error(`AI profile "${profile.name}" の auth.type が不正です`);
    const token = resolveCredential(profile.auth, process.env);
    if (!token) throw new Error(`${profile.auth.apiKeyEnv} が必要です`);
    const model = requireExplicitModel("anthropic", profile.model);
    const maxTokens = request.maxOutputTokens ?? profile.maxOutputTokens;
    const structuredTool = {
      name: "structured_output",
      description: "Return the final answer as structured JSON.",
      input_schema: request.output.format.schema,
    };
    const toolDefs = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    const messages: AnthropicMessage[] = [{
      role: "user",
      content: [
        ...textPartsOf(request).map((part) => ({ type: "text" as const, text: part })),
        ...imagePartsOf(request).flatMap((image) => [
          imageLabelPart(image),
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mediaType, data: context.readFile(image.file).toString("base64") },
          },
        ]),
      ],
    }];

    let toolCalls = 0;
    // 有界: request.maxToolCalls を使い切ったら次ラウンドは structured_output
    // だけを渡し tool_choice で強制する(必ず最終回答で終わる。§H1H2design §1-5)
    const maxRounds = request.maxToolCalls + 4;
    for (let round = 0; round < maxRounds; round++) {
      const budgetLeft = toolCalls < request.maxToolCalls;
      const body = {
        model,
        max_tokens: maxTokens,
        messages,
        tools: budgetLeft ? [...toolDefs, structuredTool] : [structuredTool],
        tool_choice: budgetLeft ? { type: "auto" as const } : { type: "tool" as const, name: "structured_output" },
      };
      const { data } = await fetchJsonWithPolicy<{
        content?: AnthropicContentBlock[];
        id?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      }>(profile, context.fetch, "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: context.signal,
      });
      const content = data.content ?? [];
      const structuredUse = content.find((c) => c.type === "tool_use" && c.name === "structured_output");
      if (structuredUse) {
        return {
          text: JSON.stringify(structuredUse.input ?? {}),
          toolCalls,
          profile: profile.name,
          adapter: profile.adapter,
          model: profile.model,
        };
      }
      const toolUses = content.filter((c) => c.type === "tool_use" && c.name !== "structured_output");
      if (toolUses.length === 0) {
        // tool も structured_output も無い応答(モデルがテキストだけ返した)。
        // ループを続けても進展しない可能性が高いので、そのテキストを最終応答
        // として扱う(呼び出し側が JSON パースに失敗すればフォールバックする)
        return {
          text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
          toolCalls,
          profile: profile.name,
          adapter: profile.adapter,
          model: profile.model,
        };
      }
      messages.push({ role: "assistant", content });
      const resultBlocks: AnthropicToolResultBlock[] = [];
      for (const use of toolUses) {
        if (!budgetLeft) {
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id!,
            content: "tool 呼び出し上限(maxToolCalls)に達しました。ここまでの set_cuts の結果で最終回答してください。",
            is_error: true,
          });
          continue;
        }
        toolCalls += 1;
        const result = await handleTool(use.name!, use.input);
        resultBlocks.push(toAnthropicToolResult(use.id!, result, context));
      }
      messages.push({ role: "user", content: resultBlocks });
    }
    throw new Error("agentic loop exceeded max rounds without a final structured_output");
  },
};

export const openAiCompatibleAdapter: AiAdapter = {
  kind: "openai-compatible",
  async complete(request, profile, context) {
    if (!profile.baseUrl) throw new Error(`AI profile "${profile.name}" は baseUrl が必要です`);
    const baseUrl = normalizeBaseUrl(profile.baseUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (profile.auth.type !== "none") {
      const token = resolveCredential(profile.auth, process.env);
      if (!token) throw new Error(`${profile.auth.apiKeyEnv} が必要です`);
      headers[profile.auth.type === "bearer" ? "authorization" : "x-api-key"] =
        profile.auth.type === "bearer" ? `Bearer ${token}` : token;
    }
    const text = textPartsOf(request).join("\n\n");
    if (profile.protocol === "responses") {
      const body = {
        model: requireExplicitModel("openai-compatible", profile.model),
        input: imagePartsOf(request).length === 0
          ? (request.output?.kind === "json-schema"
            ? renderPromptWithSchema(text, request.output.format)
            : text)
          : [{
              role: "user",
              content: [
                ...textPartsOf(request).map((part) => ({ type: "input_text" as const, text: part })),
                ...imagePartsOf(request).flatMap((image) => [
                  { type: "input_text" as const, text: `[${image.label}]` },
                  { type: "input_image" as const, image_url: toDataUrl(image, context.readFile) },
                ]),
              ],
            }],
        max_output_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
        ...(request.output?.kind === "json-schema" && profile.capabilities.structuredOutput === "native-json-schema"
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: request.output.format.name,
                  strict: request.output.format.strict ?? true,
                  schema: openAiCompatibleSchema(request.output.format.schema),
                },
              },
            }
          : {}),
      };
      const { data } = await fetchJsonWithPolicy<{
        output_text?: string;
        output?: { content?: { type?: string; text?: string }[] }[];
      }>(profile, context.fetch, `${baseUrl.toString()}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: context.signal,
      });
      return { text: extractOpenAiOutput(data), profile: profile.name, adapter: profile.adapter, model: profile.model };
    }
    const messages = [{
      role: "user",
      content: imagePartsOf(request).length === 0
        ? (request.output?.kind === "json-schema" && profile.capabilities.structuredOutput !== "native-json-schema"
          ? renderPromptWithSchema(text, request.output.format)
          : text)
        : [
            ...textPartsOf(request).map((part) => ({ type: "text" as const, text: part })),
            ...imagePartsOf(request).flatMap((image) => [
              imageLabelPart(image),
              { type: "image_url" as const, image_url: { url: toDataUrl(image, context.readFile) } },
            ]),
          ],
    }];
    const body = {
      model: requireExplicitModel("openai-compatible", profile.model),
      messages,
      max_tokens: request.maxOutputTokens ?? profile.maxOutputTokens,
      ...(request.output?.kind === "json-schema" && profile.capabilities.structuredOutput === "native-json-schema"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.output.format.name,
                strict: request.output.format.strict ?? true,
                schema: openAiCompatibleSchema(request.output.format.schema),
              },
            },
          }
        : request.output?.kind === "json-schema" && profile.capabilities.structuredOutput === "json-object"
        ? { response_format: { type: "json_object" } }
        : {}),
    };
    const { data } = await fetchJsonWithPolicy<{
      choices?: { message?: { content?: string } }[];
    }>(profile, context.fetch, `${baseUrl.toString()}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: context.signal,
    });
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("OpenAI-compatible response content が文字列ではありません");
    return { text: content, profile: profile.name, adapter: profile.adapter, model: profile.model };
  },
};

export const ADAPTERS = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
  "openai-compatible": openAiCompatibleAdapter,
} as const satisfies Record<string, AiAdapter>;

export function adapterFor(kind: keyof typeof ADAPTERS): AiAdapter {
  return ADAPTERS[kind];
}
