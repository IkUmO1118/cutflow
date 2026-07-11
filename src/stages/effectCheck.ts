// E3(座標視覚検証)+ E4(zoom 相互作用)+ E5(密度ガード)の橋渡し
// (effect-check コマンド)のオーケストレータ。
// §docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md
//
// overlays.json / transcript.json / manifest.json(+ 任意 chapters.json)を読み、
// src/lib/effectCheck.ts(純関数)で決定論チェックを回し、既存 frames 経路
// (src/stages/frames.ts)で演出ごとの after still を撮り、任意で VLM
// (vision route)に二次確認させる。決定論チェックは常に実行・成功し、
// VLM は失敗/不在でも例外を投げず「VLM 未実行」を記録して決定論レポートを
// 返す(exit 0 を維持)。収録フォルダの編集ファイル(overlays.json 等)は
// 一切書かない。書くのは effect-check.json(検品結果)と、補正候補があるときの
// effect-fix.suggested.json(apply パッチ下書き。使い捨て)だけ。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveEffectCheckCfg } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import {
  buildEffectFixPatch,
  checkDensity,
  checkVisualOverlap,
  checkZoomInteraction,
} from "../lib/effectCheck.ts";
import type { CaptionRectInput, EffectWarning } from "../lib/effectCheck.ts";
import { completeImageReview, supportsImageReview } from "../lib/llm.ts";
import { frames } from "./frames.ts";
import type { FrameShot } from "./frames.ts";
import {
  captionAnchorOf,
  captionPosOf,
  captionStyleOf,
} from "../types.ts";
import type {
  AiImagePart,
} from "../lib/ai/types.ts";
import type { Chapters, Manifest, Overlays, Region, Transcript } from "../types.ts";

export const EFFECT_CHECK_FILE = "effect-check.json";
export const EFFECT_FIX_PATCH_FILE = "effect-fix.suggested.json";

/** VLM 二次確認へ渡す still の上限(vlmObservation.ts の MAX_SECONDARY_IMAGES_PER_CALL
 * と同じ考え方。1回の呼び出しに詰め込みすぎない) */
const MAX_VLM_STILLS = 4;

export type EffectKind = "zoom" | "blur" | "annotation";

export interface EffectCheckStill {
  effectKind: EffectKind;
  refId?: string;
  /** 演出の表示中間の元収録秒 */
  sourceSec: number;
  /** 実際に撮れた出力(カット後)秒 */
  outSec: number;
  /** 収録フォルダからの相対パス(frames/out<sec>s.png) */
  file: string;
}

export interface VlmItem {
  effectKind: EffectKind;
  refId?: string;
  ok: boolean;
  reason: string;
}

export interface EffectCheckVlmResult {
  ran: boolean;
  note: string;
  items?: VlmItem[];
}

export interface EffectCheckResult {
  warnings: EffectWarning[];
  stills: EffectCheckStill[];
  vlm: EffectCheckVlmResult;
  reportPath: string;
  /** 補正候補があるときのパッチパス。無ければ null(書いていない) */
  patchPath: string | null;
}

function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** transcript の各セグメントから caption 矩形を組む(pos が無いものは
 * v1 では対象外=既定の下部中央フローは一意な矩形を持たないため)。
 * 幅・高さはフォントサイズと文字数からの粗い決定論推定(座標系はテロップ
 * pos・演出 rect と同じ出力px。改行や全角/半角混在は厳密に扱わない) */
function buildCaptionRects(transcript: Transcript, overlays: Overlays, defaultFontSizePx: number): CaptionRectInput[] {
  const rects: CaptionRectInput[] = [];
  for (const seg of transcript.segments) {
    const pos = captionPosOf(seg, overlays);
    if (!pos) continue;
    const anchor = captionAnchorOf(seg, overlays);
    const style = captionStyleOf(seg, overlays);
    const fontSizePx = style?.fontSizePx ?? defaultFontSizePx;
    const text = seg.text ?? "";
    const w = Math.max(fontSizePx, text.length * fontSizePx * 0.9);
    const h = fontSizePx * 1.4;
    const rect: Region = anchor === "topLeft"
      ? { x: round2(pos.x), y: round2(pos.y), w: round2(w), h: round2(h) }
      : { x: round2(pos.x - w / 2), y: round2(pos.y - h / 2), w: round2(w), h: round2(h) };
    rects.push({ refId: seg.id, start: seg.start, end: seg.end, rect });
  }
  return rects;
}

