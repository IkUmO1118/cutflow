// B1(+B3): BGM 配置候補の生成(plan-bgm コマンド)。
// §docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md
//
// plan-materials(M1)/plan-effects(E1)と同じ「番号選択」方式: 切替アンカー
// (章境界/大カット境界)から決定論で区間スロットを列挙し、実在音声ファイルに
// 番号を振って LLM に渡す。LLM は (slotId, file: 曲番号|null) のペアだけを
// 返し、時刻・ファイルパス・音量は一切書かせない。実体への変換
// (bgmSlots.ts の純関数)と書き込み前の validate 検査(all-or-nothing)は
// すべてコード側で行う。生成する bgm.json は下書き(未承認相当。bgm は
// もともと承認スコープ外)。cutplan.json / approvals.json には一切触れない。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import { resolveBgmSlotCfg } from "../lib/config.ts";
import {
  anchorsToSlots,
  buildBgmAnchors,
  buildBgmChoices,
  assignmentsToTracks,
} from "../lib/bgmSlots.ts";
import type { BgmAssignment, BgmChoice, BgmSlot } from "../lib/bgmSlots.ts";
import { classifyKind } from "../lib/materials.ts";
import { readRules } from "./plan.ts";
import { validateDocs } from "./validate.ts";
import type { LoadedDocs } from "./validate.ts";
import type { Config } from "../lib/config.ts";
import type { Bgm, Chapters, CutPlan, Manifest } from "../types.ts";

/** LLM 応答スキーマ(prompts/plan-bgm.md の出力形式と対応) */
export interface AssignmentsSelection {
  assignments: BgmAssignment[];
}

/**
 * LLM 応答から JSON を取り出して割り当て選定に整える。plan-materials の
 * parsePlacementsResponse / plan-effects の parseDecisionsResponse と同じ
 * 堅牢さ(コードフェンスや前後の説明文が混ざっても最初の { 〜 最後の } を
 * 拾う)。壊れた/欠けたフィールドは握りつぶし、後段(assignmentsToTracks)の
 * 機械検証(番号存在チェック)に委ねる:
 * - assignments が無い/配列でなければ空配列
 * - slotId が数値でない要素は落とす
 * - file が数値でも null でもない要素は落とす
 * - reason が文字列でなければ空文字
 */
export function parseAssignmentsResponse(raw: string): AssignmentsSelection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan-bgm.raw.txt を確認してください)",
    );
  }
  let parsed: { assignments?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { assignments?: unknown };
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan-bgm.raw.txt を確認してください)",
    );
  }
  const list = Array.isArray(parsed.assignments) ? parsed.assignments : [];
  const assignments: BgmAssignment[] = list
    .map((a) => {
      const o = (a ?? {}) as { slotId?: unknown; file?: unknown; reason?: unknown };
      return {
        slotId: o.slotId,
        file: o.file,
        reason: typeof o.reason === "string" ? o.reason : "",
      };
    })
    .filter(
      (a): a is BgmAssignment =>
        typeof a.slotId === "number" &&
        Number.isFinite(a.slotId) &&
        (a.file === null || (typeof a.file === "number" && Number.isFinite(a.file))),
    );
  return { assignments };
}

/** スロット一覧 + 曲一覧の2リストからプロンプトを組む。plan.ts の
 * renderPrompt は numbered(1リスト)専用で2リストを渡す口が無いため、
 * plan-materials/plan-effects と同じくここに専用実装を置く(rules/brief
 * 注入は他の plan-* と揃える) */
function renderBgmPrompt(dir: string, slots: BgmSlot[], choices: BgmChoice[]): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", "plan-bgm.md"), "utf8");

  const slotLines = slots
    .map((s) =>
      `#${s.id} [${s.start.toFixed(1)}-${s.end.toFixed(1)}] 可視${s.keepSec.toFixed(0)}s ${s.label || ""}`.trim(),
    )
    .join("\n");
  const choiceLines = choices
    .map((c) => `#${c.id} ${c.file}${c.durationSec !== undefined ? ` (${c.durationSec.toFixed(0)}s)` : ""}`)
    .join("\n");

  const rules = readRules(dir);
  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "(見せ場リストなし)";

  return template
    .replaceAll("{{slots}}", () => slotLines)
    .replaceAll("{{choices}}", () => choiceLines)
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

