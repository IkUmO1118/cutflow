// 収録フォルダの中間生成物/キャッシュを安全に列挙・削除する。
// 分類は src/lib/files.ts(単一の真実)由来。削除してよいのは role === "generated"
// のトップレベル子エントリだけで、editable / approval には一切触れない。
//
// 唯一の例外が "remux-dup"(元収録の自動リマックス複製。role は "other")で、
// これだけは名前ではなく**実行時の内容照合**で対象に入る。判定条件と安全の
// 論拠は src/lib/remuxDup.ts のヘッダを正とする。純粋・同期の planClean には
// 混ぜず(ffprobe が要る=非同期)、planCleanWithRemuxDup が上に足す形にして、
// 既存の planClean の契約(fs 走査だけ・generated だけ)を保っている。
import { readdirSync, statSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileRole, isGeneratedCache, isGeneratedLog } from "../lib/files.ts";
import { detectRemuxDuplicate, assertRemuxDuplicateStillSafe } from "../lib/remuxDup.ts";

export type CleanTargetKind = "file" | "dir";

/** 対象がどの根拠で選ばれたか。"generated" は files.ts の名前分類、
 * "remux-dup" は元収録との内容一致で選ばれた自動リマックス複製 */
export type CleanTargetCategory = "generated" | "remux-dup";

export type CleanTarget = {
  /** 収録フォルダからの相対パス(例 "proxy.mp4" / "frames")。常にトップレベル1階層 */
  relPath: string;
  kind: CleanTargetKind;
  /** 解放されるバイト数(dir は配下再帰の合計) */
  bytes: number;
  /** 削除される実ファイル数(file は 1、dir は配下の実ファイル数) */
  files: number;
  category: CleanTargetCategory;
  /** category === "remux-dup" のとき、対になっている元収録(manifest.source) */
  remuxSource?: string;
};

export type CleanPlan = {
  dir: string;              // 走査した収録フォルダ(絶対パス)
  cacheOnly: boolean;       // --cache-only だったか
  logsOnly: boolean;        // --logs-only だったか(cacheOnly と排他)
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
 * isGeneratedCache、logsOnly なら isGeneratedLog が true のものに絞る(両者は排他)。
 * 存在しないフォルダ/空フォルダでも安全。
 */
export function planClean(
  dir: string,
  opts?: { cacheOnly?: boolean; logsOnly?: boolean },
): CleanPlan {
  const cacheOnly = opts?.cacheOnly === true;
  const logsOnly = opts?.logsOnly === true;
  if (cacheOnly && logsOnly) {
    throw new Error("--cache-only と --logs-only は同時に指定できません");
  }
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
    if (logsOnly && !isGeneratedLog(name)) continue;    // ログ以外は logs-only で残す
    const abs = join(dir, name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      const w = walkDir(abs);
      targets.push({ relPath: name, kind: "dir", bytes: w.bytes, files: w.files, category: "generated" });
    } else {
      // ファイル or シンボリックリンク(リンクは辿らずリンク自身のサイズ)
      const size = (ent.isSymbolicLink() ? lstatSync(abs) : statSync(abs)).size;
      targets.push({ relPath: name, kind: "file", bytes: size, files: 1, category: "generated" });
    }
  }
  return finalizePlan(dir, cacheOnly, logsOnly, targets);
}

/** targets を整列し、集計値を埋めて CleanPlan にする(planClean と
 * planCleanWithRemuxDup が共有する) */
function finalizePlan(
  dir: string,
  cacheOnly: boolean,
  logsOnly: boolean,
  targets: CleanTarget[],
): CleanPlan {
  targets.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    dir,
    cacheOnly,
    logsOnly,
    targets,
    fileCount: targets.reduce((s, t) => s + t.files, 0),
    dirCount: targets.filter((t) => t.kind === "dir").length,
    bytes: targets.reduce((s, t) => s + t.bytes, 0),
  };
}

