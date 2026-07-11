#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { backupEditableFiles } from "./lib/backup.ts";
import { EDITABLE_FILES } from "./lib/files.ts";
import {
  clearCutplanApproval,
  clearShortApproval,
  writeCutplanApproval,
  writeShortApproval,
} from "./lib/approval.ts";
import {
  aiProfileStatuses,
  formatPerceptionStatusLines,
  loadConfig,
  resolvePerceptionStatus,
  resolveConfigPath,
  resolvePlanLoopSecondaryObservationCfg,
  resolveAiRuntimeConfig,
} from "./lib/config.ts";
import { findSource } from "./lib/findSource.ts";
import { loadShort, loadShorts } from "./lib/shorts.ts";
import { ingest } from "./stages/ingest.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";
import { plan, remeta } from "./stages/plan.ts";
import { planShorts } from "./stages/planShorts.ts";
import { planMaterials } from "./stages/planMaterials.ts";
import { learn } from "./stages/learn.ts";
import { preview } from "./stages/preview.ts";
import { render, renderShort, renderShorts } from "./stages/render.ts";
import { validate } from "./stages/validate.ts";
import { assert as assertProject } from "./stages/assert.ts";
import { idStamp } from "./stages/idStamp.ts";
import { applyEdits, planApply } from "./lib/applyEdits.ts";
import { describe, describeJson } from "./stages/describe.ts";
import { frames } from "./stages/frames.ts";
import type { FrameRequest } from "./stages/frames.ts";
import { DEFAULT_SERVE_PORT, startFramesServe } from "./stages/framesServe.ts";
import { tryServeFrames } from "./lib/framesClient.ts";
import { formatOcrPreview } from "./lib/ocr.ts";
import type { OcrResult } from "./lib/ocr.ts";
import { thumbnail } from "./stages/thumbnail.ts";
import { formatMaterialsSummary, materials } from "./stages/materials.ts";
import { av, formatAvSummary } from "./stages/av.ts";
import { reviewEdit } from "./stages/review.ts";
import { aiDoctor } from "./stages/aiDoctor.ts";
import { readEditSnapshot } from "./lib/renderSnapshot.ts";
import { fmtT, parseT } from "./lib/fmt.ts";
import type { ApplyPatch, CutPlan } from "./types.ts";
import type { EditSnapshot, ReviewSpec } from "./lib/review.ts";
import { buildRetrievalIndex } from "./stages/retrievalIndex.ts";
import { retrievalSearch } from "./stages/retrievalSearch.ts";
import type { AiRoute } from "./lib/config.ts";

const program = new Command();
program
  .name("cutflow")
  .description(
    "撮影後の編集を自動化するパイプライン(文字起こし→カット案→人間承認→レンダー)",
  )
  .option("--config <path>", "config.yaml のパス");

// 全コマンド共通の所要時間表示(フェーズ0: docs/perf.md のベースライン計測用)。
// render 等の内訳(loudnorm実測/ffmpeg cut/Remotion)は各ステージ側で
// src/lib/timing.ts の timed() を使って個別に出す
let commandStartedAt = 0;
program.hook("preAction", () => {
  commandStartedAt = Date.now();
});
program.hook("postAction", (_thisCommand, actionCommand) => {
  const sec = ((Date.now() - commandStartedAt) / 1000).toFixed(1);
  const line = `(所要時間: ${sec}秒)`;
  // JSON 射影はパイプ可能な純 JSON を stdout に出すので、診断行だけ stderr へ逃がす。
  // mcp は stdout が JSON-RPC 専用チャネルなので同様に stderr へ逃がす(サーバは
  // 通常 SIGINT まで返らないため多くの場合発火しないが、安全のため明示的に対応)。
  // 他コマンド・散文 describe/assert の stdout は従来どおり console.log(=不変)
  const jsonCommands = new Set(["describe", "assert"]);
  const isMcp = actionCommand.name() === "mcp";
  if (isMcp || (jsonCommands.has(actionCommand.name()) && actionCommand.opts().json === true)) {
    console.error(line);
  } else {
    console.log(line);
  }
});

function resolveDir(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`フォルダがありません: ${abs}`);
  return abs;
}

function readJsonFile<T>(file: string): T {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    throw new Error(
      `JSONファイルが見つかりません: ${abs}\n` +
      "review specの例: docs/examples/review-spec.json",
    );
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch (error) {
    throw new Error(`JSONファイルを読めません: ${abs}: ${(error as Error).message}`);
  }
}

/** --layout フラグの値を検査する。未指定は undefined(resolveLayout 既定へ委ねる) */
function parseLayoutOpt(v: string | undefined): "obs-canvas" | "plain" | "auto" | undefined {
  if (v === undefined) return undefined;
  if (v === "obs-canvas" || v === "plain" || v === "auto") return v;
  throw new Error(`--layout の値が不正です: ${v}(plain|obs-canvas|auto のいずれか)`);
}

