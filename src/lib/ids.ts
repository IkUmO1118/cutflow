// 安定 id(§docs/plans/2026-07-07-stable-ids-design.md)の採番・引き継ぎの
// 純ロジック。fs には一切触れない(CLI の id-stamp / 生成ステージ / editor 保存の
// 薄いラッパだけが fs を触る)。
//
// 中核原則(opt-in・sticky): プロジェクトに1つでも id があれば「id 有効」。
// id 有効なプロジェクトでのみ生成ステージ・editor 保存が新規要素へ採番し、
// 既存 id を保つ。id が1つも無ければ何も採番しない(バイト等価)。

import type { Bgm, CutPlan, Overlays, Shorts, Thumbnail, Chapters, Transcript } from "../types.ts";

/** 種別 → 接頭辞の単一の出所。types.ts のコメントと validate の期待接頭辞が参照する */
export const ID_PREFIX = {
  cutSegment: "seg",
  caption: "cap",
  material: "mat",
  insert: "ins",
  zoom: "zm",
  blur: "bl",
  wipeFull: "wf",
  hideCaption: "hc",
  captionTrack: "ct",
  chapter: "ch",
  bgmTrack: "bg",
  range: "rg",
  thumbnailText: "tx",
} as const;

/** id の文法: `<prefix>_<base36 6桁>`。prefix は2〜3文字の小文字 */
export const ID_RE = /^[a-z]{2,3}_[0-9a-z]{6}$/;

/** [0-9a-z] の乱数文字列(長さ len) */
function randomBase36(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += Math.floor(Math.random() * 36).toString(36);
  }
  return s;
}

/** 新規 id を1つ作る(既存集合と衝突したら振り直す)。乱数は crypto でなく
 * Math.random で十分(衝突は used で回避、暗号強度は不要)。
 * 生成した id は used に追加する(以降の呼び出しと衝突しないように) */
export function newId(prefix: string, used: Set<string>): string {
  let id: string;
  do {
    id = `${prefix}_${randomBase36(6)}`;
  } while (used.has(id));
  used.add(id);
  return id;
}

/** 配列の各要素に、id が無いものだけ採番(既存 id は不変)。used は
 * 収録全体の id 集合(ファイル間の衝突も防ぐ)。破壊的でなく新配列を返す純関数 */
export function ensureIds<T extends { id?: string }>(
  arr: T[],
  prefix: string,
  used: Set<string>,
): T[] {
  // 既存 id を先に used へ登録しておく(この配列内の新規採番が既存 id と
  // 衝突しないように)
  for (const x of arr) {
    if (x.id !== undefined) used.add(x.id);
  }
  // id は要素の先頭フィールド(types.ts のスキーマ)なので、新規採番時も
  // id を先頭に置く({ id, ...rest } の順。rest 側に id キーが残らないよう
  // 分割で取り除いてから展開する)
  return arr.map((x) => {
    if (x.id !== undefined) return x;
    const { id: _drop, ...rest } = x as { id?: string } & Record<string, unknown>;
    void _drop;
    return { id: newId(prefix, used), ...rest } as T;
  });
}

/** 生成ステージ用: 旧配列の id を、keyFn が一致する新要素へ運ぶ(採番はしない)。
 * plan は keyFn=(x)=>`${start}:${end}`、chapters は title、transcribe は
 * start:end:text。同じ key が複数あっても id を使い回さない(キューで消費)。
 * newArr の要素が既に id を持っていればそのまま(上書きしない) */
export function carryIds<T extends { id?: string }>(
  oldArr: T[],
  newArr: T[],
  keyFn: (x: T) => string,
): T[] {
  const queues = new Map<string, string[]>();
  for (const o of oldArr) {
    if (o.id === undefined) continue;
    const k = keyFn(o);
    const q = queues.get(k);
    if (q) q.push(o.id);
    else queues.set(k, [o.id]);
  }
  return newArr.map((n) => {
    if (n.id !== undefined) return n;
    const q = queues.get(keyFn(n));
    if (q && q.length > 0) {
      const id = q.shift() as string;
      return { ...n, id };
    }
    return n;
  });
}

/** id-stamp / 生成ステージ / editor 保存が共有する「指せる編集ファイル群」の型。
 * meta.json は id を持つ要素が無いため含まない。各ファイルは無ければ null */
export interface EditableDocs {
  cutplan: CutPlan | null;
  transcript: Transcript | null;
  overlays: Overlays | null;
  chapters: Chapters | null;
  bgm: Bgm | null;
  shorts: Shorts | null;
  thumbnail: Thumbnail | null;
}

/** EditableDocs の全「指せる配列」を巡回して id を集める(used への追加・
 * hasAnyId の判定の両方で使う内部ヘルパ) */
