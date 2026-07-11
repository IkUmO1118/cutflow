import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_OCR_LANGUAGES } from "./ocr.ts";
import type { Region } from "../types.ts";
import { normalizeBaseUrl, originOfProfile, resolveCredential } from "./ai/http.ts";

export type AiProvider = "claude-code" | "codex" | "anthropic" | "openai";
export type LegacyLlmBackend = "claude-cli" | "api";
export type AiProfileName = string;
export type AiAdapterKind = AiProvider | "openai-compatible";
export type AiRoute = "text" | "structured" | "vision";

export interface LegacyAiConfig {
  /** 生成 AI の入口。agent と one-shot の違いは provider 側の既定で吸収する */
  provider: AiProvider;
  /** "auto" または省略で provider の既定。API provider は明示 model を推奨 */
  model?: string;
}

export interface AiProfileConfig {
  adapter: AiAdapterKind;
  model?: string;
  protocol?: "chat-completions" | "responses";
  baseUrl?: string;
  auth?: AiAuthConfig;
  capabilities?: AiCapabilitiesConfig;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
}

export type AiAuthConfig =
  | { type: "none" }
  | { type: "bearer"; apiKeyEnv: string }
  | { type: "x-api-key"; apiKeyEnv: string };

export interface AiCapabilitiesConfig {
  structuredOutput?: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput?: boolean;
  maxImages?: number;
}

export interface AiRoutesConfig {
  text: string;
  structured: string;
  vision?: string;
}

export interface RoutedAiConfig {
  profiles: Record<string, AiProfileConfig>;
  routes: AiRoutesConfig;
  defaults?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxResponseBytes?: number;
  };
}

export type AiConfig = LegacyAiConfig | RoutedAiConfig;

export interface AiCapabilities {
  textInput: true;
  textOutput: true;
  structuredOutput: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput: boolean;
  maxImages: number;
}

export interface ResolvedAiProfile {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  protocol: "cli" | "responses" | "messages" | "chat-completions";
  baseUrl?: string;
  auth: AiAuthConfig;
  capabilities: AiCapabilities;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
}

export interface ResolvedAiConfig {
  profiles: ReadonlyMap<string, ResolvedAiProfile>;
  routes: {
    text: string;
    structured: string;
    vision?: string;
  };
  source: "routed" | "legacy-ai" | "legacy-llm" | "default";
}

export interface AiProfileStatus {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  credential: "not-required" | "present" | "missing";
  capabilities: AiCapabilities;
}

let repoEnvLoadedForStatus = false;

function loadRepoEnvForStatus(): void {
  if (repoEnvLoadedForStatus) return;
  repoEnvLoadedForStatus = true;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    process.loadEnvFile?.(join(repoRoot, ".env"));
  } catch {
    // .env is optional. Status falls back to inherited process env.
  }
}

