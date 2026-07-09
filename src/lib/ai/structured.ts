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

export function normalizeJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

export function promptJsonSchemaSuffix(schema: Record<string, unknown>): string {
  return [
    "Return exactly one JSON value matching this schema.",
    "Do not use Markdown fences.",
    "Do not add explanation before or after the JSON.",
    "Schema:",
    JSON.stringify(schema),
  ].join("\n");
}
