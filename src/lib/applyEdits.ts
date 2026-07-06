// 検査付きアトミック適用(apply コマンド)のコア。
// docs/plans/2026-07-07-atomic-apply-design.md に厳密に従う。
//
// T1: `@id` 宛先の高水準オペレーション列(EditOp[])をファイル単位の全置換
// パッチ(ApplyBody)へコンパイルする純関数 compileOps。宛先解決は Feature 2
// (src/lib/mention.ts)の collectIds/resolveMention をそのまま再利用する
// (mention.ts は無改変)。
// T2: 「body をディスク現状へ重ねた LoadedDocs を作る」写像
// (mergeBodyOverDisk)。editor/server.ts の saveProject(§735–745 相当)と
// CLI apply が共有する唯一の merge(§論点3)。
// T3: アトミック適用のコア本体。planApply(相1: 読むだけ・検査だけ・書かない)/
// applyEdits(相2: errors ゼロのときだけ backup→tmp/rename で全書き込み)。
// approved(cutplan/short)は常にディスク現状の値へ強制する(apply では承認を
// 変更できない=§不変条件2)。process.exit・console には一切依存しない
// (§論点7 MCP seam)。

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupEditableFiles } from "./backup.ts";
import { fileRole } from "./files.ts";
import { hasAnyId, stampDocs, usedIdsOf } from "./ids.ts";
import type { EditableDocs } from "./ids.ts";
import { readEditableDocs } from "../stages/idStamp.ts";
import { collectIds, resolveMention } from "./mention.ts";
import type { MentionTarget } from "./mention.ts";
import { validateDocs } from "../stages/validate.ts";
import type { LoadedDocs, Problem } from "../stages/validate.ts";
import type { ApplyBody, ApplyPatch, EditOp, Short } from "../types.ts";

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

/**
 * body(SaveRequest/ApplyBody 相当)をディスクの現状へ重ねた LoadedDocs を作る
 * 純関数(dir は各ファイルの現状読み込みにだけ使う)。validateDocs の入力形を
 * 作るのが役目。CLI apply と editor /api/save(saveProject)が共有する唯一の
 * merge(§論点3)。
 *
 * cutplan/transcript/overlays/chapters/thumbnail は `??`(body に無ければ
 * ディスク現状)、bgm/shorts は `!== undefined`(`null` = 削除シグナルを
 * ディスク現状へフォールバックさせず区別する)。この使い分けは
 * editor/server.ts の旧 saveProject(§735–745)のインライン実装と完全に同じ
 * (キー集合・読み込み順・`??`/`!== undefined` の使い分けを1文字も変えていない
 * =抽出前後でバイト等価)。
 */
export function mergeBodyOverDisk(dir: string, body: ApplyBody): LoadedDocs {
  const readDisk = (file: string): unknown => {
    const p = join(dir, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  return {
    manifest: readDisk("manifest.json"),
    cutplan: body.cutplan ?? readDisk("cutplan.json"),
    transcript: body.transcript ?? readDisk("transcript.json"),
    overlays: body.overlays ?? readDisk("overlays.json"),
    bgm: body.bgm !== undefined ? body.bgm : readDisk("bgm.json"),
    chapters: body.chapters ?? readDisk("chapters.json"),
    meta: readDisk("meta.json"),
    shorts: body.shorts !== undefined ? body.shorts : readDisk("shorts.json"),
    thumbnail: body.thumbnail ?? readDisk("thumbnail.json"),
  };
}

/** dir から LoadedDocs を読む(cutplan.json/transcript.json は必須。無い/JSON
 * 破損は Problem として errors に積む)。src/stages/validate.ts の readJson と
 * 同じ方針の薄い読み込み(承認鮮度警告・frames 陳腐化警告は付けない=
 * validateDocs の入力形を作るだけの役目) */
function readDiskDocs(dir: string): { docs: LoadedDocs; errors: Problem[] } {
  const errors: Problem[] = [];
  const readJson = (file: string, required: boolean): unknown => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (required) {
        errors.push({
          file,
          where: "-",
          message: "ファイルがありません。先にパイプライン(run)を実行してください",
        });
      }
      return null;
    }
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      errors.push({ file, where: "-", message: `JSON として読めません: ${(e as Error).message}` });
      return null;
    }
  };
  const docs: LoadedDocs = {
    manifest: readJson("manifest.json", true),
    cutplan: readJson("cutplan.json", true),
    transcript: readJson("transcript.json", true),
    overlays: readJson("overlays.json", false),
    bgm: readJson("bgm.json", false),
    chapters: readJson("chapters.json", false),
    meta: readJson("meta.json", false),
    shorts: readJson("shorts.json", false),
    thumbnail: readJson("thumbnail.json", false),
  };
  return { docs, errors };
}

