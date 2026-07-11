// M2(尺整合)+ M3(dangling/unused)の橋渡し(material-fit コマンド)の
// オーケストレータ。§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md
//
// materials.probe/index.json / overlays.json を読み、src/lib/materialFit.ts
// (純関数)を呼んで apply パッチ下書き(material-fit.suggested.json)を書く。
// 収録フォルダの編集ファイル(overlays.json 等)は一切書かない。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMaterialFitCfg } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { buildFitPatch, classifyReferences, detectFit } from "../lib/materialFit.ts";
import type { DanglingFinding, FitFinding, UnusedFinding } from "../lib/materialFit.ts";
import { MATERIALS_INDEX_FILE, MATERIALS_PROBE_DIR } from "./materials.ts";
import type { MaterialsIndex } from "../lib/materials.ts";
import type { Overlays } from "../types.ts";

/** 使い捨ての下書き(rules.suggested.md と同カテゴリ。次回実行で黙って上書き) */
export const MATERIAL_FIT_PATCH_FILE = "material-fit.suggested.json";

export interface MaterialFitResult {
  fits: FitFinding[];
  dangling: DanglingFinding[];
  unused: UnusedFinding[];
  /** 書いたパッチのパス。ops が空(何も提案できなかった)なら書かず null */
  patchPath: string | null;
}

function hasAnyOverlayId(overlays: Overlays): boolean {
  const elems = [...(overlays.overlays ?? []), ...(overlays.inserts ?? [])];
  return elems.length === 0 || elems.some((e) => typeof e.id === "string" && e.id !== "");
}

/**
 * materials.probe/index.json(前提。無ければ告知して例外)と overlays.json
 * (無ければ検出対象なしで空の結果)から、尺整合(overrun/underrun)と
 * dangling/unused を検出し、apply パッチ下書きを書く。overlays/inserts に
 * @id が1つも無いプロジェクトは「先に id-stamp」を告げて例外を投げる
 * (ops の宛先に @id が要るため)。
 */
export function materialFit(dir: string, cfg: Config): MaterialFitResult {
  const indexPath = join(dir, MATERIALS_PROBE_DIR, MATERIALS_INDEX_FILE);
  if (!existsSync(indexPath)) {
    throw new Error(
      `${indexPath} がありません。先に \`node src/cli.ts materials ${dir}\` を実行してください`,
    );
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as MaterialsIndex;

  const overlaysPath = join(dir, "overlays.json");
  const bgmPath = join(dir, "bgm.json");
  const overlaysExists = existsSync(overlaysPath);
  if (!overlaysExists && !existsSync(bgmPath)) {
    return { fits: [], dangling: [], unused: [], patchPath: null };
  }
  const overlays: Overlays = overlaysExists ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays) : {};

  if (!hasAnyOverlayId(overlays)) {
    throw new Error(
      `overlays.json の overlay/insert に @id がありません。先に \`node src/cli.ts id-stamp ${dir}\` を実行してください`,
    );
  }

  const fitCfg = resolveMaterialFitCfg(cfg);
  const fits = detectFit(index, fitCfg);
  const { dangling, unused } = classifyReferences(index, fitCfg);

  const patch = buildFitPatch(fits, dangling);
  let patchPath: string | null = null;
  if (patch.ops.length > 0) {
    patchPath = join(dir, MATERIAL_FIT_PATCH_FILE);
    writeFileSync(patchPath, JSON.stringify(patch, null, 2));
  }

  return { fits, dangling, unused, patchPath };
}

/** stdout 向けの人間可読レポート行 */
export function formatMaterialFitReport(dir: string, result: MaterialFitResult): string[] {
  const lines: string[] = [];
  if (result.fits.length === 0 && result.dangling.length === 0 && result.unused.length === 0) {
    lines.push("尺整合・dangling・unused: 検出なし");
    return lines;
  }

  for (const f of result.fits) {
    const label = f.kind === "overrun" ? "尺超過" : "尺不足";
    lines.push(`[${label}] ${f.file}(${f.as} @${f.refId}): ${f.reason}`);
  }
  for (const d of result.dangling) {
    const rep = d.replacements.length > 0 ? `貼り替え候補: ${d.replacements.join(", ")}` : "貼り替え候補なし(手動対応が必要)";
    const removable = d.removeOps.length > 0 ? "" : "(@id 未採番の参照は remove 提案できません)";
    lines.push(`[dangling] ${d.file}: 参照先が materials/ に見つかりません(${rep})${removable}`);
  }
  for (const u of result.unused) {
    lines.push(`[unused] ${u.file}: 一度も参照されていません(\`node src/cli.ts plan-materials ${dir}\` で配置候補を出せます)`);
  }

  if (result.patchPath) {
    lines.push(`修正案を ${result.patchPath} に書きました。適用は:`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath} --dry-run`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath}`);
  } else {
    lines.push("apply パッチ下書きなし(自動修正できる項目はありませんでした)");
  }
  return lines;
}