export interface Config {
  recordingsDir: string;
  ingest: {
    screenRegion: Region;
    cameraRegion: Region;
    micTrack: number;
    systemTrack: number;
    /** 収録レイアウトの既定。省略時 "plain"。
     *  auto = 寸法/縦横比から OBS 拡張キャンバスらしければ obs-canvas、それ以外は plain */
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
  /** AI 設定の新しい入口。省略時は llm(旧設定)から解決し、両方無ければ claude-code */
  ai?: AiConfig;
  /** 旧 LLM 設定。互換のため読み続けるが、新規設定は ai.provider を使う */
  llm?: { backend: LegacyLlmBackend; model: string };
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
    /** カット判断の積極度。safe=現状とバイト等価 / balanced=既定(明確な冗長は切る) /
     *  aggressive=テンポ最優先。省略時 balanced(D4)。rules/brief のマーカー行が優先。
     *  §docs/plans/2026-07-11-x4-editing-aggressiveness-design.md */
    editMode?: "safe" | "balanced" | "aggressive";
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
    /** plan --cuts-only のカット判断を「生成→観測→再調整」の有限反復にする
     * opt-in 設定。省略時は maxIterations=0 と同義で、従来の1ショットと
     * バイト等価。maxIterations >= 2 のときだけループする */
    loop?: {
      /** 最大反復回数。0 または 1 は従来どおり1ショット */
      maxIterations?: number;
      /** 目標出力尺(秒)。指定時は outDuration <= 値を内部アサーションに足す */
      targetOutDurationSec?: number | null;
      /** assertions.json + 目標尺が fail/error なしになったら停止する */
      stopWhenAssertionsPass?: boolean;
      secondaryObservation?: {
        enabled?: boolean;
        maxCalls?: number;
        maxImages?: number;
      };
    };
  };
  /** plan の候補格子を語タイムスタンプ(transcript.words)由来の語境界でも
   *  分割する(C1)+ 候補テキストを実際に残る語だけにする(C8)。省略可
   *  (古い config.yaml との互換。省略時 enabled=false=バイト等価)。
   *  §docs/plans/2026-07-11-c1-word-candidate-grid-design.md */
  candidates?: {
    /** 細分化+語ベーステキストの有効化。省略時 false */
    enabled?: boolean;
    /** これ以上長い keep だけを分割対象にする(秒)。省略時
     *  DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC(6) */
    splitOnlyLongerThanSec?: number;
    /** 語間ギャップがこの秒以上なら分割点候補にする。省略時
     *  DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC(0.3) */
    minSplitGapSec?: number;
    /** 分割後の各 sub-candidate の最小尺(秒)。省略時
     *  DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC(0.5) */
    minCandidateSec?: number;
    /** フィラー語(単独の候補として切り出せるようにする)。省略時
     *  DEFAULT_CANDIDATES_FILLERS */
    fillers?: string[];
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
    aiReview?: {
      /** before/after still を外部APIへ送る明示的opt-in。既定false */
      vlm?: boolean;
      /** APIへ送る画像枚数。1-4、既定4 */
      maxImages?: number;
      /** GUI refine の上限。既定2、最大3 */
      maxRefinements?: number;
    };
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
  av?: {
    everySec?: number;
    cols?: number;
    windowSec?: number;
    scdetThreshold?: number;
    freeze?: {
      noiseDb?: number;
      durationSec?: number;
    };
    stripWidthPx?: number;
  };
}

/** editor.defaultImageDurationSec 未指定時の既定(秒) */
export const DEFAULT_IMAGE_DURATION_SEC = 4;

/** editor.defaultShortRangeSec 未指定時の既定(秒) */
export const DEFAULT_SHORT_RANGE_SEC = 10;
export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_AI_MAX_RETRIES = 1;
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 8192;
export const MAX_AI_IMAGES = 4;
const LEGACY_AI_PROFILE = "legacy-default";

export function resolveAiReviewCfg(cfg: Config): { vlm: boolean; maxImages: number } {
  const requested = cfg.editor?.aiReview?.maxImages ?? 4;
  return {
    vlm: cfg.editor?.aiReview?.vlm ?? false,
    maxImages: Math.max(1, Math.min(MAX_AI_IMAGES, Math.trunc(requested))),
  };
}

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

/** candidates.* 未指定時の既定値。§docs/plans/2026-07-11-c1-word-candidate-grid-design.md */
export const DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC = 6;
export const DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC = 0.3;
export const DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC = 0.5;
export const DEFAULT_CANDIDATES_FILLERS = [
  "えー",
  "えっと",
  "あの",
  "あのー",
  "まあ",
  "その",
  "なんか",
];

/** candidates を既定値で解決する純関数(省略時 enabled=false=バイト等価)。
 *  loadConfig は cfg.candidates を書き換えない */
export function resolveCandidatesCfg(cfg: Config): {
  enabled: boolean;
  splitOnlyLongerThanSec: number;
  minSplitGapSec: number;
  minCandidateSec: number;
  fillers: string[];
} {
  const c = cfg.candidates ?? {};
  return {
    enabled: c.enabled ?? false,
    splitOnlyLongerThanSec: c.splitOnlyLongerThanSec ?? DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC,
    minSplitGapSec: c.minSplitGapSec ?? DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC,
    minCandidateSec: c.minCandidateSec ?? DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC,
    fillers: c.fillers ?? [...DEFAULT_CANDIDATES_FILLERS],
  };
}

/** plan.loop.maxIterations 未指定時の既定。0 は従来1ショットと同義 */
export const DEFAULT_PLAN_LOOP_MAX_ITERATIONS = 0;
export const DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS = 1;
export const DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES = 2;

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

export interface PerceptionStatus {
  explicit: boolean;
  audio: boolean;
  ocr: boolean;
  systemSpeech: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  warnings: string[];
}

export function resolvePerceptionStatus(cfg: Config): PerceptionStatus {
  const pc = resolvePerceptionCfg(cfg);
  const explicit = cfg.plan?.perception !== undefined;
  const warnings: string[] = [];
  if (!explicit) {
    warnings.push(
      "plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech)は全てオフです。",
    );
  }
  return { explicit, ...pc, warnings };
}

export function formatPerceptionStatusLines(status: PerceptionStatus): string[] {
  return [
    ...status.warnings.map((w) => `警告: ${w}`),
    `plan 知覚: audio=${status.audio ? "on" : "off"} / ` +
      `ocr=${
        status.ocr
          ? `on(max ${status.ocrMaxSegments} segments, ${status.ocrMaxLines} lines)`
          : "off"
      } / ` +
      `systemSpeech=${status.systemSpeech ? "on" : "off"}`,
  ];
}

/** plan.loop を既定値で解決する純関数。loadConfig は cfg.plan.loop を生成しない
 * (省略=従来挙動を守るため)ので、利用側は必ずこの関数を通す */
export function resolvePlanLoopCfg(cfg: Config): {
  maxIterations: number;
  targetOutDurationSec: number | null;
  stopWhenAssertionsPass: boolean;
} {
  const l = cfg.plan?.loop ?? {};
  return {
    maxIterations: l.maxIterations ?? DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
    targetOutDurationSec: l.targetOutDurationSec ?? null,
    stopWhenAssertionsPass: l.stopWhenAssertionsPass ?? true,
  };
}

export function resolvePlanLoopSecondaryObservationCfg(cfg: Config): {
  enabled: boolean;
  maxCalls: number;
  maxImages: number;
} {
  const s = cfg.plan?.loop?.secondaryObservation ?? {};
  return {
    enabled: s.enabled ?? false,
    maxCalls: s.maxCalls ?? DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS,
    maxImages: s.maxImages ?? DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES,
  };
}

export function planLoopEnabled(cfg: Config): boolean {
  return resolvePlanLoopCfg(cfg).maxIterations >= 2;
}

function validateWorkflowConfig(cfg: Config): string[] {
  const errors: string[] = [];
  const editorAiReview = cfg.editor?.aiReview as Record<string, unknown> | undefined;
  if (editorAiReview) {
    errors.push(...unknownKeys(editorAiReview, ["vlm", "maxImages", "maxRefinements"]).map((key) => `editor.aiReview.${key} は未対応です`));
    if ("vlm" in editorAiReview && typeof editorAiReview.vlm !== "boolean") {
      errors.push("editor.aiReview.vlm は boolean で指定してください");
    }
    if ("maxImages" in editorAiReview) {
      const value = editorAiReview.maxImages;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4) {
        errors.push("editor.aiReview.maxImages は 1..4 の整数で指定してください");
      }
    }
    if ("maxRefinements" in editorAiReview) {
      const value = editorAiReview.maxRefinements;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) {
        errors.push("editor.aiReview.maxRefinements は 1..3 の整数で指定してください");
      }
    }
  }
  const planLoop = cfg.plan?.loop as Record<string, unknown> | undefined;
  if (planLoop) {
    errors.push(...unknownKeys(planLoop, ["maxIterations", "targetOutDurationSec", "stopWhenAssertionsPass", "secondaryObservation"]).map((key) => `plan.loop.${key} は未対応です`));
    const secondary = planLoop.secondaryObservation as Record<string, unknown> | undefined;
    if (secondary) {
      errors.push(...unknownKeys(secondary, ["enabled", "maxCalls", "maxImages"]).map((key) => `plan.loop.secondaryObservation.${key} は未対応です`));
      if ("enabled" in secondary && typeof secondary.enabled !== "boolean") {
        errors.push("plan.loop.secondaryObservation.enabled は boolean で指定してください");
      }
      if ("maxCalls" in secondary) {
        const value = secondary.maxCalls;
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2) {
          errors.push("plan.loop.secondaryObservation.maxCalls は 0..2 の整数で指定してください");
        }
      }
      if ("maxImages" in secondary) {
        const value = secondary.maxImages;
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2) {
          errors.push("plan.loop.secondaryObservation.maxImages は 1..2 の整数で指定してください");
        }
      }
    }
  }
  return errors;
}

