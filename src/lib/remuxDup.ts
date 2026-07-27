// 元収録の「自動リマックス複製」検出。
//
// OBS は既定で .mkv に録画し(クラッシュ耐性のため)、録画停止後に同じ内容を
// .mp4 へ remux(ストリームコピー)した複製を隣に残す。CutFlow が入力として
// 使うのは manifest.json の `source` が指す1本だけなので、もう一方は収録
// フォルダ内で最大級の純粋な重複になる(実測: 3.0GB の収録で 3.0GB の重複)。
//
// ただしこれは「再生成できる中間生成物」ではなく**人間の収録ファイルと同じ
// 見た目のファイル**なので、files.ts の GENERATED_* 分類には決して入れない。
// 代わりに `clean` が実行時に、下の全条件を満たしたときだけ削除対象へ足す:
//
//   1. manifest.json の `source` が実在し、拡張子が .mp4 ではない(=消す側は
//      常に複製であって、CutFlow が実際に読む元収録では絶対にない)
//   2. 複製候補 `<source の basename>.mp4` が実在する通常ファイルである
//   3. その名前が files.ts で "other" に分類される(cut.mp4 等の生成物名や
//      編集ファイル名に化けた候補は、この経路では扱わない)
//   4. ffprobe で映像 codec・幅・高さ・fps・音声 codec・音声有無が完全一致し、
//      尺の差が tolerance 以内である
//   5. ファイルサイズ比が sizeTolerance 以内である(=ストリームコピーの複製。
//      同一内容を低ビットレートへ再エンコードした「配布用の軽い mp4」は
//      4 を満たしてもここで弾かれ、削除対象にならない)
//
// 4+5 を要求するので、たまたま同じ basename を持つ別内容の mp4 は残る。
import { readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { probe, summarizeProbe, type MaterialProbe } from "./ffmpeg.ts";
import { fileRole } from "./files.ts";

/** 尺の許容差(秒)。remux は末尾の端数フレームを落とすことがあり、実測では
 * 645.733s(mkv) と 645.633s(mp4) の 0.1s 差が出た。分単位で違う別素材は
 * この閾値では通らない */
export const REMUX_DURATION_TOLERANCE_SEC = 1.0;

/** ファイルサイズの許容相対差。ストリームコピーの remux は符号化済みストリームが
 * そのままなので、差はコンテナのヘッダ/インデックス分しか出ない(実測 0.02%)。
 * ビットレートを落とした再エンコード品は桁で違うのでここで落ちる */
export const REMUX_SIZE_TOLERANCE_RATIO = 0.05;

/** サイズ差の絶対的な許容量。コンテナのオーバーヘッドは尺に比例せず概ね一定
 * (フレーム数に応じたインデックス分)なので、短い動画では相対差が跳ね上がる
 * (実測: 1秒の mkv/mp4 ペアで 1.4KB 差 = 8%)。相対か絶対のどちらかを満たせば
 * 複製とみなす二段構えにして、短尺・長尺の両端を同じ規則で扱う */
export const REMUX_SIZE_TOLERANCE_BYTES = 1024 * 1024;

export type RemuxVerdict = { dup: true } | { dup: false; reason: string };

/** fps の比較許容差(avg_frame_rate の有理数→浮動小数変換の誤差だけを吸収する) */
const FPS_EPSILON = 0.01;

/**
 * 2本の probe 要約が「同一内容の remux 複製」かを判定する純関数(実 ffprobe
 * 非依存・テスト対象)。1つでも食い違えば dup:false と理由を返す
 * (呼び出し側はその理由をそのままレポートに出せる)。
 */
export function compareRemux(
  source: MaterialProbe,
  candidate: MaterialProbe,
  sourceBytes: number,
  candidateBytes: number,
  tolerance = REMUX_DURATION_TOLERANCE_SEC,
  sizeToleranceRatio = REMUX_SIZE_TOLERANCE_RATIO,
  sizeToleranceBytes = REMUX_SIZE_TOLERANCE_BYTES,
): RemuxVerdict {
  if (source.videoCodec === undefined || candidate.videoCodec === undefined) {
    return { dup: false, reason: "映像ストリームが無い(または codec 不明)" };
  }
  if (source.videoCodec !== candidate.videoCodec) {
    return { dup: false, reason: `映像 codec が違う(${source.videoCodec} / ${candidate.videoCodec})` };
  }
  if (source.width !== candidate.width || source.height !== candidate.height) {
    return {
      dup: false,
      reason: `解像度が違う(${source.width}x${source.height} / ${candidate.width}x${candidate.height})`,
    };
  }
  if (source.fps === undefined || candidate.fps === undefined) {
    return { dup: false, reason: "fps が読めない" };
  }
  if (Math.abs(source.fps - candidate.fps) > FPS_EPSILON) {
    return { dup: false, reason: `fps が違う(${source.fps} / ${candidate.fps})` };
  }
  if (source.hasAudio !== candidate.hasAudio) {
    return { dup: false, reason: "音声の有無が違う" };
  }
  if (source.audioCodec !== candidate.audioCodec) {
    return {
      dup: false,
      reason: `音声 codec が違う(${source.audioCodec ?? "なし"} / ${candidate.audioCodec ?? "なし"})`,
    };
  }
  if (source.durationSec === undefined || candidate.durationSec === undefined) {
    return { dup: false, reason: "尺が読めない" };
  }
  const dt = Math.abs(source.durationSec - candidate.durationSec);
  if (dt > tolerance) {
    return {
      dup: false,
      reason: `尺が違う(${source.durationSec.toFixed(3)}s / ${candidate.durationSec.toFixed(3)}s)`,
    };
  }
  const maxBytes = Math.max(sourceBytes, candidateBytes);
  if (maxBytes <= 0) return { dup: false, reason: "サイズが 0" };
  const diffBytes = Math.abs(sourceBytes - candidateBytes);
  const ratio = diffBytes / maxBytes;
  if (ratio > sizeToleranceRatio && diffBytes > sizeToleranceBytes) {
    return {
      dup: false,
      reason: `サイズが違いすぎる(差 ${(ratio * 100).toFixed(1)}% = 再エンコード品の可能性)`,
    };
  }
  return { dup: true };
}

/**
 * manifest の `source` から remux 複製の候補ファイル名を導く純関数。
 * source 自身が .mp4 のときは null(=消す側が元収録になり得る経路を作らない)。
 * ディレクトリ区切りを含む source も null(収録フォルダ直下の名前しか扱わない)。
 */
export function remuxCandidateName(source: string): string | null {
  if (source.includes("/") || source.includes("\\")) return null;
  if (source !== basename(source)) return null;
  const ext = extname(source).toLowerCase();
  if (ext === "" || ext === ".mp4") return null;
  return `${source.slice(0, source.length - ext.length)}.mp4`;
}

export type RemuxDuplicate = {
  /** 収録フォルダからの相対パス(常にトップレベルの1ファイル) */
  relPath: string;
  /** 解放されるバイト数 */
  bytes: number;
  /** 対になっている元収録(manifest.source) */
  source: string;
};

/** manifest.json を読んで `source` を取り出す(壊れていれば null)。
 * clean は manifest が消える前後どちらでも動く必要があるので、失敗は全て
 * 「複製なし」へ倒す(throw しない) */
export function readManifestSource(dir: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const source = (parsed as { source?: unknown }).source;
  return typeof source === "string" && source.length > 0 ? source : null;
}

/** 収録フォルダ直下の通常ファイルのサイズ。無い/ディレクトリなら null */
function regularFileSize(abs: string): number | null {
  try {
    const st = statSync(abs);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * 実 fs + ffprobe を叩いて remux 複製を検出する(0 件か 1 件)。
 * 上のコメントの条件 1〜5 を全て満たしたときだけ結果を返し、1つでも欠ければ
 * null を返す(理由が要るときは onSkip で受け取れる)。ffprobe が使えない
 * 環境でも throw せず null に倒れる=`clean` の既存動作を壊さない。
 */
export async function detectRemuxDuplicate(
  dir: string,
  onSkip?: (reason: string) => void,
): Promise<RemuxDuplicate | null> {
  const skip = (reason: string): null => {
    onSkip?.(reason);
    return null;
  };
  const source = readManifestSource(dir);
  if (source === null) return null; // manifest 無し=判断材料が無い(黙って諦める)

  const candidate = remuxCandidateName(source);
  if (candidate === null) return null; // 元収録が .mp4 → 複製側を特定できない
  if (candidate === source) return null; // 念のため(remuxCandidateName が保証)

  // ★安全の核: 候補名が files.ts で "other" 以外に化けるなら、この経路では扱わない
  // (cut.mp4 等の生成物は通常の generated 経路が、編集ファイルは誰も、消す)
  if (fileRole(candidate) !== "other") return null;

  const sourceBytes = regularFileSize(join(dir, source));
  if (sourceBytes === null) {
    return skip(`元収録 ${source} が見つからないので remux 複製の判定を見送りました`);
  }
  const candidateBytes = regularFileSize(join(dir, candidate));
  if (candidateBytes === null) return null; // 複製が無い=正常(掃除済み or remux 未使用)

  let probes: [MaterialProbe, MaterialProbe];
  try {
    probes = await Promise.all([
      probe(join(dir, source)).then(summarizeProbe),
      probe(join(dir, candidate)).then(summarizeProbe),
    ]);
  } catch (err) {
    return skip(`ffprobe に失敗したので ${candidate} は残します: ${(err as Error).message}`);
  }
  const verdict = compareRemux(probes[0], probes[1], sourceBytes, candidateBytes);
  if (!verdict.dup) {
    return skip(`${candidate} は ${source} の remux 複製ではないので残します(${verdict.reason})`);
  }
  return { relPath: candidate, bytes: candidateBytes, source };
}

/**
 * 削除の直前に呼ぶ同期の再アサート(belt-and-suspenders)。plan 時点から状況が
 * 変わっていて「消そうとしている mp4 こそが今の元収録」になっていたら throw する。
 * ffprobe は再実行しない(内容一致は plan 時に確認済み)。
 */
export function assertRemuxDuplicateStillSafe(dir: string, relPath: string): void {
  const source = readManifestSource(dir);
  if (source === null) {
    throw new Error(
      `内部エラー: manifest.json が読めないため remux 複製 ${relPath} の削除を中止しました`,
    );
  }
  if (source === relPath) {
    throw new Error(
      `内部エラー: ${relPath} は manifest が指す元収録そのものです(削除を中止)`,
    );
  }
  if (regularFileSize(join(dir, source)) === null) {
    throw new Error(
      `内部エラー: 元収録 ${source} が見つからないため ${relPath} の削除を中止しました`,
    );
  }
  if (fileRole(relPath) !== "other") {
    throw new Error(`内部エラー: ${relPath} は remux 複製として扱えません(削除を中止)`);
  }
}
