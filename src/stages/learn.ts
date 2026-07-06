// 「修正からの学習」= learn コマンド(候補A・MVP)。
// 直前の LLM 生成(plan.raw.txt)と人間が仕上げた現状(describe + meta.json)を
// LLM に見せ、次回のためのチャンネルルール追記案を rules.suggested.md に
// 下書きとして書く。読むだけで、channel の rules.md には一切書き込まない
// (「AI は自分で承認しない」原則。採用は人間が手で channel の rules.md へ
// 追記する)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "../lib/llm.ts";
import { describe } from "./describe.ts";
import type { Config } from "../lib/config.ts";
import type { Meta } from "../types.ts";

/** prompts/learn.md の4プレースホルダに対応する入力 */
export interface LearnInputs {
  existingRules: string;
  priorGeneration: string;
  finalEdit: string;
  finalMeta: string;
}

/**
 * learn プロンプトの組み立て(純関数・テスト対象)。renderPrompt の brief と
 * 同じ「関数形式の replaceAll」を使う。文字列指定の replace は最初の1箇所しか
 * 置換されず、本文に "$&" 等が混じると置換パターンとして誤解釈されるため。
 */
export function buildLearnPrompt(template: string, inputs: LearnInputs): string {
  return template
    .replaceAll("{{existingRules}}", () => inputs.existingRules)
    .replaceAll("{{priorGeneration}}", () => inputs.priorGeneration)
    .replaceAll("{{finalEdit}}", () => inputs.finalEdit)
    .replaceAll("{{finalMeta}}", () => inputs.finalMeta);
}

function readStageText(path: string, requiredStage: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${path} がありません。先に ${requiredStage} を実行してください`,
    );
  }
  return readFileSync(path, "utf8");
}

/** meta.json の内容を learn プロンプト用のテキストに整形する */
function formatMeta(meta: Meta): string {
  const titles = meta.titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `タイトル案:\n${titles}\n\n概要欄:\n${meta.description}`;
}

/**
 * learn コマンド本体。read → buildLearnPrompt → complete → write の薄い殻。
 *
 * 入力(すべて読むだけ・書き換えない):
 * - <dir>/plan.raw.txt: 直前の LLM 生成(無ければ先に plan/run を促してエラー)
 * - describe(dir): 人間が仕上げた現状のタイムライン要約
 * - <dir>/meta.json: 人間が仕上げたタイトル・概要欄(無ければ既定文)
 * - <dirname(dir)>/rules.md: 既存の channel rules(無ければ既定文)
 *
 * 出力: <dir>/rules.suggested.md に LLM 生応答をそのまま書く(下書き。
 * 既存があれば上書きし、上書きした旨をログに出すだけで backups/ 退避はしない)。
 * channel の rules.md には絶対に書き込まない。
 */
export async function learn(dir: string, cfg: Config): Promise<string> {
  const priorGeneration = readStageText(join(dir, "plan.raw.txt"), "plan か run");

  const finalEdit = describe(dir);

  const metaPath = join(dir, "meta.json");
  const finalMeta = existsSync(metaPath)
    ? formatMeta(JSON.parse(readFileSync(metaPath, "utf8")) as Meta)
    : "(meta.json なし)";

  const channelRulesPath = join(dirname(dir), "rules.md");
  const existingRules = existsSync(channelRulesPath)
    ? readFileSync(channelRulesPath, "utf8").trim()
    : "(まだチャンネルルールはありません)";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", "learn.md"), "utf8");
  const prompt = buildLearnPrompt(template, {
    existingRules,
    priorGeneration,
    finalEdit,
    finalMeta,
  });

  const raw = await complete(prompt, cfg);

  const outPath = join(dir, "rules.suggested.md");
  if (existsSync(outPath)) {
    console.log(
      `既存の ${outPath} を上書きします(下書きなので backups/ への退避は不要)`,
    );
  }
  writeFileSync(outPath, raw);
  return outPath;
}
