// B2(無音/被り回避の音量・duck・切替調整)+ B4(fallback/単調 検出)の
// 橋渡し(bgm-fit コマンド)のオーケストレータ。
// §docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md
//
// av.probe/sound.json(要 av <dir> の事前実行)・bgm.json・chapters.json を
// 読み、src/lib/bgmFit.ts(純関数)を呼んで apply パッチ下書き
// (bgm-fit.suggested.json)と検出結果(bgm-fit.json)を書く。収録フォルダの
// 編集ファイル(bgm.json 等)は一切書かない。cutplan.json / approvals.json は
// 読まない・書かない(不変条件5・8)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBgmFitCfg } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { buildBgmFitPatch, detectBgmFit, detectMonotone } from "../lib/bgmFit.ts";
import type { BgmFitFinding } from "../lib/bgmFit.ts";
import { AV_DIR, SOUND_FILE } from "./av.ts";
import type { SoundReport } from "./av.ts";
import { findBgm } from "./render.ts";
import type { Bgm, Chapters } from "../types.ts";

/** 検出結果(機械可読)。effect-check.json と同じ位置づけ */
export const BGM_FIT_REPORT_FILE = "bgm-fit.json";
/** 使い捨ての下書き(material-fit.suggested.json と同カテゴリ。次回実行で黙って上書き) */
export const BGM_FIT_PATCH_FILE = "bgm-fit.suggested.json";

const SCHEMA_VERSION = 1;

export interface BgmFitResult {
  findings: BgmFitFinding[];
  monotone: { monotone: boolean; message: string };
  reportPath: string;
  /** 書いたパッチのパス。ops が空(補正候補が無い)なら書かず null */
  patchPath: string | null;
}

function hasAnyBgmTrackId(bgm: Bgm): boolean {
  return bgm.tracks.length === 0 || bgm.tracks.some((t) => typeof t.id === "string" && t.id !== "");
}

/**
 * av.probe/sound.json(前提。無ければ告知して例外。§不変条件4)と
 * bgm.json(無ければ B4 の fallback 判定へ。B2 の編集対象トラックは無い)から、
 * 無音/被り/大音量/no-fade の補正候補(B2)と単調 fallback(B4)を検出し、
 * apply パッチ下書きを書く。bgm.json に tracks があるのに @id が1つも無い
 * プロジェクトは「先に id-stamp」を告げて例外を投げる(ops の宛先に @id が
 * 要るため。materialFit の id-stamp 前提チェックと同じ扱い)。
 */
export function bgmFit(dir: string, cfg: Config): BgmFitResult {
  const soundPath = join(dir, AV_DIR, SOUND_FILE);
  if (!existsSync(soundPath)) {
    throw new Error(`${soundPath} がありません。先に \`node src/cli.ts av ${dir}\` を実行してください`);
  }
  const sound = JSON.parse(readFileSync(soundPath, "utf8")) as SoundReport;

  const bgmPath = join(dir, "bgm.json");
  const bgmExists = existsSync(bgmPath);
  const bgm: Bgm | null = bgmExists ? (JSON.parse(readFileSync(bgmPath, "utf8")) as Bgm) : null;

  if (bgm && !hasAnyBgmTrackId(bgm)) {
    throw new Error(
      `bgm.json の tracks に @id がありません。先に \`node src/cli.ts id-stamp ${dir}\` を実行してください`,
    );
  }

  const fitCfg = resolveBgmFitCfg(cfg);
  const findings = bgm ? detectBgmFit(sound, bgm, fitCfg) : [];

  const chaptersPath = join(dir, "chapters.json");
  const chapterCount = existsSync(chaptersPath)
    ? ((JSON.parse(readFileSync(chaptersPath, "utf8")) as Chapters).chapters?.length ?? 0)
    : 0;
  const fallbackActive = !bgmExists && findBgm(dir) !== null;
  const totalOutSec = Math.max(0, sound.range.endSec - sound.range.startSec);
  const monotone = detectMonotone({ fallbackActive, bgm, totalOutSec, chapterCount, cfg: fitCfg });

  const patch = buildBgmFitPatch(findings);
  let patchPath: string | null = null;
  if (patch.ops.length > 0) {
    patchPath = join(dir, BGM_FIT_PATCH_FILE);
    writeFileSync(patchPath, JSON.stringify(patch, null, 2));
  }

  const reportPath = join(dir, BGM_FIT_REPORT_FILE);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        capturedAt: new Date().toISOString(),
        findings,
        monotone,
        patchFile: patchPath ? BGM_FIT_PATCH_FILE : null,
      },
      null,
      2,
    ),
  );

  return { findings, monotone, reportPath, patchPath };
}

/** stdout 向けの人間可読レポート行 */
export function formatBgmFitReport(dir: string, result: BgmFitResult): string[] {
  const lines: string[] = [];
  const kindLabel: Record<BgmFitFinding["kind"], string> = {
    "speech-overlap": "発話被り",
    "silence-float": "無音浮き",
    loud: "大音量",
    "no-fade": "フェード無し",
  };

  if (result.findings.length === 0) {
    lines.push("BGM の音量/duck/フェード: 検出なし");
  } else {
    for (const f of result.findings) {
      lines.push(
        `[${kindLabel[f.kind]}] @${f.refId}(${f.startOutSec}s〜${f.endOutSec}s, 現 volumeDb=${f.currentVolumeDb}): ${f.reason}`,
      );
    }
  }

  if (result.monotone.monotone) {
    lines.push(`[単調] ${result.monotone.message}`);
  }

  lines.push(`検出結果を ${result.reportPath} に書きました。`);
  if (result.patchPath) {
    lines.push(`修正案を ${result.patchPath} に書きました。適用は:`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath} --dry-run`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath}`);
  } else {
    lines.push("apply パッチ下書きなし(自動修正できる項目はありませんでした)");
  }
  return lines;
}
