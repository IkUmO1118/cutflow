// lib/perception.ts — plan(カット判断 LLM)へ発話テキスト以外の知覚を添える
// (opt-in・既定オフ)。§docs/plans/2026-07-07-plan-eyes-ears-design.md
//
// 音特徴(§4): detect が既に持つ cuts.auto.json の情報(silences[] +
// numberSegments の出力する NumberedSegment[])だけから計算する純関数。
// 新規の音量計測はしない(LLM に「間」の手掛かりを与えるだけ)。
//
// 画面 OCR(§5): plan 時点では frames 未実行(frames は cutplan を要求し、
// cutplan は plan の出力=鶏卵)なので、区間代表フレーム(source 秒の中点)を
// 既存プリミティブ(buildScreenStill + runOcr)で自前 OCR する。非対応環境
// (macOS 以外・swift 系なし・Vision 失敗)は runOcr が null を返すだけで、
// 例外を投げず優雅に劣化する(§9 不変条件3)。
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOcr } from "./ocr.ts";
import { buildScreenStill } from "./screenStill.ts";
import type { Interval, Manifest } from "../types.ts";
import type { NumberedSegment } from "../stages/plan.ts";

/** 区間ごとの音の特徴(秒。丸め済み)。LLM に算術をさせないため、
 * こちらで計算し記述文として渡す(§4 D2) */
