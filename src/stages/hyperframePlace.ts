// C5: HyperFrames カード(materials/hyperframes/<name>.mp4。C4 が render 済み)を
// overlays.json へ配置する apply パッチ下書きを書く(`hyperframe-place` コマンド)。
// docs/programs/hyperframes-integration-program.md の C5。
//
// material-fit / effect-check / bgm-fit と同じ「*-fit → *.suggested.json」の
// apply-patch DRAFT パターン(src/stages/materialFit.ts を参照)。**収録
// フォルダの編集ファイル(overlays.json)は一切書かない**。書くのは使い捨ての
// hyperframe-place.suggested.json という apply パッチ下書きだけで、適用は
// 人間が確認して `apply --patch` で行う。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliCmd } from "../lib/cliName.ts";
import { probe, summarizeProbe } from "../lib/ffmpeg.ts";
import type { ApplyPatch, CutPlan, Overlays, Region } from "../types.ts";

type OverlayItem = NonNullable<Overlays["overlays"]>[number];
type InsertItem = NonNullable<Overlays["inserts"]>[number];

/** 使い捨ての下書き(material-fit.suggested.json 等と同カテゴリ。
 * 次回 hyperframe-place 実行で黙って上書きされる) */
export const HYPERFRAME_PLACE_PATCH_FILE = "hyperframe-place.suggested.json";

export interface PlaceParams {
  name: string;
  kind: "overlay" | "insert";
  /** 配置位置(元収録の秒)。overlay は start、insert は at になる */
  at: number;
  durationSec: number;
  rect?: Region;
  fadeSec?: number;
  track?: number;
  startFrom?: number;
}

/** fade の展開(fadeInSec/fadeOutSec を両方セットする。省略/0以下は無し) */
function fadeFields(fadeSec?: number): { fadeInSec?: number; fadeOutSec?: number } {
  if (fadeSec === undefined || fadeSec <= 0) return {};
  return { fadeInSec: fadeSec, fadeOutSec: fadeSec };
}

/**
 * overlays.json の overlays[]/inserts[] へ1件追加する apply パッチを組み立てる
 * 純関数。**overlays.json が既に存在するかどうかで op の形を変える**
 * (src/lib/applyEdits.ts の compileOps は add の対象ファイルが未存在だと
 * 「先に replace で作成してください」と拒否するため。add はあくまで
 * 既存ファイルへの追記専用):
 * - overlaysExists: true  → 既存どおり `{ops:[{op:"add", target, value}]}`
 *   (target/op の形は schemas/apply-patch.schema.json +
 *   src/lib/applyEdits.ts の ADD_SELECTORS("overlays.overlays" /
 *   "overlays.inserts")に厳密に従う)
 * - overlaysExists: false → `{replace:{overlays:{overlays:[value]}}}` または
 *   `{replace:{overlays:{inserts:[value]}}}`(overlays.json を1件だけの
 *   配列で新規作成する whole-file replace)
 * value(配置する要素)自体はどちらの形でも同じ。id/approved は一切出さない
 * (id は apply 側が id 有効プロジェクトでのみ新規要素に採番する。承認は
 * apply のスコープ外)
 */
export function buildPlacePatch(p: PlaceParams, overlaysExists: boolean): ApplyPatch {
  const file = `materials/hyperframes/${p.name}.mp4`;
  const fade = fadeFields(p.fadeSec);

  if (p.kind === "insert") {
    const value: Record<string, unknown> = {
      at: p.at,
      file,
      durationSec: p.durationSec,
      fit: "contain",
      volume: 0,
      ...(p.startFrom !== undefined ? { startFrom: p.startFrom } : {}),
      ...fade,
    };
    if (!overlaysExists) return { replace: { overlays: { inserts: [value as unknown as InsertItem] } } };
    return { ops: [{ op: "add", target: "overlays.inserts", value }] };
  }

  const value: Record<string, unknown> = {
    start: p.at,
    end: p.at + p.durationSec,
    file,
    fit: "contain",
    volume: 0,
    ...(p.track !== undefined ? { track: p.track } : {}),
    ...(p.rect !== undefined ? { rect: p.rect } : {}),
    ...(p.startFrom !== undefined ? { startFrom: p.startFrom } : {}),
    ...fade,
  };
  if (!overlaysExists) return { replace: { overlays: { overlays: [value as unknown as OverlayItem] } } };
  return { ops: [{ op: "add", target: "overlays.overlays", value }] };
}

export interface HyperframePlaceResult {
  kind: "overlay" | "insert";
  file: string;
  at: number;
  durationSec: number;
  durationSource: "key" | "ffprobe" | "flag";
  patchPath: string;
  warnings: string[];
  /** overlays.json が存在しなかった(=このパッチが replace で新規作成する) */
  overlaysCreated: boolean;
}

/** cutplan.json の keep 区間に at(元収録の秒)が含まれるかを確認する。
 * cutplan.json が無い/読めない場合は判定しない(warning を出さない) */