/**
 * cutplan.json/shorts.json の `approved` を必ずディスク現状の値へ強制する
 * (§不変条件2)。呼び出し側が異なる値を指定していればエラーを積む
 * (「差分を検出したら拒否する」§論点6)。body を直接 mutate せず新しい
 * オブジェクトを返す。shorts は name で disk 上の対応するショートを探し、
 * 見つからない(=新規ショート)場合は「未承認(false)」を強制する
 */
function enforceApprovedUnchanged(disk: LoadedDocs, body: ApplyBody, errors: Problem[]): ApplyBody {
  const next: ApplyBody = { ...body };

  if (next.cutplan !== undefined) {
    const diskCutplan = disk.cutplan;
    const diskApproved =
      isObj(diskCutplan) && typeof diskCutplan.approved === "boolean" ? diskCutplan.approved : undefined;
    if (diskApproved !== undefined) {
      if (typeof next.cutplan.approved === "boolean" && next.cutplan.approved !== diskApproved) {
        errors.push({ file: "cutplan.json", where: "approved", message: APPROVED_BLOCKED_MESSAGE });
      }
      next.cutplan = { ...next.cutplan, approved: diskApproved };
    }
  }

  if (next.shorts !== undefined && next.shorts !== null) {
    const diskShorts = disk.shorts;
    const diskList: Short[] =
      isObj(diskShorts) && Array.isArray(diskShorts.shorts) ? (diskShorts.shorts as Short[]) : [];
    const forced = next.shorts.shorts.map((s) => {
      const diskApproved = diskList.find((d) => d.name === s.name)?.approved ?? false;
      if (typeof s.approved === "boolean" && s.approved !== diskApproved) {
        errors.push({
          file: "shorts.json",
          where: `shorts(name="${s.name}")`,
          message: APPROVED_BLOCKED_MESSAGE,
        });
      }
      return { ...s, approved: diskApproved };
    });
    next.shorts = { ...next.shorts, shorts: forced };
  }

  return next;
}

/**
 * id が有効なプロジェクト(EDITABLE_FILES のいずれかの要素に既に id がある)
 * でのみ、body が touch した各ファイルの新規要素(id 無し。主に add op が
 * 作った要素)に採番する。既存の id 採番経路(stampDocs。src/lib/ids.ts)を
 * そのまま通すだけで、opt-in/sticky の規約は変えない(§スコープ外)。
 * touch していないファイルは(disk 上に id 無し要素があっても)一切変更しない
 * (apply が触っていないファイルは1バイトも変えない、という原則を優先する)
 */
function stampNewElements(dir: string, body: ApplyBody): ApplyBody {
  const idDocs = readEditableDocs(dir);
  if (!hasAnyId(idDocs)) return body;
  const used = usedIdsOf(idDocs);
  const candidate: EditableDocs = {
    cutplan: body.cutplan !== undefined ? body.cutplan : idDocs.cutplan,
    transcript: body.transcript !== undefined ? body.transcript : idDocs.transcript,
    overlays: body.overlays !== undefined ? body.overlays : idDocs.overlays,
    chapters: body.chapters !== undefined ? body.chapters : idDocs.chapters,
    bgm: body.bgm !== undefined ? body.bgm : idDocs.bgm,
    shorts: body.shorts !== undefined ? body.shorts : idDocs.shorts,
    thumbnail: body.thumbnail !== undefined ? body.thumbnail : idDocs.thumbnail,
  };
  const stamped = stampDocs(candidate);
  const next: ApplyBody = { ...body };
  for (const key of APPLY_FILE_KEYS) {
    if (key in body) (next as Record<string, unknown>)[key] = stamped[key];
  }
  return next;
}

/** planApply(相1)の結果。--dry-run の表示にも、applyEdits(相2)の書き込み
 * 判定にもそのまま使う */
export interface ApplyPlan {
  /** 検査を通した(まだ書いていない)最終 body。op はここでコンパイル済み・
   * id 有効プロジェクトなら新規要素の id 採番も済んでいる */
  body: ApplyBody;
  /** 実際に変わる編集ファイル(相対名)。空なら no-op */
  changedFiles: string[];
  /** @id 単位の変更要約(--dry-run 表示・MCP 向け) */
  diff: ApplyDiffEntry[];
  errors: Problem[];
  warnings: Problem[];
}