function parseRangeOpt(v: string | undefined): { startSec: number; endSec: number } | undefined {
  if (v === undefined) return undefined;
  const [startRaw, endRaw] = v.split("-");
  if (startRaw === undefined || endRaw === undefined) {
    throw new Error(`--range の値が不正です: ${v}(例 10-25.5)`);
  }
  const startSec = parseT(startRaw.trim());
  const endSec = parseT(endRaw.trim());
  if (startSec === null || endSec === null || endSec <= startSec) {
    throw new Error(`--range の値が不正です: ${v}(例 10-25.5)`);
  }
  return { startSec, endSec };
}

/**
 * plan / run / plan-shorts の再実行ガード。LLM の生成物で上書きされるファイルが
 * 既にあるときは --force を要求し(運用ルールだけに頼らない防御)、実行する場合も
 * 先に手編集ファイル一式を backups/ へ退避する(上書き事故からの復元手段)
 */
function guardRerun(
  dir: string,
  outputs: string[],
  force: boolean,
  cmd: string,
): void {
  const existing = outputs.filter((f) => existsSync(join(dir, f)));
  if (existing.length === 0) return;
  if (!force) {
    throw new Error(
      `${existing.join(" / ")} が既にあります。${cmd} の再実行はこれらを ` +
        "LLM の生成物で上書きし、手編集が消えます。\n" +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを " +
        "backups/ へ退避します)",
    );
  }
  // 退避対象は標準の手編集ファイルに加え、このコマンドが上書きする outputs も含める
  // (plan-shorts の shorts.json は EDITABLE_FILES に無いので、これが無いと
  // 手編集した shorts.json を退避せず上書きしてしまう)
  const backupList = [...new Set([...EDITABLE_FILES, ...outputs])];
  const dest = backupEditableFiles(dir, backupList);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}

function printPerceptionStatus(cfg: Parameters<typeof resolvePerceptionStatus>[0]): void {
  for (const line of formatPerceptionStatusLines(resolvePerceptionStatus(cfg))) {
    console.log(line);
  }
}

function ensurePlanVlmReady(cfg: Parameters<typeof loadConfig>[0] extends never ? never : ReturnType<typeof loadConfig>): { profile: string; origin: string | null; maxCalls: number; maxImages: number } {
  const secondaryCfg = resolvePlanLoopSecondaryObservationCfg(cfg);
  if (!secondaryCfg.enabled) {
    throw new Error("plan.loop.secondaryObservation.enabled=true が必要です");
  }
  const runtime = resolveAiRuntimeConfig(cfg);
  if (!runtime.routes.vision) {
    throw new Error("vision route が未設定です");
  }
  const status = aiProfileStatuses(cfg).find((item) => item.name === runtime.routes.vision);
  if (!status) {
    throw new Error(`vision profile "${runtime.routes.vision}" が見つかりません`);
  }
  if (!status.capabilities.imageInput) {
    throw new Error(`AI profile "${status.name}" は imageInput=false です`);
  }
  if (status.credential === "missing") {
    throw new Error(`vision profile "${status.name}" の認証情報が見つかりません`);
  }
  return {
    profile: status.name,
    origin: status.origin,
    maxCalls: secondaryCfg.maxCalls,
    maxImages: secondaryCfg.maxImages,
  };
}

program
  .command("ai")
  .description("AI provider diagnostics")
  .command("doctor")
  .description("AI profile / route の接続確認")
  .option("--profile <name>", "特定profileのみ検査")
  .option("--route <route>", "特定route(text|structured|vision)のみ検査")
  .option("--json", "JSONで出力")
  .action(async (opts: { profile?: string; route?: AiRoute; json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const results = await aiDoctor(cfg, { profile: opts.profile, route: opts.route });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log("PROFILE\tADAPTER\tTEXT\tSTRUCTURED\tIMAGE\tAUTH");
    for (const item of results) {
      console.log([
        item.profile,
        item.adapter,
        item.checks.text.status,
        item.checks.structured.status,
        item.checks.image.status,
        item.checks.credential.status,
      ].join("\t"));
    }
  });

program
  .command("ingest <dir>")
  .description("収録ファイルを解析し manifest.json とマイク音声を生成")
  .option(
    "--layout <layout>",
    "収録レイアウト(plain|obs-canvas|auto)。省略時は plain",
  )
  .action(async (dir: string, opts: { layout?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const layout = parseLayoutOpt(opts.layout);
    const m = await ingest(abs, findSource(abs), cfg, layout);
    console.log(
      `ingest 完了: ${m.durationSec.toFixed(1)}秒 / ` +
        `${m.video.width}x${m.video.height} ${m.video.fps.toFixed(0)}fps / ` +
        `音声${m.audio.systemStream !== null ? "2" : "1"}トラック`,
    );
  });

program
  .command("transcribe <dir>")
  .description("whisper.cpp でマイク音声を文字起こし(transcript.json / .srt)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // 再実行はテロップの手編集(文言修正・位置・章トラック)ごと上書きする
    // ので、既存の transcript.json は退避してから書き直す
    const dest = backupEditableFiles(abs, ["transcript.json"]);
    if (dest) console.log(`既存の transcript.json を退避しました: ${dest}`);
    const t = await transcribe(abs, cfg);
    console.log(`transcribe 完了: ${t.segments.length}セグメント`);
  });

program
  .command("detect <dir>")
  .description("無音区間を検出しカット候補を生成(cuts.auto.json)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const c = await detect(resolveDir(dir), cfg);
    const saved = c.originalDurationSec - c.keptDurationSec;
    console.log(
      `detect 完了: 無音${c.silences.length}箇所 / ` +
        `${c.originalDurationSec}秒 → ${c.keptDurationSec}秒(${saved.toFixed(1)}秒削減)`,
    );
  });

