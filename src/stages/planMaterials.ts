// M1(+M4): 素材配置候補の生成(plan-materials コマンド)。
// §docs/plans/2026-07-11-m1-material-placement-candidates-design.md
//
// plan-shorts と同じ「番号選択」方式: keep span(アンカー)× 実在素材に番号を
// 振って LLM に渡し、LLM は (anchorId, materialId) のペアだけを返す。時刻・
// ファイルパス・尺は一切 LLM に書かせず、実体への変換(materialAnchors.ts の
// 純関数)と書き込み前の validate 検査(all-or-nothing)はすべてコード側で行う。
// 生成する overlays[] は全件下書き(未承認)。approvals.json には一切触れない。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import { resolveMaterialPlacementCfg } from "../lib/config.ts";
import {
  buildAnchors,
  buildMaterialChoices,
  placementsToOverlays,
} from "../lib/materialAnchors.ts";
import type { MaterialAnchor, MaterialChoice, Placement } from "../lib/materialAnchors.ts";
import { readRules } from "./plan.ts";
import { validateDocs } from "./validate.ts";
import type { LoadedDocs } from "./validate.ts";
import { MATERIALS_INDEX_FILE, MATERIALS_PROBE_DIR } from "./materials.ts";
import type { MaterialsIndex } from "../lib/materials.ts";
import type { Config } from "../lib/config.ts";
import type { CutPlan, Overlays, Transcript } from "../types.ts";

/** LLM 応答スキーマ(prompts/plan-materials.md の出力形式と対応) */
export interface PlacementsSelection {
  placements: Placement[];
}

/**
 * LLM 応答から JSON を取り出して配置選定に整える。plan-shorts の
 * parseShortsResponse と同じ堅牢さ(コードフェンスや前後の説明文が混ざっても
 * 最初の { 〜 最後の } を拾う)。壊れた/欠けたフィールドは握りつぶし、後段
 * (placementsToOverlays)の機械検証(番号存在チェック)に委ねる:
 * - placements が無い/配列でなければ空配列
 * - anchorId / materialId が数値でない要素は落とす
 * - reason が文字列でなければ空文字
 */
export function parsePlacementsResponse(raw: string): PlacementsSelection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan-materials.raw.txt を確認してください)",
    );
  }
  let parsed: { placements?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { placements?: unknown };
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan-materials.raw.txt を確認してください)",
    );
  }
  const list = Array.isArray(parsed.placements) ? parsed.placements : [];
  const placements: Placement[] = list
    .map((p) => {
      const o = (p ?? {}) as { anchorId?: unknown; materialId?: unknown; reason?: unknown };
      return {
        anchorId: o.anchorId,
        materialId: o.materialId,
        reason: typeof o.reason === "string" ? o.reason : "",
      };
    })
    .filter(
      (p): p is Placement =>
        typeof p.anchorId === "number" &&
        Number.isFinite(p.anchorId) &&
        typeof p.materialId === "number" &&
        Number.isFinite(p.materialId),
    );
  return { placements };
}

/** アンカー一覧 + 素材一覧の2リストからプロンプトを組む。plan.ts の
 * renderPrompt は numbered(1リスト)専用で2リストを渡す口が無いため、
 * ここに専用実装を置く(rules/brief 注入は plan.ts と揃える) */
