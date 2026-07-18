// lib/hyperframeCheck.ts — C2: HyperFrames 契約(composition.html)の check
// ゲート。parseComposition(hyperframe.ts)と同じ立ち位置の**契約スコープの
// 文字列スキャナ**であって、汎用の HTML/CSS パーサではない。正規表現で
// 拾えない意図的な難読化(例: JS 文字列連結で組み立てた `Math["random"]`)
// までは追わない — そこは下流の CSP/allowlist(C4/C5)がバックストップする
// 前提。ルールは config 化せずこのモジュールに固定する(cutplan 等の JSON
// スキーマと違い、この検査基準はチャンネル/収録ごとに変える対象ではない)。
//
// node: の import は不要(純文字列処理)。CLI コマンドは持たない
// (ライブラリのみ。呼び出し側は将来の C3/C4 が担う)。
//
// Rule 7(B0): data-hf-determinism の *値* だけを検証する(byte|perceptual)。
// Rule 8(B1): data-hf-requires のトークン(gsap|lottie|three)を検証する。
// Rule 9(B1): GPU 規約(hf-seek イベント購読 / data-hf-requires="three")と
// determinism tier の整合を検証する(perceptual を要する規約を使うのに
// byte(または未指定=既定 byte)を名乗るとエラー)。GSAP(__timelines)・
// Lottie(__hfLottie)単独の使用は対象外(DOM スタイル書き込みなので byte
// のままで妥当)。

import type { Problem } from "../stages/validate.ts";
import { parseComposition } from "./hyperframe.ts";

export interface CheckResult {
  errors: Problem[];
  warnings: Problem[];
  summary: string;
}

export interface CheckOpts {
  /** Problem.file に使うラベル(既定 "composition.html") */
  file?: string;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
]);

/** 属性値を拾う(hyperframe.ts の findAttr の双子。lenient パーサが捨てる
 * 生の属性値をこちらでは直接見る必要があるため独立して持つ) */
function firstAttr(scope: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(scope);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2];
}

