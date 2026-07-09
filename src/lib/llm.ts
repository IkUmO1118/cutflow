import { aiCapabilities } from "./config.ts";
import { completeAi } from "./ai/client.ts";
import { openAiCompatibleSchema } from "./ai/structured.ts";
import type { Config } from "./config.ts";
import type { AiImagePart, AiResponse, JsonSchemaTextFormat } from "./ai/types.ts";

export type { JsonSchemaTextFormat } from "./ai/types.ts";
export { openAiCompatibleSchema } from "./ai/structured.ts";
export type { AiRequest, AiResponse, AiImagePart, AiInputPart } from "./ai/types.ts";
export { completeAi } from "./ai/client.ts";

export function supportsImageReview(cfg: Config): boolean {
  const caps = aiCapabilities(cfg, "vision");
  return caps?.imageInput === true;
}

export async function complete(prompt: string, cfg: Config): Promise<string> {
  const res = await completeAi({
    route: "text",
    parts: [{ type: "text", text: prompt }],
    output: { kind: "text" },
    purpose: "other",
  }, cfg);
  return res.text;
}

export async function completeForPurpose(
  prompt: string,
  cfg: Config,
  purpose: "plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other",
): Promise<string> {
  const res = await completeAi({
    route: "text",
    parts: [{ type: "text", text: prompt }],
    output: { kind: "text" },
    purpose,
  }, cfg);
  return res.text;
}

export async function completeWithJsonSchema(
  prompt: string,
  cfg: Config,
  format: JsonSchemaTextFormat,
  purpose: "plan" | "plan-shorts" | "editor-proposal" | "vision-review" | "other" = "other",
): Promise<string> {
  const res = await completeAi({
    route: "structured",
    parts: [{ type: "text", text: prompt }],
    output: { kind: "json-schema", format },
    purpose,
  }, cfg);
  return res.text;
}

export async function completeImageReview(
  prompt: string,
  images: string[] | AiImagePart[],
  cfg: Config,
  format: JsonSchemaTextFormat,
): Promise<string> {
  const parts: AiImagePart[] = images.map((image, index) => {
    if (typeof image === "string") {
      return {
        type: "image",
        file: image,
        mediaType: image.toLowerCase().endsWith(".jpg") || image.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png",
        label: `image ${index}`,
      };
    }
    return image;
  });
  const res = await completeAi({
    route: "vision",
    parts: [{ type: "text", text: prompt }, ...parts],
    output: { kind: "json-schema", format },
    purpose: "vision-review",
  }, cfg);
  return res.text;
}

export function asText(res: AiResponse): string {
  return res.text;
}
