// 編集後の意図を宣言的に検査する `assert <dir>` コマンドの実装。
// (docs/plans/2026-07-07-visual-assertions-design.md)
//
// validate との役割分離: validate = 壊れていないか(普遍不変条件)/
// assert = この収録固有の意図どおりか(assertions.json の宣言)。
//
// 純/不純の分離は describe/validate と同じ流儀:
//   - 純コア: evaluateStructural(Tier 1・describe --json 射影から)。
//     fs 非依存・依存ゼロ・数ミリ秒・全環境。
//   - fs ラッパー: assert(dir, opts)(describeJson を呼んで純コアへ渡す。T2)。
//
// Tier 2(視覚・screenText/regionClear)は evaluateStructural では常に skip
// (--visual が必要)。実評価は evaluateVisual(T4)+ --visual 配線(T5)で行う。

import type { AssertionsDoc, AssertOp } from "../types.ts";
import { fmtT } from "../lib/fmt.ts";
import type { CaptionEntry, DescribeProjection, MaterialEntry } from "./describe.ts";

/** 1件のアサーションの評価結果 */
export interface AssertOutcome {
  /** assertions[] の添字 */
  index: number;
  /** 作者ラベル(あれば) */
  label?: string;
  /** "outDuration" 等 */
  type: string;
  status: "pass" | "fail" | "skip" | "error";
  /** 人間可読な説明 */
  message: string;
}

export interface AssertReport {
  outcomes: AssertOutcome[];
  counts: { pass: number; fail: number; skip: number; error: number };
}

/** 数値比較(outDuration / keepCount が使う) */
function compareOp(actual: number, op: AssertOp, value: number): boolean {
  switch (op) {
    case "<=":
      return actual <= value;
    case ">=":
      return actual >= value;
    case "<":
      return actual < value;
    case ">":
      return actual > value;
    case "==":
      return actual === value;
  }
}

/** "@cap_7x2f" / "cap_7x2f" の先頭 "@" を剥がす(mention.ts の resolveMention
 * と同じ正規化。describe --json 射影は自己完結しているため、mention.ts の
 * LoadedDocs 依存の collectIds は使わずここで独自に軽い解決を行う) */
function normalizeRef(ref: string): string {
  const r = ref.trim();
  return r.startsWith("@") ? r.slice(1) : r;
}

function findById<T extends { id?: string }>(
  arr: readonly T[],
  ref: string,
): T | undefined {
  const id = normalizeRef(ref);
  return arr.find((x) => x.id === id);
}

/** プロジェクトに id が1つでも採番されているか(describe --json 射影の
 * id を持ちうるコレクションを横断して確認する)。1つも無ければ ref を取る
 * アサーションは fail ではなく error にする(§論点3) */
function hasAnyId(proj: DescribeProjection): boolean {
  const some = (arr: readonly { id?: string }[] | undefined): boolean =>
    (arr ?? []).some((x) => x.id !== undefined);
  return (
    some(proj.captions) ||
    some(proj.overlays.materials) ||
    some(proj.overlays.inserts) ||
    some(proj.overlays.wipeFull) ||
    some(proj.overlays.zooms) ||
    some(proj.overlays.blurs) ||
    some(proj.overlays.hideCaption) ||
    some(proj.overlays.captionTracks) ||
    some(proj.chapters) ||
    some(proj.bgm.tracks) ||
    proj.shorts.some((s) => some(s.ranges) || some(s.captionTracks))
  );
}

/** ref 未解決時のエラーメッセージ(id 未採番プロジェクトなら id-stamp を促す。
 * それ以外は単純に「見つからない」) */
function refNotFoundMessage(proj: DescribeProjection, ref: string): string {
  if (!hasAnyId(proj)) {
    return (
      `id が1つも採番されていません。\`node src/cli.ts id-stamp <dir>\` を実行してから ` +
      `@id で指定してください(ref: ${ref})`
    );
  }
  return `ref が見つかりません: ${ref}`;
}

/** テロップの出力秒区間(captions[].out)が同一トラック内で重ならないかを
 * 検査する。track 省略時は全トラックそれぞれについて検査する */
function findCaptionOverlap(
  captions: readonly CaptionEntry[],
  track?: number,
): string | null {
  const EPS = 0.005;
  const tracks =
    track !== undefined ? [track] : [...new Set(captions.map((c) => c.track))];
  for (const t of tracks) {
    const spans = captions
      .filter((c) => c.track === t)
      .flatMap((c) => c.out.map((iv) => ({ ...iv, text: c.text })));
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1];
      const cur = spans[i];
      if (cur.start < prev.end - EPS) {
        return (
          `トラック${t}: 「${prev.text}」(出力 ${fmtT(prev.start)}–${fmtT(prev.end)})と` +
          `「${cur.text}」(出力 ${fmtT(cur.start)}–${fmtT(cur.end)})が重なっています`
        );
      }
    }
  }
  return null;
}

