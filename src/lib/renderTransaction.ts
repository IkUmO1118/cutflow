import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * §8.4 Render 完成物を transaction として公開する(単一 video file 限定)。
 *
 * cut.mp4 / final.mp4 / shorts/<name>.mp4 のいずれも「作りかけの成果物が
 * 前回の正常な成果物を上書きする」事故(produce 中のクラッシュ・verify NG・
 * 入力ファイルの並行変更)を避けたい。そのため常に一時ファイルへ書き
 * (produce)、検査し(verify)、入力が書き込み中に変化していないか確認し
 * (inputsDrifted)、最後にだけ atomic rename する。rename 前に失敗すれば
 * finalPath・対応する *.key.json は一切触れない(前回の正常な成果物が
 * そのまま残る)。
 */

/** render 開始時に取得する入力ファイルのスナップショット(mtime/size)。
 * produce 実行中に入力が書き換わっていないかの検査に使う。 */
export interface InputSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
}

/** verify の結果。呼び出し側の VerifyResult(chunkCache.ts)等、
 * `{ok:true}` に余分なフィールドを持つ型もそのまま渡せるよう構造的に緩い。 */
export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

/** tempPath に書かれた成果物を検査する関数(ffprobe 検査等) */
export type VerifyFn = (tempPath: string) => Promise<VerifyOutcome>;

/** stat の結果。null = ファイルが存在しない(欠落) */
type StatLite = { mtimeMs: number; size: number } | null;

export interface PublishTransactionOptions {
  /** 公開先の絶対パス(成功時のみここへ rename される) */
  finalPath: string;
  /** render 開始時に取得済みの入力スナップショット一覧 */
  inputs: InputSnapshot[];
  /** 成果物を tempPath に書く(finalPath には一切触れないこと) */
  produce: (tempPath: string) => Promise<void>;
  /** tempPath に対する検査(ffprobe 等) */
  verify: VerifyFn;
  /** rename 成功後にのみ呼ばれる(例: writeFileSync(keyPath, ...)) */
  commit?: () => void;
  /** 既定は node:fs の statSync ベース。テストで fake を注入する */
  statFn?: (path: string) => StatLite;
  /** 既定は node:fs の renameSync。テストで fake を注入する */
  renameFn?: (from: string, to: string) => void;
  /** 既定は node:fs の rmSync({force:true})。テストで fake を注入する */
  rmFn?: (path: string) => void;
  /** 既定は process.pid。テストで固定値を注入する */
  pid?: number;
}

/**
 * finalPath と同じディレクトリに、pid を含む一時ファイル名を作る
 * (同時に走る複数プロセス・複数レンダーで衝突しない)。
 * 例: /dir/final.mp4 → /dir/.final.mp4.publish-12345.tmp.mp4
 */
export function tempPathFor(finalPath: string, pid: number): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.publish-${pid}.tmp.mp4`);
}

/** node:fs ベースの既定 statFn。ファイルが無ければ null(欠落) */
export function defaultInputStat(path: string): StatLite {
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

/** 指定パスの現在のスナップショットを取る(既定 statFn は node:fs)。
 * 欠落しているパスを渡すのは呼び出し側の誤り(render 開始時点で
 * 入力は存在するはず)なので例外を投げる。 */
export function captureSnapshot(
  path: string,
  statFn: (path: string) => StatLite = defaultInputStat,
): InputSnapshot {
  const stat = statFn(path);
  if (!stat) {
    throw new Error(`入力ファイルが見つかりません(スナップショット取得): ${path}`);
  }
  return { path, mtimeMs: stat.mtimeMs, size: stat.size };
}

export type DriftResult =
  | { drifted: false }
  | { drifted: true; path: string; reason: string };

/**
 * スナップショット取得時から入力ファイルが変化していないか確認する。
 * mtimeMs/size のいずれかが違えば drift、欠落していれば drift(空配列は
 * drift なし)。produce の実行中(数分かかりうる)に人間/GUI が編集ファイルを
 * 差し替えても、その入力を使ったはずの成果物を正としない安全策。
 */
export function inputsDrifted(
  snapshots: InputSnapshot[],
  statFn: (path: string) => StatLite,
): DriftResult {
  for (const snap of snapshots) {
    const current = statFn(snap.path);
    if (!current) {
      return { drifted: true, path: snap.path, reason: "入力ファイルが見つかりません" };
    }
    if (current.mtimeMs !== snap.mtimeMs) {
      return {
        drifted: true,
        path: snap.path,
        reason: `mtime が変化しました(記録 ${snap.mtimeMs}、実測 ${current.mtimeMs})`,
      };
    }
    if (current.size !== snap.size) {
      return {
        drifted: true,
        path: snap.path,
        reason: `size が変化しました(記録 ${snap.size}、実測 ${current.size})`,
      };
    }
  }
  return { drifted: false };
}

/**
 * produce → verify → drift 検査 → atomic rename → commit の順で実行する
 * (この順序が契約)。rename 前のどの段階で失敗しても finalPath と
 * 対応するキャッシュキーは一切書き換わらない(commit は rename 成功後
 * にのみ呼ばれる)。tempPath は成功・失敗いずれの経路でも finally で
 * 必ず削除する(rename 成功後は既に無いので rmFn は no-op)。
 */
export async function publishAsTransaction(opts: PublishTransactionOptions): Promise<void> {
  const {
    finalPath,
    inputs,
    produce,
    verify,
    commit,
    statFn = defaultInputStat,
    renameFn = renameSync,
    rmFn = (p: string) => rmSync(p, { force: true }),
    pid = process.pid,
  } = opts;

  const temp = tempPathFor(finalPath, pid);
  try {
    await produce(temp);

    const verifyResult = await verify(temp);
    if (!verifyResult.ok) {
      throw new Error(`成果物の検証に失敗しました: ${verifyResult.reason}`);
    }

    const drift = inputsDrifted(inputs, statFn);
    if (drift.drifted) {
      throw new Error(`入力ファイルが変化しました(${drift.path}): ${drift.reason}`);
    }

    renameFn(temp, finalPath);
    commit?.();
  } finally {
    rmFn(temp);
  }
}