/** describe.pauseMax 未指定時の既定(1keepあたりの件数) */
export const DEFAULT_DESCRIBE_PAUSE_MAX = 3;

/** describe.pauseMinSec 未指定時の既定(秒) */
export const DEFAULT_DESCRIBE_PAUSE_MIN_SEC = 0.6;

export const DEFAULT_AV_EVERY_SEC = 5;
export const DEFAULT_AV_COLS = 5;
export const DEFAULT_AV_WINDOW_SEC = 1;
export const DEFAULT_AV_SCDET_THRESHOLD = 8;
export const DEFAULT_AV_FREEZE_NOISE_DB = -50;
export const DEFAULT_AV_FREEZE_DURATION_SEC = 1;
export const DEFAULT_AV_STRIP_WIDTH_PX = 320;

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

export function resolveAvCfg(cfg: Config): {
  everySec: number;
  cols: number;
  windowSec: number;
  scdetThreshold: number;
  freeze: { noiseDb: number; durationSec: number };
  stripWidthPx: number;
} {
  const av = cfg.av ?? {};
  return {
    everySec: av.everySec ?? DEFAULT_AV_EVERY_SEC,
    cols: av.cols ?? DEFAULT_AV_COLS,
    windowSec: av.windowSec ?? DEFAULT_AV_WINDOW_SEC,
    scdetThreshold: av.scdetThreshold ?? DEFAULT_AV_SCDET_THRESHOLD,
    freeze: {
      noiseDb: av.freeze?.noiseDb ?? DEFAULT_AV_FREEZE_NOISE_DB,
      durationSec: av.freeze?.durationSec ?? DEFAULT_AV_FREEZE_DURATION_SEC,
    },
    stripWidthPx: av.stripWidthPx ?? DEFAULT_AV_STRIP_WIDTH_PX,
  };
}