/** 同名属性の全出現(複数ホストにまたがる data-variable-values 用) */
function allAttrs(html: string, name: string): string[] {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

function eachOpeningTag(html: string, cb: (tag: string) => void): void {
  const re = /<[a-zA-Z][^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) cb(m[0]);
}

/** src= を持たない <script> ブロックの本文だけ(インラインスクリプト) */
function inlineScripts(html: string): string[] {
  const re = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function htmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** 値の"見た目"(プレフィックス)だけで remote 判定する。data: の base64 に
 * "https" という文字列が偶然含まれていても誤検知しないようにするため */
function isRemote(url: string): boolean {
  let v = url.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return /^https?:\/\//i.test(v) || /^\/\//.test(v);
}

function tagName(tag: string): string {
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
  return m ? m[1].toLowerCase() : "?";
}

function tagLabel(tag: string): string {
  const id = firstAttr(tag, "id");
  if (id) return `<${tagName(tag)} id="${id}">`;
  return tag.length > 60 ? `${tag.slice(0, 60)}…` : tag;
}

function firstFamilyRaw(value: string): string {
  return value
    .split(",")[0]
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

export function checkComposition(html: string, opts?: CheckOpts): CheckResult {
  const file = opts?.file ?? "composition.html";
  const errors: Problem[] = [];
  const warnings: Problem[] = [];

  // ---- Rule 1: root ----
  let rootId: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let hasRoot = true;
  try {
    const parsed = parseComposition(html);
    rootId = parsed.compositionId;
  } catch {
    hasRoot = false;
    errors.push({
      file,
      where: "<root>",
      message: "composition root is missing data-composition-id",
    });
  }

  if (hasRoot) {
    const widthRaw = firstAttr(html, "data-width");
    if (widthRaw === undefined) {
      warnings.push({
        file,
        where: "<root>",
        message: "composition has no data-width; will render at caller-provided dimensions",
      });
    } else if (!/^\d+$/.test(widthRaw.trim()) || Number(widthRaw) < 1) {
      errors.push({
        file,
        where: "<root>",
        message: `data-width must be a positive integer (got "${widthRaw}")`,
      });
    } else {
      width = Number(widthRaw);
    }

    const heightRaw = firstAttr(html, "data-height");
    if (heightRaw === undefined) {
      warnings.push({
        file,
        where: "<root>",
        message: "composition has no data-height; will render at caller-provided dimensions",
      });
    } else if (!/^\d+$/.test(heightRaw.trim()) || Number(heightRaw) < 1) {
      errors.push({
        file,
        where: "<root>",
        message: `data-height must be a positive integer (got "${heightRaw}")`,
      });
    } else {
      height = Number(heightRaw);
    }
  }

  // ---- Rule 2: typed variables ----
  let varCount = 0;
  const rawVars = firstAttr(html, "data-composition-variables");
  if (rawVars !== undefined) {
    let parsedVars: unknown;
    let parseOk = true;
    try {
      parsedVars = JSON.parse(htmlUnescape(rawVars));
    } catch {
      parseOk = false;
      errors.push({
        file,
        where: "data-composition-variables",
        message: "data-composition-variables is not valid JSON",
      });
    }
    if (parseOk) {
      if (!Array.isArray(parsedVars)) {
        errors.push({
          file,
          where: "data-composition-variables",
          message: "data-composition-variables must be a JSON array of declarations, not an object",
        });
      } else {
        varCount = parsedVars.length;
        parsedVars.forEach((decl: unknown, i: number) => {
          const where = `data-composition-variables[${i}]`;
          if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
            errors.push({ file, where, message: `${where} must be an object with "id" and "type"` });
            return;
          }
          const d = decl as Record<string, unknown>;
          if (typeof d.id !== "string") {
            errors.push({ file, where, message: `${where} is missing required "id"` });
            return;
          }
          if (typeof d.type !== "string") {
            errors.push({ file, where, message: `${where} is missing required "type"` });
          }
        });
      }
    }
  }

  const valuesRaw = allAttrs(html, "data-variable-values");
  valuesRaw.forEach((raw, i) => {
    const where = `data-variable-values[${i}]`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(htmlUnescape(raw));
    } catch {
      errors.push({ file, where, message: "data-variable-values is not valid JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push({ file, where, message: "data-variable-values must be a JSON object keyed by variable id" });
    }
  });

  // ---- Rule 3: clip discipline ----
  let clipCount = 0;
  eachOpeningTag(html, (tag) => {
    const classAttr = firstAttr(tag, "class");
    const startAttr = firstAttr(tag, "data-start");
    const durAttr = firstAttr(tag, "data-duration");
    const isClip = /(^|\s)clip(\s|$)/.test(classAttr || "");
    if (isClip) clipCount += 1;
    const hasTiming = startAttr !== undefined || durAttr !== undefined;

    if (hasTiming && !isClip) {
      warnings.push({
        file,
        where: tagLabel(tag),
        message:
          'timed element has data-start/data-duration but no class="clip"; its visibility window will not be applied',
      });
    }
    if (isClip && startAttr === undefined) {
      warnings.push({
        file,
        where: tagLabel(tag),
        message: "clip has no data-start (defaults to 0)",
      });
    }
    if (startAttr !== undefined) {
      const n = Number(startAttr);
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ file, where: tagLabel(tag), message: "data-start must be a non-negative number" });
      }
    }
    if (durAttr !== undefined) {
      const n = Number(durAttr);
      if (!Number.isFinite(n) || n < 0) {
        errors.push({ file, where: tagLabel(tag), message: "data-duration must be a non-negative number" });
      }
    }
  });

  // ---- Rule 4: remote-URL ban ----
  const stripped = stripComments(html);
  const URL_ATTR_TAGS = new Set(["script", "img", "video", "audio", "source", "iframe"]);
  eachOpeningTag(stripped, (tag) => {
    const name = tagName(tag);
    if (URL_ATTR_TAGS.has(name)) {
      const src = firstAttr(tag, "src");
      if (src !== undefined) {
        if (isRemote(src)) {
          errors.push({ file, where: tagLabel(tag), message: `remote URL not allowed: ${src}` });
        } else if (name === "script") {
          warnings.push({
            file,
            where: tagLabel(tag),
            message: "external <script src> may not load in the render iframe; inline the script",
          });
        }
      }
    }
    if (name === "link") {
      const href = firstAttr(tag, "href");
      if (href !== undefined && isRemote(href)) {
        errors.push({ file, where: tagLabel(tag), message: `remote URL not allowed: ${href}` });
      }
    }
    const srcset = firstAttr(tag, "srcset");
    if (srcset !== undefined) {
      for (const candidate of srcset.split(",")) {
        const token = candidate.trim().split(/\s+/)[0];
        if (token && isRemote(token)) {
          errors.push({ file, where: tagLabel(tag), message: `remote URL not allowed: ${token}` });
        }
      }
    }
    const poster = firstAttr(tag, "poster");
    if (poster !== undefined && isRemote(poster)) {
      errors.push({ file, where: tagLabel(tag), message: `remote URL not allowed: ${poster}` });
    }
    const compSrc = firstAttr(tag, "data-composition-src");
    if (compSrc !== undefined && isRemote(compSrc)) {
      errors.push({ file, where: tagLabel(tag), message: `remote URL not allowed: ${compSrc}` });
    }
  });

  const styleBlocks: string[] = [];
  {
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) styleBlocks.push(m[1]);
  }
  const inlineStyleAttrs = allAttrs(stripped, "style");
  const allCss = styleBlocks.concat(inlineStyleAttrs).join("\n");

  {
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(allCss)) !== null) {
      const v = m[2];
      if (isRemote(v)) errors.push({ file, where: "<style>", message: `remote URL not allowed: ${v}` });
    }
  }
  {
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(allCss)) !== null) {
      const v = m[2] || m[4];
      if (v && isRemote(v)) errors.push({ file, where: "<style>", message: `remote URL not allowed: ${v}` });
    }
  }

  // ---- Rule 5: seek-safe ----
  // GPU/WebGL カードは self-draw を hf-seek CustomEvent(bootstrap が絶対
  // 時刻で dispatch する。B1)で駆動すること(決定論)。インラインの
  // requestAnimationFrame を直接シーク駆動に使うのは上の
  // DETERMINISM_PATTERNS で禁止済み。ライブラリ内部の rAF(例: gsap.ticker)
  // はこのスキャン(author のインラインスクリプト)の対象外で、B3 の
  // 利用規約(ライブラリは pause 状態で読み込み、内部 ticker を進めない)で
  // 別途担保する
  const scripts = inlineScripts(html);
  const DETERMINISM_PATTERNS: Array<{ re: RegExp; token: string }> = [
    { re: /\bMath\.random\b/, token: "Math.random" },
    { re: /\brequestAnimationFrame\b/, token: "requestAnimationFrame" },
    { re: /\bsetInterval\b/, token: "setInterval" },
    { re: /\bDate\.now\b/, token: "Date.now" },
    { re: /\bperformance\.now\b/, token: "performance.now" },
  ];
  for (const script of scripts) {
    for (const p of DETERMINISM_PATTERNS) {
      if (p.re.test(script)) {
        errors.push({
          file,
          where: "<script>",
          message: `nondeterministic driver ${p.token} breaks seek determinism`,
        });
      }
    }
    if (/new\s+Date\s*\(\s*\)/.test(script)) {
      errors.push({
        file,
        where: "<script>",
        message: "nondeterministic driver new Date() breaks seek determinism",
      });
    }
    if (/\bsetTimeout\b/.test(script)) {
      warnings.push({
        file,
        where: "<script>",
        message: "setTimeout fires on wall-clock, not composition time; prefer CSS/WAAPI",
      });
    }
  }

  // ---- Rule 6: font embedding ----
  const fontFaceFamilies = new Set<string>();
  const fontFaceBodies: string[] = [];
  {
    const re = /@font-face\s*{([^}]*)}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(allCss)) !== null) fontFaceBodies.push(m[1]);
  }
  for (const body of fontFaceBodies) {
    const famM = /font-family\s*:\s*([^;]+)/i.exec(body);
    if (famM) fontFaceFamilies.add(firstFamilyRaw(famM[1]).toLowerCase());
  }
  const cssWithoutFontFace = allCss.replace(/@font-face\s*{[^}]*}/gi, "");
  const warnedFamilies = new Set<string>();
  {
    const re = /font-family\s*:\s*([^;}]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssWithoutFontFace)) !== null) {
      const raw = firstFamilyRaw(m[1]);
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (GENERIC_FAMILIES.has(key)) continue;
      if (fontFaceFamilies.has(key)) continue;
      if (warnedFamilies.has(key)) continue;
      warnedFamilies.add(key);
      warnings.push({
        file,
        where: "<style>",
        message: `font-family "${raw}" is neither generic/system nor a local @font-face; rendering may vary across machines`,
      });
    }
  }

  // ---- Rule 7: determinism tier value ----
  // B0: 属性の *値* だけを検証する(byte|perceptual)。GPU 規約(hf-seek /
  // __timelines / __hfLottie)との整合検査(perceptual を要する規約を使うのに
  // byte を名乗る等)は B1 で規約が導入されてから足す(ここではまだ何も
  // 突き合わせない)。
  const tierRaw = firstAttr(html, "data-hf-determinism");
  if (tierRaw !== undefined && tierRaw !== "byte" && tierRaw !== "perceptual") {
    errors.push({
      file,
      where: "data-hf-determinism",
      message: `data-hf-determinism must be "byte" or "perceptual" (got "${tierRaw}")`,
    });
  }

  // ---- Rule 8(B1): data-hf-requires トークン検証 ----
  const KNOWN_REQUIRES = new Set(["gsap", "lottie", "three"]);
  let requiresTokens: string[] = [];
  const requiresRaw = firstAttr(html, "data-hf-requires");
  if (requiresRaw !== undefined) {
    const toks = requiresRaw.split(/[\s,]+/).filter((t) => t.length > 0);
    requiresTokens = toks;
    if (toks.length === 0) {
      errors.push({
        file,
        where: "data-hf-requires",
        message: "data-hf-requires is empty / data-hf-requires が空です",
      });
    }
    for (const tok of toks) {
      if (!KNOWN_REQUIRES.has(tok)) {
        errors.push({
          file,
          where: "data-hf-requires",
          message: `data-hf-requires: unknown library "${tok}" (known: gsap, lottie, three) / 未知のライブラリです`,
        });
      }
    }
  }

  // ---- Rule 9(B1): GPU 規約 × determinism tier ----
  // hf-seek(イベント駆動の GPU/canvas 自己描画)・three(data-hf-requires)は
  // SwiftShader(chromiumOptions.gl)無しでは byte 決定論を保証できない。
  // 未指定は byte と同義なので未指定もエラーにする。B5 で SwiftShader
  // による byte 決定論が実測検証されたら byte ケースは緩和され得る
  const usesHfSeek = /['"]hf-seek['"]/.test(html);
  const requiresThree = requiresTokens.includes("three");
  if (usesHfSeek || requiresThree) {
    if (tierRaw !== "perceptual") {
      errors.push({
        file,
        where: "data-hf-determinism",
        message:
          'hf-seek/three (event-driven GPU drawing) requires data-hf-determinism="perceptual" (GPU/canvas output is not byte-deterministic without SwiftShader) / GPU 演出は perceptual tier を宣言してください',
      });
    }
  }

  // ---- summary ----
  let summary: string;
  if (errors.length === 0 && warnings.length === 0) {
    const w = width !== undefined ? String(width) : "?";
    const h = height !== undefined ? String(height) : "?";
    summary = `hyperframe OK: root=${rootId}, ${w}x${h}, vars=${varCount}, clips=${clipCount}`;
  } else {
    summary = `hyperframe: ${errors.length} error(s), ${warnings.length} warning(s)`;
  }

  return { errors, warnings, summary };
}
