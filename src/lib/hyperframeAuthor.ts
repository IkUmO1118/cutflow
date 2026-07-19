import type { AiProfileStatus } from "./config.ts";

/** CLI の hyperframe --name と同じ文字集合。 */
export const HYPERFRAME_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface HyperframeAuthorRequestShape {
  name: string;
  brief: string;
}

/** POST /api/hyperframe/author の allow-list + field validation。 */
export function validateHyperframeAuthorRequest(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["body は {name,brief} の JSON object で指定してください"];
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(record).some((key) => key !== "name" && key !== "brief")) {
    errors.push("name / brief だけを指定してください");
  }
  if (typeof record.name !== "string" || !HYPERFRAME_NAME_RE.test(record.name)) {
    errors.push("name は英数字・.・_・- のみで指定してください");
  }
  if (typeof record.brief !== "string" || record.brief.trim().length === 0) {
    errors.push("brief は空でない文字列で指定してください");
  }
  return errors;
}

export interface HyperframeAuthorReadiness {
  ready: boolean;
  disabledReason?: string;
}

/** ProjectData の公開済み AI status だけで author UI の利用可否を決める。 */
export function hyperframeAuthorReadiness(args: {
  structuredRoute: string;
  profiles: AiProfileStatus[];
}): HyperframeAuthorReadiness {
  const profile = args.profiles.find((candidate) => candidate.name === args.structuredRoute);
  if (!profile) {
    return { ready: false, disabledReason: "structured AI route が見つかりません" };
  }
  if (profile.capabilities.structuredOutput === "none") {
    return {
      ready: false,
      disabledReason: `AI profile「${profile.name}」は structured output に対応していません`,
    };
  }
  if (profile.credential === "missing") {
    return {
      ready: false,
      disabledReason: `AI profile「${profile.name}」の認証情報が未設定です`,
    };
  }
  return { ready: true };
}

/** 同名衝突判定の純関数。HTML / MP4 / cache sidecar のどれか1つでも存在すれば
 * editor author は上書きせず409にする。 */
export function hyperframeAuthorConflict(args: {
  name: string;
  htmlNames: readonly string[];
  mp4Names: readonly string[];
  sidecarNames: readonly string[];
}): boolean {
  return args.htmlNames.includes(args.name) ||
    args.mp4Names.includes(args.name) ||
    args.sidecarNames.includes(args.name);
}