function isLegacyAiConfig(value: AiConfig | undefined): value is LegacyAiConfig {
  return !!value && "provider" in value;
}

function defaultAuthForAdapter(adapter: AiAdapterKind): AiAuthConfig {
  if (adapter === "openai") return { type: "bearer", apiKeyEnv: "OPENAI_API_KEY" };
  if (adapter === "anthropic") return { type: "x-api-key", apiKeyEnv: "ANTHROPIC_API_KEY" };
  return { type: "none" };
}

function defaultProtocolForAdapter(adapter: AiAdapterKind, protocol?: string): ResolvedAiProfile["protocol"] {
  if (adapter === "claude-code" || adapter === "codex") return "cli";
  if (adapter === "anthropic") return "messages";
  if (adapter === "openai") return "responses";
  if (protocol === "responses") return "responses";
  return "chat-completions";
}

function defaultCapabilitiesForAdapter(adapter: AiAdapterKind): AiCapabilities {
  if (adapter === "claude-code") {
    return { textInput: true, textOutput: true, structuredOutput: "native-json-schema", imageInput: false, maxImages: 0 };
  }
  if (adapter === "codex") {
    return { textInput: true, textOutput: true, structuredOutput: "prompt", imageInput: false, maxImages: 0 };
  }
  if (adapter === "openai") {
    return {
      textInput: true,
      textOutput: true,
      structuredOutput: "native-json-schema",
      imageInput: true,
      maxImages: MAX_AI_IMAGES,
    };
  }
  if (adapter === "anthropic") {
    return {
      textInput: true,
      textOutput: true,
      structuredOutput: "native-json-schema",
      imageInput: true,
      maxImages: MAX_AI_IMAGES,
    };
  }
  return {
    textInput: true,
    textOutput: true,
    structuredOutput: "none",
    imageInput: false,
    maxImages: 0,
  };
}

function validateAiProfileName(name: string): void {
  if (name === LEGACY_AI_PROFILE) throw new Error(`AI profile名 "${LEGACY_AI_PROFILE}" は予約済みです`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(`AI profile名 "${name}" は不正です`);
  }
}

function requireRouteProfile(
  profiles: ReadonlyMap<string, ResolvedAiProfile>,
  route: string,
  profileName: string,
): string {
  if (!profiles.has(profileName)) {
    throw new Error(`AI route "${route}" は未知のprofile "${profileName}" を参照しています`);
  }
  return profileName;
}

