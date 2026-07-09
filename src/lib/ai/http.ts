import { setTimeout as delay } from "node:timers/promises";
import type { AiAdapterKind, AiAuthConfig, ResolvedAiProfile } from "../config.ts";

export class AiProviderError extends Error {
  code:
    | "config"
    | "capability"
    | "auth"
    | "network"
    | "timeout"
    | "rate-limit"
    | "provider"
    | "response-too-large"
    | "invalid-response";
  profile: string;
  adapter: AiAdapterKind;
  status?: number;
  retryable: boolean;
  requestId?: string;

  constructor(args: {
    message: string;
    code: AiProviderError["code"];
    profile: string;
    adapter: AiAdapterKind;
    status?: number;
    retryable?: boolean;
    requestId?: string;
  }) {
    super(args.message);
    this.code = args.code;
    this.profile = args.profile;
    this.adapter = args.adapter;
    this.status = args.status;
    this.retryable = args.retryable ?? false;
    this.requestId = args.requestId;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127\./.test(normalized);
}

export function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AI baseUrl が不正です: ${value}`);
  }
  if (url.username || url.password) throw new Error("AI baseUrl に username/password は使えません");
  if (url.search || url.hash) throw new Error("AI baseUrl に query/hash は使えません");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("AI baseUrl は https か loopback http のみ許可されます");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function originOfProfile(profile: ResolvedAiProfile): string | null {
  if (profile.adapter === "openai") return "https://api.openai.com";
  if (profile.adapter === "anthropic") return "https://api.anthropic.com";
  if (profile.baseUrl) return normalizeBaseUrl(profile.baseUrl).origin;
  return null;
}

export function resolveCredential(auth: AiAuthConfig, env: NodeJS.ProcessEnv): string | null {
  if (auth.type === "none") return null;
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(auth.apiKeyEnv)) {
    throw new Error(`apiKeyEnv が不正です: ${auth.apiKeyEnv}`);
  }
  return env[auth.apiKeyEnv] ?? null;
}

export function aiRequestSummary(
  req: { purpose: string; route: string; parts: { type: string }[] },
  profile: ResolvedAiProfile,
): string {
  const imageCount = req.parts.filter((part) => part.type === "image").length;
  const base = `AI: purpose=${req.purpose} route=${req.route} profile=${profile.name} adapter=${profile.adapter} model=${profile.model}`;
  const origin = originOfProfile(profile);
  return imageCount > 0
    ? `${base}${origin ? ` origin=${origin}` : ""} images=${imageCount}`
    : base;
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) return null;
  return seconds * 1000;
}

function requestIdOf(res: Response): string | undefined {
  return res.headers?.get?.("x-request-id") ?? res.headers?.get?.("request-id") ?? undefined;
}

function sanitizeSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`response too large: ${contentLength}`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const fallback = res as Response & { text?: () => Promise<string>; json?: () => Promise<unknown> };
    if (fallback.text) return await fallback.text();
    if (fallback.json) return JSON.stringify(await fallback.json());
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large: ${total}`);
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function classifyHttpFailure(profile: ResolvedAiProfile, res: Response, bodyText: string): AiProviderError {
  const status = res.status;
  const requestId = requestIdOf(res);
  if (status === 401 || status === 403) {
    return new AiProviderError({
      code: "auth",
      profile: profile.name,
      adapter: profile.adapter,
      status,
      requestId,
      message: `AI provider auth error profile=${profile.name} adapter=${profile.adapter} status=${status}`,
    });
  }
  if (status === 429) {
    return new AiProviderError({
      code: "rate-limit",
      profile: profile.name,
      adapter: profile.adapter,
      status,
      requestId,
      retryable: true,
      message: `AI provider rate limit profile=${profile.name} adapter=${profile.adapter} status=${status}`,
    });
  }
  return new AiProviderError({
    code: status >= 500 ? "provider" : "invalid-response",
    profile: profile.name,
    adapter: profile.adapter,
    status,
    requestId,
    retryable: status === 502 || status === 503 || status === 504,
    message: `AI provider error profile=${profile.name} adapter=${profile.adapter} status=${status} summary=${sanitizeSummary(bodyText)}`,
  });
}

export async function fetchJsonWithPolicy<T>(
  profile: ResolvedAiProfile,
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<{ data: T; requestId?: string; headers: Headers }> {
  const attempts = profile.maxRetries + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, redirect: "error" });
      if (!res.ok) {
        const bodyText = await readBoundedText(res, Math.min(profile.maxResponseBytes, 4096));
        const err = classifyHttpFailure(profile, res, bodyText);
        if (err.retryable && attempt + 1 < attempts) {
          await delay(retryAfterMs(res) ?? (attempt === 0 ? 500 : 1500));
          continue;
        }
        throw err;
      }
      const fallback = res as Response & { json?: () => Promise<unknown> };
      if (!res.body?.getReader && fallback.json) {
        return {
          data: await fallback.json() as T,
          requestId: requestIdOf(res),
          headers: res.headers ?? new Headers(),
        };
      }
      const text = await readBoundedText(res, profile.maxResponseBytes);
      try {
        return {
          data: JSON.parse(text) as T,
          requestId: requestIdOf(res),
          headers: res.headers,
        };
      } catch {
        throw new AiProviderError({
          code: "invalid-response",
          profile: profile.name,
          adapter: profile.adapter,
          requestId: requestIdOf(res),
          message: `AI provider invalid response profile=${profile.name} adapter=${profile.adapter}`,
        });
      }
    } catch (error) {
      if (error instanceof AiProviderError) {
        lastError = error;
        if (!error.retryable || attempt + 1 >= attempts) throw error;
        await delay(attempt === 0 ? 500 : 1500);
        continue;
      }
      const name = (error as Error).name;
      if (name === "AbortError" || name === "TimeoutError") {
        throw new AiProviderError({
          code: "timeout",
          profile: profile.name,
          adapter: profile.adapter,
          retryable: false,
          message: `AI provider timeout profile=${profile.name} adapter=${profile.adapter}`,
        });
      }
      lastError = new AiProviderError({
        code: "network",
        profile: profile.name,
        adapter: profile.adapter,
        retryable: attempt + 1 < attempts,
        message: `AI provider network error profile=${profile.name} adapter=${profile.adapter}`,
      });
      if (attempt + 1 >= attempts) throw lastError;
      await delay(attempt === 0 ? 500 : 1500);
    }
  }
  throw lastError;
}