/**
 * planClean(純粋・同期)に「元収録の remux 複製」検出を足した完全な計画。
 * CLI はこちらを使う。検出には ffprobe が要るので非同期になる。
 *
 * `--logs-only` のときは検出しない: remux 複製は「ログ・使い捨て下書き」では
 * ないので、logs-only の契約(消しても再レンダー/エディタ/proxy に影響せず、
 * 再生成が安価)から外れる。既定の `clean` と `--cache-only` では対象になる
 * (重い・再生成可能=ffmpeg のストリームコピーで作り直せる、という cache の性質)。
 *
 * ffprobe が無い/失敗する環境では検出をスキップするだけで、planClean と同じ
 * 結果に優雅に劣化する(理由は onSkip 経由で呼び出し側が表示できる)。
 */
export async function planCleanWithRemuxDup(
  dir: string,
  opts?: { cacheOnly?: boolean; logsOnly?: boolean; onSkip?: (reason: string) => void },
): Promise<CleanPlan> {
  const plan = planClean(dir, opts);
  if (plan.logsOnly) return plan;

  const dup = await detectRemuxDuplicate(dir, opts?.onSkip);
  if (dup === null) return plan;
  // planClean が同名を既に拾っていたら二重計上しない(fileRole が "other" である
  // ことは detectRemuxDuplicate が保証するので通常は起こらない=belt)
  if (plan.targets.some((t) => t.relPath === dup.relPath)) return plan;

  return finalizePlan(dir, plan.cacheOnly, plan.logsOnly, [
    ...plan.targets,
    {
      relPath: dup.relPath,
      kind: "file",
      bytes: dup.bytes,
      files: 1,
      category: "remux-dup",
      remuxSource: dup.source,
    },
  ]);
}

/**
 * 計画を実行(削除)する。各 unlink 直前に分類を再アサートする
 * belt-and-suspenders: 万一 generated 以外が計画に混ざっても物理削除する前に throw する
 * (=編集ファイル/approvals.json を touch し得ないことの二重保証)。remux 複製だけは
 * 名前では判定できないので、代わりに「manifest が指す元収録が別名で今も実在する」を
 * 削除直前にもう一度確かめる(plan から実行までの間に元収録が消えた/manifest が
 * 差し替わった場合に止まる)。rmSync は force で ENOENT を無視するので冪等。
 */
export function executeClean(dir: string, plan: CleanPlan): void {
  // remux 複製を先に処理する: その再アサートは manifest.json を読むが、manifest.json
  // 自身も generated=削除対象なので、relPath 順に回すと "manifest.json" が先に消えて
  // 再アサートが必ず失敗する(名前順で "m" < "r" になりやすい)。順序を分けることで
  // 「元収録はまだあるか」の検証が常に成立した状態で行われる
  const ordered = [
    ...plan.targets.filter((t) => t.category === "remux-dup"),
    ...plan.targets.filter((t) => t.category !== "remux-dup"),
  ];
  for (const t of ordered) {
    if (t.category === "remux-dup") {
      assertRemuxDuplicateStillSafe(dir, t.relPath);
    } else if (fileRole(t.relPath) !== "generated") {
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
  const scope = plan.cacheOnly ? "キャッシュのみ" : plan.logsOnly ? "ログのみ" : "全中間生成物";
  lines.push(`掃除(${scope}) 収録フォルダ: ${plan.dir}`);
  if (plan.targets.length === 0) {
    lines.push("削除対象はありません(すでに掃除済み)");
    return lines;
  }
  for (const t of plan.targets) {
    const tag = t.kind === "dir" ? "[dir] " : "[file]";
    const cnt = t.kind === "dir" ? ` ${t.files}ファイル` : "";
    const note =
      t.category === "remux-dup" ? `  (元収録 ${t.remuxSource} の remux 複製)` : "";
    lines.push(`  ${tag} ${t.relPath}${cnt}  ${formatBytes(t.bytes)}${note}`);
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
