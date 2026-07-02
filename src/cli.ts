#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./lib/config.ts";
import { ingest } from "./stages/ingest.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";
import { plan } from "./stages/plan.ts";
import { preview } from "./stages/preview.ts";
import { render } from "./stages/render.ts";

const program = new Command();
program
  .name("cutflow")
  .description(
    "撮影後の編集を自動化するパイプライン(文字起こし→カット案→人間承認→レンダー)",
  )
  .option("--config <path>", "config.yaml のパス");

/** 収録フォルダ内の raw ファイル(mkv/mp4/mov)を見つける */
function findSource(dir: string): string {
  const candidates = readdirSync(dir).filter((f) =>
    /\.(mkv|mp4|mov)$/i.test(f),
  );
  if (candidates.length === 0) {
    throw new Error(`${dir} に動画ファイル(mkv/mp4/mov)がありません`);
  }
  if (candidates.length > 1) {
    // raw.* を優先、それ以外は最初の1本
    const raw = candidates.find((f) => f.startsWith("raw."));
    if (raw) return raw;
    console.warn(`動画が複数あります。${candidates[0]} を使います。`);
  }
  return candidates[0];
}

function resolveDir(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`フォルダがありません: ${abs}`);
  return abs;
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
    const started = Date.now();
    const t = await transcribe(resolveDir(dir), cfg);
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
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const p = await plan(resolveDir(dir), cfg);
    printPlanSummary(p.segments);
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
  .command("render <dir>")
  .description(
    "承認済み cutplan.json から最終動画を生成(ワイプ+字幕+章カード → final.mp4)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    console.log("render 実行中(初回は headless Chrome の取得で数分かかります)...");
    const out = await render(resolveDir(dir), cfg);
    console.log(`render 完了: ${out}`);
  });

program
  .command("run <dir>")
  .description("ingest → transcribe → detect → plan を順に実行(承認ゲートまで)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
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
