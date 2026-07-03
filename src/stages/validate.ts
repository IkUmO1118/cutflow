// 編集ファイル(cutplan / transcript / overlays / chapters / meta)の整合性検査。
// 人間や AI(Claude Code)が JSON を直接編集した後に走らせ、preview / render で
// 数分かけて気づく壊れ方を数ミリ秒で検出する。
//
// 方針: エラー = レンダーが壊れる・結果が明らかに不正になるもの(exit 1)。
//       警告 = 動きはするが意図と違う可能性が高いもの(exit 0)。

import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { fmtT } from "../lib/fmt.ts";
import { buildTimeline, remapInterval } from "../lib/timeline.ts";
import type { TimelineEntry } from "../lib/timeline.ts";
import { capNum, captionTrack, ovNum } from "../types.ts";
import type { Interval, Manifest } from "../types.ts";

export interface Problem {
  /** 対象ファイル(収録フォルダ内の名前) */
  file: string;
  /** 位置の説明(例: "segments[3]") */
  where: string;
  message: string;
}

export interface ValidateResult {
  errors: Problem[];
  warnings: Problem[];
  /** 検査した内容の一行サマリ(問題ゼロのときの表示用) */
  summary: string;
}

/** keep 区間の重なり・隣接の判定猶予(秒)。mergeIntervals と同じ */
const EPS = 0.005;
/** 収録の長さ超えの許容(秒)。丸め誤差や whisper の末尾ずれを許す */
const DUR_EPS = 0.5;

/** validate が検査する編集ファイル群(パース済み。無ければ null)。
 * ディスクから読む CLI の validate と、メモリ上の編集を保存前に検査する
 * エディタの /api/save で共有し、同じ純粋検査を通して保証レベルを揃える */
export interface LoadedDocs {
  manifest: unknown;
  cutplan: unknown;
  transcript: unknown;
  overlays: unknown;
  chapters: unknown;
  meta: unknown;
}

