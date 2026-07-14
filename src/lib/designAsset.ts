// lib/designAsset.ts — デザイン素材(背景画像)の収録フォルダへの取り込み。
//
// Remotion が読めるのは publicDir(= 収録フォルダ)の中だけなので、config.yaml に
// チャンネル共通の背景を絶対パス(例: ~/Movies/obs/bg.jpg)で書いても、そのままでは
// staticFile で参照できない。そこで render / frames / thumbnail が合成に入る前に
// ここを通し(renderCfgWithDesign)、収録フォルダの render.design/ へ取り込んでから
// 相対パスに書き換える(収録ごとの手コピーを不要にする)。plain / obs-canvas の
// どちらでも、design が有効なら同じように動く。
//
// backgroundFile は3通りの書き方を解決する(resolveBackgroundSource):
//   assets/backgrounds/xxx.jpg  … リポジトリ同梱の既定背景(誰の環境でも動く)
//   ~/Movies/obs/xxx.jpg        … 個人のデザイン素材(絶対パス。~ 展開する)
//   materials/xxx.jpg           … その収録フォルダ内のファイル(取り込み不要)
//
// 収録フォルダ相対のパス(従来の書き方)はそのまま素通しする。fs を触るので
// remotion/Main.tsx が import する design.ts(ブラウザで動く純関数)とは別モジュール。
import { copyFileSync, existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./config.ts";
import type { Config } from "./config.ts";

/** 収録フォルダ内の取り込み先。materials/(人間の素材置き場)には置かない:
 * 背景は overlays から参照されないので `materials` コマンドに永久に「未使用素材」
 * として計上されてしまう。元ファイルからいつでも再取得できる中間生成物なので、
 * render.chunks/ ・ render.fast/ と同じ generated ディレクトリに置く
 * (files.ts の GENERATED_DIRS。clean で消えるが次の実行で自動復帰する) */
const DEST_DIR = "render.design";

/**
 * buildRenderProps に渡す render 設計値。config.yaml の
 * render.design.backgroundFile がリポジトリ同梱 / 絶対パスなら、収録フォルダの
 * render.design/ へコピーし、その相対パスへ書き換えたものを返す。相対パス・
 * デザイン無効・背景なしのときは cfg.render をそのまま返す(副作用なし)。
 *
 * **buildRenderProps を呼ぶ経路(render / thumbnail / frames / av / editor)は
 * すべて renderCfg にこれを通す。** 素通しすると背景が publicDir の外に居たまま
 * になり、背景色だけの絵になる。
 *
 * 同名・同サイズ・同 mtime のコピーが既にあれば何もしない(毎回のコピーを避ける)。
 * 元ファイルが見つからないときは警告だけして相対化せず素通しする
 * (buildRenderProps 側が「背景画像が見つかりません」で背景色へ優雅に劣化する)。
 */
export function renderCfgWithDesign(
  dir: string,
  cfg: Config,
  warn: (msg: string) => void = (msg) => console.warn(`警告: ${msg}`),
): Config["render"] {
  const design = cfg.render.design;
  if (!design?.enabled || !design.backgroundFile) return cfg.render;

  const src = resolveBackgroundSource(dir, design.backgroundFile);
  if (src === "as-is") return cfg.render; // 収録フォルダに実在 = 取り込み不要でそのまま使う
  if (src === null) {
    warn(`背景画像が見つかりません: ${design.backgroundFile}(背景色のみで描画します)`);
    return cfg.render;
  }

  const rel = join(DEST_DIR, basename(src));
  const dest = join(dir, rel);
  if (!isFresh(src, dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    // mtime を元ファイルに合わせる(次回の isFresh 判定の拠り所。
    // copyFileSync は mtime を引き継がないので、これが無いと毎回コピーになる)
    const s = statSync(src);
    utimesSync(dest, s.atime, s.mtime);
  }
  return { ...cfg.render, design: { ...design, backgroundFile: rel } };
}

/** リポジトリ直下(assets/ の親)。同梱の既定背景をここから解決する */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * backgroundFile を「取り込み元の絶対パス」へ解決する。優先順:
 * 1. 収録フォルダに実在 → "as-is"(取り込み不要。そのファイルをそのまま使う)
 * 2. 絶対パス(~ 展開)で実在 → その絶対パス(個人のデザイン素材)
 * 3. リポジトリ直下からの相対で実在 → その絶対パス(同梱の assets/backgrounds/…)
 * どれにも当たらなければ null(呼び出し側が warn して背景色へ劣化する)
 */
function resolveBackgroundSource(dir: string, file: string): string | "as-is" | null {
  if (!isAbsolute(expandHome(file)) && existsSync(join(dir, file))) return "as-is";
  const abs = expandHome(file);
  if (isAbsolute(abs)) return existsSync(abs) ? abs : null;
  const inRepo = join(REPO_ROOT, file);
  return existsSync(inRepo) ? inRepo : null;
}

/** 取り込み済みのコピーが元ファイルと同一(サイズ・mtime)か */
function isFresh(src: string, dest: string): boolean {
  if (!existsSync(dest)) return false;
  const a = statSync(src);
  const b = statSync(dest);
  return a.size === b.size && Math.floor(a.mtimeMs) === Math.floor(b.mtimeMs);
}