function collectExistingIds(docs: EditableDocs, used: Set<string>): void {
  const addAll = (arr?: readonly { id?: string }[] | null): void => {
    for (const x of arr ?? []) {
      if (x.id !== undefined) used.add(x.id);
    }
  };
  addAll(docs.cutplan?.segments);
  addAll(docs.transcript?.segments);
  addAll(docs.overlays?.overlays);
  addAll(docs.overlays?.inserts);
  addAll(docs.overlays?.wipeFull);
  addAll(docs.overlays?.hideCaption);
  addAll(docs.overlays?.zooms);
  addAll(docs.overlays?.blurs);
  addAll(docs.overlays?.captionTracks);
  addAll(docs.chapters?.chapters);
  addAll(docs.bgm?.tracks);
  for (const s of docs.shorts?.shorts ?? []) {
    addAll(s.ranges);
    addAll(s.captionTracks);
  }
  addAll(docs.thumbnail?.texts);
}

/** docs 全体の既存 id 集合を作る(生成ステージが「project 全体で衝突しない
 * used」を得るためのヘルパ。collectExistingIds の公開ラッパ) */
export function usedIdsOf(docs: EditableDocs): Set<string> {
  const used = new Set<string>();
  collectExistingIds(docs, used);
  return used;
}

/** docs のいずれかの指せる要素が id を持つか(opt-in gate) */
export function hasAnyId(docs: EditableDocs): boolean {
  const used = new Set<string>();
  collectExistingIds(docs, used);
  return used.size > 0;
}

/** docs 全体を stamp(id-stamp コマンド・生成・保存が共有)。id が1つでもあれば
 * それを used に含め、全「指せる配列」へ ensureIds を適用した新 docs を返す純関数。
 * 冪等(2回通しても内容は変わらない)。空 docs(全ファイル null)は no-op */
export function stampDocs(docs: EditableDocs): EditableDocs {
  const used = new Set<string>();
  collectExistingIds(docs, used);

  const cutplan = docs.cutplan
    ? { ...docs.cutplan, segments: ensureIds(docs.cutplan.segments, ID_PREFIX.cutSegment, used) }
    : docs.cutplan;

  const transcript = docs.transcript
    ? {
        ...docs.transcript,
        segments: ensureIds(docs.transcript.segments, ID_PREFIX.caption, used),
      }
    : docs.transcript;

  const overlays = docs.overlays
    ? {
        ...docs.overlays,
        overlays: docs.overlays.overlays
          ? ensureIds(docs.overlays.overlays, ID_PREFIX.material, used)
          : docs.overlays.overlays,
        inserts: docs.overlays.inserts
          ? ensureIds(docs.overlays.inserts, ID_PREFIX.insert, used)
          : docs.overlays.inserts,
        wipeFull: docs.overlays.wipeFull
          ? ensureIds(docs.overlays.wipeFull, ID_PREFIX.wipeFull, used)
          : docs.overlays.wipeFull,
        hideCaption: docs.overlays.hideCaption
          ? ensureIds(docs.overlays.hideCaption, ID_PREFIX.hideCaption, used)
          : docs.overlays.hideCaption,
        zooms: docs.overlays.zooms
          ? ensureIds(docs.overlays.zooms, ID_PREFIX.zoom, used)
          : docs.overlays.zooms,
        blurs: docs.overlays.blurs
          ? ensureIds(docs.overlays.blurs, ID_PREFIX.blur, used)
          : docs.overlays.blurs,
        captionTracks: docs.overlays.captionTracks
          ? ensureIds(docs.overlays.captionTracks, ID_PREFIX.captionTrack, used)
          : docs.overlays.captionTracks,
      }
    : docs.overlays;

  const chapters = docs.chapters
    ? { ...docs.chapters, chapters: ensureIds(docs.chapters.chapters, ID_PREFIX.chapter, used) }
    : docs.chapters;

  const bgm = docs.bgm
    ? { ...docs.bgm, tracks: ensureIds(docs.bgm.tracks, ID_PREFIX.bgmTrack, used) }
    : docs.bgm;

  const shorts = docs.shorts
    ? {
        ...docs.shorts,
        shorts: docs.shorts.shorts.map((s) => ({
          ...s,
          ranges: ensureIds(s.ranges, ID_PREFIX.range, used),
          captionTracks: s.captionTracks
            ? ensureIds(s.captionTracks, ID_PREFIX.captionTrack, used)
            : s.captionTracks,
        })),
      }
    : docs.shorts;

  const thumbnail = docs.thumbnail
    ? { ...docs.thumbnail, texts: ensureIds(docs.thumbnail.texts, ID_PREFIX.thumbnailText, used) }
    : docs.thumbnail;

  return { cutplan, transcript, overlays, chapters, bgm, shorts, thumbnail };
}