export function validate(dir: string): ValidateResult {
  const preErrors: Problem[] = [];
  /** JSON を読む。無ければ null、壊れていればエラーに積んで null */
  const readJson = (file: string, required: boolean): unknown => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (required) {
        preErrors.push({
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
      preErrors.push({ file, where: "-", message: `JSON として読めません: ${(e as Error).message}` });
      return null;
    }
  };
  const docs: LoadedDocs = {
    manifest: readJson("manifest.json", true),
    cutplan: readJson("cutplan.json", true),
    transcript: readJson("transcript.json", true),
    overlays: readJson("overlays.json", false),
    chapters: readJson("chapters.json", false),
    meta: readJson("meta.json", false),
  };
  return validateDocs(dir, docs, preErrors);
}

/**
 * パース済みの編集ドキュメントを検査する純関数。dir は overlays の file 参照の
 * 存在チェックにだけ使う。preErrors には呼び出し側が拾った読み込みエラー
 * (必須ファイルの欠落・JSON 破損)を渡す(検査結果の errors 先頭に積まれる)。
 */
export function validateDocs(
  dir: string,
  docs: LoadedDocs,
  preErrors: Problem[] = [],
): ValidateResult {
  const errors: Problem[] = [...preErrors];
  const warnings: Problem[] = [];
  const err = (file: string, where: string, message: string): void => {
    errors.push({ file, where, message });
  };
  const warn = (file: string, where: string, message: string): void => {
    warnings.push({ file, where, message });
  };

  const { cutplan, transcript, overlays, chapters, meta } = docs;
  const manifest = docs.manifest as Manifest | null;
  const duration = manifest?.durationSec;
  if (manifest && !isNum(duration)) {
    err("manifest.json", "durationSec", "数値ではありません(ingest をやり直してください)");
  }
  const dur = isNum(duration) ? duration : null;

  /* ---------------- cutplan.json ---------------- */

  const counts = { keep: 0, cut: 0, captions: 0, overlays: 0 };
  let keeps: Interval[] = [];
  if (isObj(cutplan)) {
    const f = "cutplan.json";
    if (typeof cutplan.approved !== "boolean") {
      err(f, "approved", "true / false のどちらかにしてください");
    }
    if (!Array.isArray(cutplan.segments)) {
      err(f, "segments", "配列ではありません");
    } else {
      cutplan.segments.forEach((s: unknown, i: number) => {
        const w = `segments[${i}]`;
        if (!isObj(s)) return err(f, w, "オブジェクトではありません");
        checkSpan(f, w, s, dur, err);
        if (s.action !== "keep" && s.action !== "cut") {
          err(f, w, `action は "keep" か "cut" です(現在: ${JSON.stringify(s.action)})`);
        }
        if (typeof s.reason !== "string") {
          warn(f, w, "reason(人間が確認するための説明)がありません");
        }
      });
      const segs = cutplan.segments.filter(
        (s: unknown): s is { start: number; end: number; action: string } =>
          isObj(s) && isNum(s.start) && isNum(s.end) && s.start < s.end,
      );
      keeps = segs.filter((s) => s.action === "keep");
      counts.keep = keeps.length;
      counts.cut = segs.length - keeps.length;
      if (keeps.length === 0) {
        err(f, "segments", "keep 区間が1つもありません(すべてカットすると動画が空になります)");
      }
      // keep は時系列順かつ重なりなし(timeline の写像とffmpegの結合の前提)
      for (let i = 1; i < keeps.length; i++) {
        const prev = keeps[i - 1];
        const cur = keeps[i];
        if (cur.start < prev.start) {
          err(f, `segments`, `keep 区間が時系列順ではありません(${fmtT(prev.start)} の後に ${fmtT(cur.start)})`);
        } else if (cur.start < prev.end - EPS) {
          err(f, `segments`, `keep 区間が重なっています(${fmtT(prev.start)}–${fmtT(prev.end)} と ${fmtT(cur.start)}–${fmtT(cur.end)})`);
        }
      }
    }
  } else if (cutplan !== null) {
    err("cutplan.json", "-", "オブジェクトではありません");
  }

  // テロップ・演出の「カット内で表示されない」警告に使う時刻写像
  const timeline: TimelineEntry[] | null =
    errors.length === 0 && keeps.length > 0 ? buildTimeline(keeps) : null;
  /** 区間がカット後の動画に一瞬でも現れるか(写像が作れないときは true 扱い) */
  const visible = (start: number, end: number): boolean =>
    !timeline || remapInterval(start, end, timeline).length > 0;

  /* ---------------- transcript.json ---------------- */

  if (isObj(transcript)) {
    const f = "transcript.json";
    if (!Array.isArray(transcript.segments)) {
      err(f, "segments", "配列ではありません");
    } else {
      counts.captions = transcript.segments.length;
      transcript.segments.forEach((s: unknown, i: number) => {
        const w = `segments[${i}]`;
        if (!isObj(s)) return err(f, w, "オブジェクトではありません");
        checkSpan(f, w, s, dur, err, warn);
        if (typeof s.text !== "string" || s.text === "") {
          warn(f, w, "text が空です(表示されないテロップ)");
        }
        if (s.track !== undefined && !isPosInt(s.track)) {
          err(f, w, `track は 1 以上の整数です(現在: ${JSON.stringify(s.track)})`);
        }
        if (s.pos !== undefined && !(isObj(s.pos) && isNum(s.pos.x) && isNum(s.pos.y))) {
          err(f, w, `pos は {x, y}(出力px の数値)です(現在: ${JSON.stringify(s.pos)})`);
        }
        checkStyle(f, w, s.style, err);
        if (isNum(s.start) && isNum(s.end) && s.start < s.end && !visible(s.start, s.end)) {
          warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(s.start)}–${fmtT(s.end)}「${String(s.text).slice(0, 12)}」)`);
        }
      });
    }
  } else if (transcript !== null) {
    err("transcript.json", "-", "オブジェクトではありません");
  }

  /* ---------------- overlays.json ---------------- */

  if (isObj(overlays)) {
    const f = "overlays.json";
    const KNOWN = ["overlays", "inserts", "wipeFull", "layerOrder", "captionTracks", "hideCaption"];
    for (const k of Object.keys(overlays)) {
      if (!KNOWN.includes(k)) warn(f, k, `不明なキーです(有効: ${KNOWN.join(" / ")})`);
    }

    const checkFile = (w: string, file: unknown): void => {
      if (typeof file !== "string" || file === "") {
        return err(f, w, "file(収録フォルダからの相対パス)がありません");
      }
      const abs = normalize(join(dir, file));
      if (!abs.startsWith(resolve(dir) + sep)) {
        err(f, w, `file が収録フォルダの外を指しています: ${file}`);
      } else if (!existsSync(abs)) {
        err(f, w, `素材ファイルがありません: ${file}`);
      }
    };
    const checkFit = (w: string, fit: unknown): void => {
      if (fit !== undefined && fit !== "contain" && fit !== "cover") {
        err(f, w, `fit は "contain" か "cover" です(現在: ${JSON.stringify(fit)})`);
      }
    };

    if (overlays.overlays !== undefined && !Array.isArray(overlays.overlays)) {
      err(f, "overlays", "配列ではありません");
    }
    (Array.isArray(overlays.overlays) ? overlays.overlays : []).forEach(
      (o: unknown, i: number) => {
        const w = `overlays[${i}]`;
        if (!isObj(o)) return err(f, w, "オブジェクトではありません");
        counts.overlays++;
        checkSpan(f, w, o, dur, err, warn);
        checkFile(w, o.file);
        checkFit(w, o.fit);
        if (o.track !== undefined && !isPosInt(o.track)) {
          err(f, w, `track は 1 以上の整数です(現在: ${JSON.stringify(o.track)})`);
        }
        if (o.layer !== undefined && o.layer !== "under" && o.layer !== "over") {
          err(f, w, `layer は "under" か "over" です(現在: ${JSON.stringify(o.layer)})`);
        }
        if (isObj(o) && isNum(o.start) && isNum(o.end) && o.start < o.end && !visible(o.start, o.end)) {
          warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(o.start)}–${fmtT(o.end)})`);
        }
      },
    );

    if (overlays.inserts !== undefined && !Array.isArray(overlays.inserts)) {
      err(f, "inserts", "配列ではありません");
    }
    (Array.isArray(overlays.inserts) ? overlays.inserts : []).forEach(
      (o: unknown, i: number) => {
        const w = `inserts[${i}]`;
        if (!isObj(o)) return err(f, w, "オブジェクトではありません");
        if (!isNum(o.at) || o.at < 0) {
          err(f, w, `at(挿入位置・元収録の秒)が不正です: ${JSON.stringify(o.at)}`);
        } else if (dur !== null && o.at > dur + DUR_EPS) {
          err(f, w, `at(${fmtT(o.at)})が収録の長さ(${fmtT(dur)})を超えています`);
        }
        if (!isNum(o.durationSec) || o.durationSec <= 0) {
          err(f, w, `durationSec(挿入する尺)は正の数です: ${JSON.stringify(o.durationSec)}`);
        }
        checkFile(w, o.file);
        checkFit(w, o.fit);
      },
    );

    for (const key of ["wipeFull", "hideCaption"] as const) {
      if (overlays[key] !== undefined && !Array.isArray(overlays[key])) {
        err(f, key, "配列ではありません");
        continue;
      }
      (Array.isArray(overlays[key]) ? (overlays[key] as unknown[]) : []).forEach(
        (o: unknown, i: number) => {
          const w = `${key}[${i}]`;
          if (!isObj(o)) return err(f, w, "オブジェクトではありません");
          checkSpan(f, w, o, dur, err, warn);
        },
      );
    }

    if (overlays.layerOrder !== undefined) {
      if (!Array.isArray(overlays.layerOrder)) {
        err(f, "layerOrder", "配列ではありません");
      } else {
        const seen = new Set<string>();
        overlays.layerOrder.forEach((id: unknown, i: number) => {
          const w = `layerOrder[${i}]`;
          if (typeof id !== "string" ||
              (id !== "wipe" && id !== "caption" && ovNum(id) === null && capNum(id) === null)) {
            return err(f, w, `不明なレイヤーです: ${JSON.stringify(id)}(wipe / caption / ov<N> / cap<N>)`);
          }
          if (seen.has(id)) err(f, w, `レイヤーが重複しています: ${id}`);
          seen.add(id);
        });
        if (!seen.has("wipe")) warn(f, "layerOrder", "wipe がありません(ワイプが描画されません)");
        if (!seen.has("caption")) warn(f, "layerOrder", "caption がありません(テロップ T1 が描画されません)");
      }
    }

    if (overlays.captionTracks !== undefined) {
      if (!Array.isArray(overlays.captionTracks)) {
        err(f, "captionTracks", "配列ではありません");
      } else {
        const seen = new Set<number>();
        overlays.captionTracks.forEach((t: unknown, i: number) => {
          const w = `captionTracks[${i}]`;
          if (!isObj(t)) return err(f, w, "オブジェクトではありません");
          if (!isPosInt(t.track)) {
            return err(f, w, `track は 1 以上の整数です(現在: ${JSON.stringify(t.track)})`);
          }
          if (seen.has(t.track)) err(f, w, `track ${t.track} の設定が重複しています`);
          seen.add(t.track);
          if (t.anchor !== undefined && t.anchor !== "center" && t.anchor !== "topLeft") {
            err(f, w, `anchor は "center" か "topLeft" です(現在: ${JSON.stringify(t.anchor)})`);
          }
          if ((t.x !== undefined && !isNum(t.x)) || (t.y !== undefined && !isNum(t.y))) {
            err(f, w, "x / y は数値(出力px)です");
          }
          checkStyle(f, w, t.style, err);
        });
      }
    }
  } else if (overlays !== null) {
    err("overlays.json", "-", "オブジェクトではありません");
  }

  /* ---------------- chapters.json / meta.json ---------------- */

  if (isObj(chapters)) {
    const f = "chapters.json";
    if (!Array.isArray(chapters.chapters)) {
      err(f, "chapters", "配列ではありません");
    } else {
      let prev = -1;
      chapters.chapters.forEach((c: unknown, i: number) => {
        const w = `chapters[${i}]`;
        if (!isObj(c)) return err(f, w, "オブジェクトではありません");
        if (!isNum(c.start) || c.start < 0) {
          err(f, w, `start(元収録の秒)が不正です: ${JSON.stringify(c.start)}`);
        } else {
          if (dur !== null && c.start > dur + DUR_EPS) {
            err(f, w, `start(${fmtT(c.start)})が収録の長さ(${fmtT(dur)})を超えています`);
          }
          if (c.start < prev) warn(f, w, "章が時系列順ではありません");
          prev = c.start;
        }
        if (typeof c.title !== "string" || c.title === "") {
          warn(f, w, "title が空です");
        }
      });
    }
  } else if (chapters !== null) {
    err("chapters.json", "-", "オブジェクトではありません");
  }

  if (meta !== null && isObj(meta)) {
    const f = "meta.json";
    if (!Array.isArray(meta.titles) || meta.titles.some((t: unknown) => typeof t !== "string")) {
      warn(f, "titles", "文字列の配列ではありません");
    }
    if (typeof meta.description !== "string") {
      warn(f, "description", "文字列ではありません");
    }
  }

  /* -------- chapters.json ⇔「章」トラックのテロップ の乖離検知 -------- */
  // plan / remeta は概要欄チャプター(chapters.json)と画面表示の章タイトル
  // (transcript の「章」トラックのテロップ)を同じ元から書くが、以降どちらか
  // だけ手編集すると、概要欄と動画内表示のタイトル・位置がずれる。二重管理で
  // 検知手段がなかった食い違いを警告する(動くので警告どまり)
  checkChapterSync(chapters, transcript, overlays, warn);

  const keptSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const summary =
    `keep ${counts.keep}区間(${fmtT(keptSec)})+ カット記録 ${counts.cut} / ` +
    `テロップ ${counts.captions} / 素材・演出 ${counts.overlays}`;
  return { errors, warnings, summary };
}

