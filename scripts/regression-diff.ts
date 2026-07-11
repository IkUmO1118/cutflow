// scripts/regression-diff.ts — 回帰基準線(D7)の before/after 比較。
// docs/plans/2026-07-11-d7-w0-implementation-design.md Part A.2-3。
//
// 同一サンプルの2ラベルのスナップショット(regression-snapshot.ts が書いた
// describeJson 結果)を読み、keep/cut 数・出力尺・カット境界・カットされた
// 発話の増減を粗く可視化する(完全一致比較ではなく編集差の可視化)。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DescribeProjection } from "../src/stages/describe.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOTS_DIR = join(REPO_ROOT, "docs/plans/regression/snapshots");

function loadSnapshot(sampleId: string, label: string): DescribeProjection {
  const path = join(SNAPSHOTS_DIR, `${sampleId}.${label}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `スナップショットがありません: ${path}\n` +
        `先に node scripts/regression-snapshot.ts <収録フォルダ> ${label} を実行してください`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as DescribeProjection;
}

const fmtSec = (n: number): string => `${n.toFixed(1)}s`;
const delta = (a: number, b: number): string => `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)}`;
const boundaryKey = (iv: { start: number; end: number }): string =>
  `${iv.start.toFixed(2)}-${iv.end.toFixed(2)}`;

function diffBoundaries(before: DescribeProjection, after: DescribeProjection): void {
  const beforeSet = new Set(before.cuts.map(boundaryKey));
  const afterSet = new Set(after.cuts.map(boundaryKey));
  const added = after.cuts.filter((c) => !beforeSet.has(boundaryKey(c)));
  const removed = before.cuts.filter((c) => !afterSet.has(boundaryKey(c)));
  console.log(`\nカット境界: 追加 ${added.length} / 削除 ${removed.length}`);
  for (const c of added) {
    console.log(`  + cut ${fmtSec(c.start)}–${fmtSec(c.end)}(${c.reasons.join(",") || "理由なし"})`);
  }
  for (const c of removed) {
    console.log(`  - cut ${fmtSec(c.start)}–${fmtSec(c.end)}(${c.reasons.join(",") || "理由なし"})`);
  }
}

function diffLostCaptions(before: DescribeProjection, after: DescribeProjection): void {
  const beforeTexts = new Set(before.cuts.flatMap((c) => c.lostCaptions.map((l) => l.text)));
  const afterTexts = new Set(after.cuts.flatMap((c) => c.lostCaptions.map((l) => l.text)));
  const newlyLost = [...afterTexts].filter((t) => !beforeTexts.has(t));
  const recovered = [...beforeTexts].filter((t) => !afterTexts.has(t));
  console.log(`\nカットされた発話: 新規カット ${newlyLost.length} / 復活 ${recovered.length}`);
  for (const t of newlyLost) console.log(`  + 「${t}」`);
  for (const t of recovered) console.log(`  - 「${t}」`);
}

function main(): void {
  const [, , sampleId, labelA, labelB] = process.argv;
  if (!sampleId || !labelA || !labelB) {
    console.error("使い方: node scripts/regression-diff.ts <sampleId> <labelA> <labelB>");
    console.error("例:     node scripts/regression-diff.ts sample-a baseline after-w0");
    process.exit(1);
  }

  const before = loadSnapshot(sampleId, labelA);
  const after = loadSnapshot(sampleId, labelB);

  console.log(`=== ${sampleId}: ${labelA} → ${labelB} ===`);
  console.log(
    `keep数: ${before.summary.keepCount} → ${after.summary.keepCount} ` +
      `(${delta(before.summary.keepCount, after.summary.keepCount)})`,
  );
  console.log(
    `cut数:  ${before.cuts.length} → ${after.cuts.length} ` +
      `(${delta(before.cuts.length, after.cuts.length)})`,
  );
  console.log(
    `出力尺: ${fmtSec(before.summary.outDurationSec)} → ${fmtSec(after.summary.outDurationSec)} ` +
      `(${delta(before.summary.outDurationSec, after.summary.outDurationSec)}s)`,
  );

  diffBoundaries(before, after);
  diffLostCaptions(before, after);
}

main();
