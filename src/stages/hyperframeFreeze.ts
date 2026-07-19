// stages/hyperframeFreeze.ts — W3: HyperFrames「レシピ凍結」。
//
// 使い終えたカード(hyperframes/<name>.html。check 済み)を、次回の作図の
// 種(シード)として再利用可能にする。`hyperframe-freeze <dir> --name <name>`
// は skeletonize した DRAFT(hyperframe-freeze.suggested/<name>.{html,md})を
// 書くだけで、それを channel 直下の `hyperframe-seeds/` へ実際にコピーして
// 採用するのは人間の仕事(`learn` → `rules.suggested.md` → 人間が `rules.md`
// へ転記、と同じ非対称パターン)。
//
// E4: cutplan.json / approvals.json は読まない・書かない。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkComposition } from "../lib/hyperframeCheck.ts";

/** 使い捨ての下書き(material-fit.suggested.json 等と同カテゴリ)を書く先。
 * 収録フォルダ直下のディレクトリ(中身は <name>.html + <name>.md)。 */
export const HYPERFRAME_FREEZE_DIR = "hyperframe-freeze.suggested";

/** channel 直下(dirname(dir))の人間手動採用先。CutFlow はここへは一切書かない。 */
export const HYPERFRAME_SEEDS_DIR = "hyperframe-seeds";

function htmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/**
 * data-composition-variables の *string 型変数の default だけ* を
 * ラベル(空なら "Text")へリセットし、color/number/その他はそのまま保つ。
 * 属性が無い/JSON として読めないときは無変更で返す(自己ガード。呼び出し側が
 * 再度 checkComposition することで安全側に倒す)。
 */