export interface SegmentAudioFeature {
  id: number;
  /** 区間の尺(end - start) */
  len: number;
  /** 直前の keep との間に落ちた素材秒(先頭区間は0) */
  gapBefore: number;
  /** 区間内に残った無音の合計秒(silences との overlap 積算) */
  silenceWithin: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 2つの区間の重なり秒(重ならなければ0) */
function overlapSec(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * numbered(残す候補区間に番号を振ったもの)+ silences(cuts.auto.json の
 * 無音区間)だけから区間ごとの音特徴を計算する純関数(detect への新規計測は
 * 要しない。§4)。
 */
export function computeAudioFeatures(
  numbered: NumberedSegment[],
  silences: Interval[],
): SegmentAudioFeature[] {
  return numbered.map((seg, i) => {
    const prev = numbered[i - 1];
    const gapBefore = i === 0 ? 0 : seg.start - prev.end;
    const silenceWithin = silences.reduce((sum, s) => sum + overlapSec(s, seg), 0);
    return {
      id: seg.id,
      len: round1(seg.end - seg.start),
      gapBefore: round1(gapBefore),
      silenceWithin: round1(silenceWithin),
    };
  });
}

/** 音特徴をプロンプト用の記述文に整形する(純関数)。番号の連続性のため
 * 全区間を含める(§4 の「省略しない」側の選択。バイト等価の不変条件には
 * 無関係=このブロック自体が opt-in なので影響しない) */
export function formatAudio(features: SegmentAudioFeature[]): string {
  const lines = features.map(
    (f) =>
      `#${f.id} 尺${f.len.toFixed(1)} / 直前カット${f.gapBefore.toFixed(1)} / 内無音${f.silenceWithin.toFixed(1)}`,
  );
  return ["## 各区間の音の特徴(秒)", ...lines].join("\n");
}

/** 区間ごとの画面 OCR テキスト(§5)。lines は先頭 ocrMaxLines 件に切り詰め済み。
 * text は lines.join(" / ") の便宜フィールド(空判定・renderPerceptionBlock の
 * ゲートに使う) */
export interface SegmentOcr {
  id: number;
  lines: string[];
  text: string;
}

/** 区間の代表 source 秒(元収録秒。中点)。純関数(§5.2 手順1) */
export function representativeSourceTime(seg: Interval): number {
  return (seg.start + seg.end) / 2;
}

/**
 * OCR をかける区間を選ぶ(コスト制御。§5.2)。区間数が maxSegments 以下なら
 * 全件そのまま。超過時は尺(len)の長い順に maxSegments 件を選び、
 * 返り値は id 昇順に戻す(プロンプト上での並びを崩さないため)。
 */
export function selectOcrTargets(
  numbered: NumberedSegment[],
  maxSegments: number,
): NumberedSegment[] {
  if (numbered.length <= maxSegments) return numbered;
  return [...numbered]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, maxSegments)
    .sort((a, b) => a.id - b.id);
}

/** computeSegmentOcr が使うコスト制御・言語設定(resolvePerceptionCfg の
 * ocrMaxSegments/ocrMaxLines + config.yaml の ocr.languages) */
export interface PerceptionOcrOptions {
  ocrMaxSegments: number;
  ocrMaxLines: number;
  /** Vision 認識言語の優先順(省略時 runOcr の既定 = DEFAULT_OCR_LANGUAGES) */
  languages?: string[];
}

/**
 * 区間ごとの代表フレーム(source 秒の中点)を screenRegion フル解像度で
 * クロップし(buildScreenStill)、Vision OCR(runOcr)にかける。tmp PNG は
 * 使用後に必ず削除する(frames.ts の ocrFrame と同じ tmp+finally パターン)。
 * runOcr が null(非対応環境・失敗)を返した区間は例外を投げず飛ばす
 * (§9 不変条件3)。OCR テキストが空だった区間は結果に含めない
 * (=全区間で空なら戻り値は空配列 → renderPerceptionBlock が OCR ブロックを
 * 出さない)。
 */
export async function computeSegmentOcr(
  dir: string,
  manifest: Manifest,
  numbered: NumberedSegment[],
  opts: PerceptionOcrOptions,
  warn: (msg: string) => void,
): Promise<SegmentOcr[]> {
  const targets = selectOcrTargets(numbered, opts.ocrMaxSegments);
  const results: SegmentOcr[] = [];
  for (const seg of targets) {
    const sourceSec = representativeSourceTime(seg);
    const cropPath = join(tmpdir(), `cutflow-plan-ocr-${process.pid}-${seg.id}.png`);
    try {
      await buildScreenStill(dir, manifest, sourceSec, cropPath);
      const result = await runOcr(cropPath, manifest.video.screenRegion, {
        languages: opts.languages,
        warn,
      });
      if (result === null) continue; // 非対応環境等(warn 済み)。優雅な劣化
      const lines = result.lines
        .slice(0, opts.ocrMaxLines)
        .map((l) => l.text)
        .filter((t) => t.trim().length > 0);
      if (lines.length > 0) results.push({ id: seg.id, lines, text: lines.join(" / ") });
    } finally {
      if (existsSync(cropPath)) rmSync(cropPath);
    }
  }
  return results;
}

/** 画面 OCR をプロンプト用の記述文に整形する(純関数)。テキストが空の区間は
 * 出さない(§5.2「全区間で OCR が空 → OCR ブロックは出さない」はこの結果と
 * renderPerceptionBlock のゲートで担保される) */
export function formatOcr(ocr: SegmentOcr[]): string {
  const rows = ocr
    .filter((o) => o.lines.length > 0)
    .map((o) => `#${o.id} 画面: ${o.lines.map((l) => `"${l}"`).join(" / ")}`);
  return [
    "## 各区間の画面テキスト(OCR。開発系は画面が主役)",
    ...rows,
    "(記載のない区間は画面テキストなし)",
  ].join("\n");
}

/**
 * 知覚ブロック({{perception}} に入る全文)を組み立てる純関数。
 * `renderRulesBlock`(stages/plan.ts)と完全に同じ契約: 両方 null/空 →
 * `""`、存在時のみ前後 `\n` を伴う1ブロック。呼び出し側はこの値をそのまま
 * `{{perception}}` に replaceAll するだけでよい(§6.1)。
 */
export function renderPerceptionBlock(
  audio: SegmentAudioFeature[] | null,
  ocr: SegmentOcr[] | null,
): string {
  const aLines = audio && audio.length ? formatAudio(audio) : null;
  const oLines = ocr && ocr.some((o) => o.text) ? formatOcr(ocr) : null;
  if (!aLines && !oLines) return "";
  const parts = ["## AI 向け知覚情報(発話以外の手掛かり)"];
  if (aLines) parts.push(aLines);
  if (oLines) parts.push(oLines);
  return `\n${parts.join("\n\n")}\n`;
}