program
  .command("plan <dir>")
  .description("LLM で意味カット・章立て・タイトル案を生成(cutplan.json ほか)")
  .option(
    "--force",
    "既存の cutplan / chapters / meta を上書きして再実行(実行前に backups/ へ退避)",
  )
  .option(
    "--cuts-only",
    "カット判断だけを行い cutplan.json / plan.raw.txt だけを書く" +
      "(chapters / meta / transcript の章テロップ / overlays の章トラックには触らない)",
  )
  .option("--with-vlm", "VLM二次観測を明示的に有効化(cuts-only loop 専用)")
  .action(async (dir: string, opts: { force?: boolean; cutsOnly?: boolean; withVlm?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const cutsOnly = opts.cutsOnly === true;
    if (opts.withVlm === true && !cutsOnly) {
      throw new Error("--with-vlm は --cuts-only と一緒に指定してください");
    }
    guardRerun(
      abs,
      cutsOnly ? ["cutplan.json"] : ["cutplan.json", "chapters.json", "meta.json"],
      opts.force === true,
      "plan",
    );
    printPerceptionStatus(cfg);
    if (opts.withVlm === true) {
      const vlm = ensurePlanVlmReady(cfg);
      console.error(
        `VLM二次観測: profile=${vlm.profile} origin=${vlm.origin ?? "local"} 最大${vlm.maxCalls}回 / 各${vlm.maxImages}枚`,
      );
    }
    const p = await plan(abs, cfg, { cutsOnly, withVlm: opts.withVlm === true });
    printPlanSummary(p.segments);
  });

program
  .command("remeta <dir>")
  .description(
    "章立て・タイトル案・概要欄だけを LLM で作り直す(cutplan は触らない。カット手編集後の再生成用)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // 章タイトル(「章」トラックのテロップ)と chapters / meta を作り直すので、
    // 上書き前に手編集ファイルを退避する(cutplan は読むだけで触らない)
    const dest = backupEditableFiles(abs, [
      "transcript.json",
      "chapters.json",
      "meta.json",
    ]);
    if (dest) console.log(`上書き前に手編集ファイルを退避しました: ${dest}`);
    printPerceptionStatus(cfg);
    console.log("remeta 実行中(LLM で章立て・タイトル案を生成)...");
    const m = await remeta(abs, cfg);
    console.log(`remeta 完了: タイトル案 ${m.titles.length}件`);
    for (const t of m.titles) console.log(`  ${t}`);
  });

program
  .command("plan-shorts <dir>")
  .description(
    "LLM でショート向きの見せ場を選ばせ shorts.json の下書きを生成(全て approved:false。承認は人間)",
  )
  .option(
    "--force",
    "既存の shorts.json を上書きして再実行(実行前に backups/ へ退避)",
  )
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardRerun(abs, ["shorts.json"], opts.force === true, "plan-shorts");
    console.log("plan-shorts 実行中(LLM でショート候補を選定)...");
    const shorts = await planShorts(abs, cfg);
    console.log(
      `plan-shorts 完了: ${shorts.shorts.length}本のショート下書きを生成` +
        "(全て approved:false)",
    );
    for (const s of shorts.shorts) {
      const dur = s.ranges.reduce((a, r) => a + (r.end - r.start), 0);
      console.log(
        `  ${s.name}: ${s.ranges.length}区間 / ${dur.toFixed(1)}秒`,
      );
    }
    console.log(
      "\n次のステップ: preview か GUI エディタ(ショートモード)で確認し、" +
        "各ショートの approved を true にしてから render --short してください。",
    );
  });

program
  .command("plan-materials <dir>")
  .description(
    "LLM で素材(B-roll)の配置候補を選ばせ overlays.json の下書きを生成" +
      "(要 materials <dir> --all の事前実行。cut/承認には触れない)",
  )
  .option(
    "--force",
    "既存の overlays.json を上書きして再実行(実行前に backups/ へ退避)",
  )
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardRerun(abs, ["overlays.json"], opts.force === true, "plan-materials");
    console.log("plan-materials 実行中(LLM で素材配置候補を選定)...");
    const result = await planMaterials(abs, cfg);
    console.log(
      `plan-materials 完了: アンカー${result.anchorCount}件 / 素材${result.choiceCount}件から` +
        `${result.placed.length}件を overlays[] へ下書き`,
    );
    for (const o of result.placed) {
      console.log(`  [${o.start.toFixed(2)}-${o.end.toFixed(2)}] ${o.file}`);
    }
    console.log(
      "\n次のステップ: preview か GUI エディタで確認し、要らなければ overlays.json から削除してください。",
    );
  });