/** chapters.json の各章を「次の章の開始まで」の見せ場区間とみなす
 * (E5 の highlightSpans。brief.md は自由記述で時刻を持たないため対象外=
 * 決定論の範囲でしか使えない chapters.json だけを使う)。無ければ空 */
function buildHighlightSpans(dir: string, durationSec: number): { start: number; end: number }[] {
  const chapters = readJsonOrNull<Chapters>(join(dir, "chapters.json"));
  if (!chapters || !Array.isArray(chapters.chapters) || chapters.chapters.length === 0) return [];
  const sorted = [...chapters.chapters].sort((a, b) => a.start - b.start);
  return sorted.map((c, i) => ({ start: c.start, end: sorted[i + 1]?.start ?? durationSec }));
}

interface EffectMidpoint {
  kind: EffectKind;
  id?: string;
  mid: number;
}

function collectEffectMidpoints(overlays: Overlays): EffectMidpoint[] {
  const list: EffectMidpoint[] = [];
  for (const z of overlays.zooms ?? []) list.push({ kind: "zoom", id: z.id, mid: (z.start + z.end) / 2 });
  for (const b of overlays.blurs ?? []) list.push({ kind: "blur", id: b.id, mid: (b.start + b.end) / 2 });
  for (const a of overlays.annotations ?? []) list.push({ kind: "annotation", id: a.id, mid: (a.start + a.end) / 2 });
  return list;
}

/** frames() が返す shots から、要求した元収録秒に最も近いものを選ぶ
 * (frames() は同じ出力フレームに丸まる複数リクエストを1枚へ統合するため、
 * 稀に複数演出の中間時刻が同一フレームに丸まると requested が一致しない
 * ことがある。これは決定論の最近傍選択で解決する=最悪でも隣接演出と
 * 同じフレームを指すだけで、誤って無関係なフレームを指すことはない) */
function nearestShot(shots: FrameShot[], sourceSec: number): FrameShot | undefined {
  let best: FrameShot | undefined;
  for (const s of shots) {
    if (!best || Math.abs(s.requested - sourceSec) < Math.abs(best.requested - sourceSec)) best = s;
  }
  return best;
}

async function captureStills(dir: string, cfg: Config, effects: EffectMidpoint[]): Promise<EffectCheckStill[]> {
  if (effects.length === 0) return [];
  const shots = await frames(dir, { mode: "times", times: effects.map((e) => e.mid), axis: "source" }, cfg);
  return effects
    .map((e): EffectCheckStill | null => {
      const shot = nearestShot(shots, e.mid);
      if (!shot) return null;
      return {
        effectKind: e.kind,
        ...(e.id ? { refId: e.id } : {}),
        sourceSec: e.mid,
        outSec: shot.outSec,
        file: relative(dir, shot.file),
      };
    })
    .filter((s): s is EffectCheckStill => s !== null);
}

/** VLM 応答スキーマの検査(index は selected 配列の添字) */
function parseVlmItems(raw: string, selected: EffectCheckStill[]): VlmItem[] {
  const parsed = JSON.parse(raw) as { items?: unknown };
  if (!Array.isArray(parsed.items)) return [];
  const items: VlmItem[] = [];
  for (const it of parsed.items) {
    if (!it || typeof it !== "object") continue;
    const o = it as { index?: unknown; ok?: unknown; reason?: unknown };
    if (typeof o.index !== "number" || !Number.isInteger(o.index)) continue;
    const still = selected[o.index];
    if (!still) continue;
    if (typeof o.ok !== "boolean") continue;
    const reason = typeof o.reason === "string" ? o.reason.slice(0, 300) : "";
    items.push({ effectKind: still.effectKind, refId: still.refId, ok: o.ok, reason });
  }
  return items;
}

