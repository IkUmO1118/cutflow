// scripts/hyperframe-audit-calibrate.ts — hyperframe-check(動的監査)を
// docs/hyperframes-skills/examples/*.html の全カードに対して回し、決定論
// 検出(src/lib/hyperframeAudit.ts)が「正しく動いている worked example」で
// 過検出(false positive warn)を出していないかを一括で確かめる較正ゲート。
//
// node --test には乗せない(hyperframe-verify.ts と同じく重いブラウザ実行を
// 伴うため。npm test は scripts/ を自動収集しない)。
//
// 使い方: node scripts/hyperframe-audit-calibrate.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { mergeVariables, parseComposition } from "../src/lib/hyperframe.ts";
import { resolveHyperframeRenderProfile } from "../src/lib/hyperframeRenderProfile.ts";
import { auditFindings, DEFAULT_AUDIT_THRESHOLDS } from "../src/lib/hyperframeAudit.ts";
import type { AuditInput } from "../src/lib/hyperframeAudit.ts";
import { DEFAULT_HYPERFRAME_CHECK_STEP_SEC } from "../src/lib/config.ts";
import { collectAuditSamplesForHtml } from "../src/stages/hyperframeAudit.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES_DIR = join(REPO_ROOT, "docs", "hyperframes-skills", "examples");

async function main(): Promise<void> {
  if (!existsSync(EXAMPLES_DIR)) {
    console.error(`examples ディレクトリがありません: ${EXAMPLES_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".html")).sort();
  if (files.length === 0) {
    console.error(`examples が1件もありません: ${EXAMPLES_DIR}`);
    process.exit(1);
  }

  await ensureBrowser();
  const browser = await openBrowser("chrome");
  let warningCount = 0;
  let cardCount = 0;

  try {
    const page = await browser.newPage({
      context: () => null,
      logLevel: "warn",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => undefined,
    } as never);

    for (const file of files) {
      const html = readFileSync(join(EXAMPLES_DIR, file), "utf8");
      let parsed;
      try {
        parsed = parseComposition(html);
      } catch (err) {
        console.log(`${file}: SKIP — parseComposition failed (${(err as Error).message})`);
        continue;
      }

      const profile = resolveHyperframeRenderProfile(html);
      const variables = mergeVariables(parsed.variables);
      const dims = {
        width: parsed.width ?? 1920,
        height: parsed.height ?? 1080,
        fps: 30,
        durationSec: parsed.intrinsicDurationSec ?? 4,
      };

      cardCount += 1;
      try {
        const collected = await collectAuditSamplesForHtml(
          page,
          html,
          variables,
          profile,
          dims,
          DEFAULT_HYPERFRAME_CHECK_STEP_SEC,
        );
        if (collected.loadFailed) {
          console.log(`${file}: load-failed — ${collected.failures.join("; ")}`);
          continue;
        }
        const input: AuditInput = {
          samples: collected.samples,
          durationSec: dims.durationSec,
          fps: dims.fps,
          canvas: { width: dims.width, height: dims.height },
          drivers: collected.drivers,
          failures: collected.failures,
        };
        const findings = auditFindings(input, DEFAULT_AUDIT_THRESHOLDS);
        const warns = findings.filter((f) => f.level === "warn");
        for (const w of warns) {
          warningCount += 1;
          console.log(`${file}: ${w.kind}${w.target ? `(${w.target})` : ""} — ${w.message}`);
        }
      } catch (err) {
        console.log(`${file}: ERROR — ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close({ silent: true });
  }

  console.log(`\ncalibrated ${cardCount} cards, ${warningCount} warnings`);
  process.exit(warningCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