program
  .command("learn <dir>")
  .description(
    "直前の生成案と人間の仕上げを見比べ、次回用のチャンネルルール追記案を生成" +
      "(rules.suggested.md に下書き。channel の rules.md は人間が手で採用)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    console.log("learn 実行中(LLM でルール追記案を生成)...");
    const out = await learn(abs, cfg);
    console.log(`learn 完了: ${out}`);
    console.log(
      "内容を確認し、採用する項目を手で channel の rules.md に追記してください。",
    );
  });

program
  .command("preview <dir>")
  .description("cutplan.json の keep 区間を繋いだ確認用動画を生成(preview.mp4)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const out = await preview(resolveDir(dir), cfg);
    console.log(`preview 完了: ${out}`);
    console.log(
      "テンポと見せ場を確認し、直したい場合は cutplan.json を編集して再実行してください。",
    );
  });

program
  .command("validate <dir>")
  .description(
    "編集ファイル(cutplan/transcript/overlays 等)の整合性を検査(JSON 編集後に実行)",
  )
  .action((dir: string) => {
    const r = validate(resolveDir(dir));
    for (const w of r.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
    if (r.errors.length > 0) {
      console.error(
        `\nエラー ${r.errors.length}件` +
          (r.warnings.length > 0 ? ` / 警告 ${r.warnings.length}件` : "") +
          "。上から順に修正して再実行してください。",
      );
      process.exit(1);
    }
    console.log(
      (r.warnings.length > 0 ? `警告 ${r.warnings.length}件(動作はします)\n` : "") +
        `✔ エラーなし: ${r.summary}`,
    );
  });

program
  .command("assert <dir>")
  .description(
    "assertions.json の期待値(意図どおりか)を describe --json 射影と照合(壊れていないかは validate)",
  )
  .option("--json", "AssertReport を JSON で標準出力に出す(パイプ可)")
  .option(
    "--visual",
    "Tier 2(視覚アサーション。frames --ocr と同じ経路で OCR)も評価する。" +
      "既定(付けない場合)は Tier 2 を skip し frames/OCR を一切呼ばない。macOS 専用",
  )
  .action(async (dir: string, opts: { json?: boolean; visual?: boolean }) => {
    const abs = resolveDir(dir);
    const report = await assertProject(abs, { visual: opts.visual === true });
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.outcomes.length === 0) {
      console.log(
        "アサーションがありません(assertions.json を置くと編集意図を宣言的に検査できます)",
      );
    } else {
      const icon = { pass: "✔", fail: "✖", error: "⚠", skip: "–" } as const;
      for (const o of report.outcomes) {
        const label = o.label ? `${o.label} ` : "";
        console.log(`${icon[o.status]} [${o.type}] ${label}${o.message}`);
      }
      const { pass, fail, skip, error } = report.counts;
      console.log(`\npass ${pass} / fail ${fail} / skip ${skip} / error ${error}`);
    }
    if (report.counts.fail > 0 || report.counts.error > 0) process.exit(1);
  });

