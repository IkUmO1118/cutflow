// stages/hyperframe.ts — C4: HyperFrames カード(無音の作図素材)を
// (a) LLM で下書き(authorHyperframe: hyperframes/<name>.html)し、
// (b) native Remotion interpreter(remotion/HyperFrame.tsx)で
// materials/hyperframes/<name>.mp4 へ render する(renderHyperframe)。
// docs/programs/hyperframes-integration-program.md の C4。
//
// node 専用モジュール(node:fs / node:crypto / node:child_process を使う)。
// ブラウザバンドルへは絶対に import されない(remotion/HyperFrame.tsx から
// import されるのは src/lib/hyperframe.ts の方)。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import { mergeVariables, parseComposition } from "../lib/hyperframe.ts";
import type { ParsedComposition, VarDecl } from "../lib/hyperframe.ts";
import { checkComposition } from "../lib/hyperframeCheck.ts";
import { compositionDurationInFrames } from "../lib/renderFrameMath.ts";
import {
  captureSnapshot,
  publishAsTransaction,
} from "../lib/renderTransaction.ts";
import type { VerifyOutcome } from "../lib/renderTransaction.ts";
import { completeWithJsonSchema } from "../lib/llm.ts";
import type { Config } from "../lib/config.ts";
import { readRules } from "./plan.ts";
import type { HyperFrameProps } from "../../remotion/HyperFrame.tsx";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** B0: byte tier で「同一入力からの再 render が byte 一致しなかった」ときに、
 * それが実害(視覚的にも変わった)か AA jitter 程度の無害な揺れかを分ける
 * しきい値。ending-card の AA jitter 実例(memory:
 * hyperframe-render-determinism-composition-dependent)で、luma max delta
 * (YMAX、0〜255)が10以下なら人間の目には区別できないことを確認済み。
 * perceptual tier の「知覚同一」判定にも同じしきい値を使う */
export const PERCEPTUAL_YMAX_THRESHOLD = 10;

/**
 * 値を再帰的に正規化(オブジェクトキーをソート)する。
 * hyperframeCacheKey が JSON.stringify のキー順に左右されないようにするため
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = canonicalize(obj[k]);
    return sorted;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* PURE(ブラウザ不使用・単体テスト対象)                                  */
/* ------------------------------------------------------------------ */

export type ResolveHyperframeBuildResult =
  | {
      ok: true;
      variables: Record<string, unknown>;
      width: number;
      height: number;
      fps: number;
      durationSec: number;
    }
  | { ok: false; error: string };

/**
 * composition の解析結果(parseComposition)+ CLI 上書き(--var / --width 等)から、
 * 実際に render する build 仕様を1つに解決する。優先度は
 * override(CLI フラグ) > parsed(data-*) > 既定(fps のみ 30)。
 * width/height/durationSec には既定値が無い(どこにも無ければ ok:false)。
 */
export function resolveHyperframeBuild(args: {
  parsed: ParsedComposition;
  cliVars: Record<string, unknown>;
  overrides?: { width?: number; height?: number; fps?: number; durationSec?: number };
  defaultFps?: number;
}): ResolveHyperframeBuildResult {
  const { parsed, cliVars, overrides, defaultFps = 30 } = args;

  const width = overrides?.width ?? parsed.width;
  const height = overrides?.height ?? parsed.height;
  const fps = overrides?.fps ?? defaultFps;
  const durationSec = overrides?.durationSec ?? parsed.intrinsicDurationSec;

  if (width === undefined || !Number.isInteger(width) || width <= 0) {
    return { ok: false, error: `width が解決できません(正の整数が必要。got ${String(width)})` };
  }
  if (height === undefined || !Number.isInteger(height) || height <= 0) {
    return { ok: false, error: `height が解決できません(正の整数が必要。got ${String(height)})` };
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    return { ok: false, error: `fps が不正です(正の数が必要。got ${String(fps)})` };
  }
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, error: `durationSec が解決できません(正の数が必要。got ${String(durationSec)})` };
  }

  const variables = mergeVariables(parsed.variables, undefined, cliVars);
  return { ok: true, variables, width, height, fps, durationSec };
}

