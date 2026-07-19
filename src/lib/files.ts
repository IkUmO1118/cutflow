// 収録フォルダ内のファイル分類の単一の真実。
//
// EDITABLE_FILES(人間/AI が手編集する対象。plan/transcribe の再実行が
// backups/ へ退避してから上書きする)・GENERATED_FILES(中間生成物。
// CLAUDE.md の「中間生成物は編集しない」一覧と一致させる。手編集されても
// 次の実行で上書きされる/再生成できるので実害が薄い)・APPROVAL_FILE
// (承認レコード。編集ワークフローのどちらにも属さない第3カテゴリ。
// backup 退避の対象にはしない)の3分類を1箇所にまとめ、backup.ts・cli.ts・
// ドキュメント(§10 T8 の推奨 deny スニペット)がここから派生する。
import { APPROVALS_FILE } from "./approval.ts";

/** 人間(や AI)が手編集する対象で、plan / transcribe の再実行が上書きし得る
 * ファイル。上書き前の退避はこの一覧のうち存在するものを対象にする
 * (backup.ts の backupEditableFiles の既定値としても使う) */
export const EDITABLE_FILES = [
  "cutplan.json",
  "chapters.json",
  "meta.json",
  "transcript.json",
  "overlays.json",
] as const;

/** 中間生成物のうち、収録フォルダ直下で名前が固定のもの。CLAUDE.md の
 * 「中間生成物は編集しない」一覧(ショート名で可変にならない部分)と一致させる */
export const GENERATED_FILES = [
  "manifest.json",
  "cuts.auto.json",
  "plan.raw.txt",
  "plan.loop.json",
  "plan-shorts.raw.txt",
  "plan-materials.raw.txt",
  "plan-effects.raw.txt",
  "plan-bgm.raw.txt",
  "render.props.json",
  "whisper-out.json",
  "whisper-out.srt",
  "transcript.system.json",
  "whisper-system-out.json",
  "cut.mp4",
  "cut.keeps.json",
  "render.key.json",
  "render.report.json",
  "preview.mp4",
  "proxy.mp4",
  "proxy.key.json",
  "material-fit.suggested.json",
  "effect-check.json",
  "effect-fix.suggested.json",
  "bgm-fit.json",
  "bgm-fit.suggested.json",
  "style-check.json",
  "hyperframe-place.suggested.json",
] as const;

/** 中間生成物のうち、ショート名(shorts.json の name)や HyperFrame カード名
 * (hyperframes/<name>.html の name)で可変になるファイル名パターン。
 * GENERATED_FILES と合わせて一覧を成す
 * (cut.<name>.mp4 / cut.<name>.keeps.json / render.<name>.props.json /
 * render.<name>.key.json / hyperframe.<name>.key.json) */
const GENERATED_NAME_PATTERNS: readonly RegExp[] = [
  /^cut\.[^./]+\.mp4$/,
  /^cut\.[^./]+\.keeps\.json$/,
  /^render\.[^./]+\.props\.json$/,
  /^render\.[^./]+\.key\.json$/,
  /^hyperframe\.[^./]+\.key\.json$/,
];

/** 中間生成物のディレクトリ(配下は丸ごと中間生成物扱い): frames/(PNG・
 * props.json・OCR サイドカー。frames 実行のたびに全消しされる)・
 * render.chunks/(チャンク差分レンダーのキャッシュ)・
 * render.design/(plain / obs-canvas 共通で、config.yaml の
 * render.design.backgroundFile が収録フォルダ外の絶対パスまたはrepo同梱素材の
 * とき、Remotion が読める publicDir 配下へ取り込んだ背景画像のコピー。
 * 元ファイルからいつでも再取得できるので generated。materials/ に置くと
 * `materials` コマンドに「未使用素材」として計上されてしまうため別ディレクトリ)・
 * render.fast/(render 高速パスのキャッシュ。captions/<key>.png=テロップ
 * 透過 PNG、overlays/<key>.png=素材オーバーレイのレイヤー画。差分更新型で
 * ディレクトリごと削除すればフル再生成に戻る)・
 * shorts/(render --short /
 * --shorts の出力先。final.mp4 相当の成果物だが CLAUDE.md は同じ
 * 「触らない」節で扱っているためここに含める)・materials.probe/(`materials
 * <dir>` が書く素材知覚の集約+キャッシュ。frames/ と違い実行のたびに
 * 全消しはされない差分更新型。`materials/` 自体(人間の素材置き場)とは
 * 別名の生成ディレクトリなので "other" にはならない)・
 * style.probe/(`style-profile` が channel 直下に書くスタイルプロファイル
 * 集約。生成物)・hyperframe.probe/(`hyperframe-check` が書く動的監査
 * レポート+still の集約。materials.probe/ 等と同じ差分更新型キャッシュ。
 * `hyperframe.probe/<name>/index.json` の形でカード名ごとのサブディレクトリを持つ) */
const GENERATED_DIRS: readonly string[] = [
  "frames",
  "render.chunks",
  "render.design",
  "render.fast",
  "shorts",
  "materials.probe",
  "av.probe",
  "review.probe",
  "style.probe",
  "hyperframe.probe",
];

