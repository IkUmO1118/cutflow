// scripts/regression-snapshot.ts — 回帰基準線(D7)のスナップショット取得。
// docs/plans/2026-07-11-d7-w0-implementation-design.md Part A.2-2。
//
// 収録フォルダの describeJson() 結果をラベル付きで
// docs/plans/regression/snapshots/<sampleId>.<label>.json に保存する。
// CLI を spawn せず既存の describeJson を関数直呼びする(その方が安定)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.ts";
import { describeJson } from "../src/stages/describe.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = join(REPO_ROOT, "docs/plans/regression/README.md");
const SNAPSHOTS_DIR = join(REPO_ROOT, "docs/plans/regression/snapshots");

/** README.md の台帳テーブル(`| id | 収録フォルダ(絶対パス) | 特徴 |`)から
 * 収録フォルダの絶対パス → sampleId を引く。台帳に無ければ null */
function lookupSampleId(dirAbs: string): string | null {
  if (!existsSync(LEDGER_PATH)) return null;
  const lines = readFileSync(LEDGER_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cols = trimmed.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const [id, path] = cols;
    if (id === "id" || /^-+$/.test(id)) continue; // ヘッダ・区切り行
    if (resolve(path) === dirAbs) return id;
  }
  return null;
}

function main(): void {
  const [, , dirArg, label] = process.argv;
  if (!dirArg || !label) {
    console.error("使い方: node scripts/regression-snapshot.ts <収録フォルダ> <label>");
    console.error("例:     node scripts/regression-snapshot.ts ~/Movies/cutflow/2026-07-02-xxx baseline");
    process.exit(1);
  }

  const dirAbs = resolve(dirArg);
  if (!existsSync(dirAbs)) {
    console.error(`収録フォルダがありません: ${dirAbs}`);
    process.exit(1);
  }

  const sampleId = lookupSampleId(dirAbs);
  if (sampleId === null) {
    console.error(
      `この収録フォルダが台帳(${LEDGER_PATH})に見つかりません。\n` +
        "先に README.md のサンプル一覧に id と絶対パスを追記してください: " +
        dirAbs,
    );
    process.exit(1);
  }

  const cfg = loadConfig();
  const projection = describeJson(dirAbs, cfg);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${sampleId}.${label}.json`);
  writeFileSync(outPath, JSON.stringify(projection, null, 2), "utf8");
  console.log(`✔ ${outPath}`);
}

main();