program
  .command("id-stamp <dir>")
  .description(
    "編集ファイルの各要素に安定 id を一括採番(@-mention の基盤。冪等・既存 id は不変)",
  )
  .action((dir: string) => {
    const abs = resolveDir(dir);
    const { changed, validate: r } = idStamp(abs);
    if (changed.length === 0) {
      console.log("変更なし(すべて採番済み、または対象ファイルがありません)");
    } else {
      console.log(`id を採番しました: ${changed.join(", ")}`);
    }
    for (const w of r.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
  });

/** process.stdin を全部読んで文字列にする(apply --patch 省略時の入力経路) */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

program
  .command("apply <dir>")
  .description(
    "検査付きアトミック適用: `@id` op 列/ファイル全置換パッチを検査し、" +
      "全部通れば全書き込み・1つでもエラーなら1バイトも書かない",
  )
  .option("--patch <file>", "パッチ JSON ファイル(省略時は stdin から読む)")
  .option("--dry-run", "検査・変更要約だけ行い、書かない")
  .action(async (dir: string, opts: { patch?: string; dryRun?: boolean }) => {
    const abs = resolveDir(dir);
    let raw: string;
    if (opts.patch) {
      raw = readFileSync(opts.patch, "utf8");
    } else if (process.stdin.isTTY === true) {
      throw new Error(
        "パッチの入力がありません。--patch <file> を指定するか、JSON を stdin にパイプしてください",
      );
    } else {
      raw = await readStdin();
    }
    let patch: ApplyPatch;
    try {
      patch = JSON.parse(raw) as ApplyPatch;
    } catch (e) {
      console.error(`✖ (patch) -: JSON として読めません: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.dryRun) {
      const plan = planApply(abs, patch);
      for (const w of plan.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
      for (const e of plan.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
      if (plan.errors.length > 0) {
        console.error(`\nエラー ${plan.errors.length}件。上から順に修正して再実行してください。`);
        process.exit(1);
      }
      if (plan.changedFiles.length === 0) {
        console.log("変更なし(no-op パッチ。--dry-run のため書いていません)");
      } else {
        for (const d of plan.diff) {
          const field = d.field ? ` ${d.field}` : "";
          console.log(
            `  ${d.ref} ${d.file}${field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
          );
        }
        console.log(`✔ 検査通過(--dry-run。書いていません): ${plan.changedFiles.join(", ")}`);
      }
      return;
    }
    const result = applyEdits(abs, patch);
    for (const w of result.plan.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of result.plan.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
    if (result.plan.errors.length > 0) {
      console.error(`\nエラー ${result.plan.errors.length}件。上から順に修正して再実行してください。`);
      process.exit(1);
    }
    if (result.written.length === 0) {
      console.log("変更なし(no-op パッチ)");
    } else {
      console.log(
        `✔ 適用しました: ${result.written.join(", ")}` +
          (result.backupDir ? ` / 退避: ${result.backupDir}` : ""),
      );
    }
  });

program
  .command("describe <dir>")
  .description(
    "編集状態の要約。既定は散文、--json で機械可読な完全射影(元秒⇔出力秒つき)",
  )
  .option(
    "--json",
    "機械可読な完全射影を JSON で標準出力に出す(発話・タイトルを切り捨てない)",
  )
  .action((dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // cfg を渡すのは describe.pauses(既定オフ)を解決するため。既定 config では
    // pauses オフ=散文/--json ともに従来と完全にバイト等価
    if (opts.json === true) console.log(JSON.stringify(describeJson(abs, cfg), null, 2));
    else console.log(describe(abs, cfg));
  });

program
  .command("frames <dir>")
  .description(
    "指定時刻のフレームを最終合成と同じ見た目で PNG 出力(frames/。AI の目視確認用)",
  )
  .option(
    "--t <times>",
    "時刻(カンマ区切り。\"90\" や \"2:30.5\" 形式。既定は元収録の秒)",
  )
  .option("--out", "--t をカット後(preview/final)の秒として解釈する")
  .option("--captions", "テロップ全件の一巡監査(各テロップの表示中間で1枚ずつ)")
  .option("--every <sec>", "カット後タイムラインを一定間隔でサンプリング(秒)")
  .option("--short <name>", "指定したショートの縦レイアウトで PNG に(shorts.json)")
  .option(
    "--ocr",
    "画面 OCR(Apple Vision)でその時刻の画面内テキストを読む(macOS専用。" +
      "非対応環境では警告のうえ PNG 出力のみ続行)",
  )
  .option(
    "--full-res",
    "ベース映像を proxy でなく元収録のフル解像度にして合成 still を鮮明にする" +
      "(画面内テキストの目視用)",
  )
  .action(async (
    dir: string,
    opts: {
      t?: string;
      out?: boolean;
      captions?: boolean;
      every?: string;
      short?: string;
      ocr?: boolean;
      fullRes?: boolean;
    },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const picked = [opts.t, opts.captions, opts.every].filter(
      (v) => v !== undefined,
    ).length;
    if (picked !== 1) {
      throw new Error("--t / --captions / --every のどれか1つを指定してください");
    }
    if (opts.out && !opts.t) {
      throw new Error("--out は --t と一緒に使ってください");
    }
    let req: FrameRequest;
    if (opts.captions) {
      req = { mode: "captions" };
    } else if (opts.every !== undefined) {
      const step = parseT(opts.every);
      if (step === null) throw new Error(`間隔を解釈できません: ${opts.every}(例: 10)`);
      req = { mode: "every", stepSec: step };
    } else {
      const times = opts.t!.split(",").map((s) => {
        const t = parseT(s);
        if (t === null) throw new Error(`時刻を解釈できません: ${s}(例: 90 / 2:30.5)`);
        return t;
      });
      req = { mode: "times", times, axis: opts.out ? "output" : "source" };
    }
    if (opts.short) console.log(`ショート "${opts.short}" のフレームを出力します`);
    const abs = resolveDir(dir);
    const frameOpts = { short: opts.short, ocr: opts.ocr === true, fullRes: opts.fullRes === true };
    // 常駐デーモン(frames-serve)が起動していれば自動検出して委譲し、
    // bundle+browser のコールドコストを省く。portfile が無い/応答しなければ
    // 現行どおりの単発実行(既存挙動は1バイトも変わらない)
    const served = await tryServeFrames(abs, req, frameOpts);
    const shots =
      served ?? (await frames(abs, req, cfg, opts.short, frameOpts.ocr, frameOpts.fullRes));
    for (const s of shots) {
      const head =
        req.mode === "times"
          ? `${opts.out ? "出力" : "元"} ${fmtT(s.requested)} → 出力 ${fmtT(s.outSec)}`
          : `出力 ${fmtT(s.outSec)}`;
      console.log(`✔ ${head}: ${s.file}` + (s.note ? `(${s.note})` : ""));
      if (s.ocrFile) {
        const result = JSON.parse(readFileSync(s.ocrFile, "utf8")) as OcrResult;
        console.log(`  OCR: ${formatOcrPreview(result)}`);
      }
    }
    console.log(
      `${shots.length}枚を出力しました(frames/ の古い PNG` +
        (opts.ocr ? "・OCR サイドカー" : "") + " は削除済み)",
    );
  });

program
  .command("frames-serve <dir>")
  .description(
    "常駐フレームサーバを起動(bundle+headless Chrome を暖機。opt-in。" +
      "起動中は frames <dir> --t ... が自動検出して使う。終了は Ctrl+C)",
  )
  .option(
    "--port <port>",
    `待受ポート(既定 ${DEFAULT_SERVE_PORT}。config.yaml の frames.serve.port` +
      "があればそちら。editor の既定 4310 とは別)",
  )
  .action(async (dir: string, opts: { port?: string }) => {
    const explicit = program.opts().config as string | undefined;
    const cfg = loadConfig(explicit);
    const abs = resolveDir(dir);
    const port =
      opts.port !== undefined ? Number(opts.port) : (cfg.frames?.serve?.port ?? DEFAULT_SERVE_PORT);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`--port の値が不正です: ${opts.port}`);
    }
    await startFramesServe(abs, explicit, port);
  });

