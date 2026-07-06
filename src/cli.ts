#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { backupEditableFiles } from "./lib/backup.ts";
import { loadConfig } from "./lib/config.ts";
import { findSource } from "./lib/findSource.ts";
import { ingest } from "./stages/ingest.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";
import { plan, remeta } from "./stages/plan.ts";
import { preview } from "./stages/preview.ts";
import { render } from "./stages/render.ts";
import { validate } from "./stages/validate.ts";
import { describe } from "./stages/describe.ts";
import { frames } from "./stages/frames.ts";
import type { FrameRequest } from "./stages/frames.ts";
import { fmtT, parseT } from "./lib/fmt.ts";

const program = new Command();
program
  .name("cutflow")
  .description(
    "撮影後の編集を自動化するパイプライン(文字起こし→カット案→人間承認→レンダー)",
  )
  .option("--config <path>", "config.yaml のパス");

function resolveDir(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`フォルダがありません: ${abs}`);
  return abs;
}

/**
 * plan / run の再実行ガード。LLM の生成物で上書きされるファイルが既にある
 * ときは --force を要求し(運用ルールだけに頼らない防御)、実行する場合も
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
      `${existing.join(" / ")} が既にあります。${cmd} の再実行はこれらと` +
        "「章」トラックのテロップを LLM の生成物で上書きし、手編集が消えます。\n" +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを " +
        "backups/ へ退避します)",
    );
  }
  const dest = backupEditableFiles(dir);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}

program
  .command("ingest <dir>")
  .description("収録ファイルを解析し manifest.json とマイク音声を生成")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const m = await ingest(abs, findSource(abs), cfg);
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
    const started = Date.now();
    const t = await transcribe(abs, cfg);
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`transcribe 完了: ${t.segments.length}セグメント(${sec}秒)`);
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
  .action(async (dir: string, opts: { force?: boolean; cutsOnly?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const cutsOnly = opts.cutsOnly === true;
    guardRerun(
      abs,
      cutsOnly ? ["cutplan.json"] : ["cutplan.json", "chapters.json", "meta.json"],
      opts.force === true,
      "plan",
    );
    const p = await plan(abs, cfg, { cutsOnly });
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
    console.log("remeta 実行中(LLM で章立て・タイトル案を生成)...");
    const m = await remeta(abs, cfg);
    console.log(`remeta 完了: タイトル案 ${m.titles.length}件`);
    for (const t of m.titles) console.log(`  ${t}`);
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
  .command("describe <dir>")
  .description(
    "編集状態のテキスト要約(keep/カット・発言・演出・章。元秒⇔出力秒の対応付き)",
  )
  .action((dir: string) => {
    console.log(describe(resolveDir(dir)));
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
  .action(async (
    dir: string,
    opts: { t?: string; out?: boolean; captions?: boolean; every?: string },
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
    const shots = await frames(resolveDir(dir), req, cfg);
    for (const s of shots) {
      const head =
        req.mode === "times"
          ? `${opts.out ? "出力" : "元"} ${fmtT(s.requested)} → 出力 ${fmtT(s.outSec)}`
          : `出力 ${fmtT(s.outSec)}`;
      console.log(`✔ ${head}: ${s.file}` + (s.note ? `(${s.note})` : ""));
    }
    console.log(`${shots.length}枚を出力しました(frames/ の古い PNG は削除済み)`);
  });

program
  .command("render <dir>")
  .description(
    "承認済み cutplan.json から最終動画を生成(ワイプ+テロップ → final.mp4)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    console.log("render 実行中(初回は headless Chrome の取得で数分かかります)...");
    const out = await render(resolveDir(dir), cfg);
    console.log(`render 完了: ${out}`);
  });

program
  .command("editor <dir>")
  .description(
    "GUI エディタを起動(overlays / transcript / cutplan をブラウザで編集)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    // esbuild 等のエディタ専用依存を CLI 起動時に読ませないため動的 import
    const { startEditor } = await import("../editor/server.ts");
    await startEditor(resolveDir(dir), cfg);
  });

program
  .command("run <dir>")
  .description("ingest → transcribe → detect → plan を順に実行(承認ゲートまで)")
  .option(
    "--force",
    "既存の transcript / cutplan 等を上書きして再実行(実行前に backups/ へ退避)",
  )
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardRerun(
      abs,
      ["transcript.json", "cutplan.json", "chapters.json", "meta.json"],
      opts.force === true,
      "run",
    );
    await ingest(abs, findSource(abs), cfg);
    console.log("ingest 完了");
    await transcribe(abs, cfg);
    console.log("transcribe 完了");
    const c = await detect(abs, cfg);
    console.log(
      `detect 完了: ${c.originalDurationSec}秒 → ${c.keptDurationSec}秒`,
    );
    console.log("plan 実行中(LLM でカット判断・章立てを生成)...");
    const p = await plan(abs, cfg);
    printPlanSummary(p.segments);
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