/** VLM(vision route)に after still を見せ、演出が目的(隠す/指す/見せる)を
 * 満たすかを yes/no + 理由で判定させる。座標は一切生成させない(判定専用。
 * 母艦 原則4)。呼び出し側(effectCheck)が supportsImageReview で route の
 * 有無を確認済みの前提だが、失敗はここでは投げずそのまま呼び出し側の
 * try/catch に委ねる(優雅な劣化は呼び出し側の責務) */
async function runVlmReview(dir: string, cfg: Config, stills: EffectCheckStill[]): Promise<VlmItem[]> {
  const selected = stills.slice(0, MAX_VLM_STILLS);
  if (selected.length === 0) return [];
  const images: AiImagePart[] = selected.map((s, index) => ({
    type: "image",
    file: join(dir, s.file),
    mediaType: "image/png",
    label: `#${index} ${s.effectKind}${s.refId ? ` id=${s.refId}` : ""}`,
  }));
  const prompt = [
    "Each labeled still is a composited frame after a visual effect (zoom / blur / annotation) was applied.",
    "For each image, judge whether the effect achieves its evident purpose:",
    "blur=hides sensitive content, annotation=points to or frames a specific spot, zoom=draws attention to a region.",
    "Return ok(true/false) + a short reason per image, keyed by its index (matching the label's leading number).",
    "Never return coordinates, rects, or a proposed fix. Judgment only.",
  ].join("\n");
  const raw = await completeImageReview(prompt, images, cfg, {
    name: "cutflow_effect_check_vlm",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          maxItems: MAX_VLM_STILLS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["index", "ok", "reason"],
            properties: {
              index: { type: "integer" },
              ok: { type: "boolean" },
              reason: { type: "string", maxLength: 300 },
            },
          },
        },
      },
    },
  });
  return parseVlmItems(raw, selected);
}

export interface EffectCheckOptions {
  /** false で VLM をスキップ(--no-vlm)。省略時は config effectCheck.useVlm に従う */
  useVlm?: boolean;
}

/**
 * overlays.json の zooms/blurs/annotations を検品する。決定論チェック
 * (E4: zoom×固定px演出の相互作用 / E5: 密度ガード / E3: caption・素材との
 * 座標重なり)は常に実行し、続けて演出ごとの after still を撮る(E3)。
 * VLM(vision route)は opts.useVlm !== false && config が有効 && route が
 * 設定されているときだけ試み、失敗しても例外は投げず「VLM 未実行」を記録して
 * 決定論の結果をそのまま返す。cutplan.json / approvals.json は読まない
 * (演出の時刻・座標はすべて元収録秒・出力pxで完結し、cut 決定に依存しない)。
 */
