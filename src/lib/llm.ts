import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.ts";
import type { Config } from "./config.ts";

/**
 * LLM にプロンプトを送り、テキスト応答を返す。バックエンドは2種類のみ:
 * - claude-cli: Claude Code の `claude -p` をサブプロセス実行。
 *               APIキー不要でサブスクリプションの範囲で動く(デフォルト)
 * - api:        Anthropic API(ANTHROPIC_API_KEY が必要、従量課金)
 */
export async function complete(prompt: string, cfg: Config): Promise<string> {
  if (cfg.llm.backend === "claude-cli") {
    const args = ["-p", "--output-format", "text"];
    if (cfg.llm.model) args.push("--model", cfg.llm.model);
    const { stdout } = await run("claude", args, { input: prompt });
    return stdout;
  }
  if (cfg.llm.backend === "api") {
    return completeViaApi(prompt, cfg);
  }
  throw new Error(
    `不明な llm.backend です: ${cfg.llm.backend}(claude-cli か api を指定)`,
  );
}

async function completeViaApi(prompt: string, cfg: Config): Promise<string> {
  // 環境変数になければリポジトリ直下の .env から読む
  if (!process.env.ANTHROPIC_API_KEY) {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const envPath = join(repoRoot, ".env");
    if (existsSync(envPath)) process.loadEnvFile(envPath);
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "llm.backend=api には ANTHROPIC_API_KEY が必要です(.env か環境変数で設定。.env.example 参照)",
    );
  }
  if (!cfg.llm.model) {
    throw new Error(
      "llm.backend=api には config.yaml の llm.model の指定が必要です(例: claude-sonnet-5)",
    );
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.llm.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  return data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}