/** キャッシュキー(hyperframe.<name>.key.json の `key` フィールド)。
 * 入力のいずれかが変われば別のキーになる(sha256 hex) */
export function hyperframeCacheKey(inputs: {
  htmlSha256: string;
  variables: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  codec: string;
  hardwareAcceleration: string;
}): string {
  const canon = canonicalize(inputs);
  return sha256Hex(JSON.stringify(canon));
}

/** render された mp4 を ffprobe で検査する(publishAsTransaction の verify)。
 * codec_name=h264 / pix_fmt∈{yuvj420p,yuv420p} / width/height/avg_frame_rate/
 * nb_read_frames が spec と一致することを確認する */
export async function verifyHyperframeVideo(
  mp4: string,
  spec: { width: number; height: number; fps: number; expectedFrames: number },
): Promise<VerifyOutcome> {
  let probe: { streams?: Array<Record<string, unknown>> };
  try {
    const raw = execFileSync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames",
      "-count_frames",
      "-of", "json",
      mp4,
    ]).toString("utf8");
    probe = JSON.parse(raw) as { streams?: Array<Record<string, unknown>> };
  } catch (err) {
    return { ok: false, reason: `ffprobe に失敗しました: ${(err as Error).message}` };
  }
  const stream = probe.streams?.[0];
  if (!stream) return { ok: false, reason: "ffprobe が video stream を返しませんでした" };

  if (stream.codec_name !== "h264") {
    return { ok: false, reason: `codec_name が一致しません(got ${String(stream.codec_name)})` };
  }
  if (stream.pix_fmt !== "yuvj420p" && stream.pix_fmt !== "yuv420p") {
    return { ok: false, reason: `pix_fmt が一致しません(got ${String(stream.pix_fmt)})` };
  }
  if (Number(stream.width) !== spec.width) {
    return { ok: false, reason: `width が一致しません(got ${String(stream.width)}, expected ${spec.width})` };
  }
  if (Number(stream.height) !== spec.height) {
    return { ok: false, reason: `height が一致しません(got ${String(stream.height)}, expected ${spec.height})` };
  }
  const expectedRate = `${spec.fps}/1`;
  if (stream.avg_frame_rate !== expectedRate) {
    return {
      ok: false,
      reason: `avg_frame_rate が一致しません(got ${String(stream.avg_frame_rate)}, expected ${expectedRate})`,
    };
  }
  if (Number(stream.nb_read_frames) !== spec.expectedFrames) {
    return {
      ok: false,
      reason:
        `nb_read_frames が一致しません(got ${String(stream.nb_read_frames)}, expected ${spec.expectedFrames})`,
    };
  }
  return { ok: true };
}

/** ffmpeg signalstats の `lavfi.signalstats.YMAX=<number>` 行(metadata=print
 * が stdout に吐く形式)から最大値を拾う純関数。複数行あれば最大、1つも
 * 無ければ 0 を返す */
export function parseSignalstatsYmax(text: string): number {
  const re = /lavfi\.signalstats\.YMAX=(-?[\d.]+)/g;
  let max: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (max === undefined || n > max) max = n;
  }
  return max ?? 0;
}

/**
 * B0 決定論判定(--force 再生成時、入力が前回と同じだったときだけ呼ばれる)。
 * tier(宣言) × byteIdentical(実測)× ymax(実測。luma max delta)から
 * ok/level/message を決める純関数。メッセージは日英併記でコード的な文体、
 * warn は "⚠ " で始める
 */
