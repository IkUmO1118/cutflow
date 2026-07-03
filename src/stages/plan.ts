import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "../lib/llm.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import type { Config } from "../lib/config.ts";
import { captionTrack } from "../types.ts";
import type {
  AutoCuts,
  Chapters,
  CutPlan,
  Interval,
  Meta,
  Overlays,
  PlanSegment,
  Transcript,
  TranscriptSegment,
} from "../types.ts";

/** 残す候補区間 + 重なる文字起こしテキストに番号を振ったもの(LLM 入力用) */
interface NumberedSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** 区間ごとに重なる文字起こしをまとめ、1始まりの番号を振る */
function numberSegments(
  segments: Interval[],
  transcript: Transcript,
): NumberedSegment[] {
  return segments.map((k, i) => {
    const texts = transcript.segments
      .filter((s) => s.start < k.end && s.end > k.start)
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    return { id: i + 1, start: k.start, end: k.end, text: texts.join(" ") };
  });
}

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
  const numbered = numberSegments(auto.keepSegments, transcript);
  if (numbered.length === 0) {
    throw new Error("残す候補区間が0件です(detect の結果を確認してください)");
  }

  const prompt = renderPrompt(dir, "plan.md", numbered, auto.originalDurationSec);
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

  writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg);

  return cutplan;
}

/**
 * 章立て・タイトル案・概要欄だけを作り直す(cutplan.json は触らない)。
 *
 * plan と違い、カット判断はすでに終わっている前提で、**現在の cutplan の
 * keep 区間**(=完成動画の中身)を LLM に見せて章・タイトル・概要欄だけを
 * 生成する。「カットは手編集済みだがタイトル案だけ作り直したい」ケース用。
 * cutplan.json は読むだけで書き換えないので、カットの手編集は保たれる。
 */
export async function remeta(dir: string, cfg: Config): Promise<Meta> {
  const transcript = readStageJson<Transcript>(
    join(dir, "transcript.json"),
    "transcribe",
  );
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const manifest = readStageJson<{ durationSec: number }>(
    join(dir, "manifest.json"),
    "ingest",
  );

  // 完成動画の中身 = cutplan の keep 区間(割れている keep は繋いで扱う)
  const keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
  const numbered = numberSegments(keeps, transcript);
  if (numbered.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  const prompt = renderPrompt(dir, "meta.md", numbered, manifest.durationSec);
  const raw = await complete(prompt, cfg);
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  const parsed = parseResponse(raw);
  return writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg);
}

/**
 * LLM 応答の章・タイトル・概要欄を chapters.json / meta.json と「章」トラックの
 * テロップ(transcript.json)へ書き出す。plan と remeta で共有する。
 */
function writeChaptersAndMeta(
  dir: string,
  transcript: Transcript,
  numbered: NumberedSegment[],
  parsed: PlanResponse,
  cfg: Config,
): Meta {
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
  writeChapterTelops(dir, transcript, chapters, cfg);

  const meta: Meta = { titles: parsed.titles, description: parsed.description };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * 章タイトルを通常テロップとして transcript.json に書く。章は描画上も編集上も
 * ただのテロップで、chapters.json は YouTube チャプター用のメタデータとして
 * だけ残る。テロップは「章」という名前の専用テロップトラックに置き、
 * トラックの標準位置を左上(旧・章カードの位置)にする(overlays.json)。
 * plan を再実行したときは、このトラックのテロップだけを作り直す
 * (他のトラックのテロップ手編集は保たれる)。
 */
function writeChapterTelops(
  dir: string,
  transcript: Transcript,
  chapters: Chapters,
  cfg: Config,
): void {
  const overlaysPath = join(dir, "overlays.json");
  const overlays: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};
  const tracks = overlays.captionTracks ?? [];
  let def = tracks.find((t) => t.name === "章");
  if (!def) {
    const track =
      Math.max(
        1,
        ...transcript.segments.map(captionTrack),
        ...tracks.map((t) => t.track),
      ) + 1;
    def = {
      track,
      name: "章",
      x: cfg.render.wipeMarginPx,
      y: cfg.render.wipeMarginPx,
      anchor: "topLeft",
    };
    overlays.captionTracks = [...tracks, def];
    writeFileSync(overlaysPath, JSON.stringify(overlays, null, 2));
  }
  const track = def.track;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const telops: TranscriptSegment[] = chapters.chapters.map((c) => ({
    start: c.start,
    end: round2(c.start + cfg.render.chapterCardSec),
    text: c.title,
    track,
  }));
  const segments = [
    ...transcript.segments.filter((s) => captionTrack(s) !== track),
    ...telops,
  ].sort((a, b) => a.start - b.start);
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({ ...transcript, segments }, null, 2),
  );
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
  templateFile: string,
  numbered: NumberedSegment[],
  durationSec: number,
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", templateFile), "utf8");

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
