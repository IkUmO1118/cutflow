import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * 外部コマンドを実行する。非ゼロ終了時は stderr を含めて例外を投げる。
 * ffmpeg のログ等で出力が大きくなるため maxBuffer は 64MB。
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { allowFailure?: boolean; input?: string; cwd?: string } = {},
): Promise<ExecResult> {
  try {
    const promise = execFileAsync(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
    });
    // input があれば標準入力に流し込む(claude -p へのプロンプト渡しに使う。
    // 引数渡しだと長いプロンプトで ARG_MAX を超えるため)
    if (opts.input !== undefined && promise.child.stdin) {
      promise.child.stdin.write(opts.input);
      promise.child.stdin.end();
    }
    const { stdout, stderr } = await promise;
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    if (e.code === "ENOENT") {
      throw new Error(
        `コマンド '${cmd}' が見つかりません。インストールされているか確認してください。`,
      );
    }
    if (opts.allowFailure) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw new Error(
      `${cmd} が失敗しました:\n${(e.stderr ?? "").slice(-2000)}`,
    );
  }
}