export function determinismVerdict(args: {
  tier: "byte" | "perceptual";
  byteIdentical: boolean;
  ymax: number;
}): { ok: boolean; level: "info" | "warn"; message: string } {
  const { tier, byteIdentical, ymax } = args;
  if (tier === "byte") {
    if (byteIdentical) {
      return { ok: true, level: "info", message: "byte tier: 前回と byte 一致(決定論 OK)" };
    }
    if (ymax <= PERCEPTUAL_YMAX_THRESHOLD) {
      return {
        ok: false,
        level: "warn",
        message:
          `⚠ byte tier 宣言だが byte 不一致(YMAX=${ymax} ≤ ${PERCEPTUAL_YMAX_THRESHOLD})。` +
          "perceptual tier の宣言を検討してください",
      };
    }
    return {
      ok: false,
      level: "warn",
      message: `⚠ byte tier: 前回と視覚が乖離しました(YMAX=${ymax})`,
    };
  }
  // perceptual
  if (ymax <= PERCEPTUAL_YMAX_THRESHOLD) {
    return {
      ok: true,
      level: "info",
      message: `perceptual tier: 知覚同一(YMAX=${ymax} ≤ ${PERCEPTUAL_YMAX_THRESHOLD})`,
    };
  }
  return {
    ok: false,
    level: "warn",
    message: `⚠ perceptual tier: YMAX=${ymax} が閾値 ${PERCEPTUAL_YMAX_THRESHOLD} を超過`,
  };
}

/**
 * 2つの mp4 の luma max delta(YMAX)を ffmpeg の signalstats で計測する。
 * `blend=all_mode=difference` で差分フレームを作り、grayscale 化した
 * signalstats の YMAX(0〜255)を metadata=print:file=- で stdout へ吐かせて
 * 読む。ffmpeg のビルドによっては差分計測自体は成功していても非ゼロ終了
 * することがあるため、例外時も捕まえた stdout から救済を試みる。それでも
 * YMAX 行が1つも取れなければ undefined(呼び出し側は「計測不能」として
 * 扱い、成功した publish 自体は絶対に失敗させない)
 */
async function lumaMaxDelta(oldMp4: string, newMp4: string): Promise<number | undefined> {
  const args = [
    "-v", "error",
    "-i", oldMp4,
    "-i", newMp4,
    "-filter_complex",
    "[0:v][1:v]blend=all_mode=difference,format=gray,signalstats,metadata=print:file=-",
    "-an",
    "-f", "null",
    "-",
  ];
  let stdout = "";
  try {
    stdout = execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  } catch (err) {
    const raw = (err as { stdout?: Buffer | string } | undefined)?.stdout;
    if (raw) stdout = typeof raw === "string" ? raw : raw.toString("utf8");
  }
  if (!stdout.includes("lavfi.signalstats.YMAX=")) return undefined;
  return parseSignalstatsYmax(stdout);
}

/* ------------------------------------------------------------------ */
/* render(node/browser)                                                */
/* ------------------------------------------------------------------ */

export interface RenderHyperframeDeps {
  /** テスト用の produce 差し替え。既定は bundle+headless Chrome での実 render */
  produce?: (tmp: string, inputProps: HyperFrameProps) => Promise<void>;
}

export interface RenderHyperframeResult {
  outPath: string;
  skipped: boolean;
  frames: number;
  sha256: string;
  /** 宣言された tier(data-hf-determinism)。常に設定される */
  tier: "byte" | "perceptual";
  /** --force で再生成したときだけ設定。旧 mp4 と新 mp4 の sha256 が一致したか */
  identical?: boolean;
  /** --force かつ inputsUnchanged(前回と入力キーが同じ)かつ !identical の
   * ときだけ設定(luma max delta。ffmpeg 計測が失敗した場合は undefined のまま) */
  ymax?: number;
  /** 同上。determinismVerdict(...).ok */
  determinismOk?: boolean;
  /** 同上。determinismVerdict(...).message(warn は "⚠ " prefix 込み) */
  determinismMessage?: string;
}