export function skeletonizeComposition(html: string): { html: string; resetVars: string[] } {
  const re = /data-composition-variables\s*=\s*(['"])([\s\S]*?)\1/;
  const m = re.exec(html);
  if (!m) return { html, resetVars: [] };

  const quote = m[1];
  const rawInner = m[2];
  const jsonText = quote === '"' ? htmlUnescape(rawInner) : rawInner;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { html, resetVars: [] };
  }
  if (!Array.isArray(parsed)) return { html, resetVars: [] };

  const resetVars: string[] = [];
  const next = parsed.map((decl) => {
    if (typeof decl !== "object" || decl === null || Array.isArray(decl)) return decl;
    const d = decl as Record<string, unknown>;
    if (d.type === "string" && typeof d.id === "string") {
      const label = typeof d.label === "string" ? d.label.trim() : "";
      resetVars.push(d.id);
      return { ...d, default: label.length > 0 ? d.label : "Text" };
    }
    return d;
  });

  let serialized = JSON.stringify(next);
  if (quote === '"') serialized = serialized.replace(/"/g, "&quot;");
  const newAttr = `data-composition-variables=${quote}${serialized}${quote}`;
  const newHtml = html.slice(0, m.index) + newAttr + html.slice(m.index + m[0].length);
  return { html: newHtml, resetVars };
}

/** カードパターンメニュー(docs/hyperframes-skills/card-patterns.md)の
 * 見出し `## N. ...` から最大パターン番号を読む(見出しが無ければ 0)。 */
export function maxPatternNumber(patterns: string): number {
  const matches = [...patterns.matchAll(/^## (\d+)\. /gm)];
  if (matches.length === 0) return 0;
  return matches.reduce((max, m) => Math.max(max, Number(m[1])), 0);
}

/**
 * channel 直下(dirname(dir))の `hyperframe-seeds/*.html` を読み、
 * checkComposition を通ったものだけを、既存パターンメニューの続き番号
 * (maxPatternNumber(patterns)+1〜)として追記するメニュー文字列を返す。
 * store が無い/1件も通らないときは常に **""**(=呼び出し側の
 * `patterns + loadFrozenSeedMenu(dir, patterns)` がバイト等価になる)。
 */
export function loadFrozenSeedMenu(dir: string, patterns: string): string {
  const storeDir = join(dirname(dir), HYPERFRAME_SEEDS_DIR);
  if (!existsSync(storeDir)) return "";

  let entries: string[];
  try {
    entries = readdirSync(storeDir).filter((f) => f.endsWith(".html")).sort();
  } catch {
    return "";
  }
  if (entries.length === 0) return "";

  const startNum = maxPatternNumber(patterns) + 1;
  const sections: string[] = [];
  let num = startNum;
  for (const file of entries) {
    const htmlPath = join(storeDir, file);
    let html: string;
    try {
      html = readFileSync(htmlPath, "utf8");
    } catch {
      continue;
    }
    const { errors } = checkComposition(html, { file: htmlPath });
    if (errors.length > 0) {
      console.warn(
        `hyperframe-freeze: 凍結カード ${file} は check に落ちるため番号メニューから除外します(${errors.length}件のエラー)`,
      );
      continue;
    }
    const basename = file.replace(/\.html$/, "");
    const mdPath = join(storeDir, `${basename}.md`);
    let gloss = "";
    if (existsSync(mdPath)) {
      try {
        const first = readFileSync(mdPath, "utf8").split("\n")[0]?.trim() ?? "";
        gloss = first.replace(/^#\s*/, "");
      } catch {
        gloss = "";
      }
    }
    const glossLine = gloss.length > 0 ? gloss : basename;
    sections.push(
      `\n\n## ${num}. ${basename}(凍結カード)\n\n${glossLine}\n\n\`\`\`html\n${html}\n\`\`\``,
    );
    num += 1;
  }

  if (sections.length === 0) return "";
  if (sections.length > 8) {
    console.warn(
      `hyperframe-freeze: 凍結カードが${sections.length}件あり番号メニューが肥大化しています(目安8件。古いものを整理してください)`,
    );
  }
  return sections.join("");
}

export interface FreezeResult {
  outDir: string;
  evidence: string[];
  resetVars: string[];
}

/** overlays.json の overlays[]/inserts[] のうち target ファイルを参照しているかを
 * 読み取り専用で確認する。壊れた overlays.json は無視(advisory evidence のため
 * 例外を投げない)。 */
function referencesInOverlays(dir: string, targetFile: string): boolean {
  const overlaysPath = join(dir, "overlays.json");
  if (!existsSync(overlaysPath)) return false;
  try {
    const overlays = JSON.parse(readFileSync(overlaysPath, "utf8")) as {
      overlays?: Array<{ file?: string }>;
      inserts?: Array<{ file?: string }>;
    };
    const inOverlays = (overlays.overlays ?? []).some((o) => o.file === targetFile);
    const inInserts = (overlays.inserts ?? []).some((o) => o.file === targetFile);
    return inOverlays || inInserts;
  } catch {
    return false;
  }
}

/** hyperframe.probe/<name>/index.json の audit.findings のうち severity==="warn" の件数。
 * 読めない/形が違うときは undefined(evidence 行を出さない)。 */
function auditWarnCount(dir: string, name: string): number | undefined {
  const probePath = join(dir, "hyperframe.probe", name, "index.json");
  if (!existsSync(probePath)) return undefined;
  try {
    const index = JSON.parse(readFileSync(probePath, "utf8")) as {
      audit?: { findings?: Array<{ severity?: string }> };
    };
    const findings = index.audit?.findings;
    if (!Array.isArray(findings)) return undefined;
    return findings.filter((f) => f.severity === "warn").length;
  } catch {
    return undefined;
  }
}

/**
 * オーケストレータ: 既存の check 済み `hyperframes/<name>.html` から
 * skeletonize した DRAFT を `hyperframe-freeze.suggested/<name>.{html,md}` へ書く。
 * **収録フォルダの編集ファイル(cutplan.json/approvals.json 含む)は一切
 * 読まない・書かない**。channel の `hyperframe-seeds/` への採用コピーは
 * 人間の仕事(このコマンドはそこへ一切書かない)。
 */
export async function freezeHyperframe(
  dir: string,
  opts: { name: string },
): Promise<FreezeResult> {
  const { name } = opts;
  const src = join(dir, "hyperframes", `${name}.html`);
  if (!existsSync(src)) {
    throw new Error(
      `先に \`hyperframe ${dir} --name ${name} --from-brief\` で作図してください: ${src}`,
    );
  }
  const html = readFileSync(src, "utf8");
  const checked = checkComposition(html, { file: src });
  if (checked.errors.length > 0) {
    const lines = checked.errors.map((e) => `  - ${e.where}: ${e.message}`).join("\n");
    throw new Error(`check に落ちるカードは freeze できません(${src}):\n${lines}`);
  }

  const evidence: string[] = [];
  const targetFile = `materials/hyperframes/${name}.mp4`;
  if (referencesInOverlays(dir, targetFile)) evidence.push("overlays で参照済み");
  if (existsSync(join(dir, "materials", "hyperframes", `${name}.mp4`))) evidence.push("render 済み");
  const warnCount = auditWarnCount(dir, name);
  if (warnCount !== undefined) {
    evidence.push(warnCount === 0 ? "監査 warn 0件(良好)" : `監査 warn ${warnCount}件`);
  }

  const { html: skel, resetVars } = skeletonizeComposition(html);
  const reChecked = checkComposition(skel, { file: src });
  if (reChecked.errors.length > 0) {
    const lines = reChecked.errors.map((e) => `  - ${e.where}: ${e.message}`).join("\n");
    throw new Error(
      `skeletonize 後に check が落ちました(内部エラー。報告してください):\n${lines}`,
    );
  }

  const outDir = join(dir, HYPERFRAME_FREEZE_DIR);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.html`), skel);

  const adoptDest = join(dirname(dir), HYPERFRAME_SEEDS_DIR);
  const mdLines = [
    `# ${name} — (用途を1行で書いてください)`,
    "",
    `採用: cp ${outDir}/${name}.* ${adoptDest}/`,
  ];
  if (evidence.length > 0) mdLines.push("", `根拠: ${evidence.join(", ")}`);
  if (resetVars.length > 0) mdLines.push("", `リセットした string 変数: ${resetVars.join(", ")}`);
  writeFileSync(join(outDir, `${name}.md`), `${mdLines.join("\n")}\n`);

  return { outDir, evidence, resetVars };
}

/** stdout 向けの人間可読レポート行 */
export function formatFreezeReport(dir: string, r: FreezeResult): string[] {
  const lines: string[] = [];
  lines.push(`下書きを書きました: ${r.outDir}`);
  if (r.evidence.length > 0) lines.push(`根拠: ${r.evidence.join(", ")}`);
  if (r.resetVars.length > 0) lines.push(`リセットした string 変数: ${r.resetVars.join(", ")}`);
  lines.push(
    `採用は人間の仕事です(${r.outDir}/*.md の用途を1行埋めてから channel の ${join(dirname(dir), HYPERFRAME_SEEDS_DIR)}/ へコピー)。`,
  );
  lines.push("採用すると、次回の `hyperframe --from-brief` の番号メニュー末尾に凍結カードとして追加で選べるようになります。");
  return lines;
}