/* ---------------- 共通チェック ---------------- */

/** start / end を持つ区間の共通検査。範囲超えは warn があれば警告、無ければエラー */
function checkSpan(
  file: string,
  where: string,
  s: Record<string, unknown>,
  dur: number | null,
  err: (f: string, w: string, m: string) => void,
  warn?: (f: string, w: string, m: string) => void,
): void {
  if (!isNum(s.start) || !isNum(s.end)) {
    return err(file, where, `start / end が数値ではありません(現在: ${JSON.stringify(s.start)} / ${JSON.stringify(s.end)})`);
  }
  if (s.start < 0) err(file, where, `start が負です: ${s.start}`);
  if (s.start >= s.end) {
    return err(file, where, `start(${fmtT(s.start)})>= end(${fmtT(s.end)})`);
  }
  if (dur !== null && s.end > dur + DUR_EPS) {
    const msg = `end(${fmtT(s.end)})が収録の長さ(${fmtT(dur)})を超えています`;
    if (warn) warn(file, where, msg);
    else err(file, where, msg);
  }
}

/** 章の開始時刻がずれているとみなす猶予(秒)。丸め差は無視する */
const CHAP_EPS = 0.05;

/**
 * 概要欄チャプター(chapters.json)と画面表示の章タイトル(transcript の
 * 「章」トラックのテロップ)の食い違いを警告する。「章」トラックは
 * overlays.captionTracks の name === "章" の track 番号で特定する。
 * タイトルを鍵に突き合わせ、片側にしか無い章・開始位置がずれた章を報告する。
 */
