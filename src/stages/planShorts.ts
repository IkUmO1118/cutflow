// ショート動画の LLM ハイライト自動選定(plan-shorts コマンド)。
// plan と同じ「番号選択」方式: detect の候補区間に番号を振って LLM に渡し、
// 「各ショートに入れる番号の集合」だけを返させる。時刻は LLM に生成させず、
// 番号 → ranges の変換と尺・番号存在の検証はすべてコード側で行う。
// 生成する全ショートは approved: false 固定(承認は人間の仕事)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "../lib/llm.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { numberSegments, renderPrompt } from "./plan.ts";
import type { NumberedSegment } from "./plan.ts";
import type { Config } from "../lib/config.ts";
import type { AutoCuts, Interval, Short, Shorts, Transcript } from "../types.ts";

/** planShorts.maxDurationSec 未指定時の既定(秒)。T3 で config.ts へ移す */
const DEFAULT_MAX_SEC = 60;

/** LLM 応答スキーマ(prompts/plan-shorts.md の出力形式と対応)。
 * 各ショートに入れる候補区間の番号(ids)だけを受け取り、
 * 番号 → ranges の変換は shortsFromSelection が行う */
export interface ShortSelection {
  name: string;
  ids: number[];
  reason: string;
}

export interface ShortsSelection {
  shorts: ShortSelection[];
}

/**
 * LLM 応答から JSON を取り出してショート選定に整える。plan.ts の parseResponse と
 * 同じ堅牢さ(コードフェンスや前後の説明文が混ざっても最初の { 〜 最後の } を拾う)。
 * 壊れた/欠けたフィールドは握りつぶし、後段(shortsFromSelection)の機械検証に委ねる:
 * - shorts が無い/配列でなければ空配列
 * - ids が配列でなければ空配列、数値以外の要素は落とす
 * - name / reason が文字列でなければ空文字(name の正規化は shortsFromSelection)
 */
export function parseShortsResponse(raw: string): ShortsSelection {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      "LLM 応答に JSON が見つかりません(plan-shorts.raw.txt を確認してください)",
    );
  }
  let parsed: { shorts?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { shorts?: unknown };
  } catch {
    throw new Error(
      "LLM 応答の JSON パースに失敗しました(plan-shorts.raw.txt を確認してください)",
    );
  }
  const list = Array.isArray(parsed.shorts) ? parsed.shorts : [];
  const shorts: ShortSelection[] = list.map((s) => {
    const o = (s ?? {}) as { name?: unknown; ids?: unknown; reason?: unknown };
    const ids = Array.isArray(o.ids)
      ? o.ids.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
    return {
      name: typeof o.name === "string" ? o.name : "",
      ids,
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  });
  return { shorts };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** ranges の合計尺(秒) */
const totalDuration = (ranges: Interval[]): number =>
  round2(ranges.reduce((a, r) => a + (r.end - r.start), 0));

/** name を [a-z0-9_-]+ に正規化する。空になったら short-<index+1> */
function normalizeName(raw: string, index: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `short-${index + 1}`;
}

/** used に無い name を返す。衝突したら -2, -3, ... を足す */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * LLM が返した番号選択(ShortsSelection)を Short[] に変換する純関数。
 * - 存在しない番号は警告して落とす(ハルシネーション耐性: plan と同じ機械検出)。
 * - ranges は開始時刻でソートして mergeIntervals(render.ts の
 *   mergeIntervals(short.ranges) と同じ=ショートは元収録の時間順にしか並ばない)。
 * - 尺合計が maxSec を超えたら末尾 range を落とす(残り1区間で削れないときは警告)。
 * - name は正規化し、収録内で重複しないようにする。
 * - approved は必ず false(承認は人間の仕事。AI が true にしない)。
 * 有効な区間が1つも無いショートは飛ばす(shorts.json は ranges 1件以上が必須)。
 */
export function shortsFromSelection(
  numbered: NumberedSegment[],
  parsed: ShortsSelection,
  maxSec: number,
): Short[] {
  const byId = new Map(numbered.map((n) => [n.id, n]));
  const usedNames = new Set<string>();
  const result: Short[] = [];

  parsed.shorts.forEach((sel, i) => {
    const label = sel.name || `#${i + 1}`;
    const picked: Interval[] = [];
    for (const id of sel.ids) {
      const seg = byId.get(id);
      if (!seg) {
        console.warn(
          `警告: ショート "${label}" が存在しない区間 id=${id} を指定(無視します)`,
        );
        continue;
      }
      picked.push({ start: seg.start, end: seg.end });
    }
    if (picked.length === 0) {
      console.warn(`警告: ショート "${label}" は有効な区間が無いので飛ばします`);
      return;
    }

    picked.sort((a, b) => a.start - b.start);
    const merged = mergeIntervals(picked);
    let ranges = merged;
    while (ranges.length > 1 && totalDuration(ranges) > maxSec) {
      ranges = ranges.slice(0, -1);
    }
    if (ranges.length < merged.length) {
      console.warn(
        `警告: ショート "${label}" が ${maxSec}秒を超えるため末尾 ` +
          `${merged.length - ranges.length} 区間を落としました`,
      );
    }
    if (totalDuration(ranges) > maxSec) {
      console.warn(
        `警告: ショート "${label}" は ${totalDuration(ranges)}秒で ${maxSec}秒を` +
          "超えています(単一区間で削れません。人間が調整してください)",
      );
    }

    const name = uniqueName(normalizeName(sel.name, i), usedNames);
    usedNames.add(name);
    result.push({ name, profile: "vertical", approved: false, ranges });
  });

  return result;
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `${path} がありません。先に ${requiredStage} を実行してください`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * transcript + detect の候補区間から、ショート向きの見せ場を LLM に番号選択
 * させて shorts.json の下書きを生成する。read/complete/write の殻で、変換の
 * 中身は shortsFromSelection(純関数)に委ねる。番号母集合は detect の
 * keepSegments(本編でカットした素材も候補に入る)。
 */
export async function planShorts(dir: string, cfg: Config): Promise<Shorts> {
  const transcript = readStageJson<Transcript>(
    join(dir, "transcript.json"),
    "transcribe",
  );
  const auto = readStageJson<AutoCuts>(join(dir, "cuts.auto.json"), "detect");

  const numbered = numberSegments(auto.keepSegments, transcript);
  if (numbered.length === 0) {
    throw new Error("候補区間が0件です(detect の結果を確認してください)");
  }

  const prompt = renderPrompt(
    dir,
    "plan-shorts.md",
    numbered,
    auto.originalDurationSec,
  );
  const raw = await complete(prompt, cfg);
  // LLM の生応答は必ず残す(パース失敗時の調査と、選定過程の記録のため)
  writeFileSync(join(dir, "plan-shorts.raw.txt"), raw);

  const parsed = parseShortsResponse(raw);
  const maxSec =
    (cfg as { planShorts?: { maxDurationSec?: number } }).planShorts
      ?.maxDurationSec ?? DEFAULT_MAX_SEC;
  const shorts = shortsFromSelection(numbered, parsed, maxSec);

  const out: Shorts = { shorts };
  writeFileSync(join(dir, "shorts.json"), JSON.stringify(out, null, 2));
  return out;
}
