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

/** agentic(tool-use)ループが読み書きする1 tool の定義(read-only 前提。
 * §docs/plans/2026-07-11-h1-h2-agentic-perception-loop-design.md §2.1) */
export interface AiAgenticTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiAgenticToolResult {
  text?: string;
  images?: AiImagePart[];
  /** true のとき tool 実行が失敗/拒否されたことを示す(モデルへそのまま
   * tool_result として返す。ループは継続する=例外にしない) */
  isError?: boolean;
}

export interface AiAgenticRequest {
  route: AiRoute;
  /** 初回ユーザーメッセージ(plan-cuts.md 展開済みのプロンプト等) */
  parts: AiInputPart[];
  tools: AiAgenticTool[];
  /** 最終回答の構造化スキーマ(anthropic では forced tool として実装) */
  output: { kind: "json-schema"; format: JsonSchemaTextFormat };
  maxOutputTokens?: number;
  /** 1ターンあたりの tool 呼び出し上限(有界。§H1H2design §1-5) */
  maxToolCalls: number;
  purpose: "plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other";
}

export interface AiAgenticResponse {
  /** 最終構造化応答(JSON文字列)。CUTS_RESPONSE_SCHEMA 等でパースされる */
  text: string;
  toolCalls: number;
  profile: string;
  adapter: AiAdapterKind;
  model: string;
}

/** tool_use が来たときに呼ばれるハンドラ。副作用(cutplan.json 書込等)は
 * 呼び出し元(lib/ai/agenticCut.ts)の tool 実装が持ち、アダプタは仲介するだけ */
export type AiAgenticToolHandler = (
  name: string,
  input: unknown,
) => Promise<AiAgenticToolResult>;

export interface AiAdapter {
  readonly kind: AiAdapterKind;
  complete(
    request: AiRequest,
    profile: ResolvedAiProfile,
    context: AiAdapterContext,
  ): Promise<AiResponse>;
  /** tool-use マルチターンのループ(H1/H2)。任意メソッド: 実装しないアダプタは
   * capability 無し=呼び出し側が既存の単発経路へフォールバックする */
  completeAgentic?(
    request: AiAgenticRequest,
    profile: ResolvedAiProfile,
    context: AiAdapterContext,
    handleTool: AiAgenticToolHandler,
  ): Promise<AiAgenticResponse>;
}

export type { Config, ResolvedAiProfile };
