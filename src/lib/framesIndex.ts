// frames/index.json — frames が撮影のたびに書く「入力フィンガープリント」。
// stale-PNG 罠(frames を経由せず古い PNG を Read してしまう事故)対策。
//
// 罠の本質は「編集した/撮り直していないの乖離を、AI が PNG を Read する前に
// 気づけない」こと。frames は実行のたびに frames/*.png を全消しして撮り直す
// ので frames 自身は安全だが、frames を*呼ばずに*古い PNG を読むケースには
// 何の歯止めも無かった。対策は「AI が編集後に必ず通る地点(validate/describe)
// で警告する」こと(docs/plans/2026-07-07-frames-server-design.md 課題1)。
//
// 記録するのは「その撮影の絵を決める、AI が手編集する JSON」の内容ハッシュ
// だけ(manifest.json・config.yaml・proxy.mp4 は対象外。理由は設計doc参照)。
// mtime ではなく内容ハッシュにするのは、git checkout やエディタの無変更
// 再保存で mtime だけ動く偽陽性を避けるため(数KBのJSONなら安い)。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** frames/index.json のファイル名(frames/ 内)。全消しループの対象外
 * (props.json と同じ扱い。次回 frames 実行のたびに上書き) */
export const FRAMES_INDEX_FILE = "index.json";

/** frames/index.json の中身(frames が撮影後に書く。実行ごとに上書き) */
export interface FramesIndex {
  /** 撮影時刻(ISO文字列) */
  capturedAt: string;
  /** 何を撮ったか(古さ判定には使わない。describe が「今 frames/ に入って
   * いるのは何の絵か」を添えるための情報) */
  shot: FramesShot;
  /** 撮影時点でのファイル名 → "sha256:<hex>" */
  inputs: Record<string, string>;
}

export interface FramesShot {
  /** FrameRequest["mode"](times/captions/every) */
  mode: string;
  /** --short 指定名。本編経路は null */
  short: string | null;
  ocr: boolean;
  fullRes: boolean;
  /** 実際に撮った枚数(unique.length) */
  count: number;
}

/** 撮影の絵を決める、AI が手編集する JSON のファイル名(経路別)。
 * 本編経路(shortName 省略): cutplan/transcript/overlays。
 * ショート経路(shortName 指定): shorts/transcript/overlays
 * (ショートは cutplan 非依存。overlays は colorFilter のみ継承だが、
 * 簡潔さのため overlays 全体をハッシュする=偽陽性は安全側なので許容)。
 * manifest.json(読み取り専用)・config.yaml(スコープ外。既知の限界)は
 * 意図的に含めない */
export function relevantInputs(shortName?: string): string[] {
  return shortName
    ? ["shorts.json", "transcript.json", "overlays.json"]
    : ["cutplan.json", "transcript.json", "overlays.json"];
}

/** 内容の sha256("sha256:<hex>")。小さい JSON なので決定論的で十分安い */
export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** ファイルが存在しないことを表す固定センチネル。writeFramesIndex /
 * framesFreshness の両方が同じ値を使うことで、「撮影時も今も無い」を
 * 誤って「変化あり」にしない(missing → missing は一致のまま) */
const MISSING = "missing";

/**
 * recorded(撮影時に記録した inputs)と current(今読み直した inputs)を
 * 突き合わせ、食い違ったファイル名を返す(recorded のキーぶんだけ判定。
 * current にキーが無い=読めなかった/対象外は「変化」に数える)。
 */
export function diffFingerprint(
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (current[file] !== hash) changed.push(file);
  }
  return changed;
}

/** dir/file を読んで内容ハッシュを返す。無ければ MISSING センチネル */
function hashFileOrMissing(dir: string, file: string): string {
  const p = join(dir, file);
  if (!existsSync(p)) return MISSING;
  return hashContent(readFileSync(p, "utf8"));
}

/** 今の関連入力ファイル群の内容ハッシュ(mapping file → hash|MISSING) */
function currentInputs(dir: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = hashFileOrMissing(dir, f);
  return out;
}

/** validate/describe が見る「frames の古さ」の3値。index.json 未生成
 * (=このフォルダで frames が一度も撮られていない、または機能導入前)は
 * `none` とし警告しない(isProxyStale が「proxy 未生成→陳腐化ではない」
 * とするのと同じ判断。古いと断言できないものを警告しない) */
export type Freshness =
  | { state: "none" }
  | { state: "fresh"; shot: FramesShot }
  | { state: "stale"; changed: string[]; shot: FramesShot };

/** frames/index.json を読み、現在の JSON 群と照合する(不純・fs 読み取り) */
export function framesFreshness(dir: string): Freshness {
  const p = join(dir, "frames", FRAMES_INDEX_FILE);
  if (!existsSync(p)) return { state: "none" };
  let index: FramesIndex;
  try {
    index = JSON.parse(readFileSync(p, "utf8")) as FramesIndex;
  } catch {
    // 壊れた index.json は「無い」と同じ扱い(古いと断言できない)
    return { state: "none" };
  }
  const current = currentInputs(dir, Object.keys(index.inputs));
  const changed = diffFingerprint(index.inputs, current);
  if (changed.length > 0) return { state: "stale", changed, shot: index.shot };
  return { state: "fresh", shot: index.shot };
}

/** frames が撮影後に呼ぶ(props.json を書くのと同じ並び)。frames/index.json
 * を書く(実行のたびに上書き)。shot.short から経路別の relevantInputs を
 * 決めて現在の内容ハッシュを記録する */
export function writeFramesIndex(dir: string, shot: FramesShot): void {
  const outDir = join(dir, "frames");
  mkdirSync(outDir, { recursive: true });
  const files = relevantInputs(shot.short ?? undefined);
  const index: FramesIndex = {
    capturedAt: new Date().toISOString(),
    shot,
    inputs: currentInputs(dir, files),
  };
  writeFileSync(join(outDir, FRAMES_INDEX_FILE), JSON.stringify(index, null, 2));
}