function isInsideKeep(dir: string, at: number): boolean | null {
  const cutplanPath = join(dir, "cutplan.json");
  if (!existsSync(cutplanPath)) return null;
  let cutplan: CutPlan;
  try {
    cutplan = JSON.parse(readFileSync(cutplanPath, "utf8")) as CutPlan;
  } catch {
    return null;
  }
  if (!Array.isArray(cutplan.segments)) return null;
  return cutplan.segments.some((s) => s.action === "keep" && at >= s.start && at <= s.end);
}

/**
 * materials/hyperframes/<name>.mp4(C4 が render 済み)の尺を解決し、
 * overlays.json への配置(overlay または insert)を提案する apply パッチ
 * 下書きを書く。**収録フォルダの編集ファイルは1バイトも書かない**
 * (出力は hyperframe-place.suggested.json という使い捨てのパッチ下書きだけ)。
 */
export async function hyperframePlace(
  dir: string,
  opts: {
    name: string;
    at: number;
    as?: "overlay" | "insert";
    durationSec?: number;
    rect?: Region;
    fadeSec?: number;
    track?: number;
    startFrom?: number;
  },
): Promise<HyperframePlaceResult> {
  const kind = opts.as ?? "overlay";
  const mp4Path = join(dir, "materials", "hyperframes", `${opts.name}.mp4`);
  if (!existsSync(mp4Path)) {
    throw new Error(
      `materials/hyperframes/${opts.name}.mp4 がありません。先に` +
        ` \`${cliCmd()} hyperframe ${dir} --name ${opts.name}\` で素材を生成してください`,
    );
  }

  if (kind === "insert" && (opts.rect !== undefined || opts.track !== undefined)) {
    throw new Error("insert は rect/track を取りません(--as overlay で配置してください)");
  }

  let durationSec: number;
  let durationSource: "key" | "ffprobe" | "flag";
  if (opts.durationSec !== undefined) {
    durationSec = opts.durationSec;
    durationSource = "flag";
  } else {
    const keyPath = join(dir, `hyperframe.${opts.name}.key.json`);
    let fromKey: number | undefined;
    if (existsSync(keyPath)) {
      try {
        const key = JSON.parse(readFileSync(keyPath, "utf8")) as { durationSec?: unknown };
        if (typeof key.durationSec === "number") fromKey = key.durationSec;
      } catch {
        // 壊れた key.json は無視して ffprobe へフォールバック
      }
    }
    if (fromKey !== undefined) {
      durationSec = fromKey;
      durationSource = "key";
    } else {
      const summary = summarizeProbe(await probe(mp4Path));
      if (summary.durationSec === undefined) {
        throw new Error(`${mp4Path} の尺が ffprobe で取得できませんでした`);
      }
      durationSec = summary.durationSec;
      durationSource = "ffprobe";
    }
  }

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`durationSec が不正です(正の数が必要。got ${String(durationSec)})`);
  }

  const warnings: string[] = [];
  const insideKeep = isInsideKeep(dir, opts.at);
  if (insideKeep === false) {
    warnings.push(
      `at=${opts.at}s は keep 区間外です。describe / frames --t で keep 内の時刻を選び直してください`,
    );
  }

  const overlaysExists = existsSync(join(dir, "overlays.json"));
  const patch = buildPlacePatch(
    {
      name: opts.name,
      kind,
      at: opts.at,
      durationSec,
      rect: opts.rect,
      fadeSec: opts.fadeSec,
      track: opts.track,
      startFrom: opts.startFrom,
    },
    overlaysExists,
  );

  const patchPath = join(dir, HYPERFRAME_PLACE_PATCH_FILE);
  writeFileSync(patchPath, JSON.stringify(patch, null, 2));

  return {
    kind,
    file: `materials/hyperframes/${opts.name}.mp4`,
    at: opts.at,
    durationSec,
    durationSource,
    patchPath,
    warnings,
    overlaysCreated: !overlaysExists,
  };
}

/** stdout 向けの人間可読レポート行 */
export function formatPlaceReport(dir: string, r: HyperframePlaceResult): string[] {
  const lines: string[] = [];
  const sourceLabel = r.durationSource === "flag" ? "--duration 指定" : r.durationSource === "key" ? "hyperframe.<name>.key.json" : "ffprobe";
  const overlaysNote = r.overlaysCreated ? "overlays.json を新規作成" : "既存の overlays.json に追記";
  lines.push(
    `${r.file} を ${r.kind}(at=${r.at}s, durationSec=${r.durationSec.toFixed(2)}, 尺の出所: ${sourceLabel}, ${overlaysNote})として配置する下書きを書きました。`,
  );
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  lines.push(`下書き: ${r.patchPath}`);
  lines.push("次のステップ(確認してから適用):");
  lines.push(`  ${cliCmd()} frames ${dir} --t ${r.at}`);
  lines.push(`  ${cliCmd()} preview ${dir}`);
  lines.push(`  ${cliCmd()} effect-check ${dir}`);
  lines.push(`  ${cliCmd()} apply ${dir} --patch ${r.patchPath} --dry-run`);
  lines.push(`  ${cliCmd()} apply ${dir} --patch ${r.patchPath}`);
  lines.push("**自分で apply しない**(placement は人間が review してから適用する)");
  return lines;
}
