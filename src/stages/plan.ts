import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "../lib/llm.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { carryIds, ensureIds, hasAnyId, ID_PREFIX, usedIdsOf } from "../lib/ids.ts";
import { readEditableDocs } from "./idStamp.ts";
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

/**
 * このプロジェクトで id が有効(§docs/plans/2026-07-07-stable-ids-design.md の
 * opt-in・sticky 原則)なら、cutplan.segments への carryIds 用の既存配列と、
 * project 全体で衝突しない used 集合を返す。無効なら undefined(=生成ステージは
 * 一切 id に触れず、出力は導入前とバイト等価)。
 */
function buildIdContext(
  dir: string,
): { used: Set<string>; existingCutplanSegments: PlanSegment[] } | undefined {
  const docs = readEditableDocs(dir);
  if (!hasAnyId(docs)) return undefined;
  return { used: usedIdsOf(docs), existingCutplanSegments: docs.cutplan?.segments ?? [] };
}

/** 残す候補区間 + 重なる文字起こしテキストに番号を振ったもの(LLM 入力用)。
 * plan-shorts でも同じ番号選択方式で流用する(planShorts.ts) */
export interface NumberedSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** 区間ごとに重なる文字起こしをまとめ、1始まりの番号を振る */
export function numberSegments(
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

/** plan のオプション */
export interface PlanOptions {
  /** true のとき cutplan.json / plan.raw.txt だけを書く(章・タイトル・
   * 概要欄・章テロップには一切触らない)。run の内訳を直交なコマンドに
   * 分解する用途(transcribe=テロップ / detect+plan --cuts-only=カット /
   * remeta=章・メタ) */
  cutsOnly?: boolean;
}

/** buildCutplan の id 引き継ぎ用コンテキスト(§buildIdContext 参照)。
 * 省略時(undefined)は id に一切触れない(=導入前とバイト等価) */
export interface CutplanIdContext {
  /** 直前の cutplan.json の segments(span 一致で id を運ぶ元) */
  existingSegments: PlanSegment[];
  /** project 全体で衝突しない used 集合(呼び出しごとに変異する) */
  used: Set<string>;
}

/** LLM 応答からカット判断を反映した cutplan を組み立てる(存在しない id は無視)。
 * idCtx があれば、span(start:end)一致で旧 segments.id を運び(carryIds)、
 * 残りを採番する(ensureIds)。span が変わった segment は新 id になる(要件どおり) */
export function buildCutplan(
  numbered: NumberedSegment[],
  cuts: { id: number; reason: string }[],
  idCtx?: CutplanIdContext,
): CutPlan {
  const cutIds = new Map(cuts.map((c) => [c.id, c.reason]));
  for (const c of cuts) {
    if (!numbered.some((n) => n.id === c.id)) {
      console.warn(`警告: LLM が存在しない区間 id=${c.id} を指定(無視します)`);
      cutIds.delete(c.id);
    }
  }

  let segments: PlanSegment[] = numbered.map((n) => ({
    start: n.start,
    end: n.end,
    action: cutIds.has(n.id) ? "cut" : "keep",
    reason: cutIds.get(n.id) ?? "",
  }));

  if (idCtx) {
    segments = carryIds(idCtx.existingSegments, segments, (s) => `${s.start}:${s.end}`);
    segments = ensureIds(segments, ID_PREFIX.cutSegment, idCtx.used);
  }

  return { approved: false, segments };
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
 *
 * `opts.cutsOnly` を指定すると、カット判断だけを LLM に求め、
 * cutplan.json / plan.raw.txt だけを書く(chapters / meta / transcript の
 * 章テロップ / overlays の章トラック定義には触らない)。
 */
export async function plan(
  dir: string,
  cfg: Config,
  opts: PlanOptions = {},
): Promise<CutPlan> {
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

  // id が有効なプロジェクトでのみ既存 id を運ぶ(§buildIdContext)。
  // 上書き前(cutplan.json 等を読むだけ)に一度だけ判定する
  const idCtx = buildIdContext(dir);

  const templateFile = opts.cutsOnly ? "plan-cuts.md" : "plan.md";
  const prompt = renderPrompt(dir, templateFile, numbered, auto.originalDurationSec);
  const raw = await complete(prompt, cfg);
  // LLM の生応答は必ず残す(パース失敗時の調査と、判断過程の記録のため)
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  if (opts.cutsOnly) {
    const parsed = parseCutsResponse(raw);
    const cutplan = buildCutplan(
      numbered,
      parsed.cuts,
      idCtx && { existingSegments: idCtx.existingCutplanSegments, used: idCtx.used },
    );
    writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));
    return cutplan;
  }

  const parsed = parseResponse(raw);
  const cutplan = buildCutplan(
    numbered,
    parsed.cuts,
    idCtx && { existingSegments: idCtx.existingCutplanSegments, used: idCtx.used },
  );
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));

  writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg, idCtx && { used: idCtx.used });

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

  // id が有効なプロジェクトでのみ既存 id を運ぶ(§buildIdContext)。remeta は
  // cutplan.segments を書かないため existingCutplanSegments は使わない
  const idCtx = buildIdContext(dir);

  const prompt = renderPrompt(dir, "meta.md", numbered, manifest.durationSec);
  const raw = await complete(prompt, cfg);
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  const parsed = parseResponse(raw);
  return writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg, idCtx && { used: idCtx.used });
}