function resolveProfile(
  name: string,
  profile: AiProfileConfig,
  defaults?: RoutedAiConfig["defaults"],
): ResolvedAiProfile {
  const baseCaps = defaultCapabilitiesForAdapter(profile.adapter);
  const structuredOutput = profile.capabilities?.structuredOutput ?? baseCaps.structuredOutput;
  const imageInput = profile.capabilities?.imageInput ?? baseCaps.imageInput;
  const maxImages = imageInput ? Math.max(1, Math.min(profile.capabilities?.maxImages ?? baseCaps.maxImages, MAX_AI_IMAGES)) : 0;
  if (profile.adapter === "openai-compatible") {
    if (!profile.baseUrl) throw new Error(`AI profile "${name}" は baseUrl が必要です`);
    if (!profile.protocol) throw new Error(`AI profile "${name}" は protocol が必要です`);
    if (profile.capabilities?.structuredOutput === undefined) {
      throw new Error(`AI profile "${name}" は capabilities.structuredOutput が必要です`);
    }
    if (profile.capabilities?.imageInput === undefined) {
      throw new Error(`AI profile "${name}" は capabilities.imageInput が必要です`);
    }
  }
  return {
    name,
    adapter: profile.adapter,
    model: profile.model ?? "auto",
    protocol: defaultProtocolForAdapter(profile.adapter, profile.protocol),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl.replace(/\/+$/, "") } : {}),
    auth: profile.auth ?? defaultAuthForAdapter(profile.adapter),
    capabilities: {
      textInput: true,
      textOutput: true,
      structuredOutput,
      imageInput,
      maxImages,
    },
    timeoutMs: Math.max(1_000, Math.min(profile.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS, 300_000)),
    maxRetries: Math.max(0, Math.min(profile.maxRetries ?? defaults?.maxRetries ?? DEFAULT_AI_MAX_RETRIES, 2)),
    maxOutputTokens: Math.max(64, Math.min(profile.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS, 131_072)),
    maxResponseBytes: Math.max(1024, Math.min(profile.maxResponseBytes ?? defaults?.maxResponseBytes ?? DEFAULT_AI_MAX_RESPONSE_BYTES, 8 * 1024 * 1024)),
  };
}

