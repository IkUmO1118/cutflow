import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "../lib/llm.ts";
import type { Config } from "../lib/config.ts";
import type {
  AutoCuts,
  Chapters,
  CutPlan,
  Meta,
  PlanSegment,
  Transcript,
} from "../types.ts";

/**
 * LLM で意味的なカット判断(言い直し・脱線)と章立て・タイトル案を作る。
 *
 * LLM に渡すのは detect が出した「残す候補区間」に番号を付けたリストで、
 * LLM は番号単位で cut/keep を判断する。タイムスタンプそのものを LLM に
 * 生成させると数値のでっち上げ(ハルシネーション)が起きるため、
 * 時刻は必ずこちらで管理し、LLM には選択だけをさせる。
 *
 * 出力の cutplan.json は人間が確認・編集して approved を true にするまで
 * render には進めない(見せ場の誤カットを防ぐ承認ゲート)。
 */
export async function plan(dir: string, cfg: Config): Promise<CutPlan> {
  const transcript = readStageJson<Transcript>(
    join(dir, "transcript.json"),
    "transcribe",
  );
  const auto = readStageJson<AutoCuts>(join(dir, "cuts.auto.json"), "detect");

  // 残す候補区間ごとに、重なる文字起こしテキストをまとめて番号を振る
  const numbered = auto.keepSegments.map((k, i) => {
    const texts = transcript.segments
      .filter((s) => s.start < k.end && s.end > k.start)
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    return { id: i + 1, start: k.start, end: k.end, text: texts.join(" ") };
  });
  if (numbered.length === 0) {
    throw new Error("残す候補区間が0件です(detect の結果を確認してください)");
  }

  const prompt = renderPrompt(dir, numbered, auto.originalDurationSec);
  const raw = await complete(prompt, cfg);
  // LLM の生応答は必ず残す(パース失敗時の調査と、判断過程の記録のため)
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  const parsed = parseResponse(raw);

  const cutIds = new Map(parsed.cuts.map((c) => [c.id, c.reason]));
  for (const c of parsed.cuts) {
    if (!numbered.some((n) => n.id === c.id)) {
      console.warn(`警告: LLM が存在しない区間 id=${c.id} を指定(無視します)`);
      cutIds.delete(c.id);
    }
  }

  const segments: PlanSegment[] = numbered.map((n) => ({
    start: n.start,
    end: n.end,
    action: cutIds.has(n.id) ? "cut" : "keep",
    reason: cutIds.get(n.id) ?? "",
  }));

  const cutplan: CutPlan = { approved: false, segments };
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));

  const chapters: Chapters = {
    chapters: parsed.chapters
      .map((c) => {
        const seg = numbered.find((n) => n.id === c.startId);
        if (!seg) {
          console.warn(
            `警告: 章「${c.title}」の開始区間 id=${c.startId} が存在しません(無視します)`,
          );
          return null;
        }
        return { start: seg.start, title: c.title };
      })
      .filter((c) => c !== null),
  };
  writeFileSync(join(dir, "chapters.json"), JSON.stringify(chapters, null, 2));

  const meta: Meta = {
    titles: parsed.titles,
    description: parsed.description,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  return cutplan;
}

/** LLM 応答の期待スキーマ(prompts/plan.md の出力形式と対応) */
interface PlanResponse {
  cuts: { id: number; reason: string }[];
  chapters: { startId: number; title: string }[];
  titles: string[];
  description: string;
}

function renderPrompt(
  dir: string,
  numbered: { id: number; start: number; end: number; text: string }[],
  durationSec: number,
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", "plan.md"), "utf8");

  const segmentLines = numbered
    .map(
      (n) =>
        `#${n.id} [${n.start.toFixed(2)}-${n.end.toFixed(2)}] ${n.text || "(発言なし)"}`,
    )
    .join("\n");

  // 収録フォルダに brief.md(企画ブリーフのコピー)があれば見せ場リストとして渡す
  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath)
    ? readFileSync(briefPath, "utf8")
    : "(見せ場リストなし。カット判断基準に従って判断してください)";

  // replaceAll + 関数形式: 文字列指定の replace は最初の1箇所しか置換されず、
  // また brief に "$&" 等が含まれると置換パターンとして解釈されてしまう
  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief);
}

/** 応答からJSONを取り出す。コードフェンスや前後の説明文が混ざっても拾う */
function parseResponse(raw: string): PlanResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan.raw.txt を確認してください)",
    );
  }
  let parsed: Partial<PlanResponse>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<PlanResponse>;
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan.raw.txt を確認してください)",
    );
  }
  return {
    cuts: parsed.cuts ?? [],
    chapters: parsed.chapters ?? [],
    titles: parsed.titles ?? [],
    description: parsed.description ?? "",
  };
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `${path} がありません。先に ${requiredStage} を実行してください`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
