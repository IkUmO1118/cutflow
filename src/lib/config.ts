import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_OCR_LANGUAGES } from "./ocr.ts";
import type { Region } from "../types.ts";

export interface Config {
  recordingsDir: string;
  ingest: {
    screenRegion: Region;
    cameraRegion: Region;
    micTrack: number;
    systemTrack: number;
    /** 収録レイアウトの既定。省略時 "obs-canvas"(旧 config 互換)。
     *  auto = キャンバス寸法(W×H)が完全一致なら obs-canvas、それ以外は plain */
    layout?: "obs-canvas" | "plain" | "auto";
  };
  whisper: {
    bin: string;
    model: string;
    language: string;
    /** 語/トークン単位のタイミング(WordTiming)を transcript.json に付加するか。
     * 省略時 false(既存挙動と完全一致・words を一切書かない)。true で
     * whisper 実行を -ojf に切り替え、各 segment に words[] を付加する */
    wordTimestamps?: boolean;
    /** システム音声(ingest.systemTrack)も第2トラックとして文字起こしし、
     *  知覚専用の transcript.system.json を書くか。省略時 false(既存挙動と
     *  完全一致=system.wav も transcript.system.json も作らず manifest も不変)。
     *  render.systemAudio.mix(=出力に音を混ぜる)とは別軸で、こちらは
     *  「AI がその音を読めるようにする」= 描画はしない知覚専用。
     *  収録に systemStream が無ければ true でも自動で無視される */
    systemAudio?: boolean;
  };
  detect: {
    silenceDb: number;
    minSilenceSec: number;
    padSec: number;
    minKeepSec: number;
  };
  llm: { backend: "claude-cli" | "api"; model: string };
  /** ショート LLM ハイライト自動選定(plan-shorts)の設定。省略可
   * (古い config.yaml との互換。省略時は既定値を使う) */
  planShorts?: {
    /** 1本のショートの尺の上限(秒)。plan-shorts が LLM の選定した区間集合の
     * 尺合計をこの値以下に収める(超過は末尾区間を落とす)。
     * 省略時 DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC(60) */
    maxDurationSec?: number;
  };
  /** カット判断 LLM(plan / plan --cuts-only / remeta)へ発話テキスト以外の
   * 知覚を添える設定。省略可(古い config.yaml との互換。省略時は全項目オフ=
   * plan の LLM 入力・plan.raw.txt が現状とバイト等価)。plan-shorts は対象外。
   * §docs/plans/2026-07-07-plan-eyes-ears-design.md */
  plan?: {
    perception?: {
      /** 無音・間の注記(区間長 / 直前に落ちた素材秒 / 区間内無音秒)を
       *  プロンプトに添える。省略時 false。決定論・追加依存なし(推奨の opt-in) */
      audio?: boolean;
      /** 各区間の代表フレームの画面 OCR テキストをプロンプトに添える。
       *  省略時 false。macOS + Apple Vision が必要(無い環境は自動で劣化=
       *  OCR 部分を省いて続行)。区間数ぶんの ffmpeg クロップ+Vision が走る */
      ocr?: boolean;
      /** OCR をかける区間数の上限(コスト制御)。省略時
       *  DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS(40)。区間数がこれを超える場合は
       *  尺の長い区間を優先して上限まで */
      ocrMaxSegments?: number;
      /** 1区間あたりプロンプトに載せる OCR 行数の上限。省略時
       *  DEFAULT_PERCEPTION_OCR_MAX_LINES(6) */
      ocrMaxLines?: number;
      /** システム音声の発話(transcript.system.json)のうち各区間に重なるものを
       *  plan の知覚ブロックに添える。省略時 false。transcript.system.json が
       *  無ければ(= whisper.systemAudio 未使用)自動で劣化=ブロック省略 */
      systemSpeech?: boolean;
    };
  };
  /** describe(操作エージェント向け)の任意露出。省略可・全オフが既定。
   *  無いときは散文・--json ともに導入前とバイト等価 */
  describe?: {
    /** keep 内に残った無音(間)の「位置と長さ」を describe に出す。省略時 false。
     *  cuts.auto.json の silences から算出(新規計測なし) */
    pauses?: boolean;
    /** 1区間あたり出す間の件数上限。省略時 DEFAULT_DESCRIBE_PAUSE_MAX(3) */
    pauseMax?: number;
    /** これ以上の長さの間だけ出す(秒)。省略時 DEFAULT_DESCRIBE_PAUSE_MIN_SEC(0.6) */
    pauseMinSec?: number;
  };
  preview: {
    width: number;
    /** proxy.mp4 / preview.mp4 のビデオエンコーダ。省略時 "videotoolbox"
     * (macOS のハードウェアエンコーダ h264_videotoolbox。生成時間はほぼ同等で
     * ファイルサイズが小さい)。"libx264" で従来の ultrafast+CRF に戻せる。
     * 実測は docs/perf.md 参照 */
    videoEncoder?: "libx264" | "videotoolbox";
  };
  /** エディタ(GUI)設定。省略可(古い config.yaml との互換) */
  editor?: {
    /** 素材アップロード(/api/upload)の1ファイルの上限(MB)。省略時は既定値 */
    maxUploadMb?: number;
    /** タイムラインに置く画像素材・尺不明素材の既定の尺(秒)。
     * 省略時は DEFAULT_IMAGE_DURATION_SEC */
    defaultImageDurationSec?: number;
    /** ショート新規追加(addShort)時、選択中の keep クリップも
     * プレイヘッドも無いときの既定レンジ長(秒)。
     * 省略時は DEFAULT_SHORT_RANGE_SEC */
    defaultShortRangeSec?: number;
  };
  render: {
    wipeWidthPx: number;
    wipeMarginPx: number;
    /** ワイプ全画面(wipeFull)の出入りの遷移時間(秒)。
     * 省略時 DEFAULT_WIPE_TRANSITION_SEC。0 で従来どおり瞬時に切り替わる */
    wipeTransitionSec?: number;
    /** カット境界のトランジション。省略時 type: "none"(既存挙動と完全一致・
     * 瞬時に切り替わる)。"dip-to-black" で keep 境界の前後に黒フェードを
     * 被せる(尺不変: cut.mp4 には触れず Remotion 合成層でのオーバーレイ)。
     * sec は黒への往復の合計秒(前半でフェードアウト、後半でフェードイン)。
     * 省略時 DEFAULT_CUT_TRANSITION_SEC(0.3) */
    cutTransition?: {
      type?: "none" | "dip-to-black";
      sec?: number;
    };
    captionFontSizePx: number;
    /** テロップ既定の文字色。省略時 CAPTION_DEFAULT_COLOR(#ffffff) */
    captionColor?: string;
    /** テロップ既定の縁取り色。省略時 CAPTION_DEFAULT_OUTLINE(#2563eb)。
     * "none" で縁取りなし */
    captionOutlineColor?: string;
    /** テロップ既定のフォント種(CSS font-family)。
     * 省略時 CAPTION_DEFAULT_FONT_FAMILY(日本語ゴシック) */
    captionFontFamily?: string;
    /** テロップ既定の太さ(100〜900)。省略時 CAPTION_DEFAULT_FONT_WEIGHT(700) */
    captionFontWeight?: number;
    chapterCardSec: number;
    targetLufs: number;
    /** システム音声(ingest.systemTrack)のミックス設定。
     * 省略時はミックスしない(古い config.yaml との互換) */
    systemAudio?: { mix: boolean; volumeDb: number };
    /** マイク音声のノイズ除去(ffmpeg afftdn)。システム音声はデジタル由来で
     * ノイズが無く劣化するだけなので対象外。省略時 mic: false / noiseFloorDb: -25
     * (古い config.yaml との互換) */
    denoise?: { mic: boolean; noiseFloorDb: number };
    bgm: {
      volumeDb: number;
      fadeOutSec: number;
      /** 発話中に BGM を下げるダッキング。省略か duckDb: 0 で無効 */
      ducking?: { duckDb: number; fadeSec: number };
    };
    /** Remotion 合成段のハードウェアエンコーダ利用。if-possible: 使えれば
     * 使う(macOS は VideoToolbox。使えない環境はソフトウェアへ自動
     * フォールバック)。disable: 常にソフトウェアエンコード(従来動作)。
     * 省略時 "if-possible" */
    hardwareAcceleration?: "if-possible" | "disable";
    /** チャンク単位の差分レンダー(render.chunks/)の目標チャンク長(秒)。
     * 直前フルレンダー以降、映像に効く要素(テロップ・位置・ワイプ等)だけを
     * 変えた再実行で、変わったチャンクだけ再レンダーして連結する。
     * 音声・keeps・全域設定を変えたときは自動でフルレンダーに戻る。
     * 省略・0 で機能オフ(常にフルレンダー。従来どおり render.chunks/ には
     * 一切触れない)。詳細は docs/render-chunk-cache.md */
    chunkSec?: number;
    /** ズーム演出(overlays.json の zooms)の既定設定。省略可 */
    zoom?: {
      /** ズームイン/アウトの遷移秒数。省略時 DEFAULT_ZOOM_EASE_SEC(0.4)。
       * zooms[].easeSec で個別指定があればそちらが優先 */
      easeSec?: number;
    };
  };
  /** 画面 OCR(frames --ocr)。Apple Vision の認識設定のうち、収録の言語構成で
   * 変わりうるものだけを置く(認識レベル・言語補正はコード内の閉じた定数。
   * src/lib/ocr.ts)。省略可(古い config.yaml との互換。frames --ocr を
   * 使わない限り読まれず既存挙動は不変) */
  ocr?: {
    /** 認識言語の優先順(Vision の recognitionLanguages)。
     * 省略時 DEFAULT_OCR_LANGUAGES(["en", "ja"]) */
    languages?: string[];
  };
  /** 常駐フレームサーバ(frames-serve)。省略可(古い config.yaml との互換)。
   * 有効化フラグはここには置かない(opt-in は `frames-serve` の明示起動で
   * 担保する。config はポート番号を変えたいときだけ使う任意の項目) */
  frames?: {
    serve?: {
      /** frames-serve の待受ポート。省略時 DEFAULT_SERVE_PORT(4311)。
       * CLI の --port が指定されていればそちらが優先 */
      port?: number;
    };
  };
}