function checkChapterSync(
  chapters: unknown,
  transcript: unknown,
  overlays: unknown,
  warn: (f: string, w: string, m: string) => void,
): void {
  if (!isObj(chapters) || !Array.isArray(chapters.chapters)) return;
  if (!isObj(transcript) || !Array.isArray(transcript.segments)) return;

  const chaps = chapters.chapters
    .filter((c): c is { start: number; title: string } => isObj(c) && isNum(c.start))
    .map((c) => ({ start: c.start, title: typeof c.title === "string" ? c.title.trim() : "" }));

  const tracks =
    isObj(overlays) && Array.isArray(overlays.captionTracks) ? overlays.captionTracks : [];
  const chapDef = tracks.find(
    (t: unknown): t is { track: number } => isObj(t) && t.name === "章" && isPosInt(t.track),
  );
  const chapTrack = chapDef ? chapDef.track : null;
  const telops =
    chapTrack === null
      ? []
      : transcript.segments
          .filter(
            (s: unknown): s is { start: number; text?: unknown } =>
              isObj(s) && isNum(s.start) && captionTrack(s) === chapTrack,
          )
          .map((s) => ({ start: s.start, title: typeof s.text === "string" ? s.text.trim() : "" }));

  if (chaps.length === 0 && telops.length === 0) return;

  const cf = "chapters.json";
  // 章テロップトラックが無い(全部消した)のに概要欄チャプターだけ残っている
  if (chapTrack === null && chaps.length > 0) {
    warn(
      cf,
      "chapters",
      `概要欄チャプターが ${chaps.length} 件ありますが、画面に表示する「章」テロップトラックがありません` +
        "(概要欄と画面表示がずれています。remeta で作り直せます)",
    );
    return;
  }

  const teloByTitle = new Map(telops.map((t) => [t.title, t.start]));
  const chapByTitle = new Map(chaps.map((c) => [c.title, c.start]));
  for (const c of chaps) {
    const at = teloByTitle.get(c.title);
    if (at === undefined) {
      warn(
        cf,
        "chapters",
        `概要欄チャプター「${c.title}」(${fmtT(c.start)})に対応する画面の章テロップがありません` +
          "(概要欄だけ編集した可能性)",
      );
    } else if (Math.abs(at - c.start) >= CHAP_EPS) {
      warn(
        cf,
        "chapters",
        `章「${c.title}」の開始位置が概要欄(${fmtT(c.start)})と画面テロップ(${fmtT(at)})でずれています`,
      );
    }
  }
  for (const t of telops) {
    if (!chapByTitle.has(t.title)) {
      warn(
        "transcript.json",
        "segments",
        `画面の章テロップ「${t.title}」(${fmtT(t.start)})が概要欄チャプター(chapters.json)にありません` +
          "(画面だけ編集した可能性)",
      );
    }
  }
}