/** writeChaptersAndMeta / writeChapterTelops の id 引き継ぎ用コンテキスト。
 * 省略時(undefined)は id に一切触れない */
export interface ChaptersIdContext {
  used: Set<string>;
}

/**
 * LLM 応答の章の配列を組み立てる純関数(fs 非依存)。idCtx があれば、
 * title 一致(trim 後)で旧 chapters.chapters の id を運び(carryIds)、
 * 残りを採番する(ensureIds)。
 */
export function buildChapterEntries(
  parsedChapters: { startId: number; title: string }[],
  numbered: NumberedSegment[],
  existingChapters: Chapters["chapters"],
  idCtx?: ChaptersIdContext,
): Chapters["chapters"] {
  let entries: Chapters["chapters"] = parsedChapters
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
    .filter((c): c is Chapters["chapters"][number] => c !== null);

  if (idCtx) {
    entries = carryIds(existingChapters, entries, (c) => c.title.trim());
    entries = ensureIds(entries, ID_PREFIX.chapter, idCtx.used);
  }
  return entries;
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
  idCtx?: ChaptersIdContext,
): Meta {
  const chaptersPath = join(dir, "chapters.json");
  const existingChapters: Chapters["chapters"] = existsSync(chaptersPath)
    ? ((JSON.parse(readFileSync(chaptersPath, "utf8")) as Chapters).chapters ?? [])
    : [];
  const chapters: Chapters = {
    chapters: buildChapterEntries(parsed.chapters, numbered, existingChapters, idCtx),
  };
  writeFileSync(chaptersPath, JSON.stringify(chapters, null, 2));
  writeChapterTelops(dir, transcript, chapters, cfg, idCtx);

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
/**
 * 章トラックのテロップ配列を組み立てる純関数(fs 非依存)。idCtx があれば、
 * title 一致(trim 後)で旧「章」トラックのテロップの id を運び(carryIds)、
 * 残りを採番する(ensureIds)。
 */
export function buildChapterTelopEntries(
  chapters: Chapters,
  track: number,
  chapterCardSec: number,
  existingTelops: TranscriptSegment[],
  idCtx?: ChaptersIdContext,
): TranscriptSegment[] {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let telops: TranscriptSegment[] = chapters.chapters.map((c) => ({
    start: c.start,
    end: round2(c.start + chapterCardSec),
    text: c.title,
    track,
  }));
  if (idCtx) {
    telops = carryIds(existingTelops, telops, (s) => s.text.trim());
    telops = ensureIds(telops, ID_PREFIX.caption, idCtx.used);
  }
  return telops;
}

function writeChapterTelops(
  dir: string,
  transcript: Transcript,
  chapters: Chapters,
  cfg: Config,
  idCtx?: ChaptersIdContext,
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
  const existingTelops = transcript.segments.filter((s) => captionTrack(s) === track);
  const telops = buildChapterTelopEntries(
    chapters,
    track,
    cfg.render.chapterCardSec,
    existingTelops,
    idCtx,
  );
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

/**
 * channel(このシリーズ全体)/ recording(この収録だけ)の rules 本文を受け、
 * プロンプトへ注入する1ブロックを返す純関数(ディスク非依存・テスト対象)。
 *
 * 両方 null/空 → "" を返す(= renderPrompt の出力を rules 不在時と完全一致
 * させるための不変条件の核。呼び出し側はこの値をそのまま {{rules}} に
 * replaceAll するだけでよい)。
 *
 * あるものだけを見出し付きで連結し、返り値には先頭 `\n`・末尾 `\n` を必ず
 * 付ける(テンプレ側の `{{rules}}` は前後を改行で挟まれた1行として置かれる
 * ため)。両方あるときだけ「チャンネル共通」「この収録だけ」の2小見出しに
 * 分け、収録固有が優先される旨を注記する。
 */
export function renderRulesBlock(
  channel: string | null,
  recording: string | null,
): string {
  const c = channel?.trim() || null;
  const r = recording?.trim() || null;
  if (!c && !r) return "";

  const parts: string[] = ["## チャンネル方針(このシリーズの恒久的な編集ルール)"];
  if (c && r) {
    parts.push(`### 全収録共通のルール\n\n${c}`);
    parts.push(`### この収録だけのルール\n\n${r}`);
    parts.push("※ 収録固有の指示が共通ルールと矛盾する場合は収録固有を優先");
  } else if (c) {
    parts.push(c);
  } else {
    parts.push(`### この収録だけのルール\n\n${r}`);
  }
  return `\n${parts.join("\n\n")}\n`;
}

/** channel(=収録フォルダの親)と収録固有の rules.md を読んで連結する
 * (非純粋な薄いラッパ。純関数本体は renderRulesBlock) */
function readRules(dir: string): string {
  const channelPath = join(dirname(dir), "rules.md");
  const recordingPath = join(dir, "rules.md");
  const channel = existsSync(channelPath) ? readFileSync(channelPath, "utf8").trim() : null;
  const recording = existsSync(recordingPath)
    ? readFileSync(recordingPath, "utf8").trim()
    : null;
  return renderRulesBlock(channel || null, recording || null);
}

export function renderPrompt(
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

  const rules = readRules(dir);

  // replaceAll + 関数形式: 文字列指定の replace は最初の1箇所しか置換されず、
  // また brief に "$&" 等が含まれると置換パターンとして解釈されてしまう
  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules);
}

/** cuts-only 応答の期待スキーマ(prompts/plan-cuts.md の出力形式と対応) */
interface CutsResponse {
  cuts: { id: number; reason: string }[];
}

/** 応答からJSONオブジェクトを取り出す。コードフェンスや前後の説明文が混ざっても拾う */
function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan.raw.txt を確認してください)",
    );
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan.raw.txt を確認してください)",
    );
  }
}

function parseResponse(raw: string): PlanResponse {
  const parsed = extractJsonObject(raw) as Partial<PlanResponse>;
  return {
    cuts: parsed.cuts ?? [],
    chapters: parsed.chapters ?? [],
    titles: parsed.titles ?? [],
    description: parsed.description ?? "",
  };
}

/** cuts-only 応答のパース(plan --cuts-only 用。cuts だけが必須) */
export function parseCutsResponse(raw: string): CutsResponse {
  const parsed = extractJsonObject(raw) as Partial<CutsResponse>;
  return { cuts: parsed.cuts ?? [] };
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `${path} がありません。先に ${requiredStage} を実行してください`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
