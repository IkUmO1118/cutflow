// stages/hyperframeAudit.ts — hyperframe-check: render 不要な HyperFrames カードの
// 動的監査(effect-check 家風。決定論のみ・常に exit 0・warn/info のみ・
// 収録フォルダの編集ファイルは一切書かない)。
//
// hyperframes/<name>.html の srcdoc を headless Chrome に読み込み、時間グリッドで
// seek しながら「論理アニメーション状態」(ピクセルではない)を採取し、
// src/lib/hyperframeAudit.ts の純関数(auditFindings)へ渡して
// dead-zone / 終端未完了 / 画面外終端 / seek 無反応 / 一斉登場 を検出する。
//
// still 抽出(commit 2): 決定論 findings が確定した後、render 済み
// materials/hyperframes/<name>.mp4 が存在すれば head/mid/tail + 各 WARN
// finding の時刻を ffmpeg で PNG 抽出する(effect-check の captureStills と
// 同じ「失敗しても決定論レポートを巻き込まない」劣化パターン)。mp4 が無ければ
// still 未抽出のまま note を残す(先に `hyperframe --name <name>` で render)。
// VLM 二次確認(任意): stills が撮れ、vision route が設定され、
// config/フラグで有効なときだけ、effect-check の runVlmReview と同じ
// パターンで judge させる(座標は生成させない=判定専用。母艦 原則4)。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureBrowser, openBrowser } from "@remotion/renderer";
import type { HeadlessBrowser } from "@remotion/renderer";
import { buildIframeSrcdoc, parseComposition } from "../lib/hyperframe.ts";
import { resolveHyperframeBuild } from "./hyperframe.ts";
import {
  HYPERFRAME_RENDER_PROFILE_CONFIG,
  resolveHyperframeRenderProfile,
} from "../lib/hyperframeRenderProfile.ts";
import type { HyperframeRenderProfile } from "../lib/hyperframeRenderProfile.ts";
import { compositionDurationInFrames } from "../lib/renderFrameMath.ts";
import { resolveHyperframeAuditCfg } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { run } from "../lib/exec.ts";
import { completeImageReview, supportsImageReview } from "../lib/llm.ts";
import type { AiImagePart } from "../lib/ai/types.ts";
import { auditFindings, selectStillTimes, vlmItemsToFindings } from "../lib/hyperframeAudit.ts";
import type {
  AuditInput,
  AuditSample,
  AuditThresholds,
  DriverCounts,
  Finding,
  VlmReviewItem,
} from "../lib/hyperframeAudit.ts";

export const HYPERFRAME_PROBE_DIR = "hyperframe.probe";

/** VLM 二次確認へ渡す still の上限(1回の呼び出しに詰め込みすぎない。
 * effect-check の MAX_VLM_STILLS と同じ考え方) */
const MAX_HYPERFRAME_VLM_STILLS = 4;

export interface HyperframeAuditOptions {
  name: string;
  useVlm?: boolean;
  stepSec?: number;
  overrides?: { width?: number; height?: number; fps?: number; durationSec?: number };
  cliVars?: Record<string, unknown>;
}

export interface HyperframeAuditStill {
  role: string;
  tSec: number;
  file: string;
}

export interface HyperframeAuditVlmItem {
  role: string;
  ok: boolean;
  reason: string;
}

