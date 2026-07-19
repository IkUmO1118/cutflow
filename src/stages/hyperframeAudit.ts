// stages/hyperframeAudit.ts — hyperframe-check: render 不要な HyperFrames カードの
// 動的監査(effect-check 家風。決定論のみ・常に exit 0・warn/info のみ・
// 収録フォルダの編集ファイルは一切書かない)。
//
// hyperframes/<name>.html の srcdoc を headless Chrome に読み込み、時間グリッドで
// seek しながら「論理アニメーション状態」(ピクセルではない)を採取し、
// src/lib/hyperframeAudit.ts の純関数(auditFindings)へ渡して
// dead-zone / 終端未完了 / 画面外終端 / seek 無反応 / 一斉登場 を検出する。
//
// commit 1(このファイル)では still 撮影 + VLM 二次確認はスタブ(commit 2 で
// render 済み mp4 から実装)。stills=[] / vlm.ran=false を書く。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { auditFindings } from "../lib/hyperframeAudit.ts";
import type {
  AuditInput,
  AuditSample,
  AuditThresholds,
  DriverCounts,
  Finding,
} from "../lib/hyperframeAudit.ts";

export const HYPERFRAME_PROBE_DIR = "hyperframe.probe";

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

export interface HyperframeAuditResult {
  reportPath: string;
  findings: Finding[];
  stills: HyperframeAuditStill[];
  stillsNote: string | null;
  vlm: { ran: boolean; note: string; items?: unknown[] };
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

/**
 * hyperframes/<name>.html を render せずに動的監査する。手順: 読み込み →
 * build 解決(resolveHyperframeBuild。render と同じ)→ headless Chrome で
 * サンプル採取(失敗しても例外は投げず loadFailed に劣化)→
 * auditFindings(純関数)→ hyperframe.probe/<name>/index.json へ書く。
 * still 撮影/VLM は commit 2 まではスタブ(常に空・未実行)。
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

  // commit 2 で still 抽出(render 済み mp4 から)+ VLM 二次確認を実装する。
  // commit 1 は常にスタブ: still は撮らない・VLM は実行しない
  const stills: HyperframeAuditStill[] = [];
  const stillsNote: string | null = null;
  const vlm = { ran: false, note: "VLM lane は commit 2 で実装" };

  const probeDir = join(dir, HYPERFRAME_PROBE_DIR, opts.name);
  mkdirSync(probeDir, { recursive: true });
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
  if (r.stillsNote) lines.push(r.stillsNote);
  lines.push(`検品レポートを ${r.reportPath} に書きました`);
  return lines;
}
