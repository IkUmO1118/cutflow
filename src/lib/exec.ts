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
  opts: { allowFailure?: boolean } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
    });
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