export interface HyperframeAuditResult {
  reportPath: string;
  findings: Finding[];
  stills: HyperframeAuditStill[];
  stillsNote: string | null;
  vlm: { ran: boolean; note: string; items?: HyperframeAuditVlmItem[] };
  loadFailed: boolean;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** すでに開いている page で1枚の HyperFrames composition を時間グリッドで
 * seek し、AuditSample[] を採取する。auditHyperframe(1カード1 browser)と
 * scripts/hyperframe-audit-calibrate.ts(1 browser を全カードで使い回す)の
 * 両方から呼ばれる共有ロジック。ブラウザ操作の失敗はここでは捕まえない
 * (呼び出し側がそれぞれの粒度で try/catch する) */
export async function collectAuditSamplesForHtml(
  page: Awaited<ReturnType<HeadlessBrowser["newPage"]>>,
  html: string,
  variables: Record<string, unknown>,
  profile: HyperframeRenderProfile,
  dims: { width: number; height: number; fps: number; durationSec: number },
  stepSec: number,
): Promise<{ samples: AuditSample[]; drivers: DriverCounts; failures: string[]; loadFailed: boolean }> {
  const { width, height, fps, durationSec } = dims;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const srcdoc = buildIframeSrcdoc(html, variables, profile);
  const dataUrl = "data:text/html;charset=utf-8;base64," + Buffer.from(srcdoc, "utf8").toString("base64");
  await page.goto({ url: dataUrl, timeout: 30000 } as never);

  await page.evaluate(() => (window as any).__hyperframes?.__isReady?.() ?? Promise.resolve()); // eslint-disable-line @typescript-eslint/no-explicit-any

  const failed = await page.evaluate(
    () =>
      (((window as any).__hyperframes?.__failed ?? []) as Array<{ message: string; fatal?: boolean }>) // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter((f) => f.fatal !== false)
        .map((f) => f.message),
  );
  if (failed.length > 0) {
    return {
      samples: [],
      drivers: { waapi: 0, gsap: 0, lottie: 0, clips: 0 },
      failures: failed,
      loadFailed: true,
    };
  }

  const drivers = await page.evaluate(() => {
    const w = window as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      waapi: document.getAnimations().length,
      gsap: w.__timelines ? Object.keys(w.__timelines).length : 0,
      lottie: w.__hfLottie ? w.__hfLottie.length : 0,
      clips: document.querySelectorAll(".clip").length,
    };
  });

  const lastFrameMs = ((compositionDurationInFrames(durationSec, fps) - 1) / fps) * 1000;
  const stepMs = Math.max(1, stepSec * 1000);
  const rawCount = Math.max(1, Math.floor(lastFrameMs / stepMs) + 1);
  const sampleCount = Math.min(rawCount, 120);
  const times: number[] = [];
  for (let i = 0; i < sampleCount - 1; i++) times.push(i * stepMs);
  times.push(lastFrameMs);

