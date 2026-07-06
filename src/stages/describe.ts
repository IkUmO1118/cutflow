// 編集状態のテキスト要約。AI(Claude Code)や人間が JSON 群を全部読まずに
// 「どこが残っていて・どこが切られ・そこで何を喋っているか」を把握するための
// 知覚コマンド。時刻は「元 = 元収録の秒 / 出力 = カット後(preview/final)の秒」を
// 併記する(人間は preview を見て出力秒で話し、編集ファイルは元秒で書くため)。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtT } from "../lib/fmt.ts";
import { loadShorts } from "../lib/shorts.ts";
import {
  buildTimeline,
  insertSpans,
  mergeIntervals,
  remapInterval,
  snapToOutput,
  toOutputTime,
} from "../lib/timeline.ts";
import { captionTrack } from "../types.ts";
import type {
  Bgm,
  Chapters,
  CutPlan,
  Manifest,
  Meta,
  Overlays,
  Transcript,
} from "../types.ts";

export function describe(dir: string): string {
  // 必須ファイル(パイプラインの生成物)。無ければ実行を促して止める
  const readRequired = <T>(file: string): T => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      throw new Error(`${file} がありません。先にパイプライン(run)を実行してください`);
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  // 任意ファイル。無ければ fallback を返す。fallback には「存在しない」を
  // 表す null も渡せる(bgm.json など)。必須扱いと区別できる別関数にすることで、
  // bgm.json の無いフォルダ(新規プロジェクト全般)で describe が誤って
  // 落ちる旧バグ(fallback=null を必須と解釈していた)を断つ
  const readOptional = <T>(file: string, fallback: T): T => {
    const p = join(dir, file);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  const manifest = readRequired<Manifest>("manifest.json");
  const cutplan = readRequired<CutPlan>("cutplan.json");
  const transcript = readRequired<Transcript>("transcript.json");
  const overlays = readOptional<Overlays>("overlays.json", {});
  const bgm = readOptional<Bgm | null>("bgm.json", null);
  const chapters = readOptional<Chapters>("chapters.json", { chapters: [] });
  const meta = readOptional<Meta>("meta.json", { titles: [], description: "" });

  const keeps = mergeIntervals(
    cutplan.segments.filter((s) => s.action === "keep"),
  );
  const cutRecords = cutplan.segments.filter((s) => s.action === "cut");
  const inserts = (overlays.inserts ?? []).filter((i) =>
    existsSync(join(dir, i.file)),
  );
  const timeline = buildTimeline(keeps, inserts);
  const keptSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const outDur = keptSec + inserts.reduce((a, i) => a + i.durationSec, 0);

  const quote = (text: string): string => {
    const t = text.trim().replace(/\s+/g, " ");
    return t.length > 36 ? `${t.slice(0, 36)}…` : t;
  };
  /** 区間 [start, end) と 0.05 秒以上重なるか */
  const overlaps = (s: { start: number; end: number }, start: number, end: number) =>
    Math.min(s.end, end) - Math.max(s.start, start) > 0.05;

  // 各テロップの置き場所: 見えるものは「最初に重なる keep」、
  // 完全にカット内で消えるものは「重なるカット区間」に出す
  const keepIndexOf = (s: { start: number; end: number }): number | null => {
    if (remapInterval(s.start, s.end, timeline).length === 0) return null;
    const i = keeps.findIndex((k) => overlaps(s, k.start, k.end));
    return i >= 0 ? i : null;
  };

  const lines: string[] = [];
  lines.push(
    `収録: ${manifest.source} ${fmtT(manifest.durationSec)} → 出力 ${fmtT(outDur)}` +
      `(keep ${keeps.length}区間、${fmtT(manifest.durationSec - keptSec)} をカット)`,
  );
  const bgmDesc =
    bgm && bgm.tracks?.length
      ? `bgm.json(${bgm.tracks.length}区間: ${[...new Set(bgm.tracks.map((t) => t.file))].join(", ")})`
      : (["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ?? "なし");
  lines.push(
    `approved: ${cutplan.approved} / テロップ ${transcript.segments.length}件 / BGM ${bgmDesc}`,
  );
  lines.push("");
  lines.push(
    "時刻は「元 = 元収録の秒(編集ファイルに書く値)/ 出力 = カット後の秒(preview/final の再生位置)」",
  );
  lines.push("");

  /* ---- タイムライン(カットと keep の交互。テロップ・カット理由を添える) ---- */

  for (let i = 0; i <= keeps.length; i++) {
    // keep[i] の手前のカット区間(収録先頭・末尾のカットも含む)
    const gapStart = i === 0 ? 0 : keeps[i - 1].end;
    const gapEnd = i < keeps.length ? keeps[i].start : manifest.durationSec;
    if (gapEnd - gapStart > 0.05) {
      lines.push(
        `✂ カット 元 ${fmtT(gapStart)}–${fmtT(gapEnd)}(${(gapEnd - gapStart).toFixed(1)}秒)`,
      );
      for (const r of cutRecords) {
        if (overlaps(r, gapStart, gapEnd) && r.reason) lines.push(`    理由: ${r.reason}`);
      }
      for (const s of transcript.segments) {
        if (overlaps(s, gapStart, gapEnd) && keepIndexOf(s) === null) {
          lines.push(`    消える発言 ${fmtT(s.start)}「${quote(s.text)}」`);
        }
      }
    }
    if (i >= keeps.length) break;

    const k = keeps[i];
    const outStart = toOutputTime(k.start, timeline) ?? 0;
    lines.push(
      `■ keep${i + 1} 元 ${fmtT(k.start)}–${fmtT(k.end)} → 出力 ${fmtT(outStart)}–` +
        `${fmtT(outStart + (k.end - k.start))}(${(k.end - k.start).toFixed(1)}秒)`,
    );
    for (const s of transcript.segments) {
      if (keepIndexOf(s) !== i) continue;
      const track = captionTrack(s);
      lines.push(`    ${fmtT(s.start)}${track > 1 ? ` [T${track}]` : ""}「${quote(s.text)}」`);
    }
  }

  /* ---- 演出・章・メタ ---- */

  const ovList = overlays.overlays ?? [];
  const wipeList = overlays.wipeFull ?? [];
  if (ovList.length + inserts.length + wipeList.length > 0) {
    lines.push("");
    lines.push("演出:");
    for (const o of ovList) {
      lines.push(
        `  素材 V${o.track ?? (o.layer === "over" ? 2 : 1)} 元 ${fmtT(o.start)}–${fmtT(o.end)} ${o.file}` +
          (existsSync(join(dir, o.file)) ? "" : "(⚠ ファイルなし)"),
      );
    }
    insertSpans(keeps, inserts).forEach((sp) => {
      const ins = inserts[sp.index];
      lines.push(
        `  挿入 元 ${fmtT(ins.at)} の手前に ${ins.file}(${ins.durationSec}秒)→ 出力 ${fmtT(sp.start)}–${fmtT(sp.end)}`,
      );
    });
    for (const w of wipeList) {
      lines.push(`  ワイプ全画面 元 ${fmtT(w.start)}–${fmtT(w.end)}`);
    }
  }

  if (chapters.chapters.length > 0) {
    lines.push("");
    lines.push("章(YouTube 概要欄用):");
    for (const c of chapters.chapters) {
      const out = snapToOutput(c.start, timeline);
      lines.push(
        `  元 ${fmtT(c.start)} → 出力 ${out !== null ? fmtT(out) : "(カット内・スナップ先なし)"} ${c.title}`,
      );
    }
  }

  if (meta.titles.length > 0) {
    lines.push("");
    lines.push(`タイトル案: ${meta.titles.slice(0, 3).join(" / ")}`);
  }

  const shorts = loadShorts(dir);
  if (shorts && shorts.shorts.length > 0) {
    lines.push("");
    lines.push("ショート(shorts.json):");
    for (const s of shorts.shorts) {
      const ranges = mergeIntervals(s.ranges);
      const outDur = ranges.reduce((a, r) => a + (r.end - r.start), 0);
      const rangesDesc = ranges
        .map((r) => `元 ${fmtT(r.start)}–${fmtT(r.end)}`)
        .join(", ");
      lines.push(
        `  ${s.name} profile=${s.profile ?? "vertical"} approved=${s.approved} ` +
          `${rangesDesc} → 出力尺 ${fmtT(outDur)}`,
      );
    }
  }
  return lines.join("\n");
}
