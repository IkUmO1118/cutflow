// @-mention 解決の純ロジック(§docs/plans/2026-07-07-stable-ids-design.md 論点4)。
// fs 非依存。validate の LoadedDocs(パース済み・型は unknown)を入力に取り、
// id→所在(MentionTarget)の索引を作る。今回の実消費者は validate(重複検査。
// collectIdOccurrences)と describe --json(id 露出)。編集を書き戻す経路
// (Feature 4)は今回のスコープ外。

import type { LoadedDocs } from "../stages/validate.ts";

/** id/name が指す所在。file はプロジェクト内の相対ファイル名、path は
 * 表示・ログ用の人間可読パス、index は対象配列の添字(short は shorts[] の添字) */
export interface MentionTarget {
  file: string;
  kind: string;
  path: string;
  index: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 1配列を巡回し、id を持つ要素があれば (id, target) を push する */
function collectFromArray(
  arr: unknown,
  file: string,
  kind: string,
  pathOf: (i: number) => string,
  out: [string, MentionTarget][],
): void {
  if (!Array.isArray(arr)) return;
  arr.forEach((x: unknown, i: number) => {
    if (!isObj(x) || typeof x.id !== "string") return;
    out.push([x.id, { file, kind, path: pathOf(i), index: i }]);
  });
}

/**
 * docs 内の全「指せる要素」の (id, MentionTarget) を、出現順そのままに
 * 列挙する(重複 id があれば同じ id で複数エントリが並ぶ)。validate の重複
 * 検査はこれを使う(最初のエントリ=既出の所在、2件目以降=重複)。
 * short は id フィールドを持たないため name をキーにして含める。
 */
export function collectIdOccurrences(docs: LoadedDocs): [string, MentionTarget][] {
  const out: [string, MentionTarget][] = [];

  const cutplan = docs.cutplan;
  if (isObj(cutplan)) {
    collectFromArray(cutplan.segments, "cutplan.json", "cutSegment", (i) => `segments[${i}]`, out);
  }

  const transcript = docs.transcript;
  if (isObj(transcript)) {
    collectFromArray(transcript.segments, "transcript.json", "caption", (i) => `segments[${i}]`, out);
  }

  const overlays = docs.overlays;
  if (isObj(overlays)) {
    collectFromArray(overlays.overlays, "overlays.json", "material", (i) => `overlays[${i}]`, out);
    collectFromArray(overlays.inserts, "overlays.json", "insert", (i) => `inserts[${i}]`, out);
    collectFromArray(overlays.wipeFull, "overlays.json", "wipeFull", (i) => `wipeFull[${i}]`, out);
    collectFromArray(overlays.hideCaption, "overlays.json", "hideCaption", (i) => `hideCaption[${i}]`, out);
    collectFromArray(overlays.zooms, "overlays.json", "zoom", (i) => `zooms[${i}]`, out);
    collectFromArray(overlays.blurs, "overlays.json", "blur", (i) => `blurs[${i}]`, out);
    collectFromArray(overlays.annotations, "overlays.json", "annotation", (i) => `annotations[${i}]`, out);
    collectFromArray(overlays.captionTracks, "overlays.json", "captionTrack", (i) => `captionTracks[${i}]`, out);
  }

  const chapters = docs.chapters;
  if (isObj(chapters)) {
    collectFromArray(chapters.chapters, "chapters.json", "chapter", (i) => `chapters[${i}]`, out);
  }

  const bgm = docs.bgm;
  if (isObj(bgm)) {
    collectFromArray(bgm.tracks, "bgm.json", "bgmTrack", (i) => `tracks[${i}]`, out);
  }

  const shorts = docs.shorts;
  if (isObj(shorts) && Array.isArray(shorts.shorts)) {
    shorts.shorts.forEach((s: unknown, j: number) => {
      if (!isObj(s)) return;
      // Short 自体は id フィールドを持たず、name が事実上の安定 id
      if (typeof s.name === "string" && s.name !== "") {
        out.push([s.name, { file: "shorts.json", kind: "short", path: `shorts[${j}]`, index: j }]);
      }
      collectFromArray(s.ranges, "shorts.json", "range", (i) => `shorts[${j}].ranges[${i}]`, out);
      collectFromArray(
        s.captionTracks,
        "shorts.json",
        "captionTrack",
        (i) => `shorts[${j}].captionTracks[${i}]`,
        out,
      );
    });
  }

  const thumbnail = docs.thumbnail;
  if (isObj(thumbnail)) {
    collectFromArray(thumbnail.texts, "thumbnail.json", "thumbnailText", (i) => `texts[${i}]`, out);
  }

  return out;
}

/** 収録の全編集ファイル(パース済み docs)から id/name→所在の索引を作る純関数。
 * 同じ id が複数箇所にあれば最初に出現した所在だけを残す(重複検査は
 * collectIdOccurrences を使う) */
export function collectIds(docs: LoadedDocs): Map<string, MentionTarget> {
  const index = new Map<string, MentionTarget>();
  for (const [id, target] of collectIdOccurrences(docs)) {
    if (!index.has(id)) index.set(id, target);
  }
  return index;
}

/** "@cap_7x2f" / "cap_7x2f" / "@short:intro" / "@intro" を所在に解決する
 * (無ければ null)。先頭の "@" と "short:" 接頭辞は剥がしてから index を引く */
export function resolveMention(
  ref: string,
  index: Map<string, MentionTarget>,
): MentionTarget | null {
  let r = ref.trim();
  if (r.startsWith("@")) r = r.slice(1);
  if (r.startsWith("short:")) r = r.slice("short:".length);
  if (r === "") return null;
  return index.get(r) ?? null;
}