/** 収録フォルダ直下の承認レコードファイル名(src/lib/approval.ts の再輸出。
 * files.ts をファイル分類の唯一の出所にするため、他コードはここから参照する) */
export const APPROVAL_FILE = APPROVALS_FILE;

export type FileRole = "editable" | "generated" | "approval" | "other";

/** 収録フォルダからの相対パス(例: "cutplan.json" / "frames/out10s.png") から
 * ファイルの分類を返す。EDITABLE_FILES / GENERATED_FILES(+パターン・
 * ディレクトリ) / APPROVAL_FILE のどれにも該当しなければ "other"
 * (final.mp4 / thumbnail.png / bgm.* / materials/ / rules*.md / backups/ /
 * .editor-draft.json など、人間の成果物やその他の特別扱いファイル) */
export function fileRole(relPath: string): FileRole {
  if (relPath === APPROVAL_FILE) return "approval";
  if ((EDITABLE_FILES as readonly string[]).includes(relPath)) return "editable";
  if ((GENERATED_FILES as readonly string[]).includes(relPath)) return "generated";
  if (GENERATED_NAME_PATTERNS.some((re) => re.test(relPath))) return "generated";
  const top = relPath.split("/")[0];
  if (GENERATED_DIRS.includes(top)) return "generated";
  return "other";
}

/** 中間生成物のうち「再生成が重い/容量を食うキャッシュ」の固定名。--cache-only が
 * 消す対象の固定ファイル部分(GENERATED_DIRS 配下と cut.<name>.mp4 等のパターンは
 * isGeneratedCache が別途 true 判定する)。ここに載らない generated 固定名
 * (manifest.json / cuts.auto.json / whisper-out.* / *.raw.txt / *.suggested.json 等)は
 * 軽い/再生成が高価なので --cache-only では残す。GENERATED_FILES の部分集合であること。 */
export const GENERATED_CACHE_FILES = [
  "cut.mp4",
  "cut.keeps.json",
  "preview.mp4",
  "proxy.mp4",
  "proxy.key.json",
  "render.key.json",
  "render.props.json",
] as const;

/** relPath が「再生成が重いキャッシュ」かどうか(--cache-only の対象判定)。
 * 前提として generated であること(generated 以外は常に false=belt)。判定:
 * 1) generated ディレクトリ配下(frames/ render.chunks/ shorts/ *.probe/)は全て cache
 * 2) ショート名可変の描画キャッシュ(cut.<name>.mp4 / .keeps.json / render.<name>.{props,key}.json)は cache
 * 3) 固定名は GENERATED_CACHE_FILES に載るものだけ cache */
export function isGeneratedCache(relPath: string): boolean {
  if (fileRole(relPath) !== "generated") return false;
  const top = relPath.split("/")[0];
  if (GENERATED_DIRS.includes(top)) return true;
  if (GENERATED_NAME_PATTERNS.some((re) => re.test(relPath))) return true;
  return (GENERATED_CACHE_FILES as readonly string[]).includes(relPath);
}

/** 中間生成物のうち「ログ・使い捨て下書き・検品結果」= 消してもレンダー/エディタ/
 * proxy の動作に影響せず、かつ再生成が安価(LLM/whisper/ffprobe の重い再実行を
 * 伴わない)なものの固定名。--logs-only が消す対象。ここに載らない generated は
 * 意図的に残す: whisper-out.* / transcript.system.json / *.probe/(再生成が高価)、
 * manifest.json(エディタ起動・render の必須入力)、cut.mp4 / render.* / proxy.*
 * (リレンダー最適化・proxy)、shorts/(成果物)。GENERATED_FILES の部分集合であること。 */
export const GENERATED_LOG_FILES = [
  "cuts.auto.json",
  "plan.raw.txt",
  "plan.loop.json",
  "plan-shorts.raw.txt",
  "plan-materials.raw.txt",
  "plan-effects.raw.txt",
  "plan-bgm.raw.txt",
  "material-fit.suggested.json",
  "effect-fix.suggested.json",
  "bgm-fit.suggested.json",
  "hyperframe-place.suggested.json",
  "effect-check.json",
  "bgm-fit.json",
  "style-check.json",
  "render.report.json",
  "preview.mp4",
] as const;

/** --logs-only が消す generated ディレクトリ(配下丸ごと)。frames/ は撮影のたびに
 * 全消し・再撮影される自己確認 still なのでログ同然。他の *.probe/ や
 * render.chunks/ 等は残す(高価キャッシュ or リレンダー最適化)。 */
const GENERATED_LOG_DIRS: readonly string[] = ["frames"];

/** relPath が「ログ・使い捨て下書き」かどうか(--logs-only の対象判定)。
 * 前提として generated であること(generated 以外は常に false=belt)。判定:
 * 1) frames/ 配下は全て log 2) 固定名は GENERATED_LOG_FILES に載るものだけ log。
 * ショート名可変のパターン(cut.<name>.mp4 等)は log ではない(リレンダー最適化)。 */
export function isGeneratedLog(relPath: string): boolean {
  if (fileRole(relPath) !== "generated") return false;
  const top = relPath.split("/")[0];
  if (GENERATED_LOG_DIRS.includes(top)) return true;
  return (GENERATED_LOG_FILES as readonly string[]).includes(relPath);
}
