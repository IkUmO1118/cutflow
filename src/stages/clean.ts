// 収録フォルダの中間生成物/キャッシュを安全に列挙・削除する。
// 分類は src/lib/files.ts(単一の真実)由来。削除してよいのは role === "generated"
// のトップレベル子エントリだけで、editable / approval / other には一切触れない。
import { readdirSync, statSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileRole, isGeneratedCache } from "../lib/files.ts";

export type CleanTargetKind = "file" | "dir";

export type CleanTarget = {
  /** 収録フォルダからの相対パス(例 "proxy.mp4" / "frames")。常にトップレベル1階層 */
  relPath: string;
  kind: CleanTargetKind;
  /** 解放されるバイト数(dir は配下再帰の合計) */
  bytes: number;
  /** 削除される実ファイル数(file は 1、dir は配下の実ファイル数) */
  files: number;
};

export type CleanPlan = {
  dir: string;              // 走査した収録フォルダ(絶対パス)
  cacheOnly: boolean;       // --cache-only だったか
  targets: CleanTarget[];   // 削除対象(relPath 昇順)
  fileCount: number;        // 実際に unlink される総ファイル数
  dirCount: number;         // 削除されるトップレベル generated ディレクトリ数
  bytes: number;            // 解放される総バイト数
};

/** dir 配下の実ファイル数と合計バイト(シンボリックリンクは辿らずリンク自身を1件計上) */
function walkDir(abs: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    const p = join(abs, ent.name);
    if (ent.isSymbolicLink()) {
      bytes += lstatSync(p).size;
      files += 1;
    } else if (ent.isDirectory()) {
      const sub = walkDir(p);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += statSync(p).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * 削除計画を立てる純関数(削除は一切しない)。収録フォルダ直下の子エントリだけを
 * 分類し、role === "generated" のものだけを対象にする。cacheOnly なら
 * isGeneratedCache が true のものに絞る。存在しないフォルダ/空フォルダでも安全。
 */
export function planClean(dir: string, opts?: { cacheOnly?: boolean }): CleanPlan {
  const cacheOnly = opts?.cacheOnly === true;
  const targets: CleanTarget[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = []; // フォルダが無い/読めない → 空計画(冪等・安全)
  }
  for (const ent of entries) {
    const name = ent.name; // readdir の name は "/" も ".." も含まない=traversal 不可
    if (fileRole(name) !== "generated") continue;      // ★安全の核: generated 以外は選ばない
    if (cacheOnly && !isGeneratedCache(name)) continue; // 軽い中間生成物は cache-only で残す
    const abs = join(dir, name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      const w = walkDir(abs);
      targets.push({ relPath: name, kind: "dir", bytes: w.bytes, files: w.files });
    } else {
      // ファイル or シンボリックリンク(リンクは辿らずリンク自身のサイズ)
      const size = (ent.isSymbolicLink() ? lstatSync(abs) : statSync(abs)).size;
      targets.push({ relPath: name, kind: "file", bytes: size, files: 1 });
    }
  }
  targets.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    dir,
    cacheOnly,
    targets,
    fileCount: targets.reduce((s, t) => s + t.files, 0),
    dirCount: targets.filter((t) => t.kind === "dir").length,
    bytes: targets.reduce((s, t) => s + t.bytes, 0),
  };
}

/**
 * 計画を実行(削除)する。各 unlink 直前に fileRole を再アサートする
 * belt-and-suspenders: 万一 generated 以外が計画に混ざっても物理削除する前に throw する
 * (=編集ファイル/approvals.json を touch し得ないことの二重保証)。rmSync は force で
 * ENOENT を無視するので冪等(既に消えていても失敗しない)。
 */
export function executeClean(dir: string, plan: CleanPlan): void {
  for (const t of plan.targets) {
    if (fileRole(t.relPath) !== "generated") {
      throw new Error(
        `内部エラー: 掃除対象が generated ではありません(削除を中止): ${t.relPath}`,
      );
    }
    rmSync(join(dir, t.relPath), { recursive: t.kind === "dir", force: true });
  }
}

/** 3桁+単位でバイトを整形(1024 進法。B/KB/MB/GB) */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

/** 人間向けレポート行を生成(CLI が1行ずつ console.log する) */
export function formatCleanReport(plan: CleanPlan, dryRun: boolean): string[] {
  const lines: string[] = [];
  const scope = plan.cacheOnly ? "キャッシュのみ" : "全中間生成物";
  lines.push(`掃除(${scope}) 収録フォルダ: ${plan.dir}`);
  if (plan.targets.length === 0) {
    lines.push("削除対象はありません(すでに掃除済み)");
    return lines;
  }
  for (const t of plan.targets) {
    const tag = t.kind === "dir" ? "[dir] " : "[file]";
    const cnt = t.kind === "dir" ? ` ${t.files}ファイル` : "";
    lines.push(`  ${tag} ${t.relPath}${cnt}  ${formatBytes(t.bytes)}`);
  }
  lines.push(
    `合計: ${plan.targets.length}項目 / ${plan.fileCount}ファイル / ${formatBytes(plan.bytes)}`,
  );
  lines.push(
    dryRun
      ? "(--dry-run: 削除していません)"
      : `削除しました(${formatBytes(plan.bytes)} 解放)`,
  );
  return lines;
}