function legacyRuntime(provider: AiProvider, model: string, source: ResolvedAiConfig["source"]): ResolvedAiConfig {
  const profile: ResolvedAiProfile = {
    name: LEGACY_AI_PROFILE,
    adapter: provider,
    model,
    protocol: defaultProtocolForAdapter(provider),
    auth: defaultAuthForAdapter(provider),
    capabilities: defaultCapabilitiesForAdapter(provider),
    timeoutMs: DEFAULT_AI_TIMEOUT_MS,
    maxRetries: DEFAULT_AI_MAX_RETRIES,
    maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
    maxResponseBytes: DEFAULT_AI_MAX_RESPONSE_BYTES,
  };
  return {
    profiles: new Map([[LEGACY_AI_PROFILE, profile]]),
    routes: {
      text: LEGACY_AI_PROFILE,
      structured: LEGACY_AI_PROFILE,
      ...(provider === "openai" || provider === "anthropic" ? { vision: LEGACY_AI_PROFILE } : {}),
    },
    source,
  };
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function validateAiConfig(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["ai は object である必要があります"];
  const ai = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("provider" in ai && "profiles" in ai) errors.push("ai.provider と ai.profiles は併記できません");
  const topUnknown = unknownKeys(ai, ["provider", "model", "profiles", "routes", "defaults"]);
  errors.push(...topUnknown.map((key) => `ai.${key} は未対応です`));
  for (const key of ["apiKey", "token", "authorization", "headers"]) {
    if (key in ai) errors.push(`ai.${key} は使えません`);
  }
  if ("provider" in ai) {
    if (!["claude-code", "codex", "anthropic", "openai"].includes(String(ai.provider))) {
      errors.push(`ai.provider が不正です: ${String(ai.provider)}`);
    }
    return errors;
  }
  if ("profiles" in ai) {
    const profiles = ai.profiles;
    const routes = ai.routes;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) errors.push("ai.profiles は object である必要があります");
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) errors.push("ai.routes は object である必要があります");
    if (errors.length > 0) return errors;
    const profileEntries = Object.entries(profiles as Record<string, unknown>);
    if (profileEntries.length > 16) errors.push("AI profile は最大16件です");
    for (const [name, rawProfile] of profileEntries) {
      if (name === LEGACY_AI_PROFILE || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) errors.push(`AI profile名 "${name}" は不正です`);
      if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        errors.push(`AI profile "${name}" は object である必要があります`);
        continue;
      }
      const profile = rawProfile as Record<string, unknown>;
      errors.push(...unknownKeys(profile, [
        "adapter", "model", "protocol", "baseUrl", "auth", "capabilities",
        "timeoutMs", "maxRetries", "maxOutputTokens", "maxResponseBytes",
      ]).map((key) => `ai.profiles.${name}.${key} は未対応です`));
      for (const key of ["apiKey", "token", "authorization", "headers"]) {
        if (key in profile) errors.push(`ai.profiles.${name}.${key} は使えません`);
      }
      const adapter = String(profile.adapter ?? "");
      if (!["claude-code", "codex", "anthropic", "openai", "openai-compatible"].includes(adapter)) {
        errors.push(`AI profile "${name}" の adapter が不正です`);
      }
      if (adapter === "openai-compatible") {
        if (typeof profile.baseUrl !== "string" || profile.baseUrl.length === 0) errors.push(`AI profile "${name}" は baseUrl が必要です`);
        else {
          try {
            normalizeBaseUrl(profile.baseUrl);
          } catch (error) {
            errors.push(`AI profile "${name}" の baseUrl が不正です: ${(error as Error).message}`);
          }
        }
        if (profile.protocol !== "chat-completions" && profile.protocol !== "responses") {
          errors.push(`AI profile "${name}" は protocol が必要です`);
        }
        if (!profile.model) errors.push(`AI profile "${name}" は model が必要です`);
        if (!(profile.capabilities && typeof profile.capabilities === "object")) {
          errors.push(`AI profile "${name}" は capabilities が必要です`);
        } else {
          const caps = profile.capabilities as Record<string, unknown>;
          if (!["native-json-schema", "json-object", "prompt", "none"].includes(String(caps.structuredOutput ?? ""))) {
            errors.push(`AI profile "${name}" は capabilities.structuredOutput が必要です`);
          }
          if (typeof caps.imageInput !== "boolean") errors.push(`AI profile "${name}" は capabilities.imageInput が必要です`);
        }
      }
      if ((adapter === "openai" || adapter === "anthropic") && "baseUrl" in profile) {
        errors.push(`AI profile "${name}" では baseUrl を指定できません`);
      }
      if ((adapter === "claude-code" || adapter === "codex") && ("baseUrl" in profile || "auth" in profile)) {
        errors.push(`AI profile "${name}" の CLI adapter では baseUrl/auth を指定できません`);
      }
      if (profile.auth !== undefined) {
        if (!profile.auth || typeof profile.auth !== "object" || Array.isArray(profile.auth)) {
          errors.push(`AI profile "${name}" の auth は object である必要があります`);
        } else {
          const auth = profile.auth as Record<string, unknown>;
          errors.push(...unknownKeys(auth, ["type", "apiKeyEnv"]).map((key) => `ai.profiles.${name}.auth.${key} は未対応です`));
          if (!["none", "bearer", "x-api-key"].includes(String(auth.type ?? ""))) errors.push(`AI profile "${name}" の auth.type が不正です`);
          if (auth.type === "none" && "apiKeyEnv" in auth) errors.push(`AI profile "${name}" の auth.type=none に apiKeyEnv は指定できません`);
          if ((auth.type === "bearer" || auth.type === "x-api-key") && typeof auth.apiKeyEnv !== "string") {
            errors.push(`AI profile "${name}" の auth.apiKeyEnv が必要です`);
          }
        }
      }
      if (profile.capabilities !== undefined) {
        if (!profile.capabilities || typeof profile.capabilities !== "object" || Array.isArray(profile.capabilities)) {
          errors.push(`AI profile "${name}" の capabilities は object である必要があります`);
        } else {
          const caps = profile.capabilities as Record<string, unknown>;
          errors.push(...unknownKeys(caps, ["structuredOutput", "imageInput", "maxImages"]).map((key) => `ai.profiles.${name}.capabilities.${key} は未対応です`));
          if (caps.maxImages !== undefined && ![1, 2, 3, 4].includes(Number(caps.maxImages))) {
            errors.push(`AI profile "${name}" の capabilities.maxImages が不正です`);
          }
        }
      }
    }
    const routeObj = routes as Record<string, unknown>;
    const routeUnknown = unknownKeys(routeObj, ["text", "structured", "vision"]);
    errors.push(...routeUnknown.map((key) => `ai.routes.${key} は未対応です`));
    if (typeof routeObj.text !== "string") errors.push("ai.routes.text が必要です");
    if (typeof routeObj.structured !== "string") errors.push("ai.routes.structured が必要です");
    for (const route of ["text", "structured", "vision"] as const) {
      const value = routeObj[route];
      if (value !== undefined && typeof value === "string" && !(profiles as Record<string, unknown>)[value]) {
        errors.push(`AI route "${route}" は未知のprofile "${value}" を参照しています`);
      }
    }
  }
  return errors;
}