  const samples: AuditSample[] = [];
  for (const tMs of times) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sample = await page.evaluate((requestedMs: number) => {
      const w = window as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      w.__hyperframes.__seek(requestedMs);

      const root = document.querySelector("#root");
      const hasRoot = !!root;
      const prefix = hasRoot ? "#root " : "";
      const selector = `${prefix}[id], ${prefix}.clip, ${prefix}[data-start]`;
      const nodeList = document.querySelectorAll(selector);
      const anims = document.getAnimations();

      // 追跡対象要素の統合リスト: セレクタ由来(#root [id]/.clip/[data-start])
      // + document.getAnimations() の各 target 要素(id/.clip/data-start の
      // どれも持たない被アニメ要素(例: CSS 点滅のみのカーソル span)も
      // 追跡できるようにする)。要素の同一性(identity)で dedup し、
      // #root がある場合はその配下でない target(あり得ないはずだが保険)を
      // 除外する
      const seen = new Set<Element>();
      const tracked: Element[] = [];
      nodeList.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        tracked.push(el);
      });
      anims.forEach((a) => {
        const target = (a as any).effect?.target as Element | null | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!target) return;
        if (hasRoot && root && !root.contains(target)) return;
        if (seen.has(target)) return;
        seen.add(target);
        tracked.push(target);
      });

      const elements: Array<{
        key: string;
        visible: boolean;
        opacity: number;
        rect: { x: number; y: number; w: number; h: number };
        text: string;
      }> = [];
      tracked.forEach((el, index) => {
        const htmlEl = el as HTMLElement;
        const key = htmlEl.id || `idx${index}`;
        const rect = htmlEl.getBoundingClientRect();
        const style = getComputedStyle(htmlEl);
        const visible = style.visibility !== "hidden" && style.display !== "none";
        const opacity = Number.isFinite(parseFloat(style.opacity)) ? parseFloat(style.opacity) : 1;
        const text = (htmlEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
        elements.push({
          key,
          visible,
          opacity,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          text,
        });
      });

      const waapi: Array<{ key: string; currentTimeMs: number; endTimeMs: number | string; iterations: number | string }> = [];
      anims.forEach((a, i) => {
        const target = (a as any).effect?.target as HTMLElement | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
        const key = target?.id || `waapi${i}`;
        const timing = (a as any).effect?.getComputedTiming?.() ?? {}; // eslint-disable-line @typescript-eslint/no-explicit-any
        const rawIterations = typeof timing.iterations === "number" ? timing.iterations : 1;
        const rawEndTime = typeof timing.endTime === "number" ? timing.endTime : 0;
        const currentTime = typeof a.currentTime === "number" ? a.currentTime : 0;
        waapi.push({
          key,
          currentTimeMs: currentTime,
          endTimeMs: rawEndTime === Infinity ? "inf" : rawEndTime,
          iterations: rawIterations === Infinity ? "inf" : rawIterations,
        });
      });

      const timelines: Array<{
        key: string;
        progress: number;
        totalDurationSec: number;
        repeat: number;
        yoyo: boolean;
      }> = [];
      const tls = w.__timelines;
      if (tls) {
        for (const key of Object.keys(tls)) {
          const tl = tls[key];
          if (!tl) continue;
          try {
            const progress = typeof tl.progress === "function" ? tl.progress() : 0;
            const totalDurationSec =
              typeof tl.totalDuration === "function"
                ? tl.totalDuration()
                : typeof tl.duration === "function"
                  ? tl.duration()
                  : 0;
            const repeat = typeof tl.repeat === "function" ? tl.repeat() : 0;
            const yoyo = typeof tl.yoyo === "function" ? !!tl.yoyo() : false;
            timelines.push({ key, progress, totalDurationSec, repeat, yoyo });
          } catch {
            // カードのタイムラインが読めないのは動的監査の対象外(スキップ)
          }
        }
      }

      const lottie: Array<{ key: string; currentFrame: number; totalFrames: number; frameRate: number }> = [];
      const las = w.__hfLottie;
      if (las && las.length) {
        for (let i = 0; i < las.length; i++) {
          const an = las[i];
          if (!an) continue;
          lottie.push({
            key: `lottie${i}`,
            currentFrame: typeof an.currentFrame === "number" ? an.currentFrame : 0,
            totalFrames: typeof an.totalFrames === "number" ? an.totalFrames : 0,
            frameRate: typeof an.frameRate === "number" ? an.frameRate : 0,
          });
        }
      }

      const clipVisibleKeys: string[] = [];
      document.querySelectorAll(".clip").forEach((el, i) => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.style.visibility !== "hidden") {
          clipVisibleKeys.push(htmlEl.id || `clip${i}`);
        }
      });

      return { tMs: requestedMs, elements, waapi, timelines, lottie, clipVisibleKeys };
    }, tMs);

    samples.push({
      tMs: sample.tMs,
      elements: sample.elements,
      waapi: sample.waapi.map((w) => ({
        key: w.key,
        currentTimeMs: w.currentTimeMs,
        endTimeMs: w.endTimeMs === "inf" ? Infinity : (w.endTimeMs as number),
        iterations: w.iterations === "inf" ? Infinity : (w.iterations as number),
      })),
      timelines: sample.timelines,
      lottie: sample.lottie,
      clipVisibleKeys: sample.clipVisibleKeys,
    });
  }

  return { samples, drivers, failures: [], loadFailed: false };
}

/** 1枚の HyperFrames カードのために browser を1つ開き、閉じるところまでを
 * 面倒見る(auditHyperframe 専用。calibration script は browser を使い回すため
 * collectAuditSamplesForHtml を直接呼ぶ) */
async function collectAuditSamples(
  html: string,
  variables: Record<string, unknown>,
  profile: HyperframeRenderProfile,
  dims: { width: number; height: number; fps: number; durationSec: number },
  stepSec: number,
): Promise<{ samples: AuditSample[]; drivers: DriverCounts; failures: string[]; loadFailed: boolean }> {
  await ensureBrowser();
  const profileConfig = HYPERFRAME_RENDER_PROFILE_CONFIG[profile];
  const browser = profileConfig?.chromiumGl === "angle"
    ? await openBrowser("chrome", { chromiumOptions: { gl: "angle" } })
    : await openBrowser("chrome");
  try {
    const page = await browser.newPage({
      context: () => null,
      logLevel: "warn",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => undefined,
    } as never);
    return await collectAuditSamplesForHtml(page, html, variables, profile, dims, stepSec);
  } finally {
    await browser.close({ silent: true });
  }
}