function renderMaterialsPrompt(
  dir: string,
  anchors: MaterialAnchor[],
  choices: MaterialChoice[],
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", "plan-materials.md"), "utf8");

  const anchorLines = anchors
    .map(
      (a) =>
        `#${a.id} [${a.start.toFixed(2)}-${a.end.toFixed(2)}] ${a.transcriptText || "(発言なし)"}`,
    )
    .join("\n");
  const materialLines = choices
    .map((c) => {
      const dur = c.durationSec !== undefined ? `${c.durationSec.toFixed(1)}s` : "画像";
      const au = c.hasAudio ? "音声あり" : "音声なし";
      const ocr = c.ocrPreview?.length ? ` / 画面文字: ${c.ocrPreview.join(" ")}` : "";
      const tr = c.transcribePreview ? ` / 発話: ${c.transcribePreview}` : "";
      return `#${c.id} ${c.kind} ${dur} ${au}${ocr}${tr}`;
    })
    .join("\n");

  const rules = readRules(dir);
  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "(見せ場リストなし)";

  // replaceAll + 関数形式: 文字列指定の replace は最初の1箇所しか置換されず、
  // また brief/rules に "$&" 等が含まれると置換パターンとして誤解釈されるため
  return template
    .replaceAll("{{anchors}}", () => anchorLines)
    .replaceAll("{{materials}}", () => materialLines)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{brief}}", () => brief);
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(`${path} がありません。先に ${requiredStage} を実行してください`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export interface PlanMaterialsResult {
  overlays: Overlays;
  placed: NonNullable<Overlays["overlays"]>;
  anchorCount: number;
  choiceCount: number;
}

/**
 * cutplan(keep span)+ transcript + materials.probe/index.json から番号付き
 * 候補を組み、LLM に (anchorId, materialId) のペアだけを選ばせて overlays.json
 * の下書きを生成する。read/complete/write の殻で、変換の中身は
 * materialAnchors.ts(純関数)に委ねる。
 */
export async function planMaterials(dir: string, cfg: Config): Promise<PlanMaterialsResult> {
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const transcript = readStageJson<Transcript>(join(dir, "transcript.json"), "transcribe");

  const indexPath = join(dir, MATERIALS_PROBE_DIR, MATERIALS_INDEX_FILE);
  if (!existsSync(indexPath)) {
    throw new Error(
      `${indexPath} がありません。先に \`node src/cli.ts materials ${dir} --all\` を実行してください`,
    );
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as MaterialsIndex;

  const placementCfg = resolveMaterialPlacementCfg(cfg);
  const anchors = buildAnchors(cutplan, transcript, placementCfg.minSpanSec);
  const choices = buildMaterialChoices(index);
  if (choices.length === 0) {
    throw new Error(
      "配置候補にできる素材が0件です(materials.probe/index.json に present な video/image がありません。materials <dir> --all を確認してください)",
    );
  }
  if (anchors.length === 0) {
    throw new Error(
      "素材を置けるアンカー(keep span)が0件です(cutplan.json の keep 区間を確認してください)",
    );
  }

  const prompt = renderMaterialsPrompt(dir, anchors, choices);
  const raw = await completeWithJsonSchema(
    prompt,
    cfg,
    {
      name: "cutflow_plan_materials",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["placements"],
        properties: {
          placements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["anchorId", "materialId", "reason"],
              properties: {
                anchorId: { type: "integer" },
                materialId: { type: "integer" },
                reason: { type: "string" },
              },
            },
          },
        },
      },
    },
    "other",
  );
  // LLM の生応答は必ず残す(パース失敗時の調査と、選定過程の記録のため)
  writeFileSync(join(dir, "plan-materials.raw.txt"), raw);

  const parsed = parsePlacementsResponse(raw);
  const newOverlayItems = placementsToOverlays(parsed.placements, anchors, choices, placementCfg);

  const overlaysPath = join(dir, "overlays.json");
  const existingOverlays = readJsonOrNull<Overlays>(overlaysPath) ?? {};
  const merged: Overlays = { ...existingOverlays, overlays: newOverlayItems };

  const loaded: LoadedDocs = {
    manifest: readJsonOrNull<unknown>(join(dir, "manifest.json")),
    cutplan,
    transcript,
    overlays: merged,
    bgm: readJsonOrNull<unknown>(join(dir, "bgm.json")),
    chapters: readJsonOrNull<unknown>(join(dir, "chapters.json")),
    meta: readJsonOrNull<unknown>(join(dir, "meta.json")),
    shorts: readJsonOrNull<unknown>(join(dir, "shorts.json")),
    thumbnail: readJsonOrNull<unknown>(join(dir, "thumbnail.json")),
  };
  const checked = validateDocs(dir, loaded);
  if (checked.errors.length > 0) {
    const lines = checked.errors.map((e) => `  ${e.file} ${e.where}: ${e.message}`);
    throw new Error(
      `生成した overlays が検査に失敗したため書き込みません:\n${lines.join("\n")}`,
    );
  }

  writeFileSync(overlaysPath, JSON.stringify(merged, null, 2));

  return {
    overlays: merged,
    placed: newOverlayItems,
    anchorCount: anchors.length,
    choiceCount: choices.length,
  };
}