export function aiProfileStatuses(cfg: Config): AiProfileStatus[] {
  loadRepoEnvForStatus();
  const runtime = resolveAiRuntimeConfig(cfg);
  return [...runtime.profiles.values()].map((profile) => ({
    name: profile.name,
    adapter: profile.adapter,
    model: profile.model,
    origin: originOfProfile(profile),
    credential:
      profile.auth.type === "none"
        ? "not-required"
        : resolveCredential(profile.auth, process.env)
          ? "present"
          : "missing",
    capabilities: profile.capabilities,
  }));
}

export function resolveAiRuntimeConfig(cfg: Config): ResolvedAiConfig {
  if (cfg.ai && "provider" in cfg.ai && "profiles" in cfg.ai) {
    throw new Error("ai.provider と ai.profiles は併記できません");
  }
  if (isLegacyAiConfig(cfg.ai)) {
    return legacyRuntime(cfg.ai.provider, cfg.ai.model ?? "auto", "legacy-ai");
  }
  if (cfg.ai?.profiles) {
    const names = Object.keys(cfg.ai.profiles);
    if (names.length > 16) throw new Error("AI profile は最大16件です");
    const profiles = new Map<string, ResolvedAiProfile>();
    for (const name of names) {
      validateAiProfileName(name);
      profiles.set(name, resolveProfile(name, cfg.ai.profiles[name], cfg.ai.defaults));
    }
    return {
      profiles,
      routes: {
        text: requireRouteProfile(profiles, "text", cfg.ai.routes.text),
        structured: requireRouteProfile(profiles, "structured", cfg.ai.routes.structured),
        ...(cfg.ai.routes.vision ? { vision: requireRouteProfile(profiles, "vision", cfg.ai.routes.vision) } : {}),
      },
      source: "routed",
    };
  }
  if (cfg.llm?.backend === "claude-cli") {
    return legacyRuntime("claude-code", cfg.llm.model || "auto", "legacy-llm");
  }
  if (cfg.llm?.backend === "api") {
    return legacyRuntime("anthropic", cfg.llm.model || "auto", "legacy-llm");
  }
  return legacyRuntime("claude-code", "auto", "default");
}

export function profileForRoute(runtime: ResolvedAiConfig, route: AiRoute): ResolvedAiProfile {
  const profileName = runtime.routes[route];
  if (!profileName) throw new Error(`AI route "${route}" は未設定です`);
  const profile = runtime.profiles.get(profileName);
  if (!profile) throw new Error(`AI route "${route}" のprofile "${profileName}" が見つかりません`);
  return profile;
}

export function aiCapabilities(cfg: Config, route: AiRoute): AiCapabilities | null {
  const runtime = resolveAiRuntimeConfig(cfg);
  const profileName = runtime.routes[route];
  if (!profileName) return null;
  return runtime.profiles.get(profileName)?.capabilities ?? null;
}

export function resolveAiCfg(cfg: Config): Required<LegacyAiConfig> {
  const runtime = resolveAiRuntimeConfig(cfg);
  const profile = profileForRoute(runtime, "text");
  return { provider: profile.adapter === "openai-compatible" ? "openai" : profile.adapter, model: profile.model };
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
  const aiErrors = validateAiConfig(cfg.ai);
  if (aiErrors.length > 0) {
    throw new Error(`AI config error:\n- ${aiErrors.join("\n- ")}`);
  }
  const workflowErrors = validateWorkflowConfig(cfg);
  if (workflowErrors.length > 0) {
    throw new Error(`Workflow config error:\n- ${workflowErrors.join("\n- ")}`);
  }
  cfg.recordingsDir = expandHome(cfg.recordingsDir);
  cfg.whisper.model = expandHome(cfg.whisper.model);
  cfg.whisper.wordTimestamps ??= true;
  cfg.whisper.systemAudio ??= false;
  cfg.ocr ??= {};
  cfg.ocr.languages ??= [...DEFAULT_OCR_LANGUAGES];
  return cfg;
}