/** カードの意図(brief)を解決する: hyperframes/<name>.assets/brief.md(将来
 * 添付されうる per-card brief) → 収録直下 brief.md → "(no brief)" の順。
 * VLM プロンプトの参考情報にのみ使う(判断材料であって命令ではない) */
function resolveHyperframeCheckBrief(dir: string, name: string): string {
  const assetBriefPath = join(dir, "hyperframes", `${name}.assets`, "brief.md");
  if (existsSync(assetBriefPath)) return readFileSync(assetBriefPath, "utf8");
  const recordingBriefPath = join(dir, "brief.md");
  if (existsSync(recordingBriefPath)) return readFileSync(recordingBriefPath, "utf8");
  return "(no brief)";
}

/** VLM 応答スキーマの検査(index は selected 配列の添字。effect-check の
 * parseVlmItems と同型)。壊れた/幻覚の item は黙って捨てる */
function parseHyperframeVlmRawItems(raw: string): VlmReviewItem[] {
  const parsed = JSON.parse(raw) as { items?: unknown };
  if (!Array.isArray(parsed.items)) return [];
  const items: VlmReviewItem[] = [];
  for (const it of parsed.items) {
    if (!it || typeof it !== "object") continue;
    const o = it as { index?: unknown; ok?: unknown; reason?: unknown };
    if (typeof o.index !== "number" || !Number.isInteger(o.index)) continue;
    if (typeof o.ok !== "boolean") continue;
    const reason = typeof o.reason === "string" ? o.reason.slice(0, 300) : "";
    items.push({ index: o.index, ok: o.ok, reason });
  }
  return items;
}

/** VLM(vision route)に head/mid/tail + finding still を見せ、意図に沿った
 * 「フレーム端で切れない・終端で凍結/空でない・可読」な構図かを yes/no+
 * 理由で判定させる。座標は一切生成させない(判定専用。母艦 原則4)。
 * 呼び出し側(auditHyperframe)が supportsImageReview で route の有無を
 * 確認済みの前提だが、失敗はここでは投げずそのまま呼び出し側の try/catch に
 * 委ねる(優雅な劣化は呼び出し側の責務) */