/** bundle + headless Chrome + renderMedia の実 render(scripts/hyperframe-verify.ts と
 * 同じパターン)。テストでは RenderHyperframeDeps.produce で差し替える */
async function renderHyperframeMp4(
  dir: string,
  outPath: string,
  inputProps: HyperFrameProps,
): Promise<void> {
  await ensureBrowser();
  const serveUrl = await bundle({
    entryPoint: join(REPO_ROOT, "remotion", "index.ts"),
    publicDir: dir,
    symlinkPublicDir: true,
  });
  const browser = await openBrowser("chrome");
  try {
    const composition = await selectComposition({
      serveUrl,
      id: "HyperFrame",
      inputProps,
      puppeteerInstance: browser,
      logLevel: "warn",
    });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
      puppeteerInstance: browser,
      overwrite: true,
      logLevel: "warn",
    });
  } finally {
    await browser.close({ silent: true });
  }
}

/**
 * hyperframes/<name>.html を render し materials/hyperframes/<name>.mp4 へ
 * 公開する。手順: 読み込み → build 解決(resolveHyperframeBuild)→ check ゲート
 * (checkComposition。エラーがあれば 1バイトも書かず throw)→ キャッシュキー
 * 一致なら再利用(skipped:true)→ publishAsTransaction(temp→verify→atomic
 * rename→commit=hyperframe.<name>.key.json 書き込み)。
 */
