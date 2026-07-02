#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./lib/config.ts";
import { ingest } from "./stages/ingest.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";

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
  .command("run <dir>")
  .description("ingest → transcribe → detect を順に実行(承認ゲートまで)")
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
    console.log(
      "\n次のステップ: plan(意味カット・章立て)は未実装です。" +
        "cuts.auto.json を確認してください。",
    );
  });

program.parseAsync().catch((err: Error) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
