import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeAi } from "../lib/ai/client.ts";
import { originOfProfile, resolveCredential } from "../lib/ai/http.ts";
import { profileForRoute, resolveAiRuntimeConfig, validateAiConfig } from "../lib/config.ts";
import type { AiAdapterKind, AiRoute, Config, ResolvedAiProfile } from "../lib/config.ts";

export interface DoctorCheck {
  status: "ok" | "warn" | "error" | "skip";
  message: string;
}

export interface AiDoctorResult {
  profile: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  checks: {
    config: DoctorCheck;
    credential: DoctorCheck;
    text: DoctorCheck;
    structured: DoctorCheck;
    image: DoctorCheck;
  };
}

export interface AiDoctorOptions {
  profile?: string;
  route?: AiRoute;
}

const DOCTOR_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKUlEQVR4AWP4z8Dwn4GBgYHhP8N/BoZGRmYGLAwM/5kZGTGQwAAb6sI9j7ZHJ0AAAAASUVORK5CYII=";

function ok(message: string): DoctorCheck {
  return { status: "ok", message };
}
function warn(message: string): DoctorCheck {
  return { status: "warn", message };
}
function error(message: string): DoctorCheck {
  return { status: "error", message };
}
function skip(message: string): DoctorCheck {
  return { status: "skip", message };
}

function targetProfiles(cfg: Config, opts: AiDoctorOptions): ResolvedAiProfile[] {
  const runtime = resolveAiRuntimeConfig(cfg);
  if (opts.profile) {
    const profile = runtime.profiles.get(opts.profile);
    if (!profile) throw new Error(`AI profile "${opts.profile}" が見つかりません`);
    return [profile];
  }
  if (opts.route) return [profileForRoute(runtime, opts.route)];
  return [...runtime.profiles.values()];
}

export async function aiDoctor(cfg: Config, opts: AiDoctorOptions = {}): Promise<AiDoctorResult[]> {
  const configErrors = validateAiConfig(cfg.ai);
  const tmp = mkdtempSync(join(tmpdir(), "cutflow-ai-doctor-"));
  const imageFile = join(tmp, "ai-doctor.png");
  writeFileSync(imageFile, Buffer.from(DOCTOR_IMAGE_BASE64, "base64"));
  try {
    const results: AiDoctorResult[] = [];
    for (const profile of targetProfiles(cfg, opts)) {
      const credential = profile.auth.type === "none"
        ? skip("not required")
        : resolveCredential(profile.auth, process.env)
          ? ok("present")
          : error("missing");
      const result: AiDoctorResult = {
        profile: profile.name,
        adapter: profile.adapter,
        model: profile.model,
        origin: originOfProfile(profile),
        checks: {
          config: configErrors.length === 0 ? ok("ok") : error(configErrors.join(" / ")),
          credential,
          text: skip("not run"),
          structured: skip("not run"),
          image: skip("not run"),
        },
      };
      if (result.checks.config.status === "error") {
        results.push(result);
        continue;
      }
      try {
        const text = await completeAi({
          route: "text",
          purpose: "other",
          parts: [{ type: "text", text: "Reply with exactly: cutflow-ok" }],
          output: { kind: "text" },
          maxOutputTokens: 64,
        }, routeConfig(cfg, profile.name));
        result.checks.text = text.text.trim() === "cutflow-ok" ? ok("cutflow-ok") : warn("unexpected response");
      } catch (e) {
        result.checks.text = error((e as Error).message);
      }
      if (profile.capabilities.structuredOutput === "none") {
        result.checks.structured = skip("structuredOutput=none");
      } else {
        try {
          const structured = await completeAi({
            route: "structured",
            purpose: "other",
            parts: [{ type: "text", text: "Return the JSON now." }],
            output: {
              kind: "json-schema",
              format: {
                name: "cutflow_doctor",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["ok"],
                  properties: { ok: { const: true } },
                },
              },
            },
            maxOutputTokens: 64,
          }, routeConfig(cfg, profile.name));
          result.checks.structured = structured.text.trim() === "{\"ok\":true}" ? ok("ok") : warn("response shape parsed");
        } catch (e) {
          result.checks.structured = error((e as Error).message);
        }
      }
      if (!profile.capabilities.imageInput) {
        result.checks.image = skip("imageInput=false");
      } else {
        try {
          await completeAi({
            route: "vision",
            purpose: "vision-review",
            parts: [
              { type: "text", text: "Return the JSON now." },
              { type: "image", file: imageFile, mediaType: "image/png", label: "image 0: red-square" },
            ],
            output: {
              kind: "json-schema",
              format: {
                name: "cutflow_doctor_image",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["saw"],
                  properties: { saw: { type: "string" } },
                },
              },
            },
            maxOutputTokens: 64,
          }, routeConfig(cfg, profile.name));
          result.checks.image = ok("ok");
        } catch (e) {
          result.checks.image = error((e as Error).message);
        }
      }
      results.push(result);
    }
    return results;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function routeConfig(cfg: Config, profileName: string): Config {
  const runtime = resolveAiRuntimeConfig(cfg);
  const profile = runtime.profiles.get(profileName);
  if (!profile) throw new Error(`AI profile "${profileName}" が見つかりません`);
  return {
    ...cfg,
    ai: {
      profiles: Object.fromEntries([...runtime.profiles.entries()].map(([name, item]) => [name, {
        adapter: item.adapter,
        model: item.model,
        ...(item.protocol === "chat-completions" || item.protocol === "responses" ? { protocol: item.protocol } : {}),
        ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
        ...(item.auth ? { auth: item.auth } : {}),
        capabilities: {
          structuredOutput: item.capabilities.structuredOutput,
          imageInput: item.capabilities.imageInput,
          ...(item.capabilities.maxImages > 0 ? { maxImages: item.capabilities.maxImages } : {}),
        },
        timeoutMs: item.timeoutMs,
        maxRetries: item.maxRetries,
        maxOutputTokens: item.maxOutputTokens,
        maxResponseBytes: item.maxResponseBytes,
      }])),
      routes: {
        text: profileName,
        structured: profileName,
        ...(profile.capabilities.imageInput ? { vision: profileName } : {}),
      },
    },
  } as Config;
}
