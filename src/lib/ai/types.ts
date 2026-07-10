import type { run } from "../exec.ts";
import type { AiAdapterKind, AiRoute, Config, ResolvedAiProfile } from "../config.ts";

export interface AiTextPart {
  type: "text";
  text: string;
}

export interface AiImagePart {
  type: "image";
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  label: string;
}

export type AiInputPart = AiTextPart | AiImagePart;

export interface JsonSchemaTextFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiRequest {
  route: AiRoute;
  parts: AiInputPart[];
  output?: { kind: "text" } | { kind: "json-schema"; format: JsonSchemaTextFormat };
  maxOutputTokens?: number;
  purpose: "plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other";
}

export interface AiResponse {
  text: string;
  profile: string;
  adapter: AiAdapterKind;
  model: string;
  requestId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AiAdapterContext {
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
  readFile: (path: string) => Buffer;
  run: typeof run;
}

export interface AiAdapter {
  readonly kind: AiAdapterKind;
  complete(
    request: AiRequest,
    profile: ResolvedAiProfile,
    context: AiAdapterContext,
  ): Promise<AiResponse>;
}

export type { Config, ResolvedAiProfile };
