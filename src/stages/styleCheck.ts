// SD-T1: style-check コマンドのオーケストレータ(薄い殻)。
// §docs/plans/2026-07-12-sd-t1-style-check-design.md §2.4
//
// channel(dir の親)の style.probe/<name>.json(reference)を読み、候補
// (この収録の現在の編集)を SD-T0 の集約経路(observeOwnProject →
// mergeObservations)で同じ形の StyleProfile へ畳んでから、
// src/lib/styleCheck.ts の純関数(compareProfiles)で距離を測る。
// 収録フォルダの編集ファイルは一切書かない(読むのは describeJson・
// av.probe・bgm 存在チェックだけ)。書くのは <dir>/style-check.json のみ。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../lib/config.ts";
import { describeJson } from "./describe.ts";
import { AV_DIR, SOUND_FILE } from "./av.ts";
import type { SoundReport, MotionReport } from "./av.ts";
import { STYLE_PROBE_DIR } from "./styleProfile.ts";
import { observeOwnProject, mergeObservations } from "../lib/styleProfile.ts";
import type { StyleProfile } from "../lib/styleProfile.ts";
import { compareProfiles, summarizeFindings, STYLE_CHECK_SCHEMA_VERSION } from "../lib/styleCheck.ts";
import type { StyleCheckReport, StyleFinding } from "../lib/styleCheck.ts";

/** motion.json のファイル名。av.ts は MOTION_FILE を export していないため
 * リテラルで持つ(SOUND_FILE/AV_DIR は export 済みなので import。
 * src/stages/styleProfile.ts の同名定数と同じ理由) */
const MOTION_FILE = "motion.json";

/** style-check.json のファイル名(収録フォルダ直下の生成物) */
export const STYLE_CHECK_FILE = "style-check.json";

export interface StyleCheckResult {
  report: StyleCheckReport;
  reportPath: string;
}

function readJsonOpt<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

/**
 * 収録の現在の編集(候補)が style profile(reference)の学習分散帯から
 * どれだけ逸脱しているかを測り、<dir>/style-check.json に書く。
 * profile 不在(前提エラー)だけ throw(→ exit 1)。逸脱報告自体は常に成功
 * (呼び出し側=cli.ts が exit 0 で返す)。
 */
export function styleCheck(dir: string, opts: { profile?: string }, cfg: Config): StyleCheckResult {
  const name = (opts.profile ?? "default").trim() || "default";

  // 1) reference profile を channel(dir の親)から読む。無ければ前提エラー(exit 1)
  const channel = dirname(resolve(dir));
  const profilePath = join(channel, STYLE_PROBE_DIR, `${name}.json`);
  if (!existsSync(profilePath)) {
    throw new Error(
      `${profilePath} がありません。先に \`node src/cli.ts style-profile --from ${dir}` +
        `${name !== "default" ? ` --name ${name}` : ""}\` を実行してください`,
    );
  }
  const reference = JSON.parse(readFileSync(profilePath, "utf8")) as StyleProfile;

  // 2) 候補を SD-T0 の集約経路で畳む(§2.2 の再利用。統計・ラベル写像の再実装ゼロ)
  const proj = describeJson(dir, cfg);
  const sound = readJsonOpt<SoundReport>(join(dir, AV_DIR, SOUND_FILE)); // 欠落可(→ audio skipped)
  const motion = readJsonOpt<MotionReport>(join(dir, AV_DIR, MOTION_FILE));
  const bgmPresent =
    existsSync(join(dir, "bgm.json")) ||
    ["bgm.mp3", "bgm.m4a", "bgm.wav"].some((f) => existsSync(join(dir, f)));
  const candObs = observeOwnProject({ path: dir, proj, sound, motion, planRaw: null, bgmPresent });
  const candidate = mergeObservations("_candidate", [candObs]);

  // 3) 距離計算(純関数)
  const findings: StyleFinding[] = compareProfiles(reference, candidate);
  const report: StyleCheckReport = {
    schemaVersion: STYLE_CHECK_SCHEMA_VERSION,
    profileName: reference.name,
    provenance: reference.provenance,
    findings,
    counts: summarizeFindings(findings),
  };

  // 4) 収録フォルダ直下 <dir>/style-check.json に書く(編集ファイルは1バイトも書かない)
  const reportPath = join(dir, STYLE_CHECK_FILE);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath };
}

const KIND_LABEL: Record<StyleFinding["kind"], string> = {
  deviation: "逸脱",
  borderline: "境界",
  mismatch: "不一致",
  skipped: "測定不能",
};

/** stdout 向けの人間可読レポート行(§2.5)。`dir` は bgmFit/effectCheck の
 * formatXxxReport と同じシグネチャに揃えるための引数(v1 は apply 誘導が
 * 無いため本文では未使用。将来 apply パッチ下書きを持たせる拡張点) */
export function formatStyleCheckReport(dir: string, result: StyleCheckResult): string[] {
  void dir;
  const { report, reportPath } = result;
  const lines: string[] = [];

  lines.push(
    `style-check: profile=${report.profileName} (${report.provenance}) / ` +
      `warn ${report.counts.warn} info ${report.counts.info} skipped ${report.counts.skipped}`,
  );

  if (report.findings.length === 0) {
    lines.push("距離 assert: profile の学習帯内(逸脱なし)");
  } else {
    for (const f of report.findings) {
      lines.push(`[${f.severity}] ${f.section}.${f.metric}(${KIND_LABEL[f.kind]}): ${f.message}`);
    }
  }

  lines.push("距離 assert はすべて warn(exit 0)。逸脱は学習帯からのズレであって不正ではありません。");
  lines.push(`検出結果を ${reportPath} に書きました。`);
  return lines;
}