program
  .command("materials <dir>")
  .description(
    "素材(B-roll)の中身を知る知覚コマンド。既定は ffprobe だけ(尺・解像度・fps・" +
      "音声有無)+ overlays/inserts/bgm との参照クロスリンク(未使用・dangling を検出)。" +
      "materials.probe/index.json に書く",
  )
  .option(
    "--frames",
    "代表フレーム PNG も抽出する(動画は尺の中点1枚。画像は複製せず自身のパスを記録)",
  )
  .option(
    "--ocr",
    "フレーム/画像を Apple Vision で OCR する(動画は --frames を含意。非対応環境は" +
      "警告のうえ probe/frame の出力のみ続行)",
  )
  .option(
    "--transcribe",
    "音声付き素材を whisper で文字起こしする(モデル欠如はその素材だけ警告してスキップ)",
  )
  .option("--all", "= --frames --ocr --transcribe")
  .action(async (dir: string, opts: { frames?: boolean; ocr?: boolean; transcribe?: boolean; all?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const { index, indexPath } = await materials(
      abs,
      {
        frames: opts.all === true || opts.frames === true,
        ocr: opts.all === true || opts.ocr === true,
        transcribe: opts.all === true || opts.transcribe === true,
      },
      cfg,
    );
    for (const line of formatMaterialsSummary(index)) console.log(line);
    for (const m of index.materials) {
      if (m.ocr) {
        const rest = m.ocr.lineCount - m.ocr.preview.length;
        console.log(
          `  OCR(${m.file}): ${m.ocr.preview.map((t) => `"${t}"`).join(" / ")}` +
            (rest > 0 ? ` ほか${rest}行` : ""),
        );
      }
      if (m.transcribe) {
        console.log(`  文字起こし(${m.file}): 「${m.transcribe.preview}」(${m.transcribe.segmentCount}区間)`);
      }
    }
    console.log(`${index.materials.length}件を ${indexPath} に書きました`);
  });

program
  .command("av <dir>")
  .description(
    "A/V フィードバック用の知覚コマンド。keep を連結した motion/sound を計測し、" +
      "av.probe/{motion,sound}.json と motion.strip.png を書く",
  )
  .option("--range <a-b>", "出力(カット後)秒の範囲。例 10-25.5")
  .option("--every <sec>", "motion のサンプル間隔(秒)")
  .option("--short <name>", "本編ではなく shorts.json の指定ショートを対象にする")
  .option("--full-res", "motion の基映像に proxy.mp4 ではなく元収録を使う")
  .option("--motion-only", "motion だけを取得する")
  .option("--sound-only", "sound だけを取得する")
  .action(async (
    dir: string,
    opts: {
      range?: string;
      every?: string;
      short?: string;
      fullRes?: boolean;
      motionOnly?: boolean;
      soundOnly?: boolean;
    },
  ) => {
    if (opts.motionOnly === true && opts.soundOnly === true) {
      throw new Error("--motion-only と --sound-only は同時指定できません");
    }
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = await av(abs, {
      range: parseRangeOpt(opts.range),
      everySec: opts.every !== undefined ? Number(opts.every) : undefined,
      short: opts.short,
      fullRes: opts.fullRes === true,
      motionOnly: opts.motionOnly === true,
      soundOnly: opts.soundOnly === true,
    }, cfg);
    for (const line of formatAvSummary(result)) console.log(line);
  });

program
  .command("review <dir>")
  .description(
    "before/after の deterministic review bundle を生成し review.probe/index.json に書く",
  )
  .requiredOption("--spec <file>", "ReviewSpec JSON")
  .option("--candidate <file>", "candidate EditSnapshot JSON。省略時は現在の編集状態を使う")
  .option("--short <name>", "本編ではなく指定ショートを対象にする")
  .option("--json", "bundle JSON を stdout に出す")
  .action(async (
    dir: string,
    opts: { spec: string; candidate?: string; short?: string; json?: boolean },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const base = readEditSnapshot(abs);
    const candidate = opts.candidate ? readJsonFile<EditSnapshot>(opts.candidate) : base;
    const spec = readJsonFile<ReviewSpec>(opts.spec);
    const bundle = await reviewEdit(abs, cfg, base, candidate, spec, {
      shortName: opts.short,
      secondaryObservation: "none",
    });
    if (opts.json === true) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    console.log(`review 完了: ${join(abs, "review.probe", "index.json")}`);
    console.log(`stills: ${bundle.stills.length}件 / warnings: ${bundle.warnings.length}件`);
    for (const check of bundle.observation.checks) {
      console.log(`[${check.status}] ${check.source} ${check.message}`);
    }
  });

program
  .command("index")
  .description("recordingsDir のローカル検索indexを更新する")
  .option("--json", "index JSONをstdoutへ出す")
  .action((opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const index = buildRetrievalIndex(cfg.recordingsDir);
    if (opts.json) console.log(JSON.stringify(index, null, 2));
    else console.log(`index完了: ${index.recordings.length} recordings / ${index.documents.length} documents`);
  });

program
  .command("search <query>")
  .description("recording/material metadata、OCR、transcriptをローカル検索する")
  .option("--kind <kind>", "recording | material | caption")
  .option("--scope <scope>", "current | other | all", "all")
  .option("--limit <n>", "最大件数", "10")
  .option("--json", "JSONをstdoutへ出す")
  .action((query: string, opts: { kind?: string; scope?: string; limit?: string; json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    if (opts.kind && !["recording", "material", "caption"].includes(opts.kind)) {
      throw new Error("--kind は recording | material | caption です");
    }
    if (opts.scope && !["current", "other", "all"].includes(opts.scope)) {
      throw new Error("--scope は current | other | all です");
    }
    const results = retrievalSearch(cfg.recordingsDir, {
      query,
      kind: opts.kind as "recording" | "material" | "caption" | undefined,
      scope: opts.scope as "current" | "other" | "all" | undefined,
      limit: Number(opts.limit),
    });
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    else for (const result of results) {
      console.log(`${result.score}\t${result.recording}\t${result.kind}\t${result.relativePath ?? "-"}\t${result.snippet}`);
    }
  });

program
  .command("thumbnail <dir>")
  .description(
    "thumbnail.json からサムネイル静止画を生成(thumbnail.png。元収録のフル解像度)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const out = await thumbnail(resolveDir(dir), cfg);
    console.log(`thumbnail 完了: ${out}`);
  });

/** shorts.json の該当 name の approved だけを書き換える(他のショート・他の
 * フィールドはそのまま)。shorts.json が無い/name が無いときは loadShort と
 * 同じ明確なエラーメッセージにするため loadShort に検査を委ねる */
function updateShortApprovedFlag(dir: string, name: string, approved: boolean): void {
  loadShort(dir, name); // 存在検査(無ければここで分かりやすいエラーを投げる)
  const shorts = loadShorts(dir)!;
  shorts.shorts = shorts.shorts.map((s) => (s.name === name ? { ...s, approved } : s));
  writeFileSync(join(dir, "shorts.json"), JSON.stringify(shorts, null, 2));
}

/** cutplan.json の approved だけを書き換える(segments はそのまま) */
function updateCutplanApprovedFlag(dir: string, approved: boolean): CutPlan {
  const cutplan = JSON.parse(
    readFileSync(join(dir, "cutplan.json"), "utf8"),
  ) as CutPlan;
  const next: CutPlan = { ...cutplan, approved };
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(next, null, 2));
  return next;
}