const BGM_ROOT_BASENAMES = ["bgm.mp3", "bgm.m4a", "bgm.wav"];

/** materials/ の音声ファイル ∪ 収録直下 bgm.* を集める(実在集合)。
 * 返すのは収録フォルダからの相対パス */
function collectAudioFiles(dir: string): string[] {
  const out: string[] = [];
  const materialsDir = join(dir, "materials");
  if (existsSync(materialsDir)) {
    for (const f of readdirSync(materialsDir)) {
      const rel = `materials/${f}`;
      if (classifyKind(rel) === "audio") out.push(rel);
    }
  }
  for (const base of BGM_ROOT_BASENAMES) {
    if (existsSync(join(dir, base))) out.push(base);
  }
  return out;
}

export interface PlanBgmResult {
  bgm: Bgm;
  tracks: NonNullable<Bgm["tracks"]>;
  slotCount: number;
  choiceCount: number;
  hasChapters: boolean;
}

/**
 * cutplan(keep/cut境界)+ chapters(あれば)+ 実在音声ファイルから番号付き
 * スロット/曲候補を組み、LLM に (slotId, file) のペアだけを選ばせて
 * bgm.json の下書きを生成する。read/complete/write の殻で、変換の中身は
 * bgmSlots.ts(純関数)に委ねる。
 */
export async function planBgm(dir: string, cfg: Config): Promise<PlanBgmResult> {
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const manifest = readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");
  const chapters = readJsonOrNull<Chapters>(join(dir, "chapters.json"));
  if (!chapters) {
    console.log(
      "chapters.json がありません。大カット境界だけで区間割りします(区間の意味づけは薄くなります)",
    );
  }

  const audioFiles = collectAudioFiles(dir);
  const choices = buildBgmChoices(audioFiles);
  if (choices.length === 0) {
    throw new Error(
      "BGM 候補ファイルが無い(materials/ に音声ファイルを置くか、" +
        "収録フォルダ直下に bgm.mp3 / bgm.m4a / bgm.wav を置いてください)",
    );
  }

  const slotCfg = resolveBgmSlotCfg(cfg);
  const anchors = buildBgmAnchors(cutplan, chapters, manifest.durationSec, slotCfg);
  const slots = anchorsToSlots(anchors, cutplan, slotCfg);
  if (slots.length === 0) {
    throw new Error(
      "BGM を置ける区間スロットが0件です(cutplan.json の keep 区間を確認してください)",
    );
  }

  const prompt = renderBgmPrompt(dir, slots, choices);
  const raw = await completeWithJsonSchema(
    prompt,
    cfg,
    {
      name: "cutflow_plan_bgm",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["assignments"],
        properties: {
          assignments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["slotId", "file", "reason"],
              properties: {
                slotId: { type: "integer" },
                file: { type: ["integer", "null"] },
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
  writeFileSync(join(dir, "plan-bgm.raw.txt"), raw);

  const parsed = parseAssignmentsResponse(raw);
  const tracks = assignmentsToTracks(parsed.assignments, slots, choices);
  const bgm: Bgm = { tracks };

  const loaded: LoadedDocs = {
    manifest,
    cutplan,
    transcript: readJsonOrNull<unknown>(join(dir, "transcript.json")),
    overlays: readJsonOrNull<unknown>(join(dir, "overlays.json")),
    bgm,
    chapters,
    meta: readJsonOrNull<unknown>(join(dir, "meta.json")),
    shorts: readJsonOrNull<unknown>(join(dir, "shorts.json")),
    thumbnail: readJsonOrNull<unknown>(join(dir, "thumbnail.json")),
  };
  const checked = validateDocs(dir, loaded);
  if (checked.errors.length > 0) {
    const lines = checked.errors.map((e) => `  ${e.file} ${e.where}: ${e.message}`);
    throw new Error(
      `生成した bgm が検査に失敗したため書き込みません:\n${lines.join("\n")}`,
    );
  }

  writeFileSync(join(dir, "bgm.json"), JSON.stringify(bgm, null, 2));

  return {
    bgm,
    tracks,
    slotCount: slots.length,
    choiceCount: choices.length,
    hasChapters: chapters !== null,
  };
}
