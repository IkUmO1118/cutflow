// 検査付きアトミック適用(apply コマンド)のコア。
// docs/plans/2026-07-07-atomic-apply-design.md に厳密に従う。
//
// T1(このコミット時点): `@id` 宛先の高水準オペレーション列(EditOp[])を
// ファイル単位の全置換パッチ(ApplyBody)へコンパイルする純関数 compileOps。
// 宛先解決は Feature 2(src/lib/mention.ts)の collectIds/resolveMention を
// そのまま再利用する(mention.ts は無改変)。fs には一切触れない。

import { collectIds, resolveMention } from "./mention.ts";
import type { MentionTarget } from "./mention.ts";
import type { LoadedDocs, Problem } from "../stages/validate.ts";
import type { ApplyBody, EditOp } from "../types.ts";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** compileOps/mergeBodyOverDisk が扱う「apply が書ける7ファイル」の共通キー
 * (ApplyBody のキーと同じ。LoadedDocs ともキー名が一致する) */
export const APPLY_FILE_KEYS = [
  "cutplan",
  "transcript",
  "overlays",
  "chapters",
  "bgm",
  "shorts",
  "thumbnail",
] as const;
export type ApplyFileKey = (typeof APPLY_FILE_KEYS)[number];

/** ApplyFileKey → 収録フォルダ内のファイル名 */
export const APPLY_FILE_NAME: Record<ApplyFileKey, string> = {
  cutplan: "cutplan.json",
  transcript: "transcript.json",
  overlays: "overlays.json",
  chapters: "chapters.json",
  bgm: "bgm.json",
  shorts: "shorts.json",
  thumbnail: "thumbnail.json",
};

/** `@id` 解決先(MentionTarget)の kind → { 所属ファイルのキー, 配列のプロパティ名 }。
 * "captionTrack" と "range"/"short" は file で分岐が要るため別扱い(arraySpecFor 参照) */
const KIND_ARRAY: Partial<Record<string, { bodyKey: ApplyFileKey; arrayKey: string }>> = {
  cutSegment: { bodyKey: "cutplan", arrayKey: "segments" },
  caption: { bodyKey: "transcript", arrayKey: "segments" },
  material: { bodyKey: "overlays", arrayKey: "overlays" },
  insert: { bodyKey: "overlays", arrayKey: "inserts" },
  wipeFull: { bodyKey: "overlays", arrayKey: "wipeFull" },
  hideCaption: { bodyKey: "overlays", arrayKey: "hideCaption" },
  zoom: { bodyKey: "overlays", arrayKey: "zooms" },
  blur: { bodyKey: "overlays", arrayKey: "blurs" },
  chapter: { bodyKey: "chapters", arrayKey: "chapters" },
  bgmTrack: { bodyKey: "bgm", arrayKey: "tracks" },
  thumbnailText: { bodyKey: "thumbnail", arrayKey: "texts" },
};

/**
 * MentionTarget から「所属する配列とそのプロパティ名」を引く。
 * - captionTrack は overlays.json(トラック標準設定)のときだけ対応する。
 *   shorts.json 配下(shorts[].captionTracks)は MentionTarget.index が
 *   ショート内の添字しか持たず、どのショート(shorts[]の添字)かを
 *   一意に復元できない(Feature 2 の MentionTarget はその情報を持たない設計)
 *   ため、set/remove の対象にはできない(全置換パッチ(replace)に委ねる)。
 * - short(ショート自体)は shorts.shorts の直接の添字なので対応できる。
 * - range(shorts[].ranges)は captionTrack と同じ理由で非対応。
 */
function arraySpecFor(
  target: MentionTarget,
): { bodyKey: ApplyFileKey; arrayKey: string } | null {
  if (target.kind === "captionTrack") {
    if (target.file === "overlays.json") return { bodyKey: "overlays", arrayKey: "captionTracks" };
    return null;
  }
  if (target.kind === "short") return { bodyKey: "shorts", arrayKey: "shorts" };
  if (target.kind === "range") return null;
  return KIND_ARRAY[target.kind] ?? null;
}

/** add の target(コレクション選択子)の allow-list。
 * shorts[] 自体・shorts 配下(ranges/captionTracks)は対象外(§スコープ外) */
const ADD_SELECTORS: Record<string, { bodyKey: ApplyFileKey; arrayKey: string }> = {
  "cutplan.segments": { bodyKey: "cutplan", arrayKey: "segments" },
  "transcript.segments": { bodyKey: "transcript", arrayKey: "segments" },
  "overlays.overlays": { bodyKey: "overlays", arrayKey: "overlays" },
  "overlays.inserts": { bodyKey: "overlays", arrayKey: "inserts" },
  "overlays.zooms": { bodyKey: "overlays", arrayKey: "zooms" },
  "overlays.blurs": { bodyKey: "overlays", arrayKey: "blurs" },
  "overlays.wipeFull": { bodyKey: "overlays", arrayKey: "wipeFull" },
  "overlays.hideCaption": { bodyKey: "overlays", arrayKey: "hideCaption" },
  "overlays.captionTracks": { bodyKey: "overlays", arrayKey: "captionTracks" },
  "chapters.chapters": { bodyKey: "chapters", arrayKey: "chapters" },
  "bgm.tracks": { bodyKey: "bgm", arrayKey: "tracks" },
  "thumbnail.texts": { bodyKey: "thumbnail", arrayKey: "texts" },
};