/** ターミナルで y/N を尋ねる(approve の対話確認用) */
async function confirmYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

program
  .command("approve <dir>")
  .description(
    "cutplan(または --short 指定でショート)の内容ハッシュを approvals.json に記録して承認する" +
      "(render の唯一のゲート。承認は人間の対話操作)",
  )
  .option("--short <name>", "指定したショートを承認(shorts.json)")
  .option(
    "--yes",
    "非対話環境でも承認する(意図的バイパス。preview 未確認のまま承認できてしまうため通常は使わない)",
  )
  .action(async (dir: string, opts: { short?: string; yes?: boolean }) => {
    const abs = resolveDir(dir);
    // 壊れた内容を承認しない: 先に validate を通す
    const r = validate(abs);
    if (r.errors.length > 0) {
      for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
      throw new Error(
        `検査エラー ${r.errors.length}件があるため承認できません。上から順に修正し、` +
          "validate が通ってから再実行してください",
      );
    }
    const interactive = process.stdin.isTTY === true;
    if (!interactive && opts.yes !== true) {
      throw new Error(
        "approve は人間の対話操作です。preview で内容を確認のうえ、端末から実行してください" +
          "(非対話環境(Bash/子エージェント等)から実行する場合は --yes が必要です)",
      );
    }
    if (interactive && opts.yes !== true) {
      const what = opts.short ? `ショート "${opts.short}" の縦動画` : "preview.mp4";
      const ok = await confirmYesNo(`${what} を確認しましたか? 承認しますか? [y/N] `);
      if (!ok) {
        console.log("承認しませんでした(preview で確認してから再実行してください)");
        return;
      }
    }
    if (opts.short) {
      const short = loadShort(abs, opts.short);
      writeShortApproval(abs, short, "cli");
      updateShortApprovedFlag(abs, opts.short, true);
      console.log(`承認しました: ショート "${opts.short}"(approvals.json に記録)`);
    } else {
      const cutplan = updateCutplanApprovedFlag(abs, true);
      writeCutplanApproval(abs, cutplan, "cli");
      console.log("承認しました: 本編(approvals.json に記録)");
    }
  });