/**
 * 構造アサーション(Tier 1)の純評価コア。describe --json の射影
 * (DescribeProjection)だけを入力に、assertions.json の宣言を照合する。
 * fs には一切触れない(テスト容易性・decision論点4 の意味論を守る)。
 * Tier 2(screenText/regionClear)は常に skip(--visual が必要。T4/T5 で
 * evaluateVisual がこの skip を上書きする)。
 */
export function evaluateStructural(
  proj: DescribeProjection,
  spec: AssertionsDoc,
): AssertOutcome[] {
  return spec.assertions.map((a, index): AssertOutcome => {
    const base = { index, type: a.type, ...(a.label !== undefined ? { label: a.label } : {}) };

    switch (a.type) {
      case "screenText":
      case "regionClear":
        return {
          ...base,
          status: "skip",
          message: "Tier 2(視覚アサーション)は `assert --visual` のときだけ評価されます",
        };

      case "outDuration": {
        let actual: number;
        if (a.short !== undefined) {
          const short = proj.shorts.find((s) => s.name === a.short);
          if (!short) {
            return { ...base, status: "error", message: `ショートが見つかりません: ${a.short}` };
          }
          actual = short.outDurationSec;
        } else {
          actual = proj.summary.outDurationSec;
        }
        const ok = compareOp(actual, a.op, a.value);
        const subject = a.short ? `ショート "${a.short}" の出力尺` : "出力尺";
        return {
          ...base,
          status: ok ? "pass" : "fail",
          message: `${subject} ${fmtT(actual)} ${a.op} ${fmtT(a.value)}: ${ok ? "満たされています" : "満たされていません"}`,
        };
      }

      case "keepCount": {
        const actual = proj.summary.keepCount;
        const ok = compareOp(actual, a.op, a.value);
        return {
          ...base,
          status: ok ? "pass" : "fail",
          message: `keep区間数 ${actual} ${a.op} ${a.value}: ${ok ? "満たされています" : "満たされていません"}`,
        };
      }

      case "captionVisible": {
        const cap = findById(proj.captions, a.ref);
        if (!cap) return { ...base, status: "error", message: refNotFoundMessage(proj, a.ref) };
        const expected = a.visible ?? true;
        const ok = cap.visible === expected;
        return {
          ...base,
          status: ok ? "pass" : "fail",
          message:
            `テロップ ${a.ref}「${cap.text}」は visible=${cap.visible}` +
            `(期待: ${expected}): ${ok ? "満たされています" : "満たされていません"}`,
        };
      }

      case "captionText": {
        const cap = findById(proj.captions, a.ref);
        if (!cap) return { ...base, status: "error", message: refNotFoundMessage(proj, a.ref) };
        if (a.contains === undefined && a.equals === undefined) {
          return {
            ...base,
            status: "error",
            message: "captionText は contains か equals のどちらかが必要です",
          };
        }
        let ok = true;
        const checks: string[] = [];
        if (a.contains !== undefined) {
          const c = cap.text.includes(a.contains);
          ok = ok && c;
          checks.push(`contains "${a.contains}": ${c}`);
        }
        if (a.equals !== undefined) {
          const c = cap.text === a.equals;
          ok = ok && c;
          checks.push(`equals "${a.equals}": ${c}`);
        }
        return {
          ...base,
          status: ok ? "pass" : "fail",
          message: `テロップ ${a.ref}「${cap.text}」: ${checks.join(" / ")}`,
        };
      }

      case "timeKept": {
        if (a.at < 0 || a.at > proj.source.durationSec + 0.5) {
          return {
            ...base,
            status: "error",
            message: `at(${fmtT(a.at)})が収録の長さ(${fmtT(proj.source.durationSec)})の外です`,
          };
        }
        const actual = proj.keeps.some((k) => a.at >= k.start && a.at < k.end);
        const expected = a.kept ?? true;
        const ok = actual === expected;
        return {
          ...base,
          status: ok ? "pass" : "fail",
          message:
            `元 ${fmtT(a.at)} は${actual ? "keep内" : "カット内"}` +
            `(期待: ${expected ? "keep内" : "カット内"}): ${ok ? "満たされています" : "満たされていません"}`,
        };
      }

      case "materialExists": {
        const mat = findById<MaterialEntry>(proj.overlays.materials, a.ref);
        if (!mat) return { ...base, status: "error", message: refNotFoundMessage(proj, a.ref) };
        return {
          ...base,
          status: mat.exists ? "pass" : "fail",
          message: `素材 ${a.ref}(${mat.file})は${mat.exists ? "存在します" : "存在しません"}`,
        };
      }

      case "noCaptionOverlap": {
        const overlap = findCaptionOverlap(proj.captions, a.track);
        return {
          ...base,
          status: overlap ? "fail" : "pass",
          message: overlap ?? "テロップの重なりはありません",
        };
      }

      default: {
        const _exhaustive: never = a;
        void _exhaustive;
        return {
          ...base,
          status: "error",
          message: `未知の type です: ${JSON.stringify((a as { type: unknown }).type)}`,
        };
      }
    }
  });
}

// evaluateVisual(Tier 2)/ assert(dir, opts) fs ラッパーは後続タスク(T2/T4/T5)で追加する。