export async function effectCheck(dir: string, cfg: Config, opts: EffectCheckOptions = {}): Promise<EffectCheckResult> {
  const manifest = readJsonOrNull<Manifest>(join(dir, "manifest.json"));
  if (!manifest) {
    throw new Error(`${join(dir, "manifest.json")} がありません。先に \`node src/cli.ts ingest\` 相当を実行してください`);
  }
  const overlays: Overlays = readJsonOrNull<Overlays>(join(dir, "overlays.json")) ?? {};
  const transcript: Transcript = readJsonOrNull<Transcript>(join(dir, "transcript.json")) ?? {
    language: "",
    model: "",
    segments: [],
  };

  const effectCfg = resolveEffectCheckCfg(cfg);

  const captionRects = buildCaptionRects(transcript, overlays, cfg.render.captionFontSizePx);
  const highlightSpans = buildHighlightSpans(dir, manifest.durationSec);

  const warnings: EffectWarning[] = [
    ...checkZoomInteraction(overlays),
    ...checkDensity(overlays, highlightSpans, effectCfg),
    ...checkVisualOverlap(overlays, captionRects, effectCfg),
  ];

  const effects = collectEffectMidpoints(overlays);
  // still 撮影は VLM(任意レーン)への入力でしかない。frames() は元収録が無い
  // ・ffmpeg / headless Chrome が失敗する等で例外を投げうるが、その失敗が
  // 決定論レポートを巻き込んではならない(設計書 §1-1 / §1-2)。ここで捕まえ、
  // 失敗時は stills=[] へ劣化し、下の VLM 分岐が撮影失敗を明示する
  let stills: EffectCheckStill[] = [];
  let stillCaptureError: string | null = null;
  try {
    stills = await captureStills(dir, cfg, effects);
  } catch (error) {
    stillCaptureError = (error as Error).message;
  }

  let vlm: EffectCheckVlmResult;
  const useVlm = (opts.useVlm ?? true) && effectCfg.useVlm;
  if (effects.length === 0) {
    vlm = { ran: false, note: "検品対象の演出(zoom/blur/annotation)がありません" };
  } else if (!useVlm) {
    vlm = { ran: false, note: "VLM 未実行(決定論のみ。--no-vlm または config effectCheck.useVlm=false)" };
  } else if (stillCaptureError !== null) {
    vlm = { ran: false, note: `VLM 未実行(still 撮影に失敗したため。決定論チェックのみ: ${stillCaptureError})` };
  } else if (!supportsImageReview(cfg)) {
    vlm = { ran: false, note: "VLM 未実行(決定論のみ。vision route が未設定です)" };
  } else if (stills.length === 0) {
    vlm = { ran: false, note: "VLM 未実行(撮影できた still が無いため。決定論チェックのみ)" };
  } else {
    try {
      const items = await runVlmReview(dir, cfg, stills);
      vlm = { ran: true, note: `VLM 実行済み(${items.length}件を判定)`, items };
      for (const item of items) {
        if (item.ok) continue;
        const still = stills.find((s) => s.effectKind === item.effectKind && s.refId === item.refId);
        warnings.push({
          kind: "vlm-mismatch",
          refId: item.refId,
          startSec: still?.sourceSec ?? 0,
          endSec: still?.sourceSec ?? 0,
          message: `VLM(${item.effectKind}${item.refId ? ` ${item.refId}` : ""}): ${item.reason}`,
        });
      }
    } catch (error) {
      vlm = { ran: false, note: `VLM 未実行(決定論のみ。実行に失敗しました: ${(error as Error).message})` };
    }
  }

  const patch = buildEffectFixPatch(warnings);
  const reportPath = join(dir, EFFECT_CHECK_FILE);
  let patchPath: string | null = null;
  if (patch.ops.length > 0) {
    patchPath = join(dir, EFFECT_FIX_PATCH_FILE);
    writeFileSync(patchPath, JSON.stringify(patch, null, 2));
  }

  const result: EffectCheckResult = { warnings, stills, vlm, reportPath, patchPath };
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        warnings,
        stills,
        vlm,
        patchPath: patchPath ? relative(dir, patchPath) : null,
      },
      null,
      2,
    ),
  );
  return result;
}

/** stdout 向けの人間可読レポート行 */
export function formatEffectCheckReport(dir: string, result: EffectCheckResult): string[] {
  const lines: string[] = [];
  if (result.warnings.length === 0) {
    lines.push("演出の検品: 警告なし");
  } else {
    for (const w of result.warnings) {
      lines.push(`[${w.kind}] ${w.message}`);
    }
  }
  lines.push(`VLM: ${result.vlm.note}`);
  for (const item of result.vlm.items ?? []) {
    lines.push(`  VLM判定 ${item.effectKind}${item.refId ? `(${item.refId})` : ""}: ${item.ok ? "OK" : "NG"} - ${item.reason}`);
  }
  lines.push(`検品レポートを ${result.reportPath} に書きました`);
  if (result.patchPath) {
    lines.push(`修正案を ${result.patchPath} に書きました。適用は:`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath} --dry-run`);
    lines.push(`  node src/cli.ts apply ${dir} --patch ${result.patchPath}`);
  } else {
    lines.push("apply パッチ下書きなし(自動修正できる項目はありませんでした)");
  }
  return lines;
}
