// M2(尺整合)+ M3(dangling/unused)の検出ロジック。
// §docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md
//
// fs 非依存の純関数のみ(実 fs/ffprobe/LLM には一切依存しない)。
// materials.probe/index.json(MaterialsIndex)を入力に取り、`apply` が食える
// @id 宛先の EditOp[] を組み立てる。時刻・尺・ファイルパスはすべて
// probe.durationSec からの算術か実在ファイル名の集合からの選択で決まり、
// LLM には一切書かせない(母艦 原則4)。
import type { MaterialEntry, MaterialRef, MaterialsIndex } from "./materials.ts";
import type { EditOp } from "../types.ts";

export interface MaterialFitCfg {
  /** overrun 判定の許容誤差(秒) */
  overrunEpsSec: number;
  /** underrun 判定倍率(実尺が宣言尺の何倍で「大半未使用」か) */
  underrunRatio: number;
  /** underrun で延長 set を出すか(既定 false = reason のみ) */
  suggestUnderrunExtend: boolean;
  /** dangling 貼り替え候補の上限 */
  maxReplacements: number;
}

/** 尺不整合の1件。ref は overlay/insert のどれか。suggestion は補正候補
 * (適用は apply。underrun かつ suggestUnderrunExtend=false のときは無い) */
export interface FitFinding {
  refId: string;
  as: "overlay" | "insert";
  file: string;
  kind: "overrun" | "underrun";
  materialDurationSec: number;
  declaredSec: number;
  startFrom: number;
  suggestion?: EditOp;
  reason: string;
}

/** dangling(used:true, present:false)の1件 */
export interface DanglingFinding {
  file: string;
  refs: MaterialRef[];
  replacements: string[];
  removeOps: EditOp[];
}

/** unused(used:false, present:true)の1件 */
export interface UnusedFinding {
  file: string;
  kind: MaterialEntry["kind"];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function declaredSecOf(ref: MaterialRef): number {
  if (ref.as === "insert") return ref.durationSec ?? 0;
  return (ref.end ?? 0) - (ref.start ?? 0);
}

function overrunSuggestion(ref: MaterialRef, id: string, newSec: number): EditOp {
  if (ref.as === "insert") {
    return { op: "set", target: `@${id}`, field: "durationSec", value: newSec };
  }
  return { op: "set", target: `@${id}`, field: "end", value: round2((ref.start ?? 0) + newSec) };
}

/** overlay/insert 参照ごとに実尺と宣言尺を突き合わせて不整合を出す純関数。
 * - overrun: startFrom + declaredSec > materialDurationSec + eps
 *     → 素材が declaredSec を賄えず末尾フレームで停止。insert は durationSec、
 *       overlay は end を実尺いっぱいに詰める set を提案する。
 * - underrun: materialDurationSec - startFrom > declaredSec * underrunRatio
 *     → 素材の大半が未使用。既定は reason のみ(suggestion 無し)。
 *       cfg.suggestUnderrunExtend のときだけ実尺いっぱいへ延ばす set を出す。
 * 画像素材(probe.durationSec 無し)・id 未採番の参照は除外する(呼び出し側の
 * `id-stamp` 前提チェックに委ねる) */
export function detectFit(index: MaterialsIndex, cfg: MaterialFitCfg): FitFinding[] {
  const findings: FitFinding[] = [];
  for (const entry of index.materials) {
    const materialDurationSec = entry.probe?.durationSec;
    if (materialDurationSec === undefined) continue;
    for (const ref of entry.references) {
      if (ref.as !== "overlay" && ref.as !== "insert") continue;
      if (typeof ref.id !== "string" || ref.id === "") continue;
      const id = ref.id;
      const startFrom = ref.startFrom ?? 0;
      const declaredSec = declaredSecOf(ref);

      if (startFrom + declaredSec > materialDurationSec + cfg.overrunEpsSec) {
        const newSec = Math.max(0, round2(materialDurationSec - startFrom));
        findings.push({
          refId: id,
          as: ref.as,
          file: entry.file,
          kind: "overrun",
          materialDurationSec,
          declaredSec,
          startFrom,
          suggestion: overrunSuggestion(ref, id, newSec),
          reason:
            `素材の実尺(${materialDurationSec.toFixed(1)}s)が宣言尺` +
            `(${declaredSec.toFixed(1)}s, startFrom=${startFrom}s)を賄えず、末尾フレームで停止します`,
        });
        continue;
      }

      if (declaredSec > 0 && materialDurationSec - startFrom > declaredSec * cfg.underrunRatio) {
        const extended = Math.max(0, round2(materialDurationSec - startFrom));
        findings.push({
          refId: id,
          as: ref.as,
          file: entry.file,
          kind: "underrun",
          materialDurationSec,
          declaredSec,
          startFrom,
          ...(cfg.suggestUnderrunExtend ? { suggestion: overrunSuggestion(ref, id, extended) } : {}),
          reason:
            `素材の実尺(${materialDurationSec.toFixed(1)}s)に対し宣言尺` +
            `(${declaredSec.toFixed(1)}s)が短く、大半が未使用です`,
        });
      }
    }
  }
  return findings;
}

/** ファイル名(拡張子・ディレクトリを除いた basename)の類似度(0..1)を
 * 編集距離(Levenshtein)ベースで返す純関数。決定論・LLM を使わない */
export function nameSimilarity(a: string, b: string): number {
  const x = basenameNoExt(a).toLowerCase();
  const y = basenameNoExt(b).toLowerCase();
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(x, y) / maxLen;
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/** dangling(used:true, present:false)と unused(used:false, present:true)を
 * 分類する純関数。dangling の貼り替え候補は unused な present ファイルから
 * 名前類似の上位 cfg.maxReplacements 件。removeOps は @id を持つ参照だけ */
export function classifyReferences(
  index: MaterialsIndex,
  cfg: MaterialFitCfg,
): { dangling: DanglingFinding[]; unused: UnusedFinding[] } {
  const presentUnused = index.materials.filter((m) => m.present && !m.used && m.kind !== "unknown");

  const dangling: DanglingFinding[] = index.materials
    .filter((m) => m.used && !m.present)
    .map((m) => {
      const replacements = presentUnused
        .map((c) => ({ file: c.file, score: nameSimilarity(m.file, c.file) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.maxReplacements)
        .map((c) => c.file);
      const removeOps: EditOp[] = m.references
        .filter((r): r is MaterialRef & { id: string } => typeof r.id === "string" && r.id !== "")
        .map((r) => ({ op: "remove", target: `@${r.id}` }));
      return { file: m.file, refs: m.references, replacements, removeOps };
    });

  const unused: UnusedFinding[] = presentUnused.map((m) => ({ file: m.file, kind: m.kind }));

  return { dangling, unused };
}

/** FitFinding[] + DanglingFinding[] を apply が食う ApplyPatch(ops のみ)へ束ねる。
 * suggestion の無い finding(underrun の既定挙動)は含めない */
export function buildFitPatch(fits: FitFinding[], danglings: DanglingFinding[]): { ops: EditOp[] } {
  const ops: EditOp[] = [];
  for (const f of fits) if (f.suggestion) ops.push(f.suggestion);
  for (const d of danglings) ops.push(...d.removeOps);
  return { ops };
}