async function runHyperframeVlmReview(
  dir: string,
  cfg: Config,
  brief: string,
  stills: HyperframeAuditStill[],
): Promise<VlmReviewItem[]> {
  const selected = stills.slice(0, MAX_HYPERFRAME_VLM_STILLS);
  if (selected.length === 0) return [];
  const images: AiImagePart[] = selected.map((s, index) => ({
    type: "image",
    file: join(dir, s.file),
    mediaType: "image/png",
    label: `#${index} ${s.role}`,
  }));
  const prompt = [
    "Each labeled still is one frame (head/mid/tail, or the moment of a flagged dynamic-audit finding) " +
      "from a silent, self-contained motion-graphics card (no audio, no live action).",
    `Card intent (brief): ${brief}`,
    "For each image, judge whether the frame shows an intentional, on-screen composition that fits the brief: " +
      "not cut off at the frame edge, not frozen/empty at the end, and legible.",
    "Return ok(true/false) + a short reason per image, keyed by its index (matching the label's leading number).",
    "Never return coordinates, rects, or a proposed fix. Judgment only.",
  ].join("\n");
  const raw = await completeImageReview(prompt, images, cfg, {
    name: "cutflow_hyperframe_check_vlm",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          maxItems: MAX_HYPERFRAME_VLM_STILLS,
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
  return parseHyperframeVlmRawItems(raw);
}

/**
 * hyperframes/<name>.html を render せずに動的監査する。手順: 読み込み →
 * build 解決(resolveHyperframeBuild。render と同じ)→ headless Chrome で
 * サンプル採取(失敗しても例外は投げず loadFailed に劣化)→
 * auditFindings(純関数)→ still 抽出(render 済み mp4 があれば head/mid/tail+
 * finding 時刻を ffmpeg で PNG 化。失敗しても決定論レポートは巻き込まない)→
 * 任意 VLM(vision route があり有効なときだけ。ok:false は vlm-mismatch
 * warn として findings に追加)→ hyperframe.probe/<name>/index.json へ書く。
 */
export async function auditHyperframe(
  dir: string,
  cfg: Config,
  opts: HyperframeAuditOptions,
): Promise<HyperframeAuditResult> {
  const sourcePath = join(dir, "hyperframes", `${opts.name}.html`);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `${sourcePath} がありません。先に \`hyperframe --from-brief\` で作図するか、` +
        `hyperframes/${opts.name}.html を置いてください`,
    );
  }
  const html = readFileSync(sourcePath, "utf8");
  const profile = resolveHyperframeRenderProfile(html);
  const parsed = parseComposition(html);

  const build = resolveHyperframeBuild({
    parsed,
    cliVars: opts.cliVars ?? {},
    overrides: opts.overrides,
  });
  if (!build.ok) {
    throw new Error(build.error);
  }
  const { variables, width, height, fps, durationSec } = build;

  const auditCfg = resolveHyperframeAuditCfg(cfg);
  const stepSec = opts.stepSec ?? auditCfg.stepSec;
  const thresholds: AuditThresholds = {
    terminalProgressThreshold: auditCfg.terminalProgressThreshold,
    offscreenOpacityGate: auditCfg.offscreenOpacityGate,
    deadZoneMaxFrac: auditCfg.deadZoneMaxFrac,
    entryMinElements: auditCfg.entryMinElements,
    entryEpsilonFrames: auditCfg.entryEpsilonFrames,
  };

  let collected: { samples: AuditSample[]; drivers: DriverCounts; failures: string[]; loadFailed: boolean };
  try {
    collected = await collectAuditSamples(html, variables, profile, { width, height, fps, durationSec }, stepSec);
  } catch (error) {
    collected = {
      samples: [],
      drivers: { waapi: 0, gsap: 0, lottie: 0, clips: 0 },
      failures: [(error as Error).message],
      loadFailed: true,
    };
  }

  const auditInput: AuditInput = {
    samples: collected.samples,
    durationSec,
    fps,
    canvas: { width, height },
    drivers: collected.drivers,
    failures: collected.failures,
  };

  const findings: Finding[] = collected.loadFailed
    ? [
        {
          kind: "load-failed",
          level: "info",
          message:
            "audit skipped: card libraries failed to load (offline/CDN blocked) or browser error; dynamic findings unavailable",
        },
      ]
    : auditFindings(auditInput, thresholds);

  const probeDir = join(dir, HYPERFRAME_PROBE_DIR, opts.name);
  mkdirSync(probeDir, { recursive: true });

  // still 抽出: render 済み mp4 が無ければ「先に render してください」と
  // 案内するだけで、決定論 findings には一切触れない(VLM は下でスキップ)。
  // 抽出失敗(ffmpeg 不在・壊れた mp4 等)も同様に決定論レポートを巻き込まず
  // stills=[] + stillsNote へ劣化する(effect-check の captureStills と同じ
  // 失敗分離パターン)
  const mp4Path = join(dir, "materials", "hyperframes", `${opts.name}.mp4`);
  let stills: HyperframeAuditStill[] = [];
  let stillsNote: string | null = null;
  if (!existsSync(mp4Path)) {
    stillsNote =
      `${relative(dir, mp4Path)} が無いため still 未抽出` +
      `(先に \`hyperframe --name ${opts.name}\` で render してください)`;
  } else {
    try {
      const warnFindingSecs: number[] = [];
      for (const f of findings) {
        if (f.level === "warn" && f.atSec !== undefined) warnFindingSecs.push(f.atSec);
      }
      const specs = selectStillTimes({ durationSec, fps, findingSecs: warnFindingSecs });
      const extracted: HyperframeAuditStill[] = [];
      for (const spec of specs) {
        const outPng = join(probeDir, `${spec.role}.png`);
        await run("ffmpeg", ["-v", "error", "-ss", String(spec.tSec), "-i", mp4Path, "-frames:v", "1", "-y", outPng]);
        extracted.push({ role: spec.role, tSec: spec.tSec, file: relative(dir, outPng) });
      }
      stills = extracted;
    } catch (error) {
      stills = [];
      stillsNote = `still 抽出に失敗しました: ${(error as Error).message}`;
    }
  }

  // VLM 二次確認(任意): loadFailed・--no-vlm/config 無効・vision route 未設定・
  // still 0枚のいずれかなら未実行として note を残す(exit 0 は常に維持)
  let vlm: { ran: boolean; note: string; items?: HyperframeAuditVlmItem[] };
  const useVlmFlag = (opts.useVlm ?? true) && auditCfg.useVlm;
  if (collected.loadFailed) {
    vlm = { ran: false, note: "VLM 未実行(カードの読み込みに失敗したため)" };
  } else if (!useVlmFlag) {
    vlm = { ran: false, note: "VLM 未実行(決定論のみ。--no-vlm または config hyperframeCheck.useVlm=false)" };
  } else if (stills.length === 0) {
    vlm = { ran: false, note: stillsNote ?? "VLM 未実行(still が撮れなかったため)" };
  } else if (!supportsImageReview(cfg)) {
    vlm = { ran: false, note: "VLM 未実行(決定論のみ。vision route が未設定です)" };
  } else {
    try {
      const brief = resolveHyperframeCheckBrief(dir, opts.name);
      const rawItems = await runHyperframeVlmReview(dir, cfg, brief, stills);
      const stillRefs = stills.map((s) => ({ role: s.role, tSec: s.tSec }));
      findings.push(...vlmItemsToFindings(rawItems, stillRefs));
      const items: HyperframeAuditVlmItem[] = rawItems.map((it) => ({
        role: stills[it.index]?.role ?? `#${it.index}`,
        ok: it.ok,
        reason: it.reason,
      }));
      vlm = { ran: true, note: `VLM 実行済み(${items.length}件を判定)`, items };
    } catch (error) {
      vlm = { ran: false, note: `VLM 未実行(決定論のみ。実行に失敗しました: ${(error as Error).message})` };
    }
  }

  const reportPath = join(probeDir, "index.json");

  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        name: opts.name,
        source: {
          html: `hyperframes/${opts.name}.html`,
          htmlSha256: sha256Hex(html),
          width,
          height,
          fps,
          durationSec,
          profile,
          determinismTier: parsed.determinismTier,
        },
        audit: {
          ran: !collected.loadFailed,
          loadFailed: collected.loadFailed,
          failures: collected.failures,
          drivers: collected.drivers,
          grid: { stepSec, sampleCount: collected.samples.length },
          findings,
        },
        stills,
        stillsNote,
        vlm,
      },
      null,
      2,
    ),
  );

  return {
    reportPath,
    findings,
    stills,
    stillsNote,
    vlm,
    loadFailed: collected.loadFailed,
  };
}

/** stdout 向けの人間可読レポート行(effect-check の formatEffectCheckReport
 * と同じ流儀) */
export function formatHyperframeAuditReport(dir: string, r: HyperframeAuditResult): string[] {
  const lines: string[] = [];
  if (r.loadFailed) {
    lines.push("⚠ カードの読み込みに失敗したため、動的監査は実行できませんでした(決定論の findings なし)");
  }
  if (r.findings.length === 0 && !r.loadFailed) {
    lines.push("動的監査: 警告なし");
  } else {
    for (const f of r.findings) {
      const where = f.target ? `${f.kind}(${f.target})` : f.kind;
      const at = f.atSec !== undefined ? ` @${f.atSec.toFixed(2)}s` : "";
      lines.push(`[${f.level}] ${where}${at}: ${f.message}`);
    }
  }
  lines.push(`VLM: ${r.vlm.note}`);
  for (const item of r.vlm.items ?? []) {
    lines.push(`  VLM判定 ${item.role}: ${item.ok ? "OK" : "NG"} - ${item.reason}`);
  }
  if (r.stillsNote) lines.push(r.stillsNote);
  lines.push(`検品レポートを ${r.reportPath} に書きました`);
  return lines;
}