/** テロップの style({fontSizePx, color, outlineColor, fontFamily,
 * fontWeight, background})の検査 */
function checkStyle(
  file: string,
  where: string,
  style: unknown,
  err: (f: string, w: string, m: string) => void,
): void {
  if (style === undefined) return;
  if (!isObj(style)) return err(file, where, `style はオブジェクトです(現在: ${JSON.stringify(style)})`);
  const w = `${where}.style`;
  if (style.fontSizePx !== undefined && (!isNum(style.fontSizePx) || style.fontSizePx <= 0)) {
    err(file, w, `fontSizePx は正の数です(現在: ${JSON.stringify(style.fontSizePx)})`);
  }
  for (const k of ["color", "outlineColor"] as const) {
    if (style[k] !== undefined && (typeof style[k] !== "string" || style[k] === "")) {
      err(file, w, `${k} は CSS カラー文字列です(現在: ${JSON.stringify(style[k])})`);
    }
  }
  if (style.fontFamily !== undefined && (typeof style.fontFamily !== "string" || style.fontFamily === "")) {
    err(file, w, `fontFamily は CSS フォント指定の文字列です(現在: ${JSON.stringify(style.fontFamily)})`);
  }
  if (
    style.fontWeight !== undefined &&
    (!isNum(style.fontWeight) || style.fontWeight < 1 || style.fontWeight > 1000)
  ) {
    err(file, w, `fontWeight は 100〜900 の数値です(現在: ${JSON.stringify(style.fontWeight)})`);
  }
  const bg = style.background;
  if (bg !== undefined) {
    if (!isObj(bg)) {
      err(file, w, `background はオブジェクト({color, paddingPx?, radiusPx?})です(現在: ${JSON.stringify(bg)})`);
    } else {
      if (typeof bg.color !== "string" || bg.color === "") {
        err(file, `${w}.background`, `color(帯の CSS カラー)がありません(現在: ${JSON.stringify(bg.color)})`);
      }
      for (const k of ["paddingPx", "radiusPx"] as const) {
        if (bg[k] !== undefined && (!isNum(bg[k]) || (bg[k] as number) < 0)) {
          err(file, `${w}.background`, `${k} は 0 以上の数値です(現在: ${JSON.stringify(bg[k])})`);
        }
      }
    }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isPosInt(v: unknown): v is number {
  return isNum(v) && Number.isInteger(v) && v >= 1;
}