program
  .command("unapprove <dir>")
  .description(
    "承認レコードを取り消す(cutplan、または --short 指定でショート)。安全側の操作なので確認は不要",
  )
  .option("--short <name>", "指定したショートの承認を取り消す(shorts.json)")
  .action((dir: string, opts: { short?: string }) => {
    const abs = resolveDir(dir);
    if (opts.short) {
      clearShortApproval(abs, opts.short);
      updateShortApprovedFlag(abs, opts.short, false);
      console.log(`承認を取り消しました: ショート "${opts.short}"`);
    } else {
      clearCutplanApproval(abs);
      updateCutplanApprovedFlag(abs, false);
      console.log("承認を取り消しました: 本編");
    }
  });

program
  .command("render <dir>")
  .description(
    "承認済み cutplan.json から最終動画を生成(ワイプ+テロップ → final.mp4)。" +
      "--short/--shorts でショート動画(shorts.json)を書き出す",
  )
  .option("--short <name>", "指定した1本のショートだけレンダー(shorts/<name>.mp4)")
  .option("--shorts", "approved な全ショートをレンダー(未承認はスキップしログ表示)")
  .action(async (dir: string, opts: { short?: string; shorts?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    if (opts.short && opts.shorts) {
      throw new Error("--short と --shorts は同時に指定できません");
    }
    if (opts.short) {
      console.log(`ショート "${opts.short}" をレンダー中...`);
      const out = await renderShort(abs, cfg, opts.short);
      console.log(`render 完了: ${out}`);
      return;
    }
    if (opts.shorts) {
      const outs = await renderShorts(abs, cfg);
      for (const out of outs) console.log(`render 完了: ${out}`);
      if (outs.length === 0) console.log("レンダーしたショートはありません");
      return;
    }
    console.log("render 実行中(初回は headless Chrome の取得で数分かかります)...");
    const out = await render(abs, cfg);
    console.log(`render 完了: ${out}`);
  });

program
  .command("editor <dir>")
  .description(
    "GUI エディタを起動(overlays / transcript / cutplan をブラウザで編集)",
  )
  .option(
    "--layout <layout>",
    "初回 bootstrap 時の収録レイアウト(plain|obs-canvas|auto)。省略時は plain",
  )
  .action(async (dir: string, opts: { layout?: string }) => {
    const explicit = program.opts().config as string | undefined;
    const cfg = loadConfig(explicit);
    const layout = parseLayoutOpt(opts.layout);
    // 設定画面(POST /api/config)が書き戻す先。読んだ config.yaml と同じパス
    const cfgPath = resolveConfigPath(explicit);
    // esbuild 等のエディタ専用依存を CLI 起動時に読ませないため動的 import
    const { startEditor } = await import("../editor/server.ts");
    await startEditor(resolveDir(dir), cfg, cfgPath, layout);
  });

program
  .command("mcp <dir>")
  .description(
    "Model Context Protocol サーバを起動(stdio。read + 承認スコープ外の安全編集の" +
      "tool だけを露出。approve/render/plan 等は一切露出しない。終了は Ctrl+C)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // MCP 専用コードを他コマンド起動時に読ませないため動的 import
    const { startMcpServer } = await import("./mcp/server.ts");
    await startMcpServer(abs, cfg);
  });

program
  .command("run <dir>")
  .description("ingest → transcribe → detect → plan を順に実行(承認ゲートまで)")
  .option(
    "--force",
    "既存の transcript / cutplan 等を上書きして再実行(実行前に backups/ へ退避)",
  )
  .option(
    "--layout <layout>",
    "収録レイアウト(plain|obs-canvas|auto)。省略時は plain",
  )
  .action(async (dir: string, opts: { force?: boolean; layout?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const layout = parseLayoutOpt(opts.layout);
    guardRerun(
      abs,
      ["transcript.json", "cutplan.json", "chapters.json", "meta.json"],
      opts.force === true,
      "run",
    );
    await ingest(abs, findSource(abs), cfg, layout);
    console.log("ingest 完了");
    await transcribe(abs, cfg);
    console.log("transcribe 完了");
    const c = await detect(abs, cfg);
    console.log(
      `detect 完了: ${c.originalDurationSec}秒 → ${c.keptDurationSec}秒`,
    );
    printPerceptionStatus(cfg);
    console.log("plan 実行中(LLM でカット判断・章立てを生成)...");
    const p = await plan(abs, cfg);
    printPlanSummary(p.segments);

    // 新規収録を初回から id 有効(@-mention 可能)にする。id-stamp は冪等・
    // approvals.json 非改変なので、run の末尾に置いても安全
    const { changed } = idStamp(abs);
    if (changed.length > 0) {
      console.log(`id-stamp 完了: ${changed.join(", ")}`);
    }
  });

function printPlanSummary(
  segments: { action: "keep" | "cut"; reason: string }[],
): void {
  const cuts = segments.filter((s) => s.action === "cut");
  console.log(
    `plan 完了: ${segments.length}区間中 ${cuts.length}区間をカット提案`,
  );
  for (const c of cuts) console.log(`  カット案: ${c.reason}`);
  console.log(
    "\n次のステップ: preview で確認し、cutplan.json を必要に応じて編集、" +
      "approved を true にしてから render を実行してください。",
  );
}

program.parseAsync().catch((err: Error) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
