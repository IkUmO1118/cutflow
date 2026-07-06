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
import { loadConfig, resolveConfigPath } from "./lib/config.ts";
import { findSource } from "./lib/findSource.ts";
import { loadShort, loadShorts } from "./lib/shorts.ts";
import { ingest } from "./stages/ingest.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";
import { plan, remeta } from "./stages/plan.ts";
import { planShorts } from "./stages/planShorts.ts";
import { learn } from "./stages/learn.ts";
import { preview } from "./stages/preview.ts";
import { render, renderShort, renderShorts } from "./stages/render.ts";
import { validate } from "./stages/validate.ts";
import { describe, describeJson } from "./stages/describe.ts";
import { frames } from "./stages/frames.ts";
import type { FrameRequest } from "./stages/frames.ts";
import { DEFAULT_SERVE_PORT, startFramesServe } from "./stages/framesServe.ts";
import { tryServeFrames } from "./lib/framesClient.ts";
import { formatOcrPreview } from "./lib/ocr.ts";
import type { OcrResult } from "./lib/ocr.ts";
import { thumbnail } from "./stages/thumbnail.ts";
import { fmtT, parseT } from "./lib/fmt.ts";
import type { CutPlan } from "./types.ts";

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
  // 他コマンド・散文 describe の stdout は従来どおり console.log(=不変)
  if (actionCommand.name() === "describe" && actionCommand.opts().json === true) {
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

/** --layout フラグの値を検査する。未指定は undefined(config 既定へ委ねる) */
function parseLayoutOpt(v: string | undefined): "obs-canvas" | "plain" | "auto" | undefined {
  if (v === undefined) return undefined;
  if (v === "obs-canvas" || v === "plain" || v === "auto") return v;
  throw new Error(`--layout の値が不正です: ${v}(plain|obs-canvas|auto のいずれか)`);
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

program
  .command("ingest <dir>")
  .description("収録ファイルを解析し manifest.json とマイク音声を生成")
  .option(
    "--layout <layout>",
    "収録レイアウト(plain|obs-canvas|auto)。省略時は config.yaml の ingest.layout",
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
  .command("describe <dir>")
  .description(
    "編集状態の要約。既定は散文、--json で機械可読な完全射影(元秒⇔出力秒つき)",
  )
  .option(
    "--json",
    "機械可読な完全射影を JSON で標準出力に出す(発話・タイトルを切り捨てない)",
  )
  .action((dir: string, opts: { json?: boolean }) => {
    const abs = resolveDir(dir);
    if (opts.json === true) console.log(JSON.stringify(describeJson(abs), null, 2));
    else console.log(describe(abs)); // ← 現状のまま(バイト不変)
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
  .action(async (dir: string) => {
    const explicit = program.opts().config as string | undefined;
    const cfg = loadConfig(explicit);
    // 設定画面(POST /api/config)が書き戻す先。読んだ config.yaml と同じパス
    const cfgPath = resolveConfigPath(explicit);
    // esbuild 等のエディタ専用依存を CLI 起動時に読ませないため動的 import
    const { startEditor } = await import("../editor/server.ts");
    await startEditor(resolveDir(dir), cfg, cfgPath);
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
    "収録レイアウト(plain|obs-canvas|auto)。省略時は config.yaml の ingest.layout",
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