function deepClone<T>(v: T): T {
  return v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** `@id` 未解決・op 不正のエラーメッセージ(AI が自己修正できる粒度) */
function unresolvedMessage(ref: string): string {
  return `${ref} が見つかりません。describe --json か id-stamp で現在の id を確認してください`;
}

const APPROVED_BLOCKED_MESSAGE =
  "approved は apply では変更できません。承認は `approve <dir>` で行ってください";

/** compileOps/mergeBodyOverDisk 共通の「apply が書ける7ファイル」への
 * 変更要約1件(--dry-run 表示・MCP 向け)。ref は @id(set/remove)または
 * add のコレクション選択子。field は set のときだけ付く */
export interface ApplyDiffEntry {
  ref: string;
  file: string;
  field?: string;
  before: unknown;
  after: unknown;
}

export interface CompileOpsResult {
  /** op を適用した結果、実際に触られたファイルだけを含む全置換パッチ */
  body: ApplyBody;
  errors: Problem[];
  diff: ApplyDiffEntry[];
}

/**
 * `@id` 宛先の高水準オペレーション列(EditOp[])を、ディスク現状(docs)を
 * ベースにした全置換パッチ(ApplyBody)へコンパイルする純関数。fs には
 * 一切触れない(docs は呼び出し側が読み込み済みのものを渡す)。
 *
 * 全 op を順に適用し、参照する各ファイルは最初に触られた時点でディスク現状
 * (docs[key])を深く複製してから可変に扱う(呼び出し側の docs は変更しない)。
 * op 単位の中間状態は検査しない(最終状態は呼び出し側が validateDocs で検査する)。
 * 解決失敗・op 不正・approved を触る op は Problem[] へ積んで処理を打ち切る
 * (そのop以降の処理は続くが、そのopの効果は反映されない)。
 */
export function compileOps(docs: LoadedDocs, ops: EditOp[]): CompileOpsResult {
  const errors: Problem[] = [];
  const diff: ApplyDiffEntry[] = [];
  const index = collectIds(docs);
  const draft: Partial<Record<ApplyFileKey, unknown>> = {};

  const ensureDraft = (key: ApplyFileKey): unknown => {
    if (!(key in draft)) {
      draft[key] = deepClone((docs as unknown as Record<string, unknown>)[key] ?? null);
    }
    return draft[key];
  };

  ops.forEach((rawOp, i) => {
    const where = `ops[${i}]`;
    if (!isObj(rawOp)) {
      errors.push({ file: "(patch)", where, message: "op がオブジェクトではありません" });
      return;
    }
    const op = rawOp as unknown as EditOp;
    const opKind = (rawOp as Record<string, unknown>).op;

    if (opKind === "set") {
      const { target, field, value } = op as { op: "set"; target: unknown; field: unknown; value: unknown };
      if (typeof target !== "string" || target === "") {
        errors.push({ file: "(patch)", where: `${where}.target`, message: "target がありません" });
        return;
      }
      if (typeof field !== "string" || field === "") {
        errors.push({ file: "(patch)", where: `${where}.field`, message: "field がありません" });
        return;
      }
      const segs = field.split(".");
      if (segs.some((s) => s === "" || /[[\]]/.test(s))) {
        errors.push({
          file: "(patch)",
          where: `${where}.field`,
          message: `field のパスが不正です(配列添字は未対応): ${field}`,
        });
        return;
      }
      if (segs[0] === "approved") {
        errors.push({ file: "(patch)", where: `${where}.field`, message: APPROVED_BLOCKED_MESSAGE });
        return;
      }
      const resolved = resolveMention(target, index);
      if (!resolved) {
        errors.push({ file: "(patch)", where: `${where}.target`, message: unresolvedMessage(target) });
        return;
      }
      const spec = arraySpecFor(resolved);
      if (!spec) {
        errors.push({
          file: "(patch)",
          where: `${where}.target`,
          message:
            `${target}(${resolved.kind})は set の対象にできません` +
            "(shorts 配下の ranges/captionTracks は replace で編集してください)",
        });
        return;
      }
      const fileDoc = ensureDraft(spec.bodyKey);
      if (!isObj(fileDoc)) {
        errors.push({ file: APPLY_FILE_NAME[spec.bodyKey], where: resolved.path, message: "対象ファイルの形式が不正です" });
        return;
      }
      const arr = fileDoc[spec.arrayKey];
      if (!Array.isArray(arr) || resolved.index < 0 || resolved.index >= arr.length) {
        errors.push({ file: APPLY_FILE_NAME[spec.bodyKey], where: resolved.path, message: "対象要素が見つかりません" });
        return;
      }
      const elem = arr[resolved.index];
      if (!isObj(elem)) {
        errors.push({ file: APPLY_FILE_NAME[spec.bodyKey], where: resolved.path, message: "対象要素がオブジェクトではありません" });
        return;
      }
      let cursor: Record<string, unknown> = elem;
      let broken = false;
      for (let j = 0; j < segs.length - 1; j++) {
        const next = cursor[segs[j]];
        if (!isObj(next)) {
          errors.push({
            file: APPLY_FILE_NAME[spec.bodyKey],
            where: `${resolved.path}.${segs.slice(0, j + 1).join(".")}`,
            message: `中間パスがありません: ${segs.slice(0, j + 1).join(".")}`,
          });
          broken = true;
          break;
        }
        cursor = next;
      }
      if (broken) return;
      const lastKey = segs[segs.length - 1];
      diff.push({ ref: target, file: APPLY_FILE_NAME[spec.bodyKey], field, before: deepClone(cursor[lastKey]), after: deepClone(value) });
      cursor[lastKey] = value;
    } else if (opKind === "remove") {
      const { target } = op as { op: "remove"; target: unknown };
      if (typeof target !== "string" || target === "") {
        errors.push({ file: "(patch)", where: `${where}.target`, message: "target がありません" });
        return;
      }
      const resolved = resolveMention(target, index);
      if (!resolved) {
        errors.push({ file: "(patch)", where: `${where}.target`, message: unresolvedMessage(target) });
        return;
      }
      const spec = arraySpecFor(resolved);
      if (!spec) {
        errors.push({
          file: "(patch)",
          where: `${where}.target`,
          message:
            `${target}(${resolved.kind})は remove の対象にできません` +
            "(shorts 配下の ranges/captionTracks は replace で編集してください)",
        });
        return;
      }
      const fileDoc = ensureDraft(spec.bodyKey);
      if (!isObj(fileDoc)) {
        errors.push({ file: APPLY_FILE_NAME[spec.bodyKey], where: resolved.path, message: "対象ファイルの形式が不正です" });
        return;
      }
      const arr = fileDoc[spec.arrayKey];
      if (!Array.isArray(arr) || resolved.index < 0 || resolved.index >= arr.length) {
        errors.push({ file: APPLY_FILE_NAME[spec.bodyKey], where: resolved.path, message: "対象要素が見つかりません" });
        return;
      }
      const removed = arr[resolved.index];
      diff.push({ ref: target, file: APPLY_FILE_NAME[spec.bodyKey], before: deepClone(removed), after: undefined });
      arr.splice(resolved.index, 1);
    } else if (opKind === "add") {
      const { target, value, at } = op as { op: "add"; target: unknown; value: unknown; at?: unknown };
      if (typeof target !== "string" || !(target in ADD_SELECTORS)) {
        errors.push({
          file: "(patch)",
          where: `${where}.target`,
          message: `add のコレクション選択子が不正です: ${JSON.stringify(target)}(有効: ${Object.keys(ADD_SELECTORS).join(" / ")})`,
        });
        return;
      }
      if (!isObj(value)) {
        errors.push({ file: "(patch)", where: `${where}.value`, message: "add の value はオブジェクトです" });
        return;
      }
      if ("approved" in value) {
        errors.push({ file: "(patch)", where: `${where}.value`, message: APPROVED_BLOCKED_MESSAGE });
        return;
      }
      const sel = ADD_SELECTORS[target];
      const fileDoc = ensureDraft(sel.bodyKey);
      if (!isObj(fileDoc)) {
        errors.push({
          file: APPLY_FILE_NAME[sel.bodyKey],
          where: `${where}.target`,
          message: `${APPLY_FILE_NAME[sel.bodyKey]} がまだ存在しません。先に replace で作成してください`,
        });
        return;
      }
      const arr = fileDoc[sel.arrayKey];
      const list: unknown[] = Array.isArray(arr) ? arr : [];
      fileDoc[sel.arrayKey] = list;
      const insertAt = at === undefined ? list.length : at;
      if (typeof insertAt !== "number" || !Number.isInteger(insertAt) || insertAt < 0 || insertAt > list.length) {
        errors.push({ file: "(patch)", where: `${where}.at`, message: `at の位置が不正です: ${JSON.stringify(at)}` });
        return;
      }
      diff.push({ ref: target, file: APPLY_FILE_NAME[sel.bodyKey], before: undefined, after: deepClone(value) });
      list.splice(insertAt, 0, value);
    } else {
      errors.push({
        file: "(patch)",
        where: `${where}.op`,
        message: `未知の op です: ${JSON.stringify(opKind)}(有効: set / remove / add)`,
      });
    }
  });

  const body: ApplyBody = {};
  for (const key of APPLY_FILE_KEYS) {
    if (key in draft) (body as Record<string, unknown>)[key] = draft[key];
  }
  return { body, errors, diff };
}