/** editor.defaultImageDurationSec 未指定時の既定(秒) */
export const DEFAULT_IMAGE_DURATION_SEC = 4;

/** editor.defaultShortRangeSec 未指定時の既定(秒) */
export const DEFAULT_SHORT_RANGE_SEC = 10;

/** planShorts.maxDurationSec 未指定時の既定(秒)。YouTube ショートの上限に合わせる */
export const DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC = 60;

/** plan-shorts の1本あたりの尺上限(秒)を解決する(省略時は既定値) */
export function planShortsMaxSec(cfg: Config): number {
  return cfg.planShorts?.maxDurationSec ?? DEFAULT_PLAN_SHORTS_MAX_DURATION_SEC;
}

/** plan.perception.ocrMaxSegments 未指定時の既定(区間数) */
export const DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS = 40;

/** plan.perception.ocrMaxLines 未指定時の既定(行数) */
export const DEFAULT_PERCEPTION_OCR_MAX_LINES = 6;

/** plan.perception を既定値で解決する純関数(省略時は全オフ)。
 *  loadConfig は cfg.plan を書き換えない(省略=オフ=バイト等価を守る) */
export function resolvePerceptionCfg(cfg: Config): {
  audio: boolean;
  ocr: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  systemSpeech: boolean;
} {
  const p = cfg.plan?.perception ?? {};
  return {
    audio: p.audio ?? false,
    ocr: p.ocr ?? false,
    ocrMaxSegments: p.ocrMaxSegments ?? DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: p.ocrMaxLines ?? DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: p.systemSpeech ?? false,
  };
}

