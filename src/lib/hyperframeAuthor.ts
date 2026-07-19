import type { AiProfileStatus } from "./config.ts";

/** CLI の hyperframe --name と同じ文字集合。 */
export const HYPERFRAME_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface HyperframeAuthorRequestShape {
  name: string;
  brief: string;
  assets?: Array<{ name: string; data: string }>;
}

/** POST /api/hyperframe/author の allow-list + field validation。 */
export function validateHyperframeAuthorRequest(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["入力内容の形式が正しくありません"];
  }
  const record = body as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(record).some((key) => key !== "name" && key !== "brief" && key !== "assets")) {
    errors.push("指定できない項目が含まれています");
  }
  if (typeof record.name !== "string" || !HYPERFRAME_NAME_RE.test(record.name)) {
    errors.push("ファイル名は英数字・.・_・- のみで指定してください");
  }
  if (typeof record.brief !== "string" || record.brief.trim().length === 0) {
    errors.push("作りたい内容を入力してください");
  }
  if (record.assets !== undefined) {
    if (!Array.isArray(record.assets)) {
      errors.push("添付素材の形式が正しくありません");
    } else {
      for (let index = 0; index < record.assets.length; index += 1) {
        const asset = record.assets[index];
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
          errors.push(`添付素材${index + 1}の形式が正しくありません`);
          continue;
        }
        const item = asset as Record<string, unknown>;
        if (Object.keys(item).some((key) => key !== "name" && key !== "data")) {
          errors.push(`添付素材${index + 1}に指定できない項目が含まれています`);
        }
        if (typeof item.name !== "string" || item.name.length === 0) {
          errors.push(`添付素材${index + 1}のファイル名が正しくありません`);
        }
        if (
          typeof item.data !== "string" || item.data.length === 0 ||
          item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
        ) {
          errors.push(`添付素材${index + 1}のデータが正しくありません`);
        }
      }
    }
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
    return { ready: false, disabledReason: "AI で素材を作るための設定が見つかりません" };
  }
  if (profile.capabilities.structuredOutput === "none") {
    return {
      ready: false,
      disabledReason: `AI 設定「${profile.name}」は素材の生成に対応していません`,
    };
  }
  if (profile.credential === "missing") {
    return {
      ready: false,
      disabledReason: `AI 設定「${profile.name}」の認証情報が未設定です`,
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