export interface ApplyResult {
  /** 実際に書いたファイル(相対名)。errors 時は空 */
  written: string[];
  backupDir: string | null;
  plan: ApplyPlan;
}

/**
 * 相1(検査・書かない)。dir の編集ファイルを読み、patch.ops を全置換パッチへ
 * コンパイルし(compileOps)、patch.replace を重ね、approved をディスク現状へ
 * 強制し(enforceApprovedUnchanged)、id 採番(stampNewElements)を経た最終
 * body を作って validateDocs で検査する。**ファイルシステムへは read しか
 * 行わない**(errors の有無に関わらず一切書かない)。
 */
export function planApply(dir: string, patch: ApplyPatch): ApplyPlan {
  if (!isObj(patch)) {
    return {
      body: {},
      changedFiles: [],
      diff: [],
      errors: [{ file: "(patch)", where: "-", message: "パッチがオブジェクトではありません" }],
      warnings: [],
    };
  }

  const errors: Problem[] = [];
  const { docs, errors: readErrors } = readDiskDocs(dir);
  errors.push(...readErrors);

  let ops: EditOp[] = [];
  if (patch.ops !== undefined) {
    if (!Array.isArray(patch.ops)) {
      errors.push({ file: "(patch)", where: "ops", message: "ops は配列です" });
    } else {
      ops = patch.ops;
    }
  }
  const { body: opsBody, errors: opsErrors, diff } = compileOps(docs, ops);
  errors.push(...opsErrors);

  let replace: ApplyBody = {};
  if (patch.replace !== undefined) {
    if (!isObj(patch.replace)) {
      errors.push({ file: "(patch)", where: "replace", message: "replace はオブジェクトです" });
    } else {
      replace = patch.replace;
    }
  }

  let body: ApplyBody = { ...opsBody, ...replace };
  body = enforceApprovedUnchanged(docs, body, errors);
  body = stampNewElements(dir, body);

  const merged = mergeBodyOverDisk(dir, body);
  const { errors: valErrors, warnings } = validateDocs(dir, merged);
  errors.push(...valErrors);

  const changedFiles = APPLY_FILE_KEYS.filter((k) => k in body).map((k) => APPLY_FILE_NAME[k]);

  return { body, changedFiles, diff, errors, warnings };
}

/**
 * 相2(書き込み)。planApply を呼び、errors があれば1バイトも書かずに返す
 * (§不変条件3)。無ければ backupEditableFiles で変更対象ファイルの現状を
 * backups/<日時>/ へ退避してから、変更のある編集ファイルだけを `<file>.tmp` →
 * renameSync で確定する(torn write を排除)。approvals.json は一切書かない
 * (§不変条件1)。process.exit・console は使わない(§論点7 MCP seam)。
 */
export function applyEdits(dir: string, patch: ApplyPatch): ApplyResult {
  const plan = planApply(dir, patch);
  if (plan.errors.length > 0) return { written: [], backupDir: null, plan };

  const touchedKeys = APPLY_FILE_KEYS.filter((k) => k in plan.body);
  if (touchedKeys.length === 0) return { written: [], backupDir: null, plan };

  const files = touchedKeys.map((k) => APPLY_FILE_NAME[k]);
  const backupDir = backupEditableFiles(dir, files);

  const written: string[] = [];
  for (const key of touchedKeys) {
    const file = APPLY_FILE_NAME[key];
    // 安全側の防御(構造的に起こり得ない): APPLY_FILE_NAME は固定7ファイルのみで
    // approvals.json(fileRole "approval")・GENERATED_FILES(fileRole "generated")
    // のいずれとも重ならない(§不変条件1・5)
    const role = fileRole(file);
    if (role === "approval" || role === "generated") {
      throw new Error(`apply が書き込めないファイルです(${role}): ${file}`);
    }
    const value = (plan.body as Record<string, unknown>)[key];
    const abs = join(dir, file);
    if (value === null) {
      // bgm.json / shorts.json の削除シグナル(saveProject と同じセマンティクス)
      if (existsSync(abs)) rmSync(abs);
    } else {
      const tmp = `${abs}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, abs);
    }
    written.push(file);
  }
  return { written, backupDir, plan };
}