/** describe.pauseMax 未指定時の既定(1keepあたりの件数) */
export const DEFAULT_DESCRIBE_PAUSE_MAX = 3;

/** describe.pauseMinSec 未指定時の既定(秒) */
export const DEFAULT_DESCRIBE_PAUSE_MIN_SEC = 0.6;

/** describe.pauses を既定値で解決する純関数(省略時は全オフ+既定値)。
 *  loadConfig は cfg.describe を書き換えない(省略=オフ=バイト等価を守る) */
export function resolveDescribePausesCfg(cfg: Config): {
  enabled: boolean;
  max: number;
  minSec: number;
} {
  const d = cfg.describe ?? {};
  return {
    enabled: d.pauses ?? false,
    max: d.pauseMax ?? DEFAULT_DESCRIBE_PAUSE_MAX,
    minSec: d.pauseMinSec ?? DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  };
}

/** "~/foo" をホームディレクトリに展開する */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * config.yaml のパスを解決する。探す順序:
 * 1. --config で明示されたパス
 * 2. カレントディレクトリの config.yaml
 * 3. リポジトリ直下の config.yaml(デフォルト設定)
 * 設定の書き戻し(エディタの設定画面)も同じパスへ書くため、読みと書きで
 * この関数を共有する
 */
export function resolveConfigPath(explicitPath?: string): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = explicitPath
    ? [explicitPath]
    : [resolve("config.yaml"), join(repoRoot, "config.yaml")];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `config.yaml が見つかりません(探した場所: ${candidates.join(", ")})`,
  );
}

/** config.yaml を読み込む(パスの解決は resolveConfigPath) */
export function loadConfig(explicitPath?: string): Config {
  const cfg = parse(readFileSync(resolveConfigPath(explicitPath), "utf8")) as Config;
  cfg.recordingsDir = expandHome(cfg.recordingsDir);
  cfg.whisper.model = expandHome(cfg.whisper.model);
  cfg.whisper.wordTimestamps ??= false;
  cfg.whisper.systemAudio ??= false;
  cfg.ocr ??= {};
  cfg.ocr.languages ??= [...DEFAULT_OCR_LANGUAGES];
  return cfg;
}