export async function renderHyperframe(
  dir: string,
  opts: {
    name: string;
    cliVars: Record<string, unknown>;
    overrides?: { width?: number; height?: number; fps?: number; durationSec?: number };
    force?: boolean;
  },
  deps?: RenderHyperframeDeps,
): Promise<RenderHyperframeResult> {
  const sourcePath = join(dir, "hyperframes", `${opts.name}.html`);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `${sourcePath} がありません。先に --from-brief で作図するか、` +
        `hyperframes/${opts.name}.html を置いてください`,
    );
  }
  const html = readFileSync(sourcePath, "utf8");
  const parsed = parseComposition(html);

  const build = resolveHyperframeBuild({
    parsed,
    cliVars: opts.cliVars,
    overrides: opts.overrides,
  });
  if (!build.ok) {
    throw new Error(build.error);
  }
  const { variables, width, height, fps, durationSec } = build;

  // check ゲート: エラーが1つでもあれば mkdir/render の前に throw(0バイト書込み)
  const check = checkComposition(html, { file: sourcePath });
  for (const w of check.warnings) {
    console.log(`⚠ ${w.where}: ${w.message}`);
  }
  if (check.errors.length > 0) {
    for (const e of check.errors) {
      console.error(`✖ ${e.where}: ${e.message}`);
    }
    throw new Error(
      `hyperframes/${opts.name}.html が check ゲートに失敗しました(${check.errors.length}件のエラー)`,
    );
  }

  const inputProps: HyperFrameProps = { html, variables, width, height, fps, durationSec };
  const expectedFrames = compositionDurationInFrames(durationSec, fps);
  const hardwareAcceleration = "none";

  const htmlSha256 = sha256Hex(html);
  const key = hyperframeCacheKey({
    htmlSha256,
    variables,
    width,
    height,
    fps,
    durationSec,
    codec: "h264",
    hardwareAcceleration,
  });

  const finalPath = join(dir, "materials", "hyperframes", `${opts.name}.mp4`);
  const keyPath = join(dir, `hyperframe.${opts.name}.key.json`);

  if (!opts.force && existsSync(finalPath) && existsSync(keyPath)) {
    try {
      const prev = JSON.parse(readFileSync(keyPath, "utf8")) as { key?: string };
      if (prev.key === key) {
        return {
          outPath: finalPath,
          skipped: true,
          frames: expectedFrames,
          sha256: sha256Hex(readFileSync(finalPath)),
          tier: parsed.determinismTier,
        };
      }
    } catch {
      // 壊れた key.json は無視してフル再生成にフォールバック
    }
  }

  mkdirSync(dirname(finalPath), { recursive: true });

  // --force で既存 mp4 を上書きするとき: 決定論判定(B0)のために「前回と
  // 入力(cache key)が同じだったか」を先に確認する。同じなら
  // publishAsTransaction が finalPath を上書きしてしまう前に旧 mp4 の
  // バイトをサイドカーへ退避しておく(publishAsTransaction は temp→
  // finalPath への atomic rename で旧ファイルを消してしまうため、退避
  // しないと render 後に旧 vs 新の diff が取れない)
  const oldExists = Boolean(opts.force && existsSync(finalPath));
  let oldSha256: string | undefined;
  let inputsUnchanged = false;
  let sidecarPath: string | undefined;
  if (oldExists) {
    oldSha256 = sha256Hex(readFileSync(finalPath));
    if (existsSync(keyPath)) {
      try {
        const prevKey = JSON.parse(readFileSync(keyPath, "utf8")) as { key?: string };
        inputsUnchanged = prevKey.key === key;
      } catch {
        inputsUnchanged = false;
      }
    }
    if (inputsUnchanged) {
      sidecarPath = join(dirname(finalPath), `.${opts.name}.det-old.tmp.mp4`);
      copyFileSync(finalPath, sidecarPath);
    }
  }

  const produce =
    deps?.produce ?? ((tmp: string, props: HyperFrameProps) => renderHyperframeMp4(dir, tmp, props));

  try {
    await publishAsTransaction({
      finalPath,
      inputs: [captureSnapshot(sourcePath)],
      produce: (tempPath) => produce(tempPath, inputProps),
      verify: (tempPath) => verifyHyperframeVideo(tempPath, { width, height, fps, expectedFrames }),
      commit: () => {
        writeFileSync(
          keyPath,
          JSON.stringify(
            {
              key,
              htmlSha256,
              variables,
              width,
              height,
              fps,
              durationSec,
              codec: "h264",
              hardwareAcceleration,
            },
            null,
            2,
          ),
        );
      },
    });

    const newSha256 = sha256Hex(readFileSync(finalPath));
    const identical = oldExists ? oldSha256 === newSha256 : undefined;

    const result: RenderHyperframeResult = {
      outPath: finalPath,
      skipped: false,
      frames: expectedFrames,
      sha256: newSha256,
      tier: parsed.determinismTier,
      identical,
    };

    // 決定論判定(verdict)は「--force かつ前回と入力キーが同じだった」
    // ときだけ意味を持つ(入力が変わっていれば byte 不一致は当然なので
    // 判定対象にしない)。identical なら ffmpeg を起動せず ymax=0 で済ませる
    if (oldExists && inputsUnchanged && sidecarPath) {
      const byteIdentical = identical === true;
      const ymax = byteIdentical ? 0 : await lumaMaxDelta(sidecarPath, finalPath);
      if (ymax !== undefined) {
        const verdict = determinismVerdict({ tier: parsed.determinismTier, byteIdentical, ymax });
        result.ymax = ymax;
        result.determinismOk = verdict.ok;
        result.determinismMessage = verdict.message;
      } else {
        console.log("(決定論判定は計測できませんでした: ffmpeg の luma diff 計測に失敗)");
      }
    }

    return result;
  } finally {
    if (sidecarPath) {
      try {
        rmSync(sidecarPath, { force: true });
      } catch {
        // 退避コピーの削除失敗は致命的ではない
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* author(LLM 下書き)                                                   */
/* ------------------------------------------------------------------ */

interface HyperframeAuthorResponse {
  html: string;
  variables: VarDecl[];
}

/** LLM 応答から {html, variables} を取り出す。plan-materials の
 * parsePlacementsResponse と同じ堅牢さ(前後の説明文/コードフェンスが混ざっても
 * 最初の { 〜 最後の } を拾う) */
function parseHyperframeAuthorResponse(raw: string): HyperframeAuthorResponse {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("LLM 応答に JSON が見つかりません(hyperframes/<name>.raw.txt を確認してください)");
  }
  let parsed: { html?: unknown; variables?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { html?: unknown; variables?: unknown };
  } catch {
    throw new Error("LLM 応答の JSON パースに失敗しました(hyperframes/<name>.raw.txt を確認してください)");
  }
  if (typeof parsed.html !== "string" || parsed.html.trim() === "") {
    throw new Error("LLM 応答に html(composition HTML 文字列)が含まれていません");
  }
  const variables = Array.isArray(parsed.variables) ? (parsed.variables as VarDecl[]) : [];
  return { html: parsed.html, variables };
}

export interface AuthorHyperframeResult {
  sourcePath: string;
  varCount: number;
  summary: string;
}

/**
 * prompts/hyperframe.md + docs/hyperframes-skills/card-patterns.md(番号メニュー)+
 * brief.md/rules.md を注入して LLM に単一の composition HTML を書かせ、
 * check ゲート(checkComposition)を通ったものだけを hyperframes/<name>.html に書く
 * (通らなければ 1バイトも書かない。raw 応答は常に *.raw.txt へ残す)。render はしない。
 */
export async function authorHyperframe(
  dir: string,
  cfg: Config,
  opts: { name: string; pattern?: number; width?: number; height?: number; durationSec?: number; force?: boolean },
): Promise<AuthorHyperframeResult> {
  const template = readFileSync(join(REPO_ROOT, "prompts", "hyperframe.md"), "utf8");
  const patterns = readFileSync(
    join(REPO_ROOT, "docs", "hyperframes-skills", "card-patterns.md"),
    "utf8",
  );

  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "(見せ場リストなし)";
  const rules = readRules(dir);

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const durationSec = opts.durationSec ?? 4;

  let prompt = template
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{patterns}}", () => patterns)
    .replaceAll("{{width}}", () => String(width))
    .replaceAll("{{height}}", () => String(height))
    .replaceAll("{{durationSec}}", () => String(durationSec));

  if (opts.pattern !== undefined) {
    prompt += `\n\n## 指定パターン\n\n上記のカードパターンメニューから **パターン${opts.pattern}** を使ってください。`;
  }

  const raw = await completeWithJsonSchema(
    prompt,
    cfg,
    {
      name: "cutflow_hyperframe",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["html", "variables"],
        properties: {
          html: { type: "string" },
          variables: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "type", "label", "default"],
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                label: { type: "string" },
                default: {},
              },
            },
          },
        },
      },
    },
    "other",
  );

  const hyperframesDir = join(dir, "hyperframes");
  mkdirSync(hyperframesDir, { recursive: true });
  // LLM の生応答は必ず残す(check ゲートで弾かれた場合の調査のため)
  writeFileSync(join(hyperframesDir, `${opts.name}.raw.txt`), raw);

  const parsed = parseHyperframeAuthorResponse(raw);

  const sourcePath = join(hyperframesDir, `${opts.name}.html`);
  const check = checkComposition(parsed.html, { file: `hyperframes/${opts.name}.html` });
  if (check.errors.length > 0) {
    const lines = check.errors.map((e) => `  ${e.where}: ${e.message}`);
    throw new Error(
      `生成された composition が check ゲートに失敗したため書き込みません` +
        `(hyperframes/${opts.name}.raw.txt を確認してください):\n${lines.join("\n")}`,
    );
  }
  for (const w of check.warnings) {
    console.log(`⚠ ${w.where}: ${w.message}`);
  }

  writeFileSync(sourcePath, parsed.html);

  return {
    sourcePath,
    varCount: parsed.variables.length,
    summary: check.summary,
  };
}
