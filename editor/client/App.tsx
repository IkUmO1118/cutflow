import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import type { LayoutChangedMeta, PanelImperativeHandle } from "react-resizable-panels";
import { Player } from "@remotion/player";
import type { CallbackListener, PlayerRef } from "@remotion/player";
import { Main } from "../../remotion/Main.tsx";
import { designForPlayer } from "./designAssets.ts";
import {
  buildRenderProps,
  capCountOf,
  normalizeLayerOrder,
  ovCountOf,
} from "../../src/lib/renderProps.ts";
import {
  buildTimeline,
  insertSpans,
  mergeIntervals,
  remapInterval,
  snapToOutput,
  timelineDuration,
  toOutputTime,
  toSourceTime,
} from "../../src/lib/timeline.ts";
import {
  applyProposalResolution,
  applyResolution,
  proposalDiff,
  threeWayDiff,
} from "../../src/lib/docDiff.ts";
import type {
  ProposalDiffResult,
  ProposalResolution,
  ReviewDocs,
  Resolution,
  ThreeWayResult,
} from "../../src/lib/docDiff.ts";
import type { TimelineEntry } from "../../src/lib/timeline.ts";
import { defaultShortProfileName, PROFILES } from "../../src/lib/profile.ts";
import type { Profile } from "../../src/lib/profile.ts";
import {
  DEFAULT_LAYER_ORDER,
  capId,
  capNum,
  captionAnchorOf,
  captionPosOf,
  captionStyleOf,
  captionTrack,
  captionTrackName,
  ovId,
  ovNum,
  overlayTrack,
} from "../../src/types.ts";
import type {
  Annotation,
  Bgm,
  CaptionPos,
  CaptionStyle,
  CutPlan,
  LayerId,
  Overlays,
  Region,
  Short,
  Shorts,
  Transcript,
} from "../../src/types.ts";
import type {
  AiProposeResponse,
  AiRefineMode,
  AiScope,
  AiSelectionContext,
  DraftData,
  HyperframeCard,
  PreviewCutResponse,
  ProjectData,
  SaveRequest,
  ScriptData,
} from "./apiTypes.ts";
import type { ReviewBundle } from "../../src/stages/review.ts";
import type { ReviewFrameRequest } from "../../src/lib/review.ts";
import { reviewSpecOfProposalReview } from "../../src/lib/editorAiReview.ts";
import {
  HYPERFRAME_NAME_RE,
  hyperframeAuthorReadiness,
} from "../../src/lib/hyperframeAuthor.ts";
import { buildReviewEvents, warningSummary } from "../../src/lib/reviewEvents.ts";
import { previewCutKeepSignature } from "../../src/lib/previewCutSignature.ts";
import { AiCommand } from "./AiCommand.tsx";
import { AiVisualReview } from "./AiVisualReview.tsx";
import { ArrowOverlay } from "./ArrowOverlay.tsx";
import type { OverlayArrow } from "./ArrowOverlay.tsx";
import { CaptionOverlay } from "./CaptionOverlay.tsx";
import type { OverlayCaption } from "./CaptionOverlay.tsx";
import { DiffReview } from "./DiffReview.tsx";
import { MaterialOverlay } from "./MaterialOverlay.tsx";
import type { OverlayRect } from "./MaterialOverlay.tsx";
import { Inspector } from "./Inspector.tsx";
import { CaptionsPanel, MaterialsPanel, ScriptPanel, ShortsPanel } from "./Panels.tsx";
import { SettingsModal, buildConfigPatch, patchTouchesProxy } from "./SettingsModal.tsx";
import type { AiSettingsValue, CfgValues } from "./SettingsModal.tsx";
import { Timeline } from "./Timeline.tsx";
import { playhead, usePlayheadSelector } from "./playhead.ts";
import { previewBaseVideoMountKey, previewBaseVideoOf } from "./previewCut.ts";
import {
  usePreviewCutRebake,
  type PreviewCutRebakeState,
} from "./previewCutRebake.ts";
import { useToasts, ToastStack } from "./toasts.tsx";
import { TOAST_TTL_MS } from "./toastReducer.ts";
import { Button } from "./components/ui/button.tsx";
import { restoreDialogFocus } from "./lib/dialogFocus.ts";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { ScrollArea } from "./components/ui/scroll-area.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import {
  ChevronDown,
  Captions,
  Download,
  FileText,
  LibraryBig,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Settings,
  Sparkles,
  Smartphone,
} from "lucide-react";
import {
  SCRIPT_CUT_REASON,
  SHORT_TRACK_DEF,
  buildTracks,
  cutSourceRange,
  fitZoomSpan,
  restoreSourceRange,
} from "./model.ts";
import type {
  AddKind,
  AnnotationPatch,
  AudioTrackId,
  Clip,
  CutMark,
  DragMode,
  Selection,
  TrackId,
} from "./model.ts";
import {
  FullscreenIcon,
  JumpIcon,
  LoopIcon,
  MaximizeIcon,
  PlayPauseIcon,
  StepIcon,
  VolumeIcon,
  VIDEO_EXT_RE,
  deleteDraft,
  deleteHyperframe,
  deleteMaterial,
  fmtTime,
  getMediaFacts,
  getHyperframes,
  getPeaks,
  getProject,
  getScript,
  postAiDoctor,
  postConfig,
  postDraft,
  postAiPropose,
  postAiRefine,
  postAiReview,
  postPreview,
  postPreviewCut,
  postProxy,
  postRender,
  postHyperframeRender,
  postHyperframeAuthor,
  postReveal,
  postSave,
  probeMaterialDuration,
  uploadMaterial,
  ApiError,
} from "./widgets.tsx";
import type { Peaks } from "./widgets.tsx";

type OverlayEntry = NonNullable<Overlays["overlays"]>[number];
type WipeFullEntry = NonNullable<Overlays["wipeFull"]>[number];
type ZoomEntry = NonNullable<Overlays["zooms"]>[number];
type BlurEntry = NonNullable<Overlays["blurs"]>[number];
type BgmEntry = NonNullable<Bgm["tracks"]>[number];
type CaptionEntry = Transcript["segments"][number];

/** クリップのコピー&ペースト(標準 NLE の a: クリップ複製)で持ち回る
 * スナップショット。中身ごと複製できるよう entry を丸ごと控える(元収録の
 * start/end を保持し、ペースト時に再生ヘッドの元秒へ平行移動する)。
 * 対象はカット後タイムライン上で中身を複製できるクリップだけ:
 * caption / overlays(素材)/ zoom / blur / annotation / bgm。
 * insert(タイムライン再構成を伴う)・wipe・cut(ベース映像)・short は対象外 */
type Clipboard =
  | { kind: "caption"; entry: CaptionEntry }
  | { kind: "overlays"; entry: OverlayEntry }
  | { kind: "zoom"; entry: ZoomEntry }
  | { kind: "blur"; entry: BlurEntry }
  | { kind: "annotation"; entry: Annotation }
  | { kind: "bgm"; entry: BgmEntry };

type AiWorkflowPhase =
  | "idle"
  | "proposing"
  | "reviewing"
  | "refining"
  | "applying"
  | "saving"
  | "verifying"
  | "complete"
  | "failed";

interface AiWorkflowState {
  phase: AiWorkflowPhase;
  instruction: string;
  scope: AiScope;
  refineMode?: AiRefineMode;
  response?: AiProposeResponse;
  diff?: ProposalDiffResult;
  resolution?: ProposalResolution;
  saved?: boolean;
  reviewBundle?: ReviewBundle;
  reviewCandidateKey?: string;
  reviewStale?: boolean;
  autoReviewRequested?: boolean;
  error?: string;
}

interface AiWorkflowReviewState extends AiWorkflowState {
  phase: "reviewing" | "verifying" | "refining";
  response: AiProposeResponse;
  diff: ProposalDiffResult;
  resolution: ProposalResolution;
}

interface ApplyAiWorkflowOptions {
  save: boolean;
  reviewFirst: boolean;
}

const isMaterialFile = (f: string) =>
  f.startsWith("materials/") &&
  /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mp3|m4a|wav|aac|ogg|flac)$/i.test(f);

/** 画像素材か(startFrom 頭出しの効かないもの)。動画・音声は false */
const isImageFile = (f: string) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f);

const keepsOf = (plan: CutPlan) => plan.segments.filter((s) => s.action === "keep");
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** ドラッグで区間がゼロ幅・逆転しないための最小幅(秒)。round2 の量子(0.01)
 * まで刻めるように最小幅もそこに合わせる(手動カットの粒度) */
const MIN_SPAN = 0.01;

/** ショートの profile 名 → Profile。src/lib/profile.ts の resolveProfile と
 * 同じ規則(省略時 defaultShortProfileName(hasCamera)。render.ts / frames.ts と
 * 同じ既定)だが、"default" は cfg 丸ごとではなく出力解像度(screenRegion)だけで足りる */
const resolveShortProfile = (
  name: string | undefined,
  output: { w: number; h: number },
  hasCamera: boolean,
): Profile => {
  const key = name ?? defaultShortProfileName(hasCamera);
  if (key === "default") return { width: output.w, height: output.h };
  const p = PROFILES[key];
  if (!p) throw new Error(`未知の profile 名です: ${key}`);
  return p;
};

const aiWorkflowPhaseLabel = (workflow: AiWorkflowState | null): string => {
  if (!workflow) return "待機";
  if (workflow.phase === "proposing") return "提案中";
  if (workflow.phase === "reviewing") return "確認中";
  if (workflow.phase === "refining") return "再提案中";
  if (workflow.phase === "applying") return "適用済み(未保存)";
  if (workflow.phase === "saving") return "保存中";
  if (workflow.phase === "verifying") return "比較を生成中";
  if (workflow.phase === "failed") return "失敗";
  if (workflow.saved) {
    return workflow.reviewBundle ? "保存+比較完了" : "保存完了";
  }
  return "適用済み(未保存)";
};

const aiWorkflowTone = (workflow: AiWorkflowState | null): "warn" | "ok" | "error" | "" => {
  if (!workflow) return "";
  if (workflow.phase === "failed") return "error";
  if (workflow.phase === "reviewing" || workflow.phase === "proposing" || workflow.phase === "refining") return "warn";
  if (workflow.phase === "complete") return workflow.saved ? "ok" : "warn";
  if (workflow.phase === "idle") return "";
  return "warn";
};

const isAiWorkflowReviewState = (
  workflow: AiWorkflowState | null,
): workflow is AiWorkflowReviewState =>
  (workflow?.phase === "reviewing" || workflow?.phase === "verifying" || workflow?.phase === "refining") &&
  workflow.response !== undefined &&
  workflow.diff !== undefined &&
  workflow.resolution !== undefined;

const acceptedAiHunkLabels = (workflow: AiWorkflowReviewState): string[] =>
  workflow.diff.hunks.flatMap((hunk) =>
    (workflow.resolution.get(hunk) ?? "theirs") === "theirs"
      ? [hunk.address.label]
      : [],
  );

/** BGM に使えるファイル(音声、または音を持つ動画)の拡張子 */
const BGM_EXT_RE = /\.(mp3|m4a|wav|aac|ogg|flac|mp4|mov|webm|mkv)$/i;
/** 音声のみのファイル(BGM 専用。素材・映像トラックには置けない) */
const AUDIO_ONLY_RE = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

/** undo/redo の1エントリ。編集対象の3ドキュメントのスナップショットを
 * 丸ごと持つ(どれも小さな JSON なので、操作の逆演算ではなく状態の控えで足りる) */
type HistoryDocs = {
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  bgm: Bgm | null;
  shorts?: Shorts | null;
};
/** undo 履歴の上限(それより古い編集は切り捨てる) */
const HISTORY_MAX = 100;
/** 連続する同種の編集(文字入力・カラーピッカー・ドラッグ)を1エントリに
 * まとめる時間窓(ms)。これ以上あいたら別の undo 単位に切る */
const HISTORY_COALESCE_MS = 2000;

/** 退避された下書きがディスクの正のデータと異なるか(同じなら復元不要) */
const draftDiffers = (d: DraftData, p: ProjectData): boolean =>
  JSON.stringify(d.cutplan) !== JSON.stringify(p.cutplan) ||
  JSON.stringify(d.overlays) !== JSON.stringify(p.overlays) ||
  JSON.stringify(d.transcript) !== JSON.stringify(p.transcript) ||
  JSON.stringify(d.bgm ?? null) !== JSON.stringify(p.bgm ?? null) ||
  (d.shorts !== undefined &&
    JSON.stringify(d.shorts ?? null) !== JSON.stringify(p.shorts ?? null));

const reviewDocsOf = (p: ProjectData): ReviewDocs => ({
  cutplan: p.cutplan,
  overlays: p.overlays,
  transcript: p.transcript,
  bgm: p.bgm,
  shorts: p.shorts,
});

const formatReviewFrame = (frame: ReviewFrameRequest): string =>
  `${fmtTime(frame.atSec)} (${frame.axis}) - ${frame.reason}`;

/** undo/redo で復元したドキュメントでも選択が指せているか
 * (配列からはみ出た添字のまま Inspector を出さないための確認) */
const selectionValid = (sel: Selection, d: HistoryDocs): boolean => {
  if (!sel) return false;
  if (sel.kind === "caption") return sel.index < d.transcript.segments.length;
  if (sel.kind === "cut") return sel.index < d.cutplan.segments.length;
  if (sel.kind === "insert") return sel.index < (d.overlays.inserts ?? []).length;
  if (sel.kind === "overlays" || sel.kind === "wipeFull") {
    return sel.index < (d.overlays[sel.kind] ?? []).length;
  }
  if (sel.kind === "zoom") return sel.index < (d.overlays.zooms ?? []).length;
  if (sel.kind === "blur") return sel.index < (d.overlays.blurs ?? []).length;
  if (sel.kind === "annotation") return sel.index < (d.overlays.annotations ?? []).length;
  if (sel.kind === "bgm") return sel.index < (d.bgm?.tracks?.length ?? 0);
  return true; // wipe は表示専用の常駐クリップ
};

/** 再生速度の選択肢(プレビューのみ。書き出しには影響しない) */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 左パネルのタブ(素材一覧・テロップ一覧)。選択クリップのプロパティは
 * 右側の常設インスペクタに出す(素材を見ながらプロパティを触れるように、
 * ライブラリとインスペクタで枠を奪い合わない) */
const PANEL_TABS = [
  ["materials", "素材"],
  ["script", "スクリプト"],
  ["captions", "テロップ"],
  ["shorts", "ショート"],
] as const;
type PanelTab = (typeof PANEL_TABS)[number][0];

const PanelTabIcon = ({ tab }: { tab: PanelTab }) => {
  if (tab === "materials") return <LibraryBig size={17} aria-hidden />;
  if (tab === "script") return <FileText size={17} aria-hidden />;
  if (tab === "captions") return <Captions size={17} aria-hidden />;
  return <Smartphone size={17} aria-hidden />;
};
/** 左パネル・インスペクタ・プレビューの最小幅(px)。
 * 境界ドラッグでこれ以下には縮まない */
const PANEL_MIN = 280;
const INSP_MIN = 300;
const VIEWER_MIN = 360;
/** タイムラインと上部(ステージ)の最小高さ(px)。上下の境界ドラッグ用 */
const TIMELINE_MIN = 140;
const STAGE_MIN = 200;

/** SaveRequest のドキュメントキー → ファイル名。src/lib/contentVersion.ts の
 *  DOC_FILE と同じ内容だが、このファイルは esbuild で browser 向けにバンドル
 *  されるため node:crypto/fs/path を import する contentVersion.ts を実行時に
 *  import できない(§8.3 実装時のコーディネータ指摘)。ここではローカルに
 *  複製する(値は絶対に乖離させないこと)。 */
const DOC_FILE: Record<string, string> = {
  cutplan: "cutplan.json",
  overlays: "overlays.json",
  transcript: "transcript.json",
  bgm: "bgm.json",
  shorts: "shorts.json",
};

/** body が触るドキュメントごとに、読み込み時点の base ハッシュ(baseHashesRef)
 *  から /api/save へ echo する baseHashes を組み立てる(§8.3)。stored に
 *  無い(=読み込み時に存在しなかった)ファイルは null(create 期待)を送る。 */
function baseHashesForBody(
  body: SaveRequest,
  stored: Record<string, string | null>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(body)) {
    const file = DOC_FILE[key];
    if (!file) continue; // baseHashes 自身などは無視
    out[file] = stored[file] ?? null; // 読んだとき存在しなかった→null(create期待)
  }
  return out;
}

/** /api/save のレスポンス contentHashes(書いた=hash / 削除=null)を
 *  baseHashesRef へ反映する(reload せずに base を進める。§8.3)。 */
function applySaveHashes(
  ref: { current: Record<string, string | null> },
  fresh: Record<string, string | null>,
): void {
  const next = { ...ref.current };
  for (const [file, h] of Object.entries(fresh)) {
    if (h === null) delete next[file]; // 削除された→base から外す
    else next[file] = h;
  }
  ref.current = next;
}

/**
 * CutFlow エディタ本体。動画編集ソフトの標準レイアウト:
 * 上=タブパネル(左: 素材/テロップ)+プレビュー(中央)+インスペクタ(右)、
 * 中=トランスポート、下=タイムライン。上部の左右比は分割バーで変えられる。
 * プレビューは最終レンダーと同じコンポジション(remotion/Main.tsx)を
 * @remotion/player で再生する。本編は現在の keep と一致する連続ベイクが
 * あれば preview-cut.mp4 を使い、無ければ元収録の軽量 proxy.mp4 を keep
 * 区間ごとに飛び飛び再生する。後者に即座に戻れるため境界編集中も反映を
 * 待たない。ショートは常に proxy.mp4 の source-domain 経路を使う。
 * 正のデータは cutplan / overlays / transcript の各 JSON(元収録の秒)。
 */
export const App = () => {
  const [proj, setProj] = useState<ProjectData | null>(null);
  const [cutplan, setCutplan] = useState<CutPlan | null>(null);
  const [overlays, setOverlays] = useState<Overlays | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  /** BGM の区間配置(bgm.json)。null = bgm.json 無し(収録フォルダ直下の
   * bgm.* を全編1曲で流す後方互換)。区間を1つでも作ると非 null になり、
   * 保存で bgm.json が書かれる(全区間を消すと bgm.json は削除される) */
  const [bgm, setBgm] = useState<Bgm | null>(null);
  /** ショート動画の定義(shorts.json)。null = 未定義。CRUD・ranges・
   * captionTracks・profile・approved の編集はここに集約する。
   * cutplan/overlays/transcript/bgm の undo 履歴には含めない
   * (別ドキュメントで、範囲ドラッグ程度の編集に undo 一貫性のコストを
   * 払う価値が薄いと判断した意図的な簡略化) */
  const [shorts, setShorts] = useState<Shorts | null>(null);
  /** 選択中のショート名。null = 本編モード(プレビュー下のセレクタで切替) */
  const [activeShortName, setActiveShortName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 通知トースト(error / job)。要対応の継続条件はバナー行が持つ(T4)
  const { toasts, addToast, updateToast, dismissToast } = useToasts();
  const [busy, setBusy] = useState<"save" | "upload" | null>(null);
  /** proxy.mp4 の生成中か。busy と分けて、生成中(初回の数十秒)も
   * 編集・保存・アップロードを普通に受け付ける */
  const [proxyBusy, setProxyBusy] = useState(false);
  /** GUI から起動した書き出しジョブ(preview / render)。running 中はボタンを
   * 無効化し、done で完了先を出す。null は非実行 */
  const [job, setJob] = useState<{
    stage: "preview" | "render";
    status: "running" | "done";
    path?: string;
  } | null>(null);
  const [selection, setSelectionState] = useState<Selection>(null);
  const [playing, setPlaying] = useState(false);
  /** ループ再生(プレビューのみ。末尾まで行ったら先頭へ戻る) */
  const [loop, setLoop] = useState(false);
  const [videoVersion, setVideoVersion] = useState(0);
  // 再生ヘッドの現在位置は React state ではなく playhead ストアが持つ
  // (毎フレームの setState は UI 全体の再レンダー = 再生の乱れになる)
  /** プレビューの音量(%)。書き出しには影響しない。ベースの音量自体は
   * proxy.mp4 生成時のラウドネス正規化(config の render.targetLufs)が揃える */
  const [volumePct, setVolumePct] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.volumePct"));
    return Number.isFinite(saved) && saved > 0 ? Math.min(saved, 100) : 100;
  });
  /** トラック別ミュート(映像・BGM)。プレビューのみで書き出しには影響しない */
  const [trackMuted, setTrackMuted] = useState<Record<AudioTrackId, boolean>>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem("cutflow.editor.trackMuted") ?? "",
      );
      const m = saved as Partial<Record<AudioTrackId, unknown>>;
      return { cut: m.cut === true, bgm: m.bgm === true };
    } catch {
      return { cut: false, bgm: false };
    }
  });
  /** 一時非表示のレイヤー(ラベルの目トグル)。プレビューのみで書き出しには
   * 影響しない。消したまま忘れる事故を避けるため意図的に保存しない(リロードで全表示) */
  const [hiddenLayers, setHiddenLayers] = useState<LayerId[]>([]);
  /** 音声の波形ピーク(タイムライン表示用)。キー "" = マイク音声、
   * それ以外 = 素材・BGM の相対パス。null = 音声なし/取得失敗(波形を
   * 描かないだけで編集は可能) */
  const [peaksMap, setPeaksMap] = useState<Record<string, Peaks | null>>({});
  /** 取得済み(進行中含む)のピークのキー。二重リクエストを避ける */
  const peaksRequestedRef = useRef(new Set<string>());
  const playerRef = useRef<PlayerRef>(null);
  const [tab, setTab] = useState<PanelTab>("materials");
  /** スクリプトタブの元データ(元収録の全文文字起こし)。タブを初めて
   * 開いたときに取得する遅延ロード(whisper-out.json 由来で大きいため)。
   * null = 未取得。外部変更のリロードで null へ戻し、次に開いたとき再取得 */
  const [script, setScript] = useState<ScriptData | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const scriptFetchingRef = useRef(false);
  useEffect(() => {
    if (tab !== "script" || script !== null || scriptFetchingRef.current) return;
    scriptFetchingRef.current = true;
    setScriptError(null);
    getScript()
      .then(setScript)
      .catch((e: Error) => setScriptError(e.message))
      .finally(() => {
        scriptFetchingRef.current = false;
      });
  }, [tab, script]);
  /** 左パネルの幅(px)。分割バーのドラッグで変更し、次回起動時も引き継ぐ */
  const [panelW, setPanelW] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.panelW"));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : 380;
  });
  /** 右側インスペクタの幅(px)。分割バーのドラッグで変更し、次回も引き継ぐ */
  const [inspW, setInspW] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.inspW"));
    return Number.isFinite(saved) && saved >= INSP_MIN ? saved : 340;
  });
  /** タイムラインの高さ(px)。上下の分割バーのドラッグで変更 */
  const [timelineH, setTimelineH] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.timelineH"));
    return Number.isFinite(saved) && saved >= TIMELINE_MIN ? saved : 300;
  });
  /** 左パネル・インスペクタ・タイムラインの開閉(VSCode 風のヘッダー右の
   * トグル)。分割バーを最小幅の半分より外へ寄せても閉じる。閉じても
   * コンポーネントは外さず CSS で隠すだけ(タブ・スクロール位置・ズームを
   * 保つ)。幅・高さは開閉と別に保持し、開き直すと前回の寸法に戻る */
  const [panelOpen, setPanelOpen] = useState(
    () => localStorage.getItem("cutflow.editor.panelOpen") !== "0",
  );
  const [inspOpen, setInspOpen] = useState(
    () => localStorage.getItem("cutflow.editor.inspOpen") !== "0",
  );
  const [timelineOpen, setTimelineOpen] = useState(
    () => localStorage.getItem("cutflow.editor.timelineOpen") !== "0",
  );
  const sidePanelRef = useRef<PanelImperativeHandle>(null);
  const inspectorPanelRef = useRef<PanelImperativeHandle>(null);
  const timelinePanelRef = useRef<PanelImperativeHandle>(null);
  const stageGroupRef = useRef<HTMLDivElement>(null);
  const shellGroupRef = useRef<HTMLDivElement>(null);
  /** パネル最大化(⇧F)。左右パネル・タイムラインを一時的に畳んでプレビューを
   * 広げる表示モード。レイアウトの切替だけでデータには一切影響しない。
   * 一時確認用なので意図的に保存しない(リロードで通常レイアウトに戻る) */
  const [maximized, setMaximized] = useState(false);
  /** フルスクリーン再生(F)。viewerCol(プレビュー+トランスポート)を
   * OS のフルスクリーンにする。実寸での最終目視用 */
  const [fullscreen, setFullscreen] = useState(false);
  const viewerColRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getProject()
      .then((p) => {
        setProj(p);
        setCutplan(p.cutplan);
        setOverlays(p.overlays);
        setTranscript(p.transcript);
        setBgm(p.bgm);
        setShorts(p.shorts);
        baseHashesRef.current = p.contentHashes ?? {};
        // proxy.mp4 の陳腐化はサーバーが proxy.key.json とファイルから毎回
        // 判定する(config.yaml が別セッション・別ツールで変わった場合も
        // 拾える)。false→true 方向だけ反映し、既にバナーが出ている
        // (このセッション中の設定保存で立てた)ものは消さない
        if (p.proxyStale) {
          setProxyStale(true);
          setProxyStaleDismissed(false);
        }
        // 前回のセッションが保存せずに終わっていたら(クラッシュ等)、
        // 退避された編集の復元を人間に選ばせる。中身が正のデータと同じなら
        // 復元するものが無いので黙って片付ける
        if (p.draft) {
          if (draftDiffers(p.draft, p)) setDraftOffer(p.draft);
          else deleteDraft().catch(() => {});
        }
        refreshMediaFacts();
        void refreshHyperframes();
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  /* ---------------- 外部変更のホットリロード ---------------- */

  /** 収録フォルダの JSON が外部(Claude Code や手編集)で変わったのに、
   * こちらにも未保存の編集があって自動では読み込み直せない状態 */
  const [externalChange, setExternalChange] = useState(false);
  const [diffReview, setDiffReview] = useState<{
    theirs: ProjectData;
    result: ThreeWayResult;
  } | null>(null);
  const [diffResolution, setDiffResolution] = useState<Resolution>(() => new Map());
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [aiWorkflow, setAiWorkflow] = useState<AiWorkflowState | null>(null);
  const [aiCommandOpen, setAiCommandOpen] = useState(false);
  const [aiCommandScope, setAiCommandScope] = useState<AiScope>("global");
  const aiCommandLauncherRef = useRef<HTMLButtonElement | null>(null);
  /** 前回のセッションの未保存編集(自動退避)。復元するか人間が選ぶまで保持 */
  const [draftOffer, setDraftOffer] = useState<DraftData | null>(null);
  /** ヘッダー右の「書き出し」ポップオーバー(preview / 承認 / render)の開閉 */
  const [exportOpen, setExportOpen] = useState(false);

  /* ---------------- 設定モーダル ---------------- */

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** モーダルを開いた時点の設定の深いコピー(キャンセル復元・保存 diff の
   * 基準)。null = モーダルを開いていない */
  const settingsSnapRef = useRef<CfgValues | null>(null);
  /** proxy.mp4 に焼き込まれる設定(targetLufs / systemAudio / denoise /
   * preview.width)を保存した後、プレビューへ反映するには再生成が要ることを促すバナー */
  const [proxyStale, setProxyStale] = useState(false);
  /** 「後で」でバナーだけ閉じても stale という生成ゲートの事実は保持する。 */
  const [proxyStaleDismissed, setProxyStaleDismissed] = useState(false);
  /** proxy 再生成ごとに進め、同じ keep でも preview-cut を必ず作り直す。 */
  const [previewCutSourceVersion, setPreviewCutSourceVersion] = useState(0);
  /** 動画素材ごとの codec 由来のブラウザ表示可否(非表示のものだけの疎な map)。
   * GET /api/media-facts から非同期に届く(loadProject は sync なので
   * /api/project には含まれない)。既定 {} = 全素材表示可能扱い(degrade)。
   * fetch 失敗時も {} のまま=警告なし(§design 8.2) */
  const [mediaCodecFacts, setMediaCodecFacts] = useState<Record<string, { codec: string; reason: string }>>({});
  /** HF palette は project payload と分離し、agent が source / MP4 を追加した
   * 変更にも保存競合なしで追随する。 */
  const [hyperframes, setHyperframes] = useState<HyperframeCard[]>([]);
  const [hyperframesLoading, setHyperframesLoading] = useState(false);
  const [hyperframesError, setHyperframesError] = useState<string | null>(null);
  const [hyperframeRendering, setHyperframeRendering] = useState<string | null>(null);
  const [hyperframeErrors, setHyperframeErrors] = useState<Record<string, string>>({});
  const [hyperframeAuthorOpen, setHyperframeAuthorOpen] = useState(false);
  const hyperframeAuthorReturnFocusRef = useRef<HTMLElement | null>(null);
  const [hyperframeAuthorName, setHyperframeAuthorName] = useState("");
  const [hyperframeAuthorAssets, setHyperframeAuthorAssets] = useState<File[]>([]);
  const [hyperframeAssetLimits, setHyperframeAssetLimits] = useState<{
    maxBytes: number;
    maxTotalBytes: number;
    fontMaxBytes: number;
  } | null>(null);
  const hyperframeAssetInputRef = useRef<HTMLInputElement>(null);
  const [hyperframeAuthorBusy, setHyperframeAuthorBusy] = useState(false);
  /** 作成中カード名。モーダルは送信時に閉じ、素材グリッドの作成中タイルと
   * ヘッダーボタンのアイコンでこの pending を見せる */
  const [hyperframeAuthorPendingName, setHyperframeAuthorPendingName] = useState<string | null>(null);
  const [hyperframeAuthorError, setHyperframeAuthorError] = useState<string | null>(null);
  /** 現在の収録フォルダに対して /api/media-facts を取り直す。初回ロード・
   * 外部変更のホットリロード・アップロード成功後、いずれも呼ぶ
   * (新しく置かれた ProRes 等を追随して検出するため) */
  const refreshMediaFacts = () => {
    getMediaFacts()
      .then((r) => setMediaCodecFacts(r.mediaCodecFacts))
      .catch(() => {}); // 失敗しても {} のまま(警告なしへ degrade)
  };
  const refreshHyperframes = useCallback(async (visible = true) => {
    if (visible) setHyperframesLoading(true);
    try {
      const data = await getHyperframes();
      setHyperframes(data.hyperframes);
      setHyperframeAssetLimits(data.assetLimits);
      const renderedPaths = data.hyperframes.flatMap((card) => card.mp4Path ? [card.mp4Path] : []);
      setProj((current) => {
        if (!current) return current;
        const previous = current.dirFiles.filter((file) => file.startsWith("materials/hyperframes/"));
        if (previous.length === renderedPaths.length && previous.every((file, index) => file === renderedPaths[index])) {
          return current;
        }
        return {
          ...current,
          dirFiles: [
            ...current.dirFiles.filter((file) => !file.startsWith("materials/hyperframes/")),
            ...renderedPaths,
          ].sort(),
        };
      });
      setHyperframesError(null);
    } catch (e) {
      setHyperframesError((e as Error).message);
    } finally {
      if (visible) setHyperframesLoading(false);
    }
  }, []);
  // HF は編集 JSON 用 SSE の監視対象外。agent/CLI の生成をパレットへ収斂
  // させるため、素材タブ表示中だけ軽い一覧 API を定期 pull し、focus 復帰時も取る。
  useEffect(() => {
    if (tab !== "materials") return;
    const timer = window.setInterval(() => void refreshHyperframes(false), 4000);
    const onFocus = () => void refreshHyperframes(false);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [tab, refreshHyperframes]);
  const [aiDoctorResult, setAiDoctorResult] = useState<import("./apiTypes.ts").AiDoctorResult[] | null>(null);
  const [aiDoctorBusy, setAiDoctorBusy] = useState(false);
  /** 再生速度(プレビューのみ)。次回起動時も引き継ぐ */
  const [playbackRate, setPlaybackRate] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.playbackRate"));
    return PLAYBACK_RATES.includes(saved) ? saved : 1;
  });
  useEffect(() => {
    localStorage.setItem("cutflow.editor.playbackRate", String(playbackRate));
  }, [playbackRate]);

  const cfgValuesOf = (p: ProjectData): CfgValues => ({
    renderCfg: p.renderCfg,
    previewCfg: p.previewCfg,
    editorCfg: p.editorCfg,
    aiCfg: aiSettingsOf(p),
  });
  const aiSettingsOf = (p: ProjectData): AiSettingsValue => {
    const textProfile = p.aiProfiles.find((profile) => profile.name === p.aiRoutes.text);
    const structuredProfile = p.aiProfiles.find((profile) => profile.name === p.aiRoutes.structured);
    const sameMain =
      textProfile &&
      structuredProfile &&
      textProfile.name === structuredProfile.name &&
      ["claude-code", "codex", "openai", "anthropic"].includes(textProfile.adapter);
    return {
      adapter: sameMain ? textProfile.adapter as AiSettingsValue["adapter"] : "custom",
      model: textProfile?.model ?? "auto",
      visionRoute: !!p.aiRoutes.vision,
      review: p.aiReviewCfg,
    };
  };
  const projectWithCfgPatch = (p: ProjectData, patch: Partial<CfgValues>): ProjectData => {
    let next = {
      ...p,
      ...(patch.renderCfg ? { renderCfg: patch.renderCfg } : {}),
      ...(patch.previewCfg ? { previewCfg: patch.previewCfg } : {}),
      ...(patch.editorCfg ? { editorCfg: patch.editorCfg } : {}),
    };
    if (patch.aiCfg) {
      const ai = patch.aiCfg;
      const routes = ai.adapter === "custom"
        ? next.aiRoutes
        : {
            text: "local",
            structured: "local",
            ...(ai.visionRoute ? { vision: "local" } : {}),
          };
      const profiles = ai.adapter === "custom"
        ? next.aiProfiles
        : [
            ...next.aiProfiles.filter((profile) => profile.name !== "local"),
            {
              name: "local",
              adapter: ai.adapter,
              model: ai.model.trim() || "auto",
              origin: null,
              credential:
                ai.adapter === "openai" || ai.adapter === "anthropic"
                  ? next.aiProfiles.find((profile) => profile.name === "local")?.credential ?? "missing"
                  : "not-required",
              capabilities:
                ai.adapter === "claude-code"
                  ? { textInput: true as const, textOutput: true as const, structuredOutput: "native-json-schema" as const, imageInput: false, maxImages: 0 }
                  : ai.adapter === "codex"
                    ? { textInput: true as const, textOutput: true as const, structuredOutput: "prompt" as const, imageInput: false, maxImages: 0 }
                    : { textInput: true as const, textOutput: true as const, structuredOutput: "native-json-schema" as const, imageInput: true, maxImages: 4 },
            },
          ];
      next = {
        ...next,
        aiProfiles: profiles,
        aiRoutes: routes,
        aiReviewCfg: ai.review,
      };
    }
    return next;
  };
  const openSettings = () => {
    if (!proj) return;
    settingsSnapRef.current = structuredClone(cfgValuesOf(proj));
    setSettingsError(null);
    setSettingsOpen(true);
  };
  /** キャンセル: ライブ反映済みの編集をモーダルを開いた時点へ戻す */
  const cancelSettings = () => {
    const snap = settingsSnapRef.current;
    if (snap) setProj((p) => p && projectWithCfgPatch(p, structuredClone(snap)));
    settingsSnapRef.current = null;
    setSettingsOpen(false);
  };
  /** 保存: スナップショットとの差分だけを config.yaml へ書く */
  const saveSettings = async () => {
    const snap = settingsSnapRef.current;
    if (!proj || !snap) return;
    const patch = buildConfigPatch(snap, cfgValuesOf(proj));
    if (!patch) {
      settingsSnapRef.current = null;
      setSettingsOpen(false);
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const res = await postConfig(patch);
      // サーバーが解決した実値で確定(editor の既定値解決なども反映)
      setProj(
        (p) =>
          p && {
            ...p,
            renderCfg: res.renderCfg,
            designAssets: res.designAssets,
            previewCfg: res.previewCfg,
            editorCfg: res.editorCfg,
            aiProfiles: res.aiProfiles,
            aiRoutes: res.aiRoutes,
            aiReviewCfg: res.aiReviewCfg,
          },
      );
      if (patchTouchesProxy(patch)) {
        setProxyStale(true);
        setProxyStaleDismissed(false);
      }
      settingsSnapRef.current = null;
      setSettingsOpen(false);
    } catch (e) {
      setSettingsError((e as Error).message);
    } finally {
      setSettingsSaving(false);
    }
  };
  const runAiDoctor = async (route?: "text" | "structured" | "vision") => {
    setAiDoctorBusy(true);
    try {
      setAiDoctorResult(await postAiDoctor(route ? { route } : {}));
    } catch (e) {
      setAiDoctorResult([{
        profile: route ?? "all",
        adapter: "claude-code",
        model: "n/a",
        origin: null,
        checks: {
          config: { status: "error", message: (e as Error).message },
          credential: { status: "skip", message: "" },
          text: { status: "skip", message: "" },
          structured: { status: "skip", message: "" },
          image: { status: "skip", message: "" },
        },
      }]);
    } finally {
      setAiDoctorBusy(false);
    }
  };

  /** ディスクの内容で全ドキュメントを読み込み直す。undo/redo は
   * 古いドキュメント由来で外部の編集を巻き戻してしまうので破棄する */
  const reloadFromDisk = async () => {
    try {
      const p = await getProject();
      // 設定モーダルの編集中は、ライブ反映済みの設定値をリロードで失わない
      // (config.yaml はこのモーダル以外から変わらないので、現値の温存で正しい)
      setProj((prev) =>
        settingsSnapRef.current && prev
          ? {
              ...p,
              renderCfg: prev.renderCfg,
              previewCfg: prev.previewCfg,
              editorCfg: prev.editorCfg,
              aiProfiles: prev.aiProfiles,
              aiRoutes: prev.aiRoutes,
              aiReviewCfg: prev.aiReviewCfg,
            }
          : p,
      );
      setCutplan(p.cutplan);
      setOverlays(p.overlays);
      setTranscript(p.transcript);
      setBgm(p.bgm);
      setShorts(p.shorts);
      baseHashesRef.current = p.contentHashes ?? {};
      if (!p.shorts?.shorts.some((s) => s.name === activeShortName)) {
        setActiveShortName(null);
      }
      if (p.proxyStale) {
        setProxyStale(true);
        setProxyStaleDismissed(false);
      }
      // 外部変更(手編集・Claude Code)で materials/ に新しいファイルが
      // 増えている可能性があるので、codec 判定も取り直す
      refreshMediaFacts();
      void refreshHyperframes(false);
      // whisper-out.json も外部(plan --force / run --force)で変わりうるので
      // スクリプトのキャッシュを捨て、次にタブを開いたとき取り直す
      setScript(null);
      setScriptError(null);
      undoRef.current = [];
      redoRef.current = [];
      historyKeyRef.current = null;
      setCapMulti([]);
      setSelectionState(null);
      setExternalChange(false);
      setDiffReview(null);
      setDiffResolution(new Map());
      setDiffPanelOpen(false);
      setAiWorkflow(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const applyMergedDocs = (theirs: ProjectData, merged: ReviewDocs, recordHistory: boolean) => {
    if (recordHistory) pushHistory();
    setCutplan(merged.cutplan);
    setOverlays(merged.overlays);
    setTranscript(merged.transcript);
    setBgm(merged.bgm);
    setShorts(merged.shorts);
    setProj(theirs);
    baseHashesRef.current = theirs.contentHashes ?? {};
    if (!merged.shorts?.shorts.some((s) => s.name === activeShortName)) {
      setActiveShortName(null);
    }
    if (theirs.proxyStale) {
      setProxyStale(true);
      setProxyStaleDismissed(false);
    }
    refreshMediaFacts();
    void refreshHyperframes(false);
    setCapMulti([]);
    setSelectionState((sel) => (selectionValid(sel, merged) ? sel : null));
    setExternalChange(false);
    setDiffReview(null);
    setDiffResolution(new Map());
    setDiffPanelOpen(false);
    setAiWorkflow(null);
  };

  const reviewExternalChange = async () => {
    if (!proj || !cutplan || !overlays || !transcript) {
      setExternalChange(true);
      return;
    }
    try {
      const theirs = await getProject();
      const base = reviewDocsOf(proj);
      const mine: ReviewDocs = { cutplan, overlays, transcript, bgm, shorts };
      const theirsDocs = reviewDocsOf(theirs);
      const result = threeWayDiff(base, mine, theirsDocs);
      if (result.cleanMerge) {
        applyMergedDocs(theirs, applyResolution(theirsDocs, result, new Map()), false);
        return;
      }
      setExternalChange(true);
      setDiffReview({ theirs, result });
      setDiffPanelOpen(false);
      setDiffResolution(new Map(result.conflicts.map((h) => [h, "theirs"] as const)));
    } catch (e) {
      setExternalChange(true);
      setError((e as Error).message);
    }
  };

  // client が読んだ各ファイルの内容バージョン(sha256:…)。save 時に baseHashes
  // として送り、409 stale_base を避ける。render を伴わないので ref で持つ。§8.3
  const baseHashesRef = useRef<Record<string, string | null>>({});

  // 外部変更の監視(SSE)。未保存の編集が無ければ黙って読み込み直し、
  // あればバナーを出して人間に選ばせる(自動で上書きすると編集が消えるため)
  const dirtyRef = useRef(false);
  const reloadRef = useRef(reloadFromDisk);
  reloadRef.current = reloadFromDisk;
  const reviewExternalRef = useRef(reviewExternalChange);
  reviewExternalRef.current = reviewExternalChange;
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      if (dirtyRef.current) void reviewExternalRef.current();
      else void reloadRef.current();
    };
    return () => es.close();
  }, []);

  // error が立ったらエラートーストを出す。表示は TOAST_TTL_MS.error で自動消滅する
  // (×を押さなくても消える)。error state 自体は起動失敗の全画面(!proj)とプロキシ
  // 失敗の分岐(3178)が読むので残す(消えるのはトースト表示だけ=状態は保つ)。
  // null→msg / msg→別msg の遷移で発火する
  useEffect(() => {
    if (error)
      addToast({ kind: "error", message: `エラー: ${error}`, ttlMs: TOAST_TTL_MS.error });
  }, [error, addToast]);

  /** 必要になったピークを取りに行く(マイク・BGM・挿入クリップの動画)。
   * 波形は無くても編集できるので、失敗は警告に留める */
  const requestPeaks = (key: string) => {
    if (peaksRequestedRef.current.has(key)) return;
    peaksRequestedRef.current.add(key);
    getPeaks(key === "" ? undefined : key)
      .then((p) => setPeaksMap((m) => ({ ...m, [key]: p.data.length > 0 ? p : null })))
      .catch((e: Error) => {
        console.warn(`波形を読み込めませんでした(${key || "マイク"}): ${e.message}`);
        setPeaksMap((m) => ({ ...m, [key]: null }));
      });
  };
  useEffect(() => {
    if (!proj) return;
    requestPeaks(""); // マイク(映像トラックの keep クリップ)
    // BGM: bgm.json(編集中の状態)があれば各区間の素材、無ければ bgm.*
    if (bgm?.tracks?.length) {
      for (const t of bgm.tracks) requestPeaks(t.file);
    } else if (proj.bgmFile) {
      requestPeaks(proj.bgmFile);
    }
    // 挿入クリップは音声ごと合成される。動画素材ぶんのピークを取る
    for (const ins of overlays?.inserts ?? []) {
      if (VIDEO_EXT_RE.test(ins.file)) requestPeaks(ins.file);
    }
  }, [proj, overlays, bgm]);

  /* ---------------- 編集履歴(undo / redo) ---------------- */

  const undoRef = useRef<HistoryDocs[]>([]);
  const redoRef = useRef<HistoryDocs[]>([]);
  /** 直前に履歴を積んだ編集の種類と時刻(pushHistory の key のまとめ判定用) */
  const historyKeyRef = useRef<{ key: string; at: number } | null>(null);
  /** イベントハンドラから最新の編集ドキュメントを参照するための控え */
  const docsRef = useRef<HistoryDocs | null>(null);
  docsRef.current =
    cutplan && overlays && transcript ? { cutplan, overlays, transcript, bgm, shorts } : null;

  /** クリップのコピー&ペースト用のアプリ内クリップボード(OS のクリップボードは
   * 経由しない)。⌘C で選択中クリップの中身を控え、⌘V で再生ヘッド位置へ複製する */
  const clipboardRef = useRef<Clipboard | null>(null);

  /** 変更を加える直前に呼び、現在の状態を undo 履歴へ積む(redo は捨てる)。
   * key を渡すと、同じ key が短い間隔で続く間は積み直さない(テロップの
   * 文字入力・カラーピッカー・プレビュー上のドラッグのような連続編集用) */
  const pushHistory = (key: string | null = null) => {
    const d = docsRef.current;
    if (!d) return;
    const prev = historyKeyRef.current;
    const now = Date.now();
    historyKeyRef.current = key === null ? null : { key, at: now };
    if (key !== null && prev?.key === key && now - prev.at < HISTORY_COALESCE_MS) return;
    // 同じイベント内の複合操作(「トラックの標準位置にする」=トラック更新+
    // 個別解除など)は再レンダー前でドキュメントが同一参照なので二重に積まない
    const top = undoRef.current[undoRef.current.length - 1];
    if (
      top?.cutplan === d.cutplan &&
      top?.overlays === d.overlays &&
      top?.transcript === d.transcript &&
      top?.bgm === d.bgm &&
      top?.shorts === d.shorts
    ) {
      return;
    }
    undoRef.current.push(d);
    if (undoRef.current.length > HISTORY_MAX) undoRef.current.shift();
    redoRef.current = [];
  };

  /** undo/redo の実体。from の末尾を取り出して復元し、現在の状態を to へ積む */
  const applyHistory = (from: HistoryDocs[], to: HistoryDocs[]) => {
    const cur = docsRef.current;
    const d = from.pop();
    if (!cur || !d) return;
    to.push(cur);
    historyKeyRef.current = null;
    dragRef.current = null; // ドラッグ中の控えからの再構築と競合しないように
    setCutplan(d.cutplan);
    setOverlays(d.overlays);
    setTranscript(d.transcript);
    setBgm(d.bgm);
    setShorts(d.shorts !== undefined ? d.shorts ?? null : shorts);
    setCapMulti([]); // 添字がずれている可能性があるので複数選択は解除
    setSelectionState((sel) => (selectionValid(sel, d) ? sel : null));
  };
  const undoEdit = () => applyHistory(undoRef.current, redoRef.current);
  const redoEdit = () => applyHistory(redoRef.current, undoRef.current);

  /** 選択の変更は連続編集のまとめの区切り(同じテロップを2回ドラッグしたら
   * undo も2回に分かれるように)。選択を触る箇所はすべてここを通す。
   * 通常の選択で複数選択(テロップの⌘クリック)は解除される */
  const setSelection: typeof setSelectionState = (v) => {
    historyKeyRef.current = null;
    setCapMulti([]);
    setSelectionState(v);
  };

  /** 複数選択中のテロップ(transcript.segments の添字。2件以上のときだけ
   * 値を持つ)。テロップクリップ・一覧行の⌘クリックで追加/解除する。
   * 添字ベースなので、テロップの増減がある操作(削除・undo・再読込)では
   * 迷子にならないよう空へ戻す */
  const [capMulti, setCapMulti] = useState<number[]>([]);
  const toggleCaptionMulti = (i: number) => {
    historyKeyRef.current = null;
    const cur =
      selection?.kind === "caption"
        ? capMulti.length > 0
          ? capMulti
          : [selection.index]
        : [];
    const next = cur.includes(i)
      ? cur.filter((x) => x !== i)
      : [...cur, i].sort((a, b) => a - b);
    if (next.length === 0) {
      setCapMulti([]);
      setSelectionState(null);
      return;
    }
    setCapMulti(next.length > 1 ? next : []);
    setSelectionState({
      kind: "caption",
      index: next.includes(i) ? i : next[next.length - 1],
    });
  };

  const keeps = useMemo(() => (cutplan ? keepsOf(cutplan) : []), [cutplan]);
  const inserts = useMemo(() => overlays?.inserts ?? [], [overlays]);
  const timeline = useMemo(() => buildTimeline(keeps, inserts), [keeps, inserts]);
  /** スクリプトタブで消したカット記録。取り消し線判定の微小穴ブリッジから
   * 除外する(消した語が即グレーになるフィードバックを守る。§scriptKeptFlags) */
  const scriptCutSpans = useMemo(
    () =>
      (cutplan?.segments ?? []).filter(
        (s) => s.action === "cut" && s.reason === SCRIPT_CUT_REASON,
      ),
    [cutplan],
  );
  /** スクリプトタブの虚構タイムスタンプ判定に使う無音証拠。実測
   * (cuts.auto.json の silences)に、cutplan の無音カット記録(plan 時点の
   * 実測。reason は config 解決値で一致判定)を合算する。whisper がポーズへ
   * 塗り広げた語をここへ照らして「実際は隣の発話」と判定する(§scriptKeptFlags) */
  const silenceEvidence = useMemo(() => {
    if (!proj) return null;
    const list = [
      ...(proj.silences ?? []),
      ...(cutplan?.segments ?? []).filter(
        (s) => s.action === "cut" && s.reason === proj.silenceCutReason,
      ),
    ]
      .map((s) => ({ start: s.start, end: s.end }))
      .sort((a, b) => a.start - b.start);
    return list.length > 0 ? mergeIntervals(list) : null;
  }, [proj, cutplan]);

  /* ---------------- ショートモード ----------------
   * 選択中のショートは本編とは独立の keep 集合(ranges)を持つ別の出力。
   * D2/D4 の実装(src/stages/render.ts の renderOneShort)と同じ規則:
   * ranges を mergeIntervals した集合がそのままショートの keep 集合になり
   * (本編 cutplan とは交差させない)、overlays/inserts/wipeFull/bgm は
   * 継承しない(v1 スコープ)。 */
  const activeShort = useMemo(
    () => (activeShortName ? (shorts?.shorts.find((s) => s.name === activeShortName) ?? null) : null),
    [shorts, activeShortName],
  );
  const shortMode = activeShort !== null;
  // 選択中のショートが削除された等で見つからなくなったら本編モードへ戻る
  useEffect(() => {
    if (activeShortName && !activeShort) setActiveShortName(null);
  }, [activeShortName, activeShort]);
  // モード切替(本編⇔ショート、ショート間)では選択を持ち越さない
  // (indices の意味がモードごとに違うため)
  useEffect(() => {
    setSelectionState(null);
    setCapMulti([]);
  }, [activeShortName]);
  // 本編からショートへ切り替えた時、インスペクタが閉じていれば自動で開く
  // (右インスペクタの「ショート」節の発見性を担保する一度きりのナッジ。
  // ショート間の切替や本編へ戻す操作では再オープンしない)
  const wasShortRef = useRef(false);
  useEffect(() => {
    if (activeShortName && !wasShortRef.current) setInspOpen(true);
    wasShortRef.current = activeShortName !== null;
  }, [activeShortName]);
  const shortKeepsMerged = useMemo(
    () => mergeIntervals(activeShort?.ranges ?? []),
    [activeShort],
  );
  const shortTimelineMemo = useMemo(
    () => buildTimeline(shortKeepsMerged, []),
    [shortKeepsMerged],
  );
  /** 共有コード(再生・シーク・テロップ表示・ドラッグ)が参照する「いまの
   * モードの写像」。本編モードでは main の timeline と同じ */
  const curTimeline = shortMode ? shortTimelineMemo : timeline;
  /** テロップの位置/スタイル解決に使う captionTracks の出典。ショートモードは
   * shorts.json の当該ショートの captionTracks(D2)、本編は overlays.json */
  const curCaptionOverlays = useMemo<Overlays>(
    () => (shortMode && activeShort ? { captionTracks: activeShort.captionTracks } : (overlays ?? {})),
    [shortMode, activeShort, overlays],
  );
  /** 重なり順(下→上)。overlays.json の layerOrder を正規化したもの */
  const layerOrder = useMemo(
    () =>
      normalizeLayerOrder(
        overlays?.layerOrder,
        overlays ? ovCountOf(overlays) : 2,
        transcript ? capCountOf(transcript) : 1,
      ),
    [overlays, transcript],
  );
  const tracks = useMemo(() => {
    const capCount = layerOrder.filter((id) => capNum(id) !== null).length;
    // plain(カメラ無し)ではワイプトラックを表示から隠す。overlays.json に
    // 保存する layerOrder(上の useMemo)は触らず、表示用の並びだけ除外する
    const displayOrder =
      proj?.hasCamera === false ? layerOrder.filter((id) => id !== "wipe") : layerOrder;
    return buildTracks(displayOrder, (n) =>
      overlays ? captionTrackName(n, overlays, capCount) : undefined,
    );
  }, [layerOrder, overlays, proj]);
  /** 素材トラックの本数(Inspector のトラック選択肢にも使う) */
  const ovTracks = useMemo(
    () => layerOrder.reduce((n, id) => Math.max(n, ovNum(id) ?? 0), 0),
    [layerOrder],
  );
  /** テロップトラックの本数(Inspector のトラック選択肢にも使う) */
  const capTracks = useMemo(
    () => layerOrder.reduce((n, id) => Math.max(n, capNum(id) ?? 0), 0),
    [layerOrder],
  );
  const materials = useMemo(
    () => (proj
      ? proj.dirFiles.filter(isMaterialFile).filter((file) => !file.startsWith("materials/hyperframes/"))
      : []),
    [proj],
  );
  /** Timeline へ渡すトラック一覧。ショートモードは ranges 帯 + テロップ
   * トラックだけに絞る(D6: 別ビューを作らず既存 Timeline を最小限流用) */
  const timelineTracks = useMemo(
    () => (shortMode ? [SHORT_TRACK_DEF, ...tracks.filter((t) => capNum(t.id) !== null)] : tracks),
    [shortMode, tracks],
  );

  const currentPreviewKeepSignature = useMemo(
    () => (cutplan ? previewCutKeepSignature(cutplan) : ""),
    [cutplan],
  );
  const requestPreviewCut = useCallback(
    (snapshot: CutPlan) => postPreviewCut({ cutplan: snapshot }),
    [],
  );
  const acceptPreviewCut = useCallback((response: PreviewCutResponse) => {
    setProj((current) => current && {
      ...current,
      previewCut: { ready: true, keepSignature: response.keepSignature },
    });
  }, []);
  const previewCutRebake = usePreviewCutRebake({
    cutplan,
    keepSignature: currentPreviewKeepSignature,
    ready: proj?.previewCut.ready ?? false,
    readySignature: proj?.previewCut.keepSignature ?? "",
    enabled: !!proj?.proxyExists && !proxyStale && !shortMode,
    sourceVersion: previewCutSourceVersion,
    request: requestPreviewCut,
    onReady: acceptPreviewCut,
  });

  const previewBaseVideo = useMemo(
    () =>
      proj && cutplan
        ? previewBaseVideoOf({
            cutplan,
            previewCut: proj.previewCut,
            shortMode,
            proxyStale,
          })
        : null,
    [proj, cutplan, shortMode, proxyStale],
  );
  /** base video の経路が source ⇄ continuous で切り替わると、同じ Main の
   * video 要素を使い回さず既存 videoVersion seam から Player を remount する。
   * C4 の生成完了は proj.previewCut を更新するだけでこの経路へ収斂できる。 */
  const mountedPreviewVideoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewBaseVideo) return;
    const key = previewBaseVideoMountKey(previewBaseVideo);
    if (mountedPreviewVideoRef.current !== null && mountedPreviewVideoRef.current !== key) {
      setVideoVersion((v) => v + 1);
    }
    mountedPreviewVideoRef.current = key;
  }, [previewBaseVideo]);

  const built = useMemo(() => {
    if (!proj || !cutplan || !overlays || !transcript) return null;
    const warnings: string[] = [];
    if (shortMode && activeShort) {
      // ショートモード: render.ts の renderOneShort と同じ組み立て
      // (keeps = shortKeepsMerged、overlays は captionTracks だけ、
      // bgm/silences なし、profile で出力サイズ・レイアウトを切替)。
      // 手編集で不正な profile 名が入っている可能性があるので、throw させず
      // 警告して既定(defaultShortProfileName(proj.hasCamera))にフォールバックする
      // (validate は別途エラーにする)
      let shortProfile: Profile;
      try {
        shortProfile = resolveShortProfile(activeShort.profile, proj.output, proj.hasCamera);
      } catch (e) {
        warnings.push((e as Error).message);
        shortProfile = resolveShortProfile(undefined, proj.output, proj.hasCamera);
      }
      const props = buildRenderProps({
        manifest: proj.manifest,
        keeps: shortKeepsMerged,
        transcript,
        overlays: { captionTracks: activeShort.captionTracks },
        renderCfg: proj.renderCfg,
        width: shortProfile.width,
        height: shortProfile.height,
        profile: shortProfile,
        videoFile: "media/proxy.mp4",
        videoIsSource: true,
        bgm: null,
        bgmFallbackFile: null,
        silences: null,
        overlayExists: () => true,
        warn: (m) => warnings.push(m),
      });
      return { warnings, props };
    }
    const props = buildRenderProps({
      manifest: proj.manifest,
      keeps,
      transcript,
      overlays,
      renderCfg: proj.renderCfg,
      width: proj.output.w,
      height: proj.output.h,
      // fresh な連続ベイクはカット後時刻で1本として再生する。欠落・陳腐・
      // keep 編集直後は source proxy へ即時フォールバックする
      ...(previewBaseVideo ?? {
        videoFile: "media/proxy.mp4" as const,
        videoIsSource: true,
      }),
      // bgm.json(区間配置)を優先。無ければ収録フォルダ直下の bgm.* を
      // 全編1曲で流す(後方互換)。素材ファイルはこの後 media/ 経由に付け替える
      bgm,
      bgmFallbackFile: proj.bgmFile,
      // 発話中の BGM ダッキングもレンダーと同じ聞こえ方にする
      silences: proj.silences,
      overlayExists: (f) => proj.dirFiles.includes(f),
      warn: (m) => warnings.push(m),
    });
    if ((overlays.hideCaption?.length ?? 0) > 0) {
      warnings.push(
        "overlays.json の hideCaption はタイムラインに出ませんが" +
          "プレビュー・レンダーには効いています(テロップの直接編集を推奨)",
      );
    }
    // ぼかし×ズームの時間重なり・ぼかし×ショートの非継承は buildRenderProps が
    // 出さない validate.ts 専用の warn なので、hideCaption と同じ流儀で
    // ここに明示 push する(判断5。保存は通す=warn であって error ではない)
    const blurs = overlays.blurs ?? [];
    if (blurs.length > 0) {
      const zooms = overlays.zooms ?? [];
      for (const b of blurs) {
        if (zooms.some((z) => b.start < z.end && z.start < b.end)) {
          warnings.push(
            `blurs(${fmtTime(b.start)}〜${fmtTime(b.end)})が zoom 区間と時間が重なっています。` +
              "blur は zoom に追従しないため、隠したい情報が矩形からずれて見えることがあります",
          );
          break;
        }
      }
      if ((shorts?.shorts.length ?? 0) > 0) {
        warnings.push(
          "本編に領域ぼかしがありますが、ショートには継承されません。" +
            "ショートに秘匿情報が写る場合は別途隠してください",
        );
      }
    }
    // 注釈グラフィックのショート非継承警告(validate.ts と parity。
    // annotation×zoom の時間重なりは validate が警告しないのでここでも出さない)
    if ((overlays.annotations?.length ?? 0) > 0 && (shorts?.shorts.length ?? 0) > 0) {
      warnings.push(
        "本編に注釈グラフィックがありますが、ショートには継承されません。" +
          "ショートにも指し示したい場合は別途足してください",
      );
    }
    // codec 非対応の素材が overlays/inserts で使われていると Player でも黒く映る。
    // 素材パネルのプレースホルダだけでは Player の空表示を説明できないので
    // バナーにも出す(BGM は音声再生なので対象外)
    const usedFiles = new Set<string>([
      ...(overlays.overlays ?? []).map((o) => o.file),
      ...(overlays.inserts ?? []).map((o) => o.file),
    ]);
    for (const f of usedFiles) {
      const bad = mediaCodecFacts[f];
      if (bad) {
        warnings.push(
          `素材「${f.replace(/^materials\//, "")}」(${bad.codec.toUpperCase()})は` +
            "編集プレビューに映りません(プレビューが黒くてもレンダーには正しく入ります)。" +
            "内容を確認したいときは H.264 に変換した素材に差し替えてください",
        );
      }
    }
    // 素材はローカルサーバーの /media/ 経由で配信される
    const overlayItems = props.overlays.map((o) => ({ ...o, file: `media/${o.file}` }));
    const insertItems = (props.inserts ?? []).map((o) => ({
      ...o,
      file: `media/${o.file}`,
    }));
    const bgmTracks = props.bgm.map((b) => ({ ...b, file: `media/${b.file}` }));
    // デザインの背景画像も収録フォルダ内のファイル(render.design/…)なので、
    // 素材と同じく /media/ 経由に付け替える(付け替え漏れると 404 で背景が
    // 出ず、背景色だけになる)
    const design = designForPlayer(
      props.design,
      props.width,
      props.height,
      proj.designAssets,
    );
    return {
      warnings,
      props: {
        ...props,
        overlays: overlayItems,
        inserts: insertItems,
        bgm: bgmTracks,
        ...(design ? { design } : {}),
      },
    };
  }, [
    proj, cutplan, overlays, transcript, bgm, keeps, shortMode, activeShort, shortKeepsMerged,
    shorts, mediaCodecFacts, previewBaseVideo,
  ]);

  /** Player に渡す props。トラック別ミュート・レイヤーの一時非表示は
   * プレビューにだけ効かせる(built.props は書き出しと同じ内容のまま保つ) */
  const playerProps = useMemo(
    () =>
      built && {
        ...built.props,
        muteBase: trackMuted.cut,
        muteBgm: trackMuted.bgm,
        hiddenLayers,
      },
    [built, trackMuted, hiddenLayers],
  );

  const fps = built?.props.fps ?? 30;
  const duration = built?.props.durationSec ?? 0;
  const durationInFrames = Math.max(1, Math.round(duration * fps));
  const srcDur = proj?.manifest.durationSec ?? 0;
  /** 画像素材・尺不明素材を置くときの既定の尺(秒)。config で変更できる */
  const defaultImgSec = proj?.editorCfg.defaultImageDurationSec ?? 4;
  /** ショート新規追加(addShort)で、選択中の keep クリップもプレイヘッドの
   * 位置も取れないときの既定レンジ長(秒)。config で変更できる */
  const defaultShortRangeSec = proj?.editorCfg.defaultShortRangeSec ?? 10;

  // 未保存の編集の有無。JSON 全体の stringify 比較はドキュメントが
  // 差し替わったときだけ行う(毎レンダーで3ドキュメントを直列化すると、
  // 収録が長いほど再生・ドラッグ中の主要なメインスレッド負荷になる)
  const cutplanDirty = useMemo(
    () => !!proj && JSON.stringify(cutplan) !== JSON.stringify(proj.cutplan),
    [proj, cutplan],
  );
  const overlaysDirty = useMemo(
    () => !!proj && JSON.stringify(overlays) !== JSON.stringify(proj.overlays),
    [proj, overlays],
  );
  const transcriptDirty = useMemo(
    () => !!proj && JSON.stringify(transcript) !== JSON.stringify(proj.transcript),
    [proj, transcript],
  );
  const bgmDirty = useMemo(
    () => !!proj && JSON.stringify(bgm ?? null) !== JSON.stringify(proj.bgm ?? null),
    [proj, bgm],
  );
  const shortsDirty = useMemo(
    () => !!proj && JSON.stringify(shorts ?? null) !== JSON.stringify(proj.shorts ?? null),
    [proj, shorts],
  );
  const anyDirty =
    cutplanDirty || overlaysDirty || transcriptDirty || bgmDirty || shortsDirty;
  const aiBusy = aiWorkflow?.phase === "proposing";
  const aiWorkflowLocked =
    aiWorkflow !== null &&
    ["proposing", "reviewing", "refining", "applying", "saving", "verifying"].includes(aiWorkflow.phase);
  const aiWorkflowReview = isAiWorkflowReviewState(aiWorkflow) ? aiWorkflow : null;
  // SSE ハンドラ(マウント時に固定)から最新の dirty 状態を見るための控え
  dirtyRef.current = anyDirty;

  /* ---------------- 再生・シーク ---------------- */

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame: CallbackListener<"frameupdate"> = (e) => {
      playhead.set(e.detail.frame / fps);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
    };
  }, [fps, videoVersion, proj?.proxyExists]);

  /** Player remount(source⇄baked スワップ・proxy 再生成で videoVersion が
   * 進むと key={videoVersion} 経由で全 remount)後、一時停止中の新しい
   * <video> は最初の seek が来るまで現フレームをデコードせず黒を出し、再生
   * 位置も frame 0 に戻る。remount 直後に現在の再生ヘッドへ seek し直して、
   * 位置復元と初回デコードを同時に促す(手でスクラブすると直る症状の恒久修正)。
   * <video> の準備を待つため rAF を2つ挟む。 */
  useEffect(() => {
    if (!proj?.proxyExists) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const p = playerRef.current;
        if (!p) return;
        p.seekTo(clamp(Math.round(playhead.get() * fps), 0, durationInFrames - 1));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [videoVersion, proj?.proxyExists, fps, durationInFrames]);

  /** Player に渡す音量。0 ちょうどにすると Remotion が内部の AudioContext を
   * 破棄→再生成し、共有 audio タグの登録がずれて unregisterAudio が
   * TypeError を投げるため、聞こえない微小値(-60dB)を下限にする */
  const playerVolume = Math.max(0.001, clamp(volumePct / 100, 0, 1));

  // 音量の適用(Player 再マウント時にも反映し直す)
  useEffect(() => {
    localStorage.setItem("cutflow.editor.volumePct", String(volumePct));
    playerRef.current?.setVolume(playerVolume);
  }, [volumePct, playerVolume, videoVersion, proj?.proxyExists]);
  /** ミュート切替(戻すときは直前の音量へ) */
  const lastVolRef = useRef(100);
  const toggleMute = () => {
    if (volumePct > 0) {
      lastVolRef.current = volumePct;
      setVolumePct(0);
    } else {
      setVolumePct(lastVolRef.current || 100);
    }
  };
  useEffect(() => {
    localStorage.setItem("cutflow.editor.trackMuted", JSON.stringify(trackMuted));
  }, [trackMuted]);
  const toggleTrackMute = (id: AudioTrackId) =>
    setTrackMuted((m) => ({ ...m, [id]: !m[id] }));
  const toggleTrackHide = (id: LayerId) =>
    setHiddenLayers((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  // トラックの削除・番号詰め直しで存在しなくなったレイヤーは非表示リストから
  // 外す(同じ id で作り直した新トラックが隠れたまま始まらないように)
  useEffect(() => {
    setHiddenLayers((h) => {
      const next = h.filter((id) => layerOrder.includes(id));
      return next.length === h.length ? h : next;
    });
  }, [layerOrder]);

  const seekOut = (outT: number) =>
    playerRef.current?.seekTo(clamp(Math.round(outT * fps), 0, durationInFrames - 1));
  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  };
  const stepFrames = (n: number) => {
    const p = playerRef.current;
    if (!p) return;
    p.pause();
    p.seekTo(clamp(p.getCurrentFrame() + n, 0, durationInFrames - 1));
  };
  /** シークバー: ポインタの横位置の割合でカット後の時間へシーク */
  const scrubTo = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekOut(clamp((e.clientX - rect.left) / rect.width, 0, 1) * duration);
  };
  /** カット後の時刻を元収録の秒へ(終端は少し内側に丸める)。
   * ショートモードでは当該ショートの写像(curTimeline)を使う */
  const srcAt = (outT: number): number | null =>
    toSourceTime(clamp(outT, 0, Math.max(0, duration - 0.01)), curTimeline);
  /** 元収録の秒へ再生ヘッドを移動(カット内なら直後の keep へスナップ)。
   * インスペクタの「ここを再生」・発言リストのクリックが使う */
  const seekToSrc = (src: number) => {
    const o = snapToOutput(src, curTimeline);
    if (o !== null) seekOut(clamp(o, 0, Math.max(0, duration - 0.01)));
  };
  /** 再生ヘッド位置の元収録の秒(カット外・挿入クリップ上は null)を返す。
   * 毎フレーム変わる値なので props で値は渡さず、Inspector がクリック時に
   * 読む(ボタンの活性は usePlayheadSelector で null かどうかだけ購読) */
  const getPlayheadSrc = useCallback(
    (): number | null =>
      toSourceTime(clamp(playhead.get(), 0, Math.max(0, duration - 0.01)), curTimeline),
    [curTimeline, duration],
  );

  /* ---------------- タイムラインのクリップ ---------------- */

  const clips = useMemo<Clip[]>(() => {
    if (!transcript || !built) return [];
    if (shortMode) {
      // ショートモード: テロップ(位置編集用に流用)+ ranges 帯だけを描く
      // (D6: 新規サーフェスは最小限。overlays/cut/bgm/insert は非対応・v1)
      if (!activeShort) return [];
      const cs: Clip[] = [];
      transcript.segments.forEach((s, i) => {
        const parts = remapInterval(s.start, s.end, shortTimelineMemo);
        parts.forEach((iv, j) => {
          cs.push({
            kind: "caption", index: i, track: capId(captionTrack(s)),
            outStart: iv.start, outEnd: iv.end, label: s.text.trim(), editable: true,
            noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
          });
        });
      });
      activeShort.ranges.forEach((r, i) => {
        const parts = remapInterval(r.start, r.end, shortTimelineMemo);
        parts.forEach((iv, j) => {
          cs.push({
            kind: "short", index: i, track: "short",
            outStart: iv.start, outEnd: iv.end,
            label: `${r.start.toFixed(1)}s〜${r.end.toFixed(1)}s`, editable: true,
            noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
          });
        });
      });
      return cs;
    }
    if (!cutplan || !overlays) return [];
    const cs: Clip[] = [];
    // テロップ: transcript.segments を直接編集する(index = segments の添字)。
    // セグメントのトラック番号 → caption / cap<N> トラックへ
    transcript.segments.forEach((s, i) => {
      const parts = remapInterval(s.start, s.end, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "caption", index: i, track: capId(captionTrack(s)),
          outStart: iv.start, outEnd: iv.end, label: s.text.trim(), editable: true,
          // 挿入で割れたときは本当の端だけトリム可(継ぎ目の辺は掴めない)
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
        });
      });
    });
    // 素材: エントリのトラック番号 → ov<N> トラックへ(重なりは layerOrder)
    (overlays.overlays ?? []).forEach((sp, i) => {
      const track: TrackId = ovId(overlayTrack(sp));
      const label = sp.file.replace(/^materials\//, "");
      // 挿入で途切れる区間は複数のクリップに割れる(同じ index を指す)
      const parts = remapInterval(sp.start, sp.end, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "overlays", index: i, track,
          outStart: iv.start, outEnd: iv.end, label, editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
        });
      });
    });
    // ワイプ: 常駐レイヤー(表示のみ)+ その上に「全画面」属性スパン。
    // plain(カメラ無し)はワイプトラック自体を出さないので clip も積まない
    if (built.props.cameraRegion) {
      cs.push({
        kind: "wipe", index: 0, track: "wipe",
        outStart: 0, outEnd: duration, label: "カメラ", editable: false, static: true,
      });
      (overlays.wipeFull ?? []).forEach((sp, i) => {
        const parts = remapInterval(sp.start, sp.end, timeline);
        parts.forEach((iv, j) => {
          cs.push({
            kind: "wipeFull", index: i, track: "wipe",
            outStart: iv.start, outEnd: iv.end, label: "全画面", editable: true,
            noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
          });
        });
      });
    }
    // ズーム: 背景レイヤーを拡大する区間(専用の「ズーム」トラック)
    (overlays.zooms ?? []).forEach((z, i) => {
      const parts = remapInterval(z.start, z.end, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "zoom", index: i, track: "zoom",
          outStart: iv.start, outEnd: iv.end, label: "ズーム", editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
        });
      });
    });
    // ぼかし: 領域ぼかし区間(専用の「ぼかし」トラック)
    (overlays.blurs ?? []).forEach((b, i) => {
      const parts = remapInterval(b.start, b.end, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "blur", index: i, track: "blur",
          outStart: iv.start, outEnd: iv.end,
          label: "ぼかし", editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
        });
      });
    });
    // 注釈: 矢印・囲み・スポットライト(専用の「注釈」トラック)
    (overlays.annotations ?? []).forEach((a, i) => {
      const parts = remapInterval(a.start, a.end, timeline);
      const label = a.type === "arrow" ? "矢印" : a.type === "spotlight" ? "スポット" : "囲み";
      parts.forEach((iv, j) => {
        cs.push({
          kind: "annotation", index: i, track: "annotation",
          outStart: iv.start, outEnd: iv.end, label, editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
        });
      });
    });
    // 映像(画面+マイク): keep 区間。挿入が途中に入ると割れる
    cutplan.segments.forEach((s, i) => {
      if (s.action !== "keep") return;
      const parts = remapInterval(s.start, s.end, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "cut", index: i, track: "cut",
          outStart: iv.start, outEnd: iv.end,
          label: `${s.start.toFixed(1)}s〜${s.end.toFixed(1)}s`, editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
          // 波形はマイク音声。keep クリップの中身は元収録と連続なので先頭の秒だけ持つ
          wave: (() => {
            const s = toSourceTime(iv.start, timeline);
            return s !== null ? { src: "", startSec: s } : undefined;
          })(),
        });
      });
    });
    // 映像トラックへの挿入クリップ(インサート編集)。音声ごと合成されるので
    // 波形は素材ファイル自身の音(頭出し startFrom の位置から再生される)。
    // 左端=頭出し(In点トリム)、右端=尺の調整
    insertSpans(keeps, inserts).forEach((sp) => {
      const ins = inserts[sp.index];
      cs.push({
        kind: "insert", index: sp.index, track: "cut",
        outStart: sp.start, outEnd: sp.end,
        label: `↳ ${ins.file.replace(/^materials\//, "")}`,
        editable: true,
        wave: { src: ins.file, startSec: ins.startFrom ?? 0 },
      });
    });
    // BGM。bgm.json があれば区間を編集可能なクリップに(index = tracks の添字)。
    // 挿入・カットで割れると同じ index のクリップが複数できる(overlays と同じ)。
    // 合成はループ再生なので波形もループで描く
    if (bgm?.tracks?.length) {
      bgm.tracks.forEach((t, i) => {
        const label = t.file.replace(/^materials\//, "");
        const parts = remapInterval(t.start, t.end, timeline);
        parts.forEach((iv, j) => {
          cs.push({
            kind: "bgm", index: i, track: "bgm",
            outStart: iv.start, outEnd: iv.end, label, editable: true,
            noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
            wave: { src: t.file, startSec: t.startFrom ?? 0, loop: true },
          });
        });
      });
    } else if (proj?.bgmFile && duration > 0) {
      // 後方互換: bgm.json が無ければ収録フォルダ直下の bgm.* を全編1曲。
      // bgm.json のトラック {start:0, end:srcDur} と同じ見た目で編集可能に描く
      // (端をトリム・本体を移動すると onDragStart で bgm.json 化される)。
      const label = proj.bgmFile.replace(/^materials\//, "");
      const parts = remapInterval(0, srcDur, timeline);
      parts.forEach((iv, j) => {
        cs.push({
          kind: "bgm", index: 0, track: "bgm",
          outStart: iv.start, outEnd: iv.end, label, editable: true,
          noTrimStart: j > 0, noTrimEnd: j < parts.length - 1,
          wave: { src: proj.bgmFile!, startSec: 0, loop: true },
        });
      });
    }
    return cs;
  }, [
    cutplan, overlays, transcript, bgm, built, timeline, duration, proj?.bgmFile,
    shortMode, activeShort, shortTimelineMemo,
  ]);

  /* ---------------- カット編集(分割・keep⇄cut・復元) ----------------
   * cut 区間は削除せず記録として残す(plan の候補と同じ扱い)。だから
   * どの操作も可逆で、映像トラックの継ぎ目の印からいつでも戻せる。 */

  /** 映像トラックの継ぎ目に出す「カットされた区間」の印。cutplan の cut
   * 記録のうち、いまも実際に切られているものだけ(トリムで keep が記録の
   * 上まで伸び直したものは出さない)。同じ継ぎ目に複数の記録があるときは
   * stack で横に少しずらして両方掴めるようにする */
  const cutMarks = useMemo(() => {
    // ショートモードには「カット記録」の概念がない(ranges は独立の keep 集合)
    if (!cutplan || shortMode) return [];
    const marks: CutMark[] = [];
    const stackAt = new Map<number, number>();
    cutplan.segments.forEach((s, i) => {
      if (s.action !== "cut") return;
      if (toOutputTime((s.start + s.end) / 2, timeline) !== null) return;
      const out = round2(snapToOutput(s.start, timeline) ?? duration);
      const stack = stackAt.get(out) ?? 0;
      stackAt.set(out, stack + 1);
      marks.push({ index: i, out, durSec: round2(s.end - s.start), reason: s.reason, stack });
    });
    return marks;
  }, [cutplan, timeline, duration, shortMode]);

  /** outT が keep 区間の内側(境界から MIN_SPAN より内)にあるときだけ
   * 分割できる。-1 = 分割できる位置ではない。再生ヘッドの現在値は
   * 呼び出し側が playhead.get() で渡す(毎フレームの再計算を避けるため
   * レンダー中の固定値は持たない) */
  const splitIndexAt = (outT: number): number => {
    if (!cutplan) return -1;
    const src = srcAt(outT);
    if (src === null) return -1;
    return cutplan.segments.findIndex(
      (s) => s.action === "keep" && src > s.start + MIN_SPAN && src < s.end - MIN_SPAN,
    );
  };

  /** outT が挿入クリップの内側にあるときはそのクリップを分割できる
   * (keep 上とは排他: 挿入の上では srcAt が null なので splitIndexAt は -1)。
   * -1 = 挿入クリップの上ではない */
  const splitInsertIndexAt = (outT: number): number => {
    if (!cutplan) return -1;
    const sp = insertSpans(keeps, inserts).find(
      (s) => outT > s.start + MIN_SPAN && outT < s.end - MIN_SPAN,
    );
    return sp ? sp.index : -1;
  };

  /** 分割ボタンの非活性判定。Timeline 側がボタン単体で再生ヘッドを購読して
   * 評価する(App を毎フレーム再レンダーしないため関数で渡す) */
  const getSplitDisabled = (outT: number): boolean =>
    shortMode || (splitIndexAt(outT) === -1 && splitInsertIndexAt(outT) === -1);

  /** 再生ヘッド位置で keep 区間を2つに割る(⌘K)。割っただけでは映像は
   * 変わらない(隣接 keep はカット後も連続)。割ってから端をトリムして
   * 隙間を作る・片側を Delete でカットする、が「真ん中を抜く」手順になる。
   * 再生ヘッドが挿入クリップの上にあるときはそちらを分割する */
  const splitAtPlayhead = () => {
    if (!cutplan || shortMode) return;
    const outT = playhead.get();
    const splitIndex = splitIndexAt(outT);
    if (splitIndex === -1) {
      splitInsertAtPlayhead(outT);
      return;
    }
    const src = srcAt(outT);
    if (src === null) return;
    pushHistory();
    const segs = [...cutplan.segments];
    const seg = segs[splitIndex];
    // 分割は「境界維持」: 左(先行)側が元 id を保持し、右側は新規要素として
    // id を落とす(保存時に id 有効なら ensureIds が新 id を採番。承認は
    // cut 決定=keep 集合のハッシュだけを見るため、この分割では失効しない)
    segs.splice(
      splitIndex,
      1,
      { ...seg, end: round2(src) },
      { ...seg, start: round2(src), id: undefined },
    );
    setCutplan({ ...cutplan, segments: segs });
    setSelection({ kind: "cut", index: splitIndex + 1 });
  };

  /** 再生ヘッド位置で挿入クリップを2つに割る。前半は尺を縮めるだけ、
   * 後半は同じアンカー(at)に頭出し(startFrom)を進めた「続き」として
   * 直後へ差し込む。同じアンカーの挿入は配列順に連続再生されるので
   * 割っただけでは映像は変わらず、keep の分割と同じく端のトリムや
   * Delete で「真ん中を抜く」「片側だけ残す」ができるようになる */
  const splitInsertAtPlayhead = (outT: number) => {
    const splitInsertIndex = splitInsertIndexAt(outT);
    if (!overlays || splitInsertIndex === -1) return;
    const arr = overlays.inserts ?? [];
    const ins = arr[splitInsertIndex];
    const sp = insertSpans(keeps, inserts).find((s) => s.index === splitInsertIndex);
    if (!ins || !sp) return;
    const head = round2(outT - sp.start);
    pushHistory();
    const next = [...arr];
    // 分割は「境界維持」: 左(先行)側が元 id を保持し、右側は新規要素として
    // id を落とす(cutplan の split と同じ規約。§docs/plans/2026-07-07-stable-ids-design.md)
    next.splice(
      splitInsertIndex,
      1,
      { ...ins, durationSec: head },
      {
        ...ins,
        startFrom: round2((ins.startFrom ?? 0) + head),
        durationSec: round2(ins.durationSec - head),
        id: undefined,
      },
    );
    setOverlays({ ...overlays, inserts: next });
    setSelection({ kind: "insert", index: splitInsertIndex + 1 });
  };

  /** keep 区間をカットへ倒す(Delete キー・Inspector のボタン)。
   * 区間は削除せず cut 記録になり、継ぎ目の印からいつでも戻せる */
  const cutKeepSeg = (i: number) => {
    if (!cutplan) return;
    const s = cutplan.segments[i];
    if (!s || s.action !== "keep") return;
    if (keeps.length <= 1) {
      setError("最後の映像クリップはカットできません");
      return;
    }
    updateCutSeg(i, { action: "cut" });
  };

  /** カットされた区間を keep に戻す。トリムで隣の keep が記録の上まで
   * 伸びていることがあるので、重ならない範囲へ縮めて戻す */
  const restoreCutSeg = (i: number) => {
    if (!cutplan) return;
    const s = cutplan.segments[i];
    if (!s || s.action !== "cut") return;
    let a = s.start;
    let b = s.end;
    for (const k of cutplan.segments) {
      if (k === s || k.action !== "keep") continue;
      if (k.end <= a || k.start >= b) continue;
      if (k.start <= a) a = Math.max(a, k.end);
      else b = Math.min(b, k.start);
    }
    if (b - a < MIN_SPAN) {
      setError("この区間はすでに隣の映像クリップに含まれています");
      return;
    }
    pushHistory();
    const segs = [...cutplan.segments];
    segs[i] = { ...s, start: round2(a), end: round2(b), action: "keep" };
    setCutplan({ ...cutplan, segments: segs });
  };

  /** スクリプトタブ: 選択した語の範囲(元収録の秒)をカットする。
   * 範囲計算は model.ts の純関数(cutSourceRange)で、ここは履歴と state だけ */
  const cutScriptRange = (start: number, end: number) => {
    if (!cutplan || shortMode) return;
    const r = cutSourceRange(cutplan.segments, { start, end }, MIN_SPAN);
    if (!r.ok) {
      if (r.reason === "empty") setError("すべての映像をカットすることはできません");
      return;
    }
    pushHistory();
    setCutplan({ ...cutplan, segments: r.segments });
  };

  /** スクリプトタブ: 取り消し線の範囲(元収録の秒)を keep へ戻す */
  const restoreScriptRange = (start: number, end: number) => {
    if (!cutplan || shortMode) return;
    const r = restoreSourceRange(cutplan.segments, { start, end }, MIN_SPAN);
    if (!r.ok) return;
    pushHistory();
    setCutplan({ ...cutplan, segments: r.segments });
  };

  /* ---------------- プレビュー上のテロップ移動 ---------------- */

  /** 位置未指定テロップの標準位置(下部中央のテキスト中心。1行ぶんで近似) */
  const stdCaptionPos = useMemo<CaptionPos>(() => {
    if (!built) return { x: 0, y: 0 };
    const { width, height, wipe, caption, captionDefaultPos, cameraRegion } = built.props;
    // 縦プリセット等、profile が既定テロップ位置を持つときはそれを使う
    if (captionDefaultPos) return { x: captionDefaultPos.x, y: captionDefaultPos.y };
    // カメラがあるときだけワイプ回避の右側予約を引く(B1 の Remotion 側と同規約)。
    // plain(カメラ無し)は全幅中央
    const reserve = cameraRegion ? wipe.widthPx + wipe.marginPx * 2 : 0;
    return {
      x: Math.round((width - reserve) / 2),
      y: Math.round(height - wipe.marginPx - caption.fontSizePx * 0.7),
    };
  }, [built]);

  /** テロップごとのカット後の表示区間(編集時だけ再計算)。再生中の
   * 「いま表示中か」の判定を毎フレーム軽く済ませるための前計算 */
  const captionIntervals = useMemo(() => {
    if (!transcript) return [];
    return transcript.segments.map((s, i) => ({
      index: i,
      empty: s.text.trim().length === 0,
      ivs: remapInterval(s.start, s.end, curTimeline),
    }));
  }, [transcript, curTimeline]);

  /** outT に表示中のテロップの添字列(LiveCaptionOverlay の購読キー)。
   * キーが変わったとき=表示中の組が入れ替わったときだけ本体を作り直す */
  const visibleCaptionKey = useCallback(
    (outT: number): string => {
      let key = "";
      for (const c of captionIntervals) {
        if (c.empty) continue;
        if (c.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${c.index},`;
      }
      return key;
    },
    [captionIntervals],
  );

  /** outT に表示中のテロップ(プレビュー上でドラッグ移動できる) */
  const getVisibleCaptions = useCallback(
    (outT: number): OverlayCaption[] => {
      if (!transcript || !overlays || !built) return [];
      return captionIntervals.flatMap((c) => {
        if (c.empty) return [];
        if (!c.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        const s = transcript.segments[c.index];
        // 実効位置が確定しているものはトラックの anchor に従い、
        // 位置未指定(下部中央)は中心座標の近似 stdCaptionPos を掴ませる。
        // ショートモードは curCaptionOverlays(当該ショートの captionTracks)
        // から解決する(D2/5-4)
        const pos = captionPosOf(s, curCaptionOverlays);
        const style = captionStyleOf(s, curCaptionOverlays);
        return [
          {
            index: c.index,
            text: s.text.trim(),
            pos: pos ?? stdCaptionPos,
            anchor: pos ? captionAnchorOf(s, curCaptionOverlays) : ("center" as const),
            fontSizePx: style?.fontSizePx ?? built.props.caption.fontSizePx,
            // config の既定(render.caption*)まで解決して渡す(当たり判定の
            // フォント計量を本編の見た目と一致させる)
            fontFamily: style?.fontFamily ?? built.props.caption.fontFamily,
            fontWeight: style?.fontWeight ?? built.props.caption.fontWeight,
          },
        ];
      });
    },
    [captionIntervals, transcript, overlays, built, stdCaptionPos, curCaptionOverlays],
  );

  /** 素材(overlays.overlays)ごとのカット後の表示区間。テロップと同じ流儀で
   * 再生ヘッド購読時の「いま表示中か」を軽く判定するための前計算 */
  const overlayIntervals = useMemo(() => {
    // ショートモードは overlays.json の素材(部分配置)を継承しない(v1 スコープ)
    if (!overlays || shortMode) return [];
    return (overlays.overlays ?? []).map((sp, i) => ({
      index: i,
      ivs: remapInterval(sp.start, sp.end, timeline),
    }));
  }, [overlays, timeline, shortMode]);

  /** outT に表示中の「部分配置(rect あり)」素材の添字列(購読キー)。
   * 全画面(rect なし)はプレビュー上に枠を出さないので含めない */
  const visibleOverlayKey = useCallback(
    (outT: number): string => {
      if (!overlays) return "";
      let key = "";
      for (const o of overlayIntervals) {
        if (!(overlays.overlays ?? [])[o.index]?.rect) continue;
        if (o.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${o.index},`;
      }
      return key;
    },
    [overlayIntervals, overlays],
  );

  /** outT に表示中の部分配置素材(プレビュー上でドラッグ移動・リサイズできる) */
  const getVisibleOverlays = useCallback(
    (outT: number): OverlayRect[] => {
      if (!overlays) return [];
      return overlayIntervals.flatMap((o) => {
        const rect = (overlays.overlays ?? [])[o.index]?.rect;
        if (!rect) return [];
        if (!o.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        return [{ index: o.index, rect }];
      });
    },
    [overlayIntervals, overlays],
  );

  /** ズーム(overlays.zooms)ごとのカット後の表示区間。素材(部分配置)と
   * 同じ流儀でプレビュー上に rect の枠を出す(ショートモードは継承しない) */
  const zoomIntervals = useMemo(() => {
    if (!overlays || shortMode) return [];
    return (overlays.zooms ?? []).map((z, i) => ({
      index: i,
      ivs: remapInterval(z.start, z.end, timeline),
    }));
  }, [overlays, timeline, shortMode]);

  /** outT に表示中のズーム区間の添字列(購読キー) */
  const visibleZoomKey = useCallback(
    (outT: number): string => {
      let key = "";
      for (const z of zoomIntervals) {
        if (z.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${z.index},`;
      }
      return key;
    },
    [zoomIntervals],
  );

  /** outT に表示中のズーム区間(プレビュー上でドラッグ移動・リサイズできる rect) */
  const getVisibleZooms = useCallback(
    (outT: number): OverlayRect[] => {
      if (!overlays) return [];
      return zoomIntervals.flatMap((z) => {
        const rect = (overlays.zooms ?? [])[z.index]?.rect;
        if (!rect) return [];
        if (!z.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        return [{ index: z.index, rect }];
      });
    },
    [zoomIntervals, overlays],
  );

  /** ぼかし(overlays.blurs)ごとのカット後の表示区間。zoom と同じ流儀で
   * プレビュー上に rect の枠を出す(ショートモードは継承しない) */
  const blurIntervals = useMemo(() => {
    if (!overlays || shortMode) return [];
    return (overlays.blurs ?? []).map((b, i) => ({
      index: i,
      ivs: remapInterval(b.start, b.end, timeline),
    }));
  }, [overlays, timeline, shortMode]);

  /** outT に表示中のぼかし区間の添字列(購読キー) */
  const visibleBlurKey = useCallback(
    (outT: number): string => {
      let key = "";
      for (const b of blurIntervals) {
        if (b.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${b.index},`;
      }
      return key;
    },
    [blurIntervals],
  );

  /** outT に表示中のぼかし区間(プレビュー上でドラッグ移動・リサイズできる rect) */
  const getVisibleBlurs = useCallback(
    (outT: number): OverlayRect[] => {
      if (!overlays) return [];
      return blurIntervals.flatMap((b) => {
        const rect = (overlays.blurs ?? [])[b.index]?.rect;
        if (!rect) return [];
        if (!b.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        return [{ index: b.index, rect }];
      });
    },
    [blurIntervals, overlays],
  );

  /** 注釈(overlays.annotations)ごとのカット後の表示区間。box/spotlight(rect)
   * と arrow(点)は type で排他的に扱い、それぞれ別のオーバーレイへ渡す
   * (両方に出すと二重枠になる) */
  const annotationIntervals = useMemo(() => {
    if (!overlays || shortMode) return [];
    return (overlays.annotations ?? []).map((a, i) => ({
      index: i,
      ivs: remapInterval(a.start, a.end, timeline),
    }));
  }, [overlays, timeline, shortMode]);

  /** outT に表示中の box/spotlight 注釈の添字列(購読キー) */
  const visibleAnnotationRectKey = useCallback(
    (outT: number): string => {
      let key = "";
      for (const a of annotationIntervals) {
        const ann = (overlays?.annotations ?? [])[a.index];
        if (ann && ann.type !== "arrow" && a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) {
          key += `${a.index},`;
        }
      }
      return key;
    },
    [annotationIntervals, overlays],
  );
  /** outT に表示中の box/spotlight 注釈(プレビュー上でドラッグ移動・
   * リサイズできる rect。MaterialOverlay を流用) */
  const getVisibleAnnotationRects = useCallback(
    (outT: number): OverlayRect[] =>
      annotationIntervals.flatMap((a) => {
        const ann = (overlays?.annotations ?? [])[a.index];
        if (!ann || ann.type === "arrow") return [];
        if (!a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        return [{ index: a.index, rect: ann.rect }];
      }),
    [annotationIntervals, overlays],
  );

  /** outT に表示中の arrow 注釈の添字列(購読キー) */
  const visibleAnnotationArrowKey = useCallback(
    (outT: number): string => {
      let key = "";
      for (const a of annotationIntervals) {
        const ann = (overlays?.annotations ?? [])[a.index];
        if (ann && ann.type === "arrow" && a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) {
          key += `${a.index},`;
        }
      }
      return key;
    },
    [annotationIntervals, overlays],
  );
  /** outT に表示中の arrow 注釈(プレビュー上で from/to をドラッグできる) */
  const getVisibleAnnotationArrows = useCallback(
    (outT: number): OverlayArrow[] =>
      annotationIntervals.flatMap((a) => {
        const ann = (overlays?.annotations ?? [])[a.index];
        if (!ann || ann.type !== "arrow") return [];
        if (!a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
        return [{ index: a.index, from: ann.from, to: ann.to }];
      }),
    [annotationIntervals, overlays],
  );

  /** テロップトラックの標準位置・標準スタイル・座標基準(anchor)を設定/解除
   * (overlays.json の captionTracks。null で解除、undefined は現状維持)。
   * anchor はトラック標準位置が無くてもセグメント個別の pos の解釈に効くので、
   * 位置と独立に保持する */
  const setCaptionTrackDefault = (
    track: number,
    patch: {
      pos?: CaptionPos | null;
      style?: CaptionStyle | null;
      anchor?: "center" | "topLeft" | null;
    },
    // カラーピッカー・スライダーの連続更新を undo 1回分にまとめる
    // (updateCaption の coalesceKey と同じ仕組み)
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const entry = { ...((prev.captionTracks ?? []).find((t) => t.track === track) ?? { track }) };
      if (patch.pos !== undefined) {
        if (patch.pos) {
          entry.x = patch.pos.x;
          entry.y = patch.pos.y;
        } else {
          delete entry.x;
          delete entry.y;
        }
      }
      if (patch.style !== undefined) {
        if (patch.style && Object.keys(patch.style).length > 0) entry.style = patch.style;
        else delete entry.style;
      }
      if (patch.anchor !== undefined) {
        // center は既定なのでキーごと消す(JSON を汚さない)
        if (patch.anchor && patch.anchor !== "center") entry.anchor = patch.anchor;
        else delete entry.anchor;
      }
      const list = (prev.captionTracks ?? []).filter((t) => t.track !== track);
      // 位置・スタイル・名前・座標基準が全部無くなったらエントリごと消す
      if (
        entry.x !== undefined ||
        entry.y !== undefined ||
        entry.style ||
        entry.name !== undefined ||
        entry.anchor !== undefined
      ) {
        list.push(entry);
      }
      list.sort((a, b) => a.track - b.track);
      const next: Overlays = { ...prev, captionTracks: list };
      if (list.length === 0) delete next.captionTracks;
      return next;
    });
  };

  /** テロップトラックの名前を変更(空文字で解除)。overlays.json の captionTracks */
  const setCaptionTrackName = (track: number, name: string) => {
    pushHistory();
    setOverlays((prev) => {
      if (!prev) return prev;
      const entry = {
        ...((prev.captionTracks ?? []).find((t) => t.track === track) ?? { track }),
      };
      const trimmed = name.trim();
      if (trimmed) entry.name = trimmed;
      else delete entry.name;
      const list = (prev.captionTracks ?? []).filter((t) => t.track !== track);
      // 保持条件は setCaptionTrackDefault と揃える(anchor を落とすと、
      // 名前を消しただけでそのトラックの座標解釈が変わってしまう)
      if (
        entry.x !== undefined ||
        entry.y !== undefined ||
        entry.style ||
        entry.name !== undefined ||
        entry.anchor !== undefined
      ) {
        list.push(entry);
      }
      list.sort((a, b) => a.track - b.track);
      const next: Overlays = { ...prev, captionTracks: list };
      if (list.length === 0) delete next.captionTracks;
      return next;
    });
  };

  /* ---------------- ショート編集(CRUD・ranges・captionTracks) ----------------
   * shorts.json への書き込みはすべてここに集約する。cutplan/overlays/
   * transcript/bgm の undo 履歴(pushHistory/HistoryDocs)には含めない
   * (別ドキュメントで、この程度の編集に undo 一貫性のコストを払う価値が
   * 薄いと判断した意図的な簡略化)。 */

  /** 選択中ショートを部分更新する(見つからなければ何もしない) */
  const updateActiveShort = (updater: (s: Short) => Short) => {
    if (!activeShortName) return;
    setShorts((prev) => {
      if (!prev) return prev;
      const idx = prev.shorts.findIndex((s) => s.name === activeShortName);
      if (idx === -1) return prev;
      const next = [...prev.shorts];
      next[idx] = updater(next[idx]);
      return { shorts: next };
    });
  };

  /** ショートモードのテロップトラック標準位置/スタイル/座標基準の設定
   * (null で解除、undefined は現状維持)。setCaptionTrackDefault と同じ形
   * だが書き込み先が shorts.json の当該ショートの captionTracks(D2/5-4:
   * ショートは per-segment 上書きを持たず、常にトラック単位) */
  const setShortCaptionTrackDefault = (
    track: number,
    patch: {
      pos?: CaptionPos | null;
      style?: CaptionStyle | null;
      anchor?: "center" | "topLeft" | null;
    },
  ) => {
    updateActiveShort((short) => {
      const entry = {
        ...((short.captionTracks ?? []).find((t) => t.track === track) ?? { track }),
      };
      if (patch.pos !== undefined) {
        if (patch.pos) {
          entry.x = patch.pos.x;
          entry.y = patch.pos.y;
        } else {
          delete entry.x;
          delete entry.y;
        }
      }
      if (patch.style !== undefined) {
        if (patch.style && Object.keys(patch.style).length > 0) entry.style = patch.style;
        else delete entry.style;
      }
      if (patch.anchor !== undefined) {
        if (patch.anchor && patch.anchor !== "center") entry.anchor = patch.anchor;
        else delete entry.anchor;
      }
      const list = (short.captionTracks ?? []).filter((t) => t.track !== track);
      if (
        entry.x !== undefined ||
        entry.y !== undefined ||
        entry.style ||
        entry.name !== undefined ||
        entry.anchor !== undefined
      ) {
        list.push(entry);
      }
      list.sort((a, b) => a.track - b.track);
      const next: Short = { ...short, captionTracks: list };
      if (list.length === 0) delete next.captionTracks;
      return next;
    });
  };

  /** ショートの ranges 区間を更新(タイムラインのドラッグ・Inspector の
   * タイミング編集の両方から呼ばれる) */
  const updateShortRange = (i: number, patch: Partial<{ start: number; end: number }>) => {
    updateActiveShort((short) => {
      const ranges = [...short.ranges];
      if (!ranges[i]) return short;
      ranges[i] = { ...ranges[i], ...patch };
      return { ...short, ranges };
    });
  };
  /** ranges 区間を1つ追加(元収録の秒) */
  const addShortRange = (start: number, end: number) => {
    if (!activeShort) return;
    const index = activeShort.ranges.length;
    updateActiveShort((short) => ({ ...short, ranges: [...short.ranges, { start, end }] }));
    setSelection({ kind: "short", index });
  };
  /** ranges 区間を1つ削除(最後の1件は残す。cutKeepSeg と同じ理由) */
  const removeShortRange = (i: number) => {
    if (!activeShort) return;
    if (activeShort.ranges.length <= 1) {
      setError("ショートの最後の区間は削除できません");
      return;
    }
    updateActiveShort((short) => ({ ...short, ranges: short.ranges.filter((_, j) => j !== i) }));
    setSelection(null);
  };

  /** 収録内で一意なショート名を作る("short-1", "short-2", ...) */
  const nextShortName = (): string => {
    const used = new Set((shorts?.shorts ?? []).map((s) => s.name));
    for (let i = 1; ; i++) {
      const name = `short-${i}`;
      if (!used.has(name)) return name;
    }
  };
  /** ショートを1本追加(承認は人間の仕事なので approved: false 固定)。
   * 既定 ranges は優先順に: (a) 本編で keep クリップ選択中ならその区間、
   * (b) 無ければプレイヘッドの現在元秒から defaultShortRangeSec 分、
   * (c) それも取れなければ先頭から defaultShortRangeSec 分。
   * 追加したショートへそのままモードを切り替える */
  const addShort = () => {
    const name = nextShortName();
    const selCut =
      selection?.kind === "cut" ? cutplan?.segments[selection.index] : undefined;
    let range: { start: number; end: number };
    if (selCut) {
      range = { start: round2(selCut.start), end: round2(selCut.end) };
    } else {
      const src = toSourceTime(playhead.get(), timeline);
      const start = src !== null ? round2(src) : 0;
      range = { start, end: round2(Math.min(start + defaultShortRangeSec, srcDur)) };
    }
    const short: Short = { name, approved: false, ranges: [range] };
    setShorts((prev) => ({ shorts: [...(prev?.shorts ?? []), short] }));
    setActiveShortName(name);
  };
  /** ショートをリネーム(名前は shorts.json 内で一意な必要がある) */
  const renameShort = (oldName: string, newName: string): void => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if ((shorts?.shorts ?? []).some((s) => s.name === trimmed)) {
      setError(`ショート名が重複しています: ${trimmed}`);
      return;
    }
    setShorts(
      (prev) =>
        prev && {
          shorts: prev.shorts.map((s) => (s.name === oldName ? { ...s, name: trimmed } : s)),
        },
    );
    if (activeShortName === oldName) setActiveShortName(trimmed);
  };
  /** ショートを削除する(確認は呼び出し側 = パネルで挟む) */
  const removeShort = (name: string) => {
    setShorts((prev) => prev && { shorts: prev.shorts.filter((s) => s.name !== name) });
    if (activeShortName === name) setActiveShortName(null);
  };

  /* ---------------- ドラッグ編集 ----------------
   * ドラッグ開始時点のドキュメント・写像・掴んだクリップの位置を控えておき、
   * 毎回「控え+累計移動量」から作り直す(トリムでタイムライン自体が動いても
   * 基準がぶれないように)。Δ はカット後の秒なので、掴んだ辺のカット後位置に
   * 足してから元収録の秒へ逆変換する(カット境界をまたいでもポインタに追従)。 */

  const dragRef = useRef<{
    sel: NonNullable<Selection>;
    mode: DragMode;
    cutplan: CutPlan;
    overlays: Overlays;
    transcript: Transcript;
    bgm: Bgm | null;
    /** ショートモードのドラッグ開始時スナップショット(本編モードでは null) */
    shorts: Shorts | null;
    /** ドラッグ開始時の写像と、掴んだクリップのカット後位置(Δ の基準)。
     * ショートモードでは shortTimelineMemo(当該ショートの写像) */
    timeline: TimelineEntry[];
    grabOutStart: number;
    grabOutEnd: number;
    /** このドラッグを undo 履歴へ積んだか(最初に動いた瞬間に1回だけ積む) */
    pushed: boolean;
  } | null>(null);

  const onDragStart = (sel: NonNullable<Selection>, mode: DragMode, clip: Clip) => {
    if (!cutplan || !overlays || !transcript) return;
    dragRef.current = {
      sel, mode, cutplan, overlays, transcript, bgm, shorts,
      timeline: curTimeline, grabOutStart: clip.outStart, grabOutEnd: clip.outEnd, pushed: false,
    };
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };
  const onDragMove = (d: number, overTrack: TrackId) => {
    const ctx = dragRef.current;
    if (!ctx) return;
    // クリックだけ(移動なし)では積まない。ドラッグ中の更新は毎回届くが
    // 履歴はドラッグ開始前の状態1回分だけ(1ドラッグ=1 undo)。
    // ショート(shorts.json)の編集は cutplan/overlays/transcript/bgm の
    // undo 履歴には含めない(意図的な簡略化。上のコメント参照)
    if (!ctx.pushed && ctx.sel.kind !== "short") {
      ctx.pushed = true;
      pushHistory();
    }
    const { sel, mode } = ctx;
    const tl = ctx.timeline;
    const outDur = timelineDuration(tl);
    /** ドラッグ開始時のカット後位置 out0 に移動量を足し、元収録の秒へ逆変換 */
    const dragTo = (out0: number, delta: number): number | null =>
      toSourceTime(clamp(out0 + delta, 0, Math.max(0, outDur - 0.01)), tl);
    /** 区間(元収録の秒)の move / trim。カット後の座標を経由して計算する */
    const retime = (span: {
      start: number;
      end: number;
    }): { start: number; end: number } | null => {
      if (mode === "move") {
        const a0 = dragTo(ctx.grabOutStart, 0);
        const a1 = dragTo(ctx.grabOutStart, d);
        if (a0 === null || a1 === null) return null;
        const dd = clamp(a1 - a0, -span.start, srcDur - span.end);
        return { start: round2(span.start + dd), end: round2(span.end + dd) };
      }
      if (mode === "trim-start") {
        const ns = dragTo(ctx.grabOutStart, d);
        if (ns === null) return null;
        return { start: round2(clamp(ns, 0, span.end - MIN_SPAN)), end: span.end };
      }
      const ne = dragTo(ctx.grabOutEnd, d);
      if (ne === null) return null;
      return { start: span.start, end: round2(clamp(ne, span.start + MIN_SPAN, srcDur)) };
    };
    if (sel.kind === "cut") {
      const segs = ctx.cutplan.segments;
      const seg = segs[sel.index];
      // 動かせる範囲は隣の keep まで(間の cut 区間は候補の記録なので跨いでよい)
      const keepIdx = segs
        .map((s, i) => ({ s, i }))
        .filter((x) => x.s.action === "keep");
      const pos = keepIdx.findIndex((x) => x.i === sel.index);
      if (pos === -1) return;
      const lo = pos > 0 ? keepIdx[pos - 1].s.end : 0;
      const hi = pos < keepIdx.length - 1 ? keepIdx[pos + 1].s.start : srcDur;
      let { start, end } = seg;
      if (mode === "move") {
        const dd = clamp(d, lo - seg.start, hi - seg.end);
        start = seg.start + dd;
        end = seg.end + dd;
      } else if (mode === "trim-start") {
        start = clamp(seg.start + d, lo, seg.end - MIN_SPAN);
      } else {
        end = clamp(seg.end + d, seg.start + MIN_SPAN, hi);
      }
      const next = [...segs];
      next[sel.index] = { ...seg, start: round2(start), end: round2(end) };
      setCutplan({ ...ctx.cutplan, segments: next });
    } else if (sel.kind === "insert") {
      const arr = [...(ctx.overlays.inserts ?? [])];
      const ins = arr[sel.index];
      if (!ins) return;
      if (mode === "trim-end") {
        arr[sel.index] = {
          ...ins,
          durationSec: round2(Math.max(MIN_SPAN, ins.durationSec + d)),
        };
      } else if (mode === "trim-start") {
        // 頭出し(In点トリム / ripple-trim-in): 割り込み位置 at は固定。素材の頭を
        // 削り(startFrom 増・尺減)、out 点(startFrom+尺)は保つ。左端は動かず
        // 右端が縮み、後続はカット後タイムラインで左へ詰まる(ベースは前に増えない)。
        // 頭が削れていることは波形(startSec=startFrom)が後ろへずれることで分かる
        const sf0 = ins.startFrom ?? 0;
        const out = sf0 + ins.durationSec;
        const sf1 = clamp(round2(sf0 + d), 0, round2(out - MIN_SPAN));
        const next = { ...ins, durationSec: round2(out - sf1) };
        if (sf1 > 0) next.startFrom = sf1;
        else delete next.startFrom;
        arr[sel.index] = next;
      } else {
        // move: 自分を除いた写像の上でアンカー(元収録の秒)を追従させる
        const others = arr.filter((_, j) => j !== sel.index);
        const tlx = buildTimeline(keepsOf(ctx.cutplan), others);
        const durX = timelineDuration(tlx);
        const out0 = snapToOutput(ins.at, tlx) ?? durX;
        const target = out0 + d;
        if (target >= durX - 0.005) {
          // 末尾までドラッグしたら「最後の keep の後ろ」にアンカーする
          arr[sel.index] = { ...ins, at: round2(srcDur) };
        } else {
          const ns = toSourceTime(clamp(target, 0, Math.max(0, durX - 0.01)), tlx);
          if (ns === null) return;
          arr[sel.index] = { ...ins, at: round2(ns) };
        }
      }
      setOverlays({ ...ctx.overlays, inserts: arr });
    } else if (sel.kind === "caption") {
      const segs = [...ctx.transcript.segments];
      const s = segs[sel.index];
      if (!s) return;
      const t = retime(s);
      if (!t) return;
      const entry = { ...s, ...t };
      // テロップを上下のトラックへドラッグしたら track(z-index)を移す
      if (mode === "move") {
        const n = capNum(overTrack);
        if (n !== null && n !== captionTrack(s)) {
          if (n > 1) entry.track = n;
          else delete entry.track;
        }
      }
      segs[sel.index] = entry;
      setTranscript({ ...ctx.transcript, segments: segs });
    } else if (sel.kind === "overlays" || sel.kind === "wipeFull") {
      const kind = sel.kind;
      const arr = [...(ctx.overlays[kind] ?? [])];
      const sp = arr[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      const entry = { ...sp, ...t };
      // 素材を上下のトラックへドラッグしたら track(z-index)を移す
      if (kind === "overlays" && mode === "move") {
        const n = ovNum(overTrack);
        if (n !== null && n !== overlayTrack(sp as OverlayEntry)) {
          const e = entry as OverlayEntry;
          delete e.layer; // 旧式指定はここで track へ移行する
          if (n > 1) e.track = n;
          else delete e.track;
        }
      }
      // 動画素材の左端(In点)トリム: 左端を右へ削ったら頭出し(startFrom)を
      // 同量進めて素材の out 点(startFrom+尺)を保つ = 動画の先頭が削れる
      // (右端トリムは尺が縮むだけ = 後尾から削れる)。進める量はカット後
      // (出力)秒。画像は頭が無いので従来どおり表示窓を縮めるだけ(bgm と同じ流儀)
      if (kind === "overlays" && mode === "trim-start" && !isImageFile((sp as OverlayEntry).file)) {
        const o1 = toOutputTime(t.start, tl);
        if (o1 !== null) {
          const e = entry as OverlayEntry;
          const sf = round2(((sp as OverlayEntry).startFrom ?? 0) + (o1 - ctx.grabOutStart));
          if (sf > 0) e.startFrom = sf;
          else delete e.startFrom;
        }
      }
      arr[sel.index] = entry;
      setOverlays({ ...ctx.overlays, [kind]: arr });
    } else if (sel.kind === "zoom") {
      // ズーム区間の move / trim。rect / easeSec は動かさない
      const arr = [...(ctx.overlays.zooms ?? [])];
      const sp = arr[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      // ズームは重なれない(validate がエラー=保存できなくなる)ので、隣の
      // ズームの手前で止める。カットの中へ丸ごと落ちた区間はタイムラインに
      // クリップが出ず選択も削除もできなくなるので、その編集も採らない
      const fit = fitZoomSpan(
        arr.filter((_, j) => j !== sel.index),
        t,
        mode,
        MIN_SPAN,
      );
      if (!fit || remapInterval(fit.start, fit.end, tl).length === 0) return;
      arr[sel.index] = { ...sp, ...fit };
      setOverlays({ ...ctx.overlays, zooms: arr });
    } else if (sel.kind === "blur") {
      // ぼかし区間の move / trim。rect / strength は動かさない
      const arr = [...(ctx.overlays.blurs ?? [])];
      const sp = arr[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      arr[sel.index] = { ...sp, ...t };
      setOverlays({ ...ctx.overlays, blurs: arr });
    } else if (sel.kind === "annotation") {
      // 注釈区間の move / trim。start/end 以外(rect/from/to/見た目)は動かさない
      const arr = [...(ctx.overlays.annotations ?? [])];
      const sp = arr[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      arr[sel.index] = { ...sp, ...t };
      setOverlays({ ...ctx.overlays, annotations: arr });
    } else if (sel.kind === "bgm") {
      // BGM 区間の move / trim。トラック間移動はない(BGM は1トラック)。
      // 後方互換の全編 BGM(bgm.json 無し)を初めて動かしたら、ここで
      // tracks[0]=元収録の全編 として bgm.json 化する(履歴は上の
      // pushHistory で materialize 前=null を積んでいるので ⌘Z で全編へ戻る)
      let tracks: Bgm["tracks"];
      if (!ctx.bgm?.tracks?.length) {
        if (!proj?.bgmFile || srcDur <= 0) return;
        const base = { start: 0, end: round2(srcDur), file: proj.bgmFile };
        // ctx.bgm はドラッグ中の不変スナップショット。書き換え用の tracks とは
        // 別配列にして、毎フレームの retime が元の全編を基準に計算されるようにする
        ctx.bgm = { tracks: [base] };
        tracks = [base];
      } else {
        tracks = [...ctx.bgm.tracks];
      }
      const sp = tracks[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      const next = { ...sp, ...t };
      if (mode === "trim-start") {
        // 左端を削ったら、その分だけ音源の頭出し(startFrom)を進める。
        // 末尾の音の位置は動かさない = NLE の In 点トリム(曲の先頭が削れる)。
        // 削り量はカット後(出力)秒で数える。波形の startSec も startFrom に
        // 追従するので、頭が飛んでいることが見た目でも分かる
        const o1 = toOutputTime(t.start, tl);
        if (o1 !== null) {
          const sf = round2((sp.startFrom ?? 0) + (o1 - ctx.grabOutStart));
          if (sf > 0) next.startFrom = sf;
          else delete next.startFrom;
        }
      }
      tracks[sel.index] = next;
      setBgm({ tracks });
    } else if (sel.kind === "short") {
      // ショートの ranges 区間。move/trim の計算は overlays/wipeFull と同じ
      // retime を流用(ranges は重なり・不整列でもよい。mergeIntervals は
      // buildRenderProps 側で行う。D2)
      const shortsDoc = ctx.shorts;
      if (!shortsDoc) return;
      const idx = shortsDoc.shorts.findIndex((s) => s.name === activeShortName);
      if (idx === -1) return;
      const short = shortsDoc.shorts[idx];
      const ranges = [...short.ranges];
      const r = ranges[sel.index];
      if (!r) return;
      const t = retime(r);
      if (!t) return;
      ranges[sel.index] = t;
      setShorts({
        shorts: shortsDoc.shorts.map((s, i) => (i === idx ? { ...short, ranges } : s)),
      });
    }
  };

  /* ---------------- 区間・章・テロップの追加/更新/削除 ---------------- */

  const addOverlaySpan = (start: number, end: number, track = 1, file?: string) => {
    if (!overlays) return;
    const f = file ?? materials[0];
    if (!f) {
      setError(
        "素材がありません。「素材を読み込む…」でアップロードするか、" +
          "収録フォルダの materials/ に画像・動画を置いてください",
      );
      return;
    }
    pushHistory();
    const list = [
      ...(overlays.overlays ?? []),
      { start, end, file: f, ...(track > 1 ? { track } : {}) },
    ];
    setOverlays({ ...overlays, overlays: list });
    setSelection({ kind: "overlays", index: list.length - 1 });
  };
  /** BGM 区間を1つ追加(元収録の秒)。file 省略時は既存の BGM /
   * 収録フォルダ内の音声・動画から自動で選ぶ(無ければエラー) */
  const addBgmSpan = (start: number, end: number, file?: string) => {
    const f =
      file ??
      proj?.bgmFile ??
      proj?.dirFiles.find((d) => BGM_EXT_RE.test(d));
    if (!f) {
      setError(
        "BGM に使える音声・動画がありません。BGM トラックへ音声ファイルを" +
          "ドロップするか、収録フォルダに置いてください",
      );
      return;
    }
    pushHistory();
    const tracks = [...(bgm?.tracks ?? []), { start, end, file: f }];
    setBgm({ tracks });
    setSelection({ kind: "bgm", index: tracks.length - 1 });
  };
  const addWipeFull = (start: number, end: number) => {
    if (!overlays) return;
    pushHistory();
    const list = [...(overlays.wipeFull ?? []), { start, end }];
    setOverlays({ ...overlays, wipeFull: list });
    setSelection({ kind: "wipeFull", index: list.length - 1 });
  };
  /** ズーム区間を1つ追加。既定 rect は出力中央の半分サイズ(2倍ズーム相当)。
   * インスペクタ・プレビュー上の枠で調整する前提の叩き台 */
  const addZoomSpan = (start: number, end: number) => {
    if (!overlays || !proj) return;
    // ズームは重なれない。既存ズームの上に重なる分は手前で切り、丸ごと
    // 重なるなら作らない(作れてしまうと validate で保存できなくなる)
    const fit = fitZoomSpan(overlays.zooms ?? [], { start, end }, "create", MIN_SPAN);
    if (!fit) {
      setError(
        "ここには既にズームがあります。ズームは重ねられません" +
          "(別の区間に作るか、既存のズームを編集してください)",
      );
      return;
    }
    pushHistory();
    const w = Math.round(proj.output.w / 2);
    const h = Math.round(proj.output.h / 2);
    const rect = {
      x: Math.round((proj.output.w - w) / 2),
      y: Math.round((proj.output.h - h) / 2),
      w,
      h,
    };
    const list = [...(overlays.zooms ?? []), { ...fit, rect }];
    setOverlays({ ...overlays, zooms: list });
    setSelection({ kind: "zoom", index: list.length - 1 });
  };
  /** ぼかし区間を1つ追加。既定 rect は出力中央の小さめ矩形(幅1/3・高さ1/6)。
   * 目隠し対象からずれていることが多い叩き台なので、Inspector・プレビュー枠
   * ドラッグでの調整前提。type/strength は省略(既定 blur/0.5)で JSON を汚さない */
  const addBlurSpan = (start: number, end: number) => {
    if (!overlays || !proj) return;
    pushHistory();
    const w = Math.round(proj.output.w / 3);
    const h = Math.round(proj.output.h / 6);
    const rect = {
      x: Math.round((proj.output.w - w) / 2),
      y: Math.round((proj.output.h - h) / 2),
      w,
      h,
    };
    const list = [...(overlays.blurs ?? []), { start, end, rect }];
    setOverlays({ ...overlays, blurs: list });
    setSelection({ kind: "blur", index: list.length - 1 });
  };
  /** 注釈区間を1つ追加。既定は box(囲み)。中央付近の矩形を叩き台にする
   * (Inspector で矢印/スポットライトへ切替・rect/from-to を調整する前提) */
  const addAnnotationSpan = (start: number, end: number) => {
    if (!overlays || !proj) return;
    pushHistory();
    const w = Math.round(proj.output.w / 3);
    const h = Math.round(proj.output.h / 4);
    const rect = {
      x: Math.round((proj.output.w - w) / 2),
      y: Math.round((proj.output.h - h) / 2),
      w,
      h,
    };
    const list: Annotation[] = [...(overlays.annotations ?? []), { type: "box", start, end, rect }];
    setOverlays({ ...overlays, annotations: list });
    setSelection({ kind: "annotation", index: list.length - 1 });
  };
  const addCaption = (start: number, end: number, track = 1) => {
    if (!transcript) return;
    pushHistory();
    // 表示順に影響するので開始時刻順を保って挿入する
    const segs = [...transcript.segments];
    let at = segs.findIndex((s) => s.start > start);
    if (at === -1) at = segs.length;
    segs.splice(at, 0, { start, end, text: "テロップ", ...(track > 1 ? { track } : {}) });
    setTranscript({ ...transcript, segments: segs });
    setSelection({ kind: "caption", index: at });
  };
  const addByKind = (kind: AddKind, start: number, end: number, track?: number) => {
    if (kind === "overlays") addOverlaySpan(start, end, track);
    else if (kind === "wipeFull") addWipeFull(start, end);
    else if (kind === "zoom") addZoomSpan(start, end);
    else if (kind === "blur") addBlurSpan(start, end);
    else if (kind === "annotation") addAnnotationSpan(start, end);
    else if (kind === "bgm") addBgmSpan(start, end);
    else if (kind === "short") addShortRange(start, end);
    else addCaption(start, end, track);
  };

  const onCreate = (track: TrackId, outStart: number, outEnd: number) => {
    const s = srcAt(outStart);
    const e = srcAt(outEnd);
    if (s === null || e === null || e - s < MIN_SPAN / 2) return;
    const n = ovNum(track);
    const cn = capNum(track);
    if (n !== null) {
      addByKind("overlays", round2(s), round2(e), n);
    } else if (track === "wipe") {
      addByKind("wipeFull", round2(s), round2(e));
    } else if (track === "zoom") {
      addByKind("zoom", round2(s), round2(e));
    } else if (track === "blur") {
      addByKind("blur", round2(s), round2(e));
    } else if (track === "annotation") {
      addByKind("annotation", round2(s), round2(e));
    } else if (track === "bgm") {
      addByKind("bgm", round2(s), round2(e));
    } else if (track === "short") {
      addByKind("short", round2(s), round2(e));
    } else if (cn !== null) {
      addByKind("caption", round2(s), round2(e), cn);
    }
  };

  /** トラックのラベルを toTrackIdx 行目へ。layerOrder(下→上)に変換して保存 */
  const onReorderTrack = (id: TrackId, toTrackIdx: number) => {
    if (!overlays) return;
    const order = [...layerOrder];
    const from = order.indexOf(id as LayerId);
    if (from === -1) return;
    // トラック表示は上=前面なので添字を反転(映像・BGM 行へは端に丸める)
    const to = clamp(order.length - 1 - toTrackIdx, 0, order.length - 1);
    if (to === from) return;
    pushHistory();
    order.splice(from, 1);
    order.splice(to, 0, id as LayerId);
    const next: Overlays = { ...overlays, layerOrder: order };
    // 既定の並びに戻したらキーごと消す(JSON を汚さない)
    if (
      order.length === DEFAULT_LAYER_ORDER.length &&
      order.every((v, i) => v === DEFAULT_LAYER_ORDER[i])
    ) {
      delete next.layerOrder;
    }
    setOverlays(next);
  };

  /** トラックを1本追加(同じ種類の一番上のトラックの直上に積む)。
   * テロップトラックは transcript には何も書かず layerOrder だけで増える */
  const addTrack = (kind: "caption" | "overlay") => {
    if (!overlays) return;
    pushHistory();
    const order = [...layerOrder];
    if (kind === "overlay") {
      const topIdx = order.reduce((top, id, i) => (ovNum(id) !== null ? i : top), 0);
      order.splice(topIdx + 1, 0, ovId(ovTracks + 1));
    } else {
      const topIdx = order.reduce((top, id, i) => (capNum(id) !== null ? i : top), 0);
      order.splice(topIdx + 1, 0, capId(capTracks + 1));
    }
    setOverlays({ ...overlays, layerOrder: order });
  };

  /** 既定の並びに戻ったら layerOrder キーごと消す(JSON を汚さない) */
  const withLayerOrder = (base: Overlays, order: LayerId[]): Overlays => {
    const next: Overlays = { ...base, layerOrder: order };
    if (
      order.length === DEFAULT_LAYER_ORDER.length &&
      order.every((v, i) => v === DEFAULT_LAYER_ORDER[i])
    ) {
      delete next.layerOrder;
    }
    return next;
  };

  /** 空の素材/テロップトラックを削除し、上のトラックの番号を詰める */
  const removeTrack = (id: TrackId) => {
    if (!overlays || !transcript) return;
    const n = ovNum(id);
    const cn = capNum(id);
    if (n !== null) {
      if (ovTracks <= 1) return;
      const entries = overlays.overlays ?? [];
      if (entries.some((o) => overlayTrack(o) === n)) return; // 空トラックのみ
      pushHistory();
      const order = layerOrder
        .filter((x) => x !== id)
        .map((x) => {
          const m = ovNum(x);
          return m !== null && m > n ? ovId(m - 1) : x;
        });
      const renumbered = entries.map((o) => {
        const t = overlayTrack(o);
        if (t <= n) return o;
        const { layer: _l, track: _t, ...rest } = o;
        return t - 1 > 1 ? { ...rest, track: t - 1 } : rest;
      });
      const next = withLayerOrder({ ...overlays, overlays: renumbered }, order);
      if (!overlays.overlays) delete next.overlays;
      setOverlays(next);
    } else if (cn !== null) {
      if (capTracks <= 1) return;
      const segs = transcript.segments;
      if (segs.some((s) => captionTrack(s) === cn)) return; // 空トラックのみ
      pushHistory();
      const order = layerOrder
        .filter((x) => x !== id)
        .map((x) => {
          const m = capNum(x);
          return m !== null && m > cn ? capId(m - 1) : x;
        });
      const renumbered = segs.map((s) => {
        const t = captionTrack(s);
        if (t <= cn) return s;
        const { track: _t, ...rest } = s;
        return t - 1 > 1 ? { ...rest, track: t - 1 } : rest;
      });
      setOverlays(withLayerOrder(overlays, order));
      setTranscript({ ...transcript, segments: renumbered });
    }
  };

  /* ---------------- 素材のアップロード ---------------- */

  const fileInputRef = useRef<HTMLInputElement>(null);

  /** アップロードして配置する(動画は実尺、画像は4秒)。
   * at = null はボタン経由: 再生ヘッド位置・一番手前の素材トラック。
   * insert はドロップ経由のみ(at 必須) */
  const uploadAndPlace = async (
    f: File,
    at: { track: TrackId; outT: number } | null,
    mode: "overlay" | "insert" | "bgm",
  ) => {
    setBusy("upload");
    setError(null);
    try {
      const res = await uploadMaterial(f);
      setProj(
        (p) =>
          p && {
            ...p,
            dirFiles: p.dirFiles.includes(res.file)
              ? p.dirFiles
              : [...p.dirFiles, res.file].sort(),
          },
      );
      // 新しくアップロードした素材が非対応 codec なら、配置後すぐプレースホルダ/
      // バナーに反映されてほしい(配置は続けて行う=感知は非同期・待たない)
      refreshMediaFacts();
      if (mode === "insert") {
        if (!at) return;
        // ドロップ位置にアンカー(末尾なら最後の keep の後ろへ)
        const anchor = at.outT >= duration - 0.05 ? srcDur : srcAt(at.outT);
        if (anchor === null) {
          setError("挿入位置を特定できません(映像クリップの上にドロップしてください)");
          return;
        }
        placeInsert(res.file, res.durationSec, anchor);
        return;
      }
      if (mode === "bgm") {
        const s = srcAt(at?.outT ?? playhead.get());
        if (s === null) return;
        // 尺不明の音声は動画末尾まで敷く(ループ合成されるので長さは足りる)
        const dur = res.durationSec ?? srcDur - s;
        addBgmSpan(round2(s), round2(Math.min(s + dur, srcDur)), res.file);
        return;
      }
      const outT = at?.outT ?? playhead.get();
      const s = srcAt(outT);
      if (s === null) return;
      const dur = res.durationSec ?? defaultImgSec;
      const track = (at ? ovNum(at.track) : null) ?? ovTracks; // 既定は一番手前
      addOverlaySpan(round2(s), round2(Math.min(s + dur, srcDur)), track, res.file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** アップロードのみ(配置しない)。ボタン・素材パネルのドロップゾーン用。
   * 複数ファイルを順次(直列)アップロードする — サーバは衝突時に stem-2/-3 を
   * 採番するので、並列だと同名採番が競合しうる。dirFiles(プール)だけ更新し、
   * addOverlaySpan/placeInsert/addBgmSpan は一切呼ばない=決して配置しない。
   * 1件の失敗で残りを止めず、失敗はまとめて報告する。 */
  const uploadOnly = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy("upload");
    const toastId = addToast({
      kind: "progress",
      message: `0/${files.length} 件アップロード中…`,
    });
    const errors: string[] = [];
    let done = 0;
    for (const f of files) {
      try {
        const res = await uploadMaterial(f);
        setProj(
          (p) =>
            p && {
              ...p,
              dirFiles: p.dirFiles.includes(res.file)
                ? p.dirFiles
                : [...p.dirFiles, res.file].sort(),
            },
        );
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`);
      } finally {
        done++;
        updateToast(toastId, { message: `${done}/${files.length} 件アップロード中…` });
      }
    }
    // 複数ファイルを直列アップロードした後にまとめて1回だけ取り直す
    // (ファイルごとに叩くと N 回の ffprobe 往復になる)
    refreshMediaFacts();
    setBusy(null);
    if (errors.length === 0) {
      updateToast(toastId, {
        kind: "success",
        message: `${files.length} 件の素材を追加しました`,
        ttlMs: TOAST_TTL_MS.success,
      });
    } else if (errors.length < files.length) {
      updateToast(toastId, {
        kind: "error",
        message: `${files.length - errors.length} 件成功 / ${errors.length} 件失敗: ${errors.join(" / ")}`,
        ttlMs: TOAST_TTL_MS.error,
      });
    } else {
      updateToast(toastId, {
        kind: "error",
        message: `アップロード失敗: ${errors.join(" / ")}`,
        ttlMs: TOAST_TTL_MS.error,
      });
    }
  };

  const onUploadClick = () => {
    fileInputRef.current?.click();
  };
  const onDropFile = (track: TrackId, outT: number, f: File) => {
    if (track === "bgm") {
      if (!BGM_EXT_RE.test(f.name)) {
        setError("BGM には音声か、音のある動画を使ってください(画像は置けません)");
        return;
      }
      void uploadAndPlace(f, { track, outT }, "bgm");
    } else if (AUDIO_ONLY_RE.test(f.name)) {
      setError("音声ファイルは BGM トラックへドロップしてください(素材・映像トラックには置けません)");
    } else if (track === "cut") {
      void uploadAndPlace(f, { track, outT }, "insert");
    } else if (ovNum(track) !== null) {
      void uploadAndPlace(f, { track, outT }, "overlay");
    }
  };
  const onFileChosen = (files: FileList | null) => {
    if (files && files.length > 0) void uploadOnly(Array.from(files));
  };

  const updateCutSeg = (i: number, patch: Partial<CutPlan["segments"][number]>) => {
    pushHistory();
    setCutplan((prev) => {
      if (!prev) return prev;
      const segments = [...prev.segments];
      segments[i] = { ...segments[i], ...patch };
      return { ...prev, segments };
    });
  };
  const updateCaption = (
    i: number,
    patch: Partial<Transcript["segments"][number]>,
    coalesceKey?: string,
  ) => {
    // 文字入力・カラーピッカー・プレビュー上の位置ドラッグは1操作で何度も
    // 届くので、呼び出し側が coalesceKey を渡した連続更新だけ undo 1回分に
    // まとめる(9点プリセットやトグルのような独立したボタン操作まで
    // まとめないよう、キー無しは常に別エントリ)
    pushHistory(coalesceKey ?? null);
    setTranscript((prev) => {
      if (!prev) return prev;
      const segments = [...prev.segments];
      const entry = { ...segments[i], ...patch };
      // undefined を明示した項目(pos / style / track の解除)はキーごと消す
      // (JSON を汚さない)
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[k] === undefined) delete entry[k];
      }
      segments[i] = entry;
      return { ...prev, segments };
    });
  };
  const removeCaption = (i: number) => {
    pushHistory();
    setTranscript(
      (prev) => prev && { ...prev, segments: prev.segments.filter((_, j) => j !== i) },
    );
    setSelection(null);
  };
  /** 複数テロップの style を項目単位で一括変更(patch = null で個別スタイルを
   * 全解除)。undefined を明示した項目は消す(patchStyle と同じ流儀) */
  const updateCaptionsStyle = (
    indices: number[],
    patch: Partial<CaptionStyle> | null,
    coalesceKey?: string,
  ) => {
    // カラーピッカーの連続変更だけ undo 1回にまとめる(updateCaption と同じ流儀)
    pushHistory(coalesceKey ?? null);
    setTranscript((prev) => {
      if (!prev) return prev;
      const segments = [...prev.segments];
      for (const i of indices) {
        const s = segments[i];
        if (!s) continue;
        if (patch === null) {
          const { style: _drop, ...rest } = s;
          segments[i] = rest;
          continue;
        }
        const st: CaptionStyle = { ...s.style, ...patch };
        for (const k of Object.keys(st) as (keyof CaptionStyle)[]) {
          if (st[k] === undefined) delete st[k];
        }
        const entry = { ...s };
        if (Object.keys(st).length > 0) entry.style = st;
        else delete entry.style;
        segments[i] = entry;
      }
      return { ...prev, segments };
    });
  };
  const updateCaptionsTrack = (indices: number[], track: number) => {
    pushHistory();
    setTranscript((prev) => {
      if (!prev) return prev;
      const segments = [...prev.segments];
      for (const i of indices) {
        const s = segments[i];
        if (!s) continue;
        const entry: Transcript["segments"][number] = { ...s, track };
        if (track <= 1) delete entry.track;
        segments[i] = entry;
      }
      return { ...prev, segments };
    });
  };
  const removeCaptions = (indices: number[]) => {
    pushHistory();
    setTranscript(
      (prev) =>
        prev && { ...prev, segments: prev.segments.filter((_, j) => !indices.includes(j)) },
    );
    setSelection(null);
  };
  /** coalesceKey を渡すと同じ項目への連続更新(スライダー・カラーピッカー)を
   * undo 1回にまとめる */
  const updateSpan = (
    kind: "overlays" | "wipeFull",
    i: number,
    patch: Partial<OverlayEntry & WipeFullEntry>,
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...((prev[kind] ?? []) as (OverlayEntry | WipeFullEntry)[])];
      const entry = { ...arr[i], ...patch };
      // undefined を明示した項目(rect / volume 等の解除)はキーごと消す
      for (const k of Object.keys(patch) as (keyof (OverlayEntry & WipeFullEntry))[]) {
        if (patch[k] === undefined) delete entry[k];
      }
      arr[i] = entry;
      return { ...prev, [kind]: arr };
    });
  };
  const removeSpan = (kind: "overlays" | "wipeFull", i: number) => {
    pushHistory();
    setOverlays((prev) => prev && { ...prev, [kind]: (prev[kind] ?? []).filter((_, j) => j !== i) });
    setSelection(null);
  };
  /** ズーム区間の start/end/rect/easeSec を部分更新。coalesceKey は
   * プレビュー上のドラッグ・スライダーの連続変更を undo 1回にまとめる用 */
  const updateZoom = (
    i: number,
    patch: Partial<NonNullable<Overlays["zooms"]>[number]>,
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...(prev.zooms ?? [])];
      const entry = { ...arr[i], ...patch };
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[k] === undefined) delete entry[k];
      }
      arr[i] = entry;
      return { ...prev, zooms: arr };
    });
  };
  const removeZoom = (i: number) => {
    pushHistory();
    setOverlays((prev) => prev && { ...prev, zooms: (prev.zooms ?? []).filter((_, j) => j !== i) });
    setSelection(null);
  };
  /** ぼかし区間の start/end/rect/strength を部分更新。coalesceKey は
   * プレビュー上のドラッグ・スライダーの連続変更を undo 1回にまとめる用。
   * strength=0.5(既定値)への変更は undefined を渡してキー削除
   * (判断4。JSON を汚さない) */
  const updateBlur = (
    i: number,
    patch: Partial<NonNullable<Overlays["blurs"]>[number]>,
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...(prev.blurs ?? [])];
      const entry = { ...arr[i], ...patch };
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[k] === undefined) delete entry[k];
      }
      arr[i] = entry;
      return { ...prev, blurs: arr };
    });
  };
  const removeBlur = (i: number) => {
    pushHistory();
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = (prev.blurs ?? []).filter((_, j) => j !== i);
      // 全区間を消したら blurs キーごと削除(空配列を残さない)
      const { blurs: _drop, ...rest } = prev;
      return arr.length === 0 ? rest : { ...rest, blurs: arr };
    });
    setSelection(null);
  };
  /** 注釈の start/end/rect/from/to/見た目/type を部分更新。coalesceKey は
   * プレビュー上のドラッグ・スライダーの連続変更を undo 1回にまとめる用。
   * type 切替は Inspector 側で旧 type 固有キーを undefined にして渡す
   * (このハンドラは緩い AnnotationPatch を受けて delete-undefined するだけ) */
  const updateAnnotation = (i: number, patch: AnnotationPatch, coalesceKey?: string) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...(prev.annotations ?? [])];
      const entry: Record<string, unknown> = { ...(arr[i] as object), ...patch };
      for (const k of Object.keys(patch) as (keyof AnnotationPatch)[]) {
        if (patch[k] === undefined) delete entry[k];
      }
      arr[i] = entry as unknown as Annotation;
      return { ...prev, annotations: arr };
    });
  };
  const removeAnnotation = (i: number) => {
    pushHistory();
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = (prev.annotations ?? []).filter((_, j) => j !== i);
      // 全区間を消したら annotations キーごと削除(空配列を残さない)
      const { annotations: _drop, ...rest } = prev;
      return arr.length === 0 ? rest : { ...rest, annotations: arr };
    });
    setSelection(null);
  };
  /** インサート編集: anchorSrc(元収録の秒)の位置に file を素材の実尺で差し込む */
  const placeInsert = (file: string, durationSec: number | null, anchorSrc: number) => {
    if (!overlays) return;
    pushHistory();
    const list = [
      ...(overlays.inserts ?? []),
      {
        at: round2(anchorSrc),
        file,
        durationSec: round2(Math.max(MIN_SPAN, durationSec ?? defaultImgSec)),
      },
    ];
    setOverlays({ ...overlays, inserts: list });
    setSelection({ kind: "insert", index: list.length - 1 });
  };
  const updateInsert = (
    i: number,
    patch: Partial<NonNullable<Overlays["inserts"]>[number]>,
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...(prev.inserts ?? [])];
      const merged = { ...arr[i], ...patch };
      // undefined を明示した項目(volume / fade 等の解除)はキーごと消す
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[k] === undefined) delete merged[k];
      }
      if (!merged.startFrom) delete merged.startFrom; // 0/未指定は省略して JSON を汚さない
      arr[i] = merged;
      return { ...prev, inserts: arr };
    });
  };
  const removeInsert = (i: number) => {
    pushHistory();
    setOverlays(
      (prev) => prev && { ...prev, inserts: (prev.inserts ?? []).filter((_, j) => j !== i) },
    );
    setSelection(null);
  };

  const updateBgm = (
    i: number,
    patch: Partial<Bgm["tracks"][number]>,
    coalesceKey?: string,
  ) => {
    pushHistory(coalesceKey ?? null);
    setBgm((prev) => {
      if (!prev) return prev;
      const tracks = [...prev.tracks];
      const merged = { ...tracks[i], ...patch };
      // undefined を明示した項目(volumeDb / fade / startFrom の解除)はキーごと消す
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
        if (patch[k] === undefined) delete merged[k];
      }
      if (!merged.startFrom) delete merged.startFrom; // 0/未指定は省略して JSON を汚さない
      tracks[i] = merged;
      return { tracks };
    });
  };
  const removeBgm = (i: number) => {
    pushHistory();
    setBgm((prev) => {
      if (!prev) return prev;
      const tracks = prev.tracks.filter((_, j) => j !== i);
      // 全区間を消したら bgm.json ごと削除(= 全編1曲の後方互換へ戻す)
      return tracks.length > 0 ? { tracks } : null;
    });
    setSelection(null);
  };

  const removeSelected = () => {
    if (!selection) return;
    // ドラッグ中に消した場合、スナップショットからの再構築で復活しないように
    dragRef.current = null;
    if (selection.kind === "caption") {
      if (capMulti.length > 1) removeCaptions(capMulti);
      else removeCaption(selection.index);
    } else if (selection.kind === "insert") removeInsert(selection.index);
    else if (selection.kind === "overlays" || selection.kind === "wipeFull") {
      removeSpan(selection.kind, selection.index);
    } else if (selection.kind === "bgm") removeBgm(selection.index);
    else if (selection.kind === "zoom") removeZoom(selection.index);
    else if (selection.kind === "blur") removeBlur(selection.index);
    else if (selection.kind === "annotation") removeAnnotation(selection.index);
    else if (selection.kind === "short") removeShortRange(selection.index);
    else if (selection.kind === "cut") {
      // 映像クリップの Delete は削除ではなくカット(記録に倒すだけ。
      // 継ぎ目の印からいつでも戻せる)
      cutKeepSeg(selection.index);
    }
  };

  /* ---------------- クリップのコピー&ペースト(標準 NLE の a) ---------------- */

  /** 選択中クリップの中身をクリップボードへ控える(⌘C)。複製できる中身を
   * 持たない選択(insert / wipe / 映像 keep / ショート範囲)は対象外 */
  const copySelected = () => {
    if (!selection) return;
    const { kind, index } = selection;
    let clip: Clipboard | null = null;
    if (kind === "caption") {
      const s = transcript?.segments[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    } else if (kind === "overlays") {
      const s = overlays?.overlays?.[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    } else if (kind === "zoom") {
      const s = overlays?.zooms?.[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    } else if (kind === "blur") {
      const s = overlays?.blurs?.[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    } else if (kind === "annotation") {
      const s = overlays?.annotations?.[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    } else if (kind === "bgm") {
      const s = bgm?.tracks?.[index];
      if (s) clip = { kind, entry: structuredClone(s) };
    }
    // 複製できる中身が無い選択(insert / wipe / 映像 keep / ショート範囲)は無反応
    if (!clip) return;
    clipboardRef.current = clip;
  };

  /** クリップボードの中身を再生ヘッド位置へ複製する(⌘V)。ペースト起点は
   * 標準 NLE と同じく再生ヘッド(出力秒 → 元収録の秒へ変換)。控えた start から
   * の平行移動で start/end と入れ子の時刻(caption の words・blur の keyframes)を
   * ずらし、トラックは保ったまま、複製先で id/内部 layer は剥がす(@id は
   * 一意なので splitAtPlayhead と同じ流儀) */
  const pasteClipboard = () => {
    const clip = clipboardRef.current;
    if (!clip) return;
    // ショートモードは本編クリップの座標系と別なので今は貼らせない(範囲だけ扱う)
    if (shortMode) return;
    // 再生ヘッドが keep 区間の外(カット/挿入クリップ上)なら貼り付け先が無い
    const base = srcAt(playhead.get());
    if (base === null) return;
    if (clip.kind === "caption") {
      if (!transcript) return;
      const src = clip.entry;
      const delta = round2(base - src.start);
      const dur = src.end - src.start;
      const { id: _id, ...rest } = src;
      const entry: CaptionEntry = {
        ...rest,
        start: round2(base),
        end: round2(base + dur),
        ...(src.words
          ? { words: src.words.map((w) => ({ ...w, start: round2(w.start + delta), end: round2(w.end + delta) })) }
          : {}),
      };
      pushHistory();
      const segs = [...transcript.segments];
      let at = segs.findIndex((s) => s.start > entry.start);
      if (at === -1) at = segs.length;
      segs.splice(at, 0, entry);
      setTranscript({ ...transcript, segments: segs });
      setSelection({ kind: "caption", index: at });
    } else if (clip.kind === "bgm") {
      const src = clip.entry;
      const dur = src.end - src.start;
      const entry: BgmEntry = { ...src, start: round2(base), end: round2(base + dur) };
      pushHistory();
      const tracks = [...(bgm?.tracks ?? []), entry];
      setBgm({ tracks });
      setSelection({ kind: "bgm", index: tracks.length - 1 });
    } else {
      // overlays / zoom / blur / annotation は overlays.json の各配列へ追加。
      // shifted/delta は各 entry 共通の start/end から算出(clip.entry を各分岐で
      // narrow して使う=union のまま keyframes 等へ触らない)
      if (!overlays) return;
      const delta = round2(base - clip.entry.start);
      const dur = clip.entry.end - clip.entry.start;
      const shifted = { start: round2(base), end: round2(base + dur) };
      // ズームだけは重なれない。貼り付け先が既存ズームと重なるなら手前で切り、
      // 丸ごと重なるなら貼らない(履歴を積む前に判断する)
      const zoomFit =
        clip.kind === "zoom"
          ? fitZoomSpan(overlays.zooms ?? [], shifted, "create", MIN_SPAN)
          : null;
      if (clip.kind === "zoom" && !zoomFit) {
        setError(
          "貼り付け先に既にズームがあります。ズームは重ねられません" +
            "(プレイヘッドを別の位置へ動かしてください)",
        );
        return;
      }
      pushHistory();
      if (clip.kind === "overlays") {
        const { id: _id, layer: _layer, ...rest } = clip.entry;
        const entry: OverlayEntry = {
          ...rest,
          ...shifted,
          // 素材の keyframes(位置/サイズ/opacity の時間変化)も元収録の秒なので平行移動
          ...(clip.entry.keyframes
            ? { keyframes: clip.entry.keyframes.map((k) => ({ ...k, at: round2(k.at + delta) })) }
            : {}),
        };
        const list = [...(overlays.overlays ?? []), entry];
        setOverlays({ ...overlays, overlays: list });
        setSelection({ kind: "overlays", index: list.length - 1 });
      } else if (clip.kind === "zoom") {
        const { id: _id, ...rest } = clip.entry;
        const list = [...(overlays.zooms ?? []), { ...rest, ...(zoomFit ?? shifted) }];
        setOverlays({ ...overlays, zooms: list });
        setSelection({ kind: "zoom", index: list.length - 1 });
      } else if (clip.kind === "blur") {
        const { id: _id, ...rest } = clip.entry;
        const entry: BlurEntry = {
          ...rest,
          ...shifted,
          ...(clip.entry.keyframes
            ? { keyframes: clip.entry.keyframes.map((k) => ({ ...k, at: round2(k.at + delta) })) }
            : {}),
        };
        const list = [...(overlays.blurs ?? []), entry];
        setOverlays({ ...overlays, blurs: list });
        setSelection({ kind: "blur", index: list.length - 1 });
      } else {
        // annotation(from/to・rect は座標なので平行移動しない)
        const { id: _id, ...rest } = clip.entry;
        const list = [...(overlays.annotations ?? []), { ...rest, ...shifted } as Annotation];
        setOverlays({ ...overlays, annotations: list });
        setSelection({ kind: "annotation", index: list.length - 1 });
      }
    }
  };

  /* ---------------- 保存・下書き退避・プロキシ生成 ---------------- */

  const save = async () => {
    if (!proj || !cutplan || !overlays || !transcript) return;
    const body = {
      ...(JSON.stringify(cutplan) !== JSON.stringify(proj.cutplan) ? { cutplan } : {}),
      ...(JSON.stringify(overlays) !== JSON.stringify(proj.overlays) ? { overlays } : {}),
      ...(JSON.stringify(transcript) !== JSON.stringify(proj.transcript) ? { transcript } : {}),
      // bgm は null(bgm.json 削除)も送るので、キーの有無で変更を判定する
      ...(JSON.stringify(bgm ?? null) !== JSON.stringify(proj.bgm ?? null) ? { bgm } : {}),
      // shorts も同様、null/空は shorts.json 削除
      ...(JSON.stringify(shorts ?? null) !== JSON.stringify(proj.shorts ?? null)
        ? { shorts }
        : {}),
    };
    if (Object.keys(body).length > 0) {
      try {
        const resp = await postSave({
          ...body,
          baseHashes: baseHashesForBody(body, baseHashesRef.current),
        });
        applySaveHashes(baseHashesRef, resp.contentHashes);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === "stale_base") {
          // 外部変更で base が古い。上書きせず、SSE-while-dirty と同じ三方向マージへ。
          await reviewExternalChange();
          return; // 成功時の後処理(proj 上書き・dirty 解除)はしない
        }
        throw e; // heavyJob 409 等はこれまでどおり呼び出し側/エラー表示へ
      }
    }
    setProj({ ...proj, cutplan, overlays, transcript, bgm, shorts });
    // 保存 = こちらの内容で上書きすると選んだということ。外部変更の警告は下げる
    setExternalChange(false);
    setAiWorkflow((wf) =>
      wf && wf.phase === "complete" && wf.saved === false ? { ...wf, saved: true } : wf,
    );
    // 保存できたら下書きの退避は不要(残すと次回起動時に復元を聞いてしまう)
    deleteDraft().catch(() => {});
  };

  // 未保存の編集を .editor-draft.json へ自動退避(クラッシュ・強制終了への
  // 保険)。正のデータへの書き込みはこれまで通り手動保存(⌘S)だけが行う。
  // 編集が続く間はタイマーが延び、手が止まって 1.5 秒後に書く
  useEffect(() => {
    if (!anyDirty) return;
    const t = setTimeout(() => {
      const d = docsRef.current;
      if (!d) return;
      postDraft({ savedAt: new Date().toISOString(), ...d }).catch((e: Error) =>
        console.warn(`下書きの退避に失敗しました: ${e.message}`),
      );
    }, 1500);
    return () => clearTimeout(t);
  }, [cutplan, overlays, transcript, bgm, anyDirty]);

  // 未保存のままタブを閉じる・リロードする操作にはブラウザの確認を出す
  // (下書き退避があるので致命ではないが、気づかず失うのを防ぐ)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /** 退避されていた未保存編集をエディタへ戻す(ディスクの正のデータは
   * 保存するまで変わらない)。復元自体も ⌘Z で戻せるよう履歴に積む */
  const restoreDraft = () => {
    const d = draftOffer;
    if (!d) return;
    pushHistory();
    setCutplan(d.cutplan);
    setOverlays(d.overlays);
    setTranscript(d.transcript);
    setBgm(d.bgm ?? null);
    setShorts(d.shorts !== undefined ? d.shorts ?? null : shorts);
    setCapMulti([]);
    setSelectionState((sel) => (selectionValid(sel, d) ? sel : null));
    setDraftOffer(null);
  };

  const applyDiffReview = () => {
    if (!diffReview) return;
    const merged = applyResolution(reviewDocsOf(diffReview.theirs), diffReview.result, diffResolution);
    applyMergedDocs(diffReview.theirs, merged, true);
  };

  const buildAiSelectionContext = (scope: AiScope): AiSelectionContext => {
    const outputSec = playhead.get();
    const playheadSec = getPlayheadSrc() ?? undefined;
    const ctx: AiSelectionContext = {
      scope,
      activeShortName,
    };
    if (scope !== "global") {
      ctx.outputSec = round2(outputSec);
      if (playheadSec !== undefined) ctx.playheadSec = round2(playheadSec);
    }
    if (scope !== "selection" || !selection) return ctx;

    const idOf = (v: unknown): string | undefined =>
      v && typeof v === "object" && "id" in v && typeof (v as { id?: unknown }).id === "string"
        ? (v as { id: string }).id
        : undefined;
    const addRange = (v: unknown) => {
      if (
        v &&
        typeof v === "object" &&
        "start" in v &&
        "end" in v &&
        typeof (v as { start?: unknown }).start === "number" &&
        typeof (v as { end?: unknown }).end === "number"
      ) {
        ctx.selectedRange = {
          startSec: round2((v as { start: number }).start),
          endSec: round2((v as { end: number }).end),
        };
      }
    };
    const setObject = (kind: AiSelectionContext["selectedKind"], v: unknown) => {
      ctx.selectedKind = kind;
      const id = idOf(v);
      if (id) ctx.selectedIds = [id];
      addRange(v);
    };

    if (selection.kind === "caption") {
      const s = transcript?.segments[selection.index];
      setObject("caption", s);
      if (s) ctx.selectedText = s.text;
    } else if (selection.kind === "cut") {
      setObject("cut", cutplan?.segments[selection.index]);
    } else if (selection.kind === "overlays") {
      setObject("overlay", overlays?.overlays?.[selection.index]);
    } else if (selection.kind === "insert") {
      const ins = overlays?.inserts?.[selection.index];
      setObject("overlay", ins);
      if (ins) ctx.selectedRange = { startSec: round2(ins.at), endSec: round2(ins.at + ins.durationSec) };
    } else if (selection.kind === "wipeFull") {
      setObject("overlay", overlays?.wipeFull?.[selection.index]);
    } else if (selection.kind === "zoom") {
      setObject("overlay", overlays?.zooms?.[selection.index]);
    } else if (selection.kind === "blur") {
      setObject("blur", overlays?.blurs?.[selection.index]);
    } else if (selection.kind === "annotation") {
      setObject("annotation", overlays?.annotations?.[selection.index]);
    } else if (selection.kind === "bgm") {
      setObject("range", bgm?.tracks?.[selection.index]);
    } else if (selection.kind === "short") {
      ctx.selectedKind = "short";
      const range = activeShort?.ranges[selection.index];
      const id = idOf(range);
      if (id) ctx.selectedIds = [id];
      addRange(range);
    }
    return ctx;
  };

  const startAiWorkflow = async (scope: AiScope, instruction: string) => {
    if (!proj) return;
    if (anyDirty) {
      setError("AI 一発編集は保存済みの状態から開始します。先に保存してください");
      return;
    }
    setAiWorkflow({ phase: "proposing", instruction, scope });
    setError(null);
    try {
      const response = await postAiPropose({
        instruction,
        activeShortName,
        selection: buildAiSelectionContext(scope),
      });
      const diff = proposalDiff(reviewDocsOf(proj), response.proposal.proposedDocs);
      if (diff.hunks.length === 0) {
        setAiWorkflow({
          phase: "complete",
          instruction,
          scope,
          response,
          diff,
          resolution: new Map(),
          saved: false,
        });
        addToast({ kind: "info", message: "AI 提案に差分はありませんでした", ttlMs: TOAST_TTL_MS.info });
        return;
      }
      setAiWorkflow({
        phase: "reviewing",
        instruction,
        scope,
        response,
        diff,
        resolution: new Map(diff.hunks.map((h) => [h, "theirs"] as const)),
        autoReviewRequested: false,
      });
    } catch (e) {
      const message = (e as Error).message;
      setAiWorkflow({ phase: "failed", instruction, scope, error: message });
      setError(message);
    }
  };

  const mergedAiWorkflowDocs = () => {
    if (!aiWorkflowReview || !proj) return;
    const base = reviewDocsOf(proj);
    return applyProposalResolution(
      base,
      aiWorkflowReview.response.proposal.proposedDocs,
      aiWorkflowReview.diff,
      aiWorkflowReview.resolution,
    );
  };

  const applyLiveDocs = (merged: ReturnType<typeof applyProposalResolution>) => {
    pushHistory();
    setCutplan(merged.cutplan);
    setOverlays(merged.overlays);
    setTranscript(merged.transcript);
    setBgm(merged.bgm);
    setShorts(merged.shorts);
    if (!merged.shorts?.shorts.some((s) => s.name === activeShortName)) {
      setActiveShortName(null);
    }
    setCapMulti([]);
    setSelectionState((sel) => (selectionValid(sel, merged) ? sel : null));
  };

  const generateAiReview = async (
    options?: { withVlm?: boolean },
  ): Promise<ReviewBundle | null> => {
    if (!aiWorkflowReview) return null;
    const withVlm = options?.withVlm ?? false;
    const spec = reviewSpecOfProposalReview(aiWorkflowReview.response.proposal.review);
    if (!spec) {
      setError("比較対象の review.frames がありません");
      return null;
    }
    const merged = mergedAiWorkflowDocs();
    if (!merged) return null;
    setAiWorkflow({ ...aiWorkflowReview, phase: "verifying" });
    setError(null);
    try {
      const res = await postAiReview({
        proposalId: aiWorkflowReview.response.proposalId,
        acceptedHunkLabels: acceptedAiHunkLabels(aiWorkflowReview),
        secondaryObservation: withVlm ? "vlm" : "none",
      });
      setAiWorkflow((prev) =>
        prev && isAiWorkflowReviewState(prev)
          ? {
              ...prev,
              phase: "reviewing",
              reviewBundle: res.bundle,
              reviewCandidateKey: JSON.stringify(merged),
              reviewStale: false,
              autoReviewRequested: true,
            }
          : prev,
      );
      return res.bundle;
    } catch (e) {
      const apiError = e instanceof ApiError ? e : null;
      const message =
        apiError?.code === "proposal_expired" || apiError?.code === "proposal_stale"
          ? `比較は失効しました: ${apiError.message}`
          : `比較の生成に失敗しました: ${(e as Error).message}`;
      setAiWorkflow((prev) =>
        prev && isAiWorkflowReviewState(prev)
          ? {
              ...prev,
              phase: "reviewing",
              error: message,
              autoReviewRequested: true,
              reviewStale: apiError?.code === "proposal_expired" || apiError?.code === "proposal_stale"
                ? true
                : prev.reviewStale,
            }
          : prev,
      );
      setError(message);
      return null;
    }
  };

  const refineAiWorkflow = async (
    options: { mode?: AiRefineMode; withVlm: boolean; instruction?: string },
  ): Promise<void> => {
    if (!aiWorkflowReview || !proj) return;
    const current = aiWorkflowReview;
    const mode = options.mode ?? "normal";
    setAiWorkflow({ ...current, phase: "refining", refineMode: mode });
    setError(null);
    try {
      const response = await postAiRefine({
        proposalId: current.response.proposalId,
        acceptedHunkLabels: acceptedAiHunkLabels(current),
        instruction: options.instruction?.trim() || undefined,
        vlm: options.withVlm,
        mode,
      });
      const diff = proposalDiff(reviewDocsOf(proj), response.proposal.proposedDocs);
      if (diff.hunks.length === 0) {
        setAiWorkflow({
          phase: "complete",
          instruction: current.instruction,
          scope: current.scope,
          response,
          diff,
          resolution: new Map(),
          saved: false,
        });
        addToast({ kind: "info", message: "再提案に差分はありませんでした", ttlMs: TOAST_TTL_MS.info });
        return;
      }
      setAiWorkflow({
        phase: "reviewing",
        instruction: current.instruction,
        scope: current.scope,
        response,
        diff,
        resolution: new Map(diff.hunks.map((h) => [h, "theirs"] as const)),
        refineMode: undefined,
      });
    } catch (e) {
      const message = `再提案に失敗しました: ${(e as Error).message}`;
      setAiWorkflow({ ...current, phase: "reviewing", refineMode: undefined, error: message });
      setError(message);
    }
  };

  const applyAiWorkflow = async ({ save, reviewFirst }: ApplyAiWorkflowOptions) => {
    if (!aiWorkflowReview) return;
    const merged = mergedAiWorkflowDocs();
    if (!merged) return;
    if (reviewFirst) {
      const bundle = await generateAiReview();
      if (!bundle) return;
      if (!save) return;
      aiWorkflowReview.reviewBundle = bundle;
      aiWorkflowReview.reviewCandidateKey = JSON.stringify(merged);
    }
    const nextPhase: AiWorkflowPhase = save ? "saving" : "applying";
    setAiWorkflow({ ...aiWorkflowReview, phase: nextPhase });
    setError(null);
    let saveSucceeded = false;
    try {
      applyLiveDocs(merged);
      if (!save) {
        setAiWorkflow({
          ...aiWorkflowReview,
          phase: "complete",
          saved: false,
          reviewBundle: aiWorkflowReview.reviewBundle,
          reviewCandidateKey: aiWorkflowReview.reviewCandidateKey,
          reviewStale: false,
        });
        return;
      }
      const aiSaveBody: SaveRequest = {
        cutplan: merged.cutplan,
        overlays: merged.overlays,
        transcript: merged.transcript,
        bgm: merged.bgm,
        shorts: merged.shorts,
      };
      const resp = await postSave({
        ...aiSaveBody,
        baseHashes: baseHashesForBody(aiSaveBody, baseHashesRef.current),
      });
      applySaveHashes(baseHashesRef, resp.contentHashes);
      saveSucceeded = true;
      setProj((p) => p && { ...p, ...merged });
      setExternalChange(false);
      deleteDraft().catch(() => {});
      setAiWorkflow({
        ...aiWorkflowReview,
        phase: "complete",
        saved: true,
        reviewBundle: aiWorkflowReview.reviewBundle,
        reviewCandidateKey: aiWorkflowReview.reviewCandidateKey,
        reviewStale: false,
      });
      return;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "stale_base") {
        // 外部変更で base が古い。上書きせず三方向マージへ(saveSucceeded は
        // false のまま=保存済み扱いにしない)
        await reviewExternalChange();
        return;
      }
      const raw = (e as Error).message;
      const message =
        save ? `画面には反映しましたが保存に失敗しました: ${raw}` : raw;
      setAiWorkflow({
        ...aiWorkflowReview,
        phase: "failed",
        saved: saveSucceeded,
        error: message,
        reviewBundle: aiWorkflowReview.reviewBundle,
        reviewCandidateKey: aiWorkflowReview.reviewCandidateKey,
      });
      setError(message);
    }
  };
  const discardDraft = () => {
    setDraftOffer(null);
    deleteDraft().catch(() => {});
  };

  const onSave = async () => {
    setBusy("save");
    setError(null);
    try {
      await save();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** proxy.mp4(元収録の軽量プロキシ)を生成 → プレイヤー再読み込み。
   * 収録ごとに1回だけ。カットは焼き込まないので編集による再生成は不要 */
  const generateProxy = async (): Promise<boolean> => {
    setProxyBusy(true);
    setError(null);
    try {
      await postProxy();
      // proxy の内容が変わった時点で旧 preview-cut は同じ keep でも採用不可。
      // ready を落とし sourceVersion を進めると、stale gate解除後に必ず再ベイクする。
      setProj((p) => p && {
        ...p,
        proxyExists: true,
        previewCut: { ready: false, keepSignature: "" },
      });
      setPreviewCutSourceVersion((v) => v + 1);
      setVideoVersion((v) => v + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setProxyBusy(false);
    }
  };

  /** 設定バナーからのプロキシ再生成。成功したらバナーを下げる */
  const regenProxyForSettings = async () => {
    if (await generateProxy()) {
      setProxyStale(false);
      setProxyStaleDismissed(false);
    }
  };

  /** 書き出し(preview / render)を GUI から起動する。preview / render は
   * ディスクの JSON を読むので、未保存の編集があれば先に保存してから走らせる
   * (承認チェックも cutplan の一部なので、これでディスクへ反映される)。
   * render は approved: true が要る(サーバー側でも承認ゲートで弾かれる) */
  const runExport = async (stage: "preview" | "render") => {
    if (job?.status === "running") return;
    setError(null);
    if (anyDirty) {
      setBusy("save");
      try {
        await save();
      } catch (e) {
        setError((e as Error).message);
        return;
      } finally {
        setBusy(null);
      }
    }
    setJob({ stage, status: "running" });
    // 実行中は progress トーストを1枚。完了時に updateToast で success へ差し替え
    // (消して出し直さない=積み位置が飛ばない)。id はこのクロージャ内で完結する
    const label = stage === "render" ? "レンダー" : "プレビュー生成";
    const toastId = addToast({
      kind: "progress",
      message:
        `${label}中…` +
        (stage === "render" ? "(数分かかることがあります)" : ""),
    });
    try {
      const res = stage === "preview" ? await postPreview() : await postRender();
      setJob({ stage, status: "done", path: res.path });
      const fname = res.path.split("/").pop() ?? res.path;
      updateToast(toastId, {
        kind: "success",
        message: `${stage === "render" ? "レンダー" : "プレビュー"}完了: ${fname}`,
        action: {
          label: "開く",
          onClick: () =>
            postReveal(res.path).catch((e) => setError((e as Error).message)),
        },
        ttlMs: 6000,
      });
    } catch (e) {
      setError((e as Error).message); // エラートーストは error の effect が出す
      setJob(null);
      dismissToast(toastId); // progress トーストは畳む(表示は error トーストへ委ねる)
    }
  };

  // proxy.mp4 が無ければ開いた時点で自動生成を始める。プロキシ無しの
  // エディタは再生できず「生成しない」選択肢が無いので、確認は挟まない
  // (生成中もタイムライン・テロップの編集と保存は普通にできる)。
  // 失敗したときだけビューアに再試行ボタンが出る
  const proxyKickedRef = useRef(false);
  useEffect(() => {
    if (!proj || proj.proxyExists || proxyKickedRef.current) return;
    proxyKickedRef.current = true;
    void generateProxy();
  }, [proj]);

  /* ---------------- 左パネル(タブ・分割バー) ---------------- */

  useEffect(() => {
    localStorage.setItem("cutflow.editor.panelW", String(panelW));
  }, [panelW]);
  useEffect(() => {
    localStorage.setItem("cutflow.editor.inspW", String(inspW));
  }, [inspW]);
  useEffect(() => {
    localStorage.setItem("cutflow.editor.timelineH", String(timelineH));
  }, [timelineH]);
  useEffect(() => {
    localStorage.setItem("cutflow.editor.panelOpen", panelOpen ? "1" : "0");
  }, [panelOpen]);
  useEffect(() => {
    localStorage.setItem("cutflow.editor.inspOpen", inspOpen ? "1" : "0");
  }, [inspOpen]);
  useEffect(() => {
    localStorage.setItem("cutflow.editor.timelineOpen", timelineOpen ? "1" : "0");
  }, [timelineOpen]);

  /** v4 の imperative API で論理的な開閉状態と直前の px を DOM layout へ
   * 投影する。最大化中は論理 state を変えず3面を一時 collapse するため、
   * 解除時には保存済みの開閉と寸法へそのまま戻せる。 */
  useEffect(() => {
    const syncPanel = (
      ref: React.RefObject<PanelImperativeHandle | null>,
      open: boolean,
      sizePx: number,
    ) => {
      const panel = ref.current;
      if (!panel) return;
      if (maximized || !open) panel.collapse();
      else {
        panel.expand();
        panel.resize(sizePx);
      }
    };
    syncPanel(sidePanelRef, panelOpen, panelW);
    syncPanel(inspectorPanelRef, inspOpen, inspW);
    syncPanel(timelinePanelRef, timelineOpen, timelineH);
  }, [maximized, panelOpen, panelW, inspOpen, inspW, timelineOpen, timelineH]);

  /** drag / keyboard resize の完了時だけ state と既存 localStorage を更新する。
   * 初期 layout や上の imperative collapse/resize は isUserInteraction=false
   * なので、最大化中を含め永続 state を汚さない。 */
  /** v4 の layout は Panel 合計を100とする確定値。callback 中の imperative
   * getSize() は keyboard resize 直後に1つ前の値を返し得るため使わず、Group
   * 直下の Panel 合計pxへ比率を掛けて既存のpx永続値へ戻す。 */
  const panelPixelSpan = (group: HTMLDivElement | null, axis: "width" | "height") =>
    group
      ? [...group.children]
          .filter((child): child is HTMLElement =>
            child instanceof HTMLElement && child.hasAttribute("data-panel"))
          .reduce((sum, panel) => sum + panel.getBoundingClientRect()[axis], 0)
      : 0;

  const onStageLayoutChanged = (layout: Record<string, number>, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || maximized) return;
    const span = panelPixelSpan(stageGroupRef.current, "width");
    const left = layout.left ?? 0;
    const right = layout.right ?? 0;
    setPanelOpen(left > 0);
    setInspOpen(right > 0);
    if (left > 0 && span > 0) setPanelW(Math.round(span * left / 100));
    if (right > 0 && span > 0) setInspW(Math.round(span * right / 100));
  };

  const onShellLayoutChanged = (layout: Record<string, number>, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction || maximized) return;
    const span = panelPixelSpan(shellGroupRef.current, "height");
    const timeline = layout.timeline ?? 0;
    setTimelineOpen(timeline > 0);
    if (timeline > 0 && span > 0) setTimelineH(Math.round(span * timeline / 100));
  };

  // テロップを選択したら左パネルを「テロップ」タブへ(一覧の該当行へ
  // 自動スクロールされる)。プロパティは右の常設インスペクタに出るので
  // それ以外の選択ではタブを動かさない。手動のタブ切替は上書きしない
  const prevSelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = selection ? `${selection.kind}-${selection.index}` : null;
    if (key === prevSelKeyRef.current) return;
    prevSelKeyRef.current = key;
    if (selection?.kind === "caption") setTab("captions");
  }, [selection]);

  /** テロップ一覧からの選択。seek = true なら開始位置へ再生ヘッドも動かす */
  const selectCaption = (i: number, seek: boolean) => {
    setSelection({ kind: "caption", index: i });
    if (!seek || !transcript) return;
    const s = transcript.segments[i];
    if (!s) return;
    const o = toOutputTime(s.start, timeline) ?? snapToOutput(s.start, timeline);
    if (o !== null) seekOut(Math.min(o, Math.max(0, duration - 0.01)));
  };

  /** 既存素材の配置(素材パネルのボタン・タイムラインへのドラッグ)。
   * uploadAndPlace と同じ規則で、尺だけブラウザのメタデータから調べる */
  const placeMaterial = async (
    file: string,
    at: { track: TrackId; outT: number } | null,
    mode: "overlay" | "insert" | "bgm",
  ) => {
    const dur = await probeMaterialDuration(file);
    if (mode === "insert") {
      if (!at) return;
      const anchor = at.outT >= duration - 0.05 ? srcDur : srcAt(at.outT);
      if (anchor === null) {
        setError("挿入位置を特定できません(映像クリップの上にドロップしてください)");
        return;
      }
      placeInsert(file, dur, anchor);
      return;
    }
    if (mode === "bgm") {
      const s = srcAt(at?.outT ?? playhead.get());
      if (s === null) return;
      addBgmSpan(round2(s), round2(Math.min(s + (dur ?? srcDur - s), srcDur)), file);
      return;
    }
    const outT = at?.outT ?? playhead.get();
    const s = srcAt(outT);
    if (s === null) return;
    const track = (at ? ovNum(at.track) : null) ?? ovTracks; // 既定は一番手前
    addOverlaySpan(round2(s), round2(Math.min(s + (dur ?? defaultImgSec), srcDur)), track, file);
  };

  const onDropMaterial = (track: TrackId, outT: number, file: string) => {
    if (track === "bgm") {
      if (!BGM_EXT_RE.test(file)) {
        setError("BGM には音声か、音のある動画を使ってください(画像は置けません)");
        return;
      }
      void placeMaterial(file, { track, outT }, "bgm");
    } else if (AUDIO_ONLY_RE.test(file)) {
      setError("音声ファイルは BGM トラックへドロップしてください(素材・映像トラックには置けません)");
    } else if (track === "cut") void placeMaterial(file, { track, outT }, "insert");
    else if (ovNum(track) !== null) void placeMaterial(file, { track, outT }, "overlay");
  };

  /** 素材ファイルの削除(素材タブの右クリックメニュー)。参照が残ったまま
   * ファイルを消すと validate の実在チェックに落ちて保存もレンダーも
   * できなくなるので、編集中の状態とディスク(最後に保存した状態)の両方で
   * 参照ゼロのときだけ消せる。ファイル削除は JSON と違い ⌘Z で戻せないので
   * 確認を挟む */
  const deleteMaterialFile = async (file: string) => {
    const name = file.replace(/^materials\//, "");
    const bgmUses = (b: Bgm | null | undefined): number =>
      (b?.tracks ?? []).filter((t) => t.file === file).length;
    const usedIn = (o: Overlays | null | undefined): number =>
      (o?.overlays ?? []).filter((s) => s.file === file).length +
      (o?.inserts ?? []).filter((s) => s.file === file).length;
    if (usedIn(overlays) + bgmUses(bgm) > 0) {
      setError(
        `「${name}」はタイムラインで ${usedIn(overlays) + bgmUses(bgm)} 箇所使用中のため削除できません。` +
          "先にクリップを削除してください",
      );
      return;
    }
    if (usedIn(proj?.overlays) + bgmUses(proj?.bgm) > 0) {
      setError(
        `「${name}」を使うクリップの削除がまだ保存されていません。` +
          "⌘S で保存してから素材を削除してください",
      );
      return;
    }
    if (
      !window.confirm(
        `素材「${name}」を削除しますか?\n` +
          "ファイルは収録フォルダの materials/ から消え、元に戻せません(⌘Z も効きません)。",
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deleteMaterial(file);
      setProj((p) => p && { ...p, dirFiles: p.dirFiles.filter((f) => f !== file) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** HF render は server の runHeavyJob に直列化を委ねる。成功・失敗のどちらも
   * palette 行へ残し、失敗は通常の sticky toast にも出す。 */
  const runHyperframeRender = async (name: string) => {
    setHyperframeRendering(name);
    setHyperframeErrors((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    try {
      const result = await postHyperframeRender(name);
      setHyperframes((cards) => {
        const rest = cards.filter((card) => card.name !== name);
        return [...rest, result.card].sort((a, b) => a.name.localeCompare(b.name));
      });
      addToast({
        kind: "success",
        ttlMs: TOAST_TTL_MS.success,
        message: result.skipped
          ? `素材「${name}」は最新です`
          : `素材「${name}」を作り直しました`,
      });
      await refreshHyperframes(false);
    } catch (e) {
      const message = (e as Error).message;
      setHyperframeErrors((current) => ({ ...current, [name]: message }));
      addToast({
        kind: "error",
        ttlMs: TOAST_TTL_MS.error,
        message: `素材「${name}」を作り直せませんでした: ${message}`,
      });
      await refreshHyperframes(false);
    } finally {
      setHyperframeRendering(null);
    }
  };

  const openHyperframeAuthor = () => {
    hyperframeAuthorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHyperframeAuthorName("");
    setHyperframeAuthorAssets([]);
    setHyperframeAuthorError(null);
    setHyperframeAuthorOpen(true);
  };

  const addHyperframeAuthorAssets = (files: readonly File[]) => {
    const next = [...hyperframeAuthorAssets];
    for (const file of files) {
      if (!/\.(png|jpe?g|gif|webp|woff2)$/i.test(file.name)) {
        setHyperframeAuthorError(`「${file.name}」は添付できません。PNG / JPEG / GIF / WebP / WOFF2 を選んでください`);
        return;
      }
      const isFont = /\.woff2$/i.test(file.name);
      const maxBytes = hyperframeAssetLimits && isFont
        ? Math.min(hyperframeAssetLimits.maxBytes, hyperframeAssetLimits.fontMaxBytes)
        : hyperframeAssetLimits?.maxBytes;
      if (maxBytes !== undefined && file.size > maxBytes) {
        setHyperframeAuthorError(`「${file.name}」が1ファイルの上限を超えています`);
        return;
      }
      const previous = next.findIndex((item) => item.name.toLowerCase() === file.name.toLowerCase());
      if (previous >= 0) next.splice(previous, 1, file);
      else next.push(file);
    }
    if (
      hyperframeAssetLimits &&
      next.reduce((sum, file) => sum + file.size, 0) > hyperframeAssetLimits.maxTotalBytes
    ) {
      setHyperframeAuthorError("添付素材の合計サイズが上限を超えています");
      return;
    }
    setHyperframeAuthorAssets(next);
    setHyperframeAuthorError(null);
  };

  const onHyperframeAssetDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (hyperframeAuthorBusy) return;
    addHyperframeAuthorAssets([...event.dataTransfer.files]);
  };

  const runHyperframeAuthor = async (brief: string) => {
    const name = hyperframeAuthorName;
    if (!HYPERFRAME_NAME_RE.test(name)) {
      setHyperframeAuthorError("ファイル名は英数字・.・_・- のみで指定してください");
      return;
    }
    const assets = hyperframeAuthorAssets;
    setHyperframeAuthorBusy(true);
    setHyperframeAuthorError(null);
    // 生成は1〜2分かかるためモーダルは送信時に閉じ、進行は素材グリッドの
    // 作成中タイルで見せる。入力は失敗時の再試行に備えて成功まで消さない
    setHyperframeAuthorPendingName(name);
    setHyperframeAuthorOpen(false);
    try {
      const result = await postHyperframeAuthor(name, brief, assets);
      setHyperframes((cards) => {
        const rest = cards.filter((card) => card.name !== name);
        return [...rest, result.card].sort((a, b) => a.name.localeCompare(b.name));
      });
      await refreshHyperframes(false);
      setHyperframeAuthorName("");
      setHyperframeAuthorAssets([]);
      addToast({ kind: "success", ttlMs: TOAST_TTL_MS.success, message: `素材「${name}」を作りました` });
    } catch (e) {
      setHyperframeAuthorError((e as Error).message);
      addToast({
        kind: "error",
        ttlMs: TOAST_TTL_MS.error,
        message: `素材「${name}」を作れませんでした: ${(e as Error).message}`,
      });
    } finally {
      setHyperframeAuthorBusy(false);
      setHyperframeAuthorPendingName(null);
    }
  };

  /** AI 生成素材の削除。render 済み MP4 の使用中チェックは通常素材と同じ基準で
   * 行い、確認のうえ source(html)ごとサーバへカード単位の削除を依頼する */
  const deleteHyperframeCard = async (name: string) => {
    const file = `materials/hyperframes/${name}.mp4`;
    const bgmUses = (b: Bgm | null | undefined): number =>
      (b?.tracks ?? []).filter((t) => t.file === file).length;
    const usedIn = (o: Overlays | null | undefined): number =>
      (o?.overlays ?? []).filter((s) => s.file === file).length +
      (o?.inserts ?? []).filter((s) => s.file === file).length;
    if (usedIn(overlays) + bgmUses(bgm) > 0) {
      setError(
        `「${name}」はタイムラインで ${usedIn(overlays) + bgmUses(bgm)} 箇所使用中のため削除できません。` +
          "先にクリップを削除してください",
      );
      return;
    }
    if (usedIn(proj?.overlays) + bgmUses(proj?.bgm) > 0) {
      setError(
        `「${name}」を使うクリップの削除がまだ保存されていません。` +
          "⌘S で保存してから素材を削除してください",
      );
      return;
    }
    if (
      !window.confirm(
        `AI 素材「${name}」を削除しますか?\n` +
          "作成した動画と、作り直しに使う元データの両方が収録フォルダから消え、" +
          "元に戻せません(⌘Z も効きません)。",
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deleteHyperframe(name);
      setHyperframes((cards) => cards.filter((card) => card.name !== name));
      setHyperframeErrors((errors) => {
        const rest = { ...errors };
        delete rest[name];
        return rest;
      });
      setProj((p) => p && { ...p, dirFiles: p.dirFiles.filter((f) => f !== file) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 素材パネルからドラッグ中の素材。タイムラインが実尺のゴーストを出せる
   * よう、掴んだ瞬間に尺を調べて渡す(結果は次回のために控えておく) */
  const [dragMaterial, setDragMaterial] = useState<{
    file: string;
    durationSec: number | null;
  } | null>(null);
  const durCacheRef = useRef<Record<string, number | null>>({});
  const onMaterialDragBegin = (file: string) => {
    setDragMaterial({ file, durationSec: durCacheRef.current[file] ?? null });
    if (!(file in durCacheRef.current)) {
      void probeMaterialDuration(file).then((d) => {
        durCacheRef.current[file] = d;
        setDragMaterial((cur) =>
          cur && cur.file === file ? { ...cur, durationSec: d } : cur,
        );
      });
    }
  };
  const onMaterialDragEnd = () => setDragMaterial(null);

  /* ---------------- パネル最大化・フルスクリーン ---------------- */

  // フルスクリーンは Esc やブラウザ操作でも解除されるので、状態は
  // fullscreenchange から拾う(ボタンの点灯とアイコンの向きに使う)
  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /** viewerCol(プレビュー+トランスポート)を OS フルスクリーンへ。
   * Remotion Player 組込みのフルスクリーンではなく自前要素を使うことで、
   * トランスポート一式とプレビュー上のテロップドラッグをそのまま使える */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewerColRef.current?.requestFullscreen();
  };

  /* ---------------- キーボード ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        // 保存・生成・アップロードの実行中は重ねて保存しない
        if (busy === null) void onSave();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (settingsOpen) {
          if (!settingsSaving) cancelSettings();
        }
        else openSettings();
        return;
      }
      const t = e.target as HTMLElement;
      const inField = ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
      if (settingsOpen) {
        // モーダル表示中は再生・削除などのグローバルショートカットを止める。
        // Escape の dismissal は Dialog が一度だけ処理する。入力欄では
        // SettingsModal が dismissal を止め、NumInput の入力破棄を優先する。
        return;
      }
      if (aiCommandOpen) {
        // Dialog が Escape dismissal と launcher への focus return を一度だけ処理する。
        // ここでは再生・削除などのグローバルショートカットだけを止める。
        return;
      }
      // 入力欄の中はブラウザ標準の undo/redo に任せる(下の guard で除外)
      if (inField) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoEdit();
        else undoEdit();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        // 選択中クリップの中身をコピー(標準 NLE の a)。選択が無ければ
        // 素通し(ブラウザの通常コピーに任せる)
        if (selection) {
          e.preventDefault();
          copySelected();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (clipboardRef.current) {
          e.preventDefault();
          pasteClipboard();
        }
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (e.shiftKey) setMaximized((v) => !v);
        else toggleFullscreen();
        return;
      }
      if (e.key === "Escape") {
        // フルスクリーン中の Esc はブラウザの解除に任せる(こちらでは
        // 何もしない)。それ以外はパネル最大化の解除
        if (!document.fullscreenElement) setMaximized(false);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") stepFrames(e.shiftKey ? -fps : -1);
      else if (e.key === "ArrowRight") stepFrames(e.shiftKey ? fps : 1);
      else if (e.key === "Home") seekOut(0);
      else if (e.key === "End") seekOut(duration);
      else if (e.key === "Backspace" || e.key === "Delete") removeSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!aiWorkflow || aiWorkflow.phase !== "reviewing") return;
    if (aiWorkflow.reviewBundle || aiWorkflow.reviewStale) return;
    if (aiWorkflow.autoReviewRequested) return;
    setAiWorkflow((prev) =>
      prev && prev.phase === "reviewing"
        ? { ...prev, autoReviewRequested: true }
        : prev,
    );
    void generateAiReview({ withVlm: false });
  }, [aiWorkflow]);

  /* ---------------- 描画 ---------------- */

  if (error && !proj) return <div className="fatal">エラー: {error}</div>;
  const hyperframeAuthorStatus = proj
    ? hyperframeAuthorReadiness({
        structuredRoute: proj.aiRoutes.structured,
        profiles: proj.aiProfiles,
      })
    : { ready: false, disabledReason: "AI 設定を読み込み中です" };

  if (!proj || !built || !cutplan || !overlays || !transcript) {
    return <div className="fatal dim">読み込み中…</div>;
  }

  const aiWorkflowTitle = aiWorkflow
    ? [
        `AI 一発編集: ${aiWorkflowPhaseLabel(aiWorkflow)}`,
        `指示: ${aiWorkflow.instruction}`,
        ...(aiWorkflow.error ? [aiWorkflow.error] : []),
      ].join("\n")
    : "AI 一発編集";
  const mergedAiCandidate = aiWorkflowReview ? mergedAiWorkflowDocs() : null;
  const aiReviewStale = aiWorkflowReview
    ? (aiWorkflowReview.reviewBundle
        ? JSON.stringify(mergedAiCandidate) !== (aiWorkflowReview.reviewCandidateKey ?? "")
        : false) || aiWorkflowReview.reviewStale === true
    : false;
  const aiFrameParse = aiWorkflowReview
    ? aiWorkflowReview.response.proposal.review.frames.map(formatReviewFrame)
    : [];
  const aiReviewEvents = aiWorkflowReview
    ? buildReviewEvents({
        hunks: aiWorkflowReview.diff.hunks,
        reviewBundle: aiWorkflowReview.reviewBundle,
        aiNotes: aiWorkflowReview.response.proposal.review.notes,
        applyWarnings: aiWorkflowReview.response.proposal.applyPlan.warnings.map(
          (warning) => `${warning.file} ${warning.where}: ${warning.message}`,
        ),
      })
    : [];
  const aiWarningSummary = warningSummary(aiReviewEvents);
  const setAiWorkflowHunks = (hunks: ProposalDiffResult["hunks"], side: "theirs" | "mine") => {
    setAiWorkflow((prev) => {
      if (!prev?.resolution) return prev;
      const next = new Map(prev.resolution);
      for (const hunk of hunks) next.set(hunk, side);
      return { ...prev, resolution: next, reviewStale: prev.reviewBundle ? true : prev.reviewStale };
    });
  };

  // 開閉・最大化でも Panel の children は常時 mount したまま保つ。
  const appClass = "app" + (maximized ? " max" : "");
  return (
    <TooltipProvider delayDuration={350}>
    <div className={appClass}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/ogg,audio/flac,.mp3,.m4a,.wav"
        style={{ display: "none" }}
        onChange={(e) => {
          onFileChosen(e.target.files);
          e.target.value = ""; // 同じファイルを続けて選べるように
        }}
      />
      <header className="ocHeader">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="brand ocBreadcrumb" tabIndex={0}>
              <strong>CutFlow</strong>
              <span className="sep" aria-hidden>/</span>
              <span className="dim path" title={proj.dir}>
                {proj.dir.replace(/\/+$/, "").split("/").pop()}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>{proj.dir}</TooltipContent>
        </Tooltip>
        <span className="spacer" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={anyDirty ? "saveStatus dirty" : "saveStatus"}
              tabIndex={0}
              title="変更は ⌘S で保存。未保存の編集は自動退避され、閉じる前に確認が出ます"
            >
              {busy === "save" ? "保存中…" : anyDirty ? "● 未保存 (⌘S)" : "保存済み"}
            </span>
          </TooltipTrigger>
          <TooltipContent>変更は ⌘S で保存。未保存の編集は自動退避されます</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={aiCommandLauncherRef}
              variant="secondary"
              size="sm"
              className="aiCommandLauncher"
              disabled={aiWorkflowLocked}
              title={aiWorkflowLocked ? aiWorkflowTitle : anyDirty ? "保存してから AI 一発編集" : "AI 一発編集を開く"}
              onClick={() => {
                setAiCommandScope("global");
                setAiCommandOpen(true);
              }}
            >
              {aiWorkflowLocked
                ? <img className="aiCommandLauncherIcon" src="/particle_loop_icon.svg" alt="" />
                : <Sparkles size={14} aria-hidden />}
              {aiWorkflowLocked ? "編集中" : "AI編集"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{aiWorkflowLocked ? aiWorkflowTitle : anyDirty ? "保存してから AI 一発編集" : "AI 一発編集を開く"}</TooltipContent>
        </Tooltip>
        {/* レイアウト切替(VSCode 風)。アイコンの塗られた面 = 表示中のパネル。
            閉じてもデータ・編集状態には影響しない(表示だけの切替) */}
        <div className="layoutBtns">
          <Tooltip><TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hIcon"
              data-active={panelOpen}
              title={`左パネル(素材/テロップ)を${panelOpen ? "隠す" : "表示"}(分割バーを左端へ寄せても閉じられる)`}
              aria-label="左パネルの表示切替"
              onClick={() => setPanelOpen((v) => !v)}
            ><PanelLeft size={15} aria-hidden /></Button>
          </TooltipTrigger><TooltipContent>左パネルを{panelOpen ? "隠す" : "表示"}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hIcon"
              data-active={timelineOpen}
              title={`タイムラインを${timelineOpen ? "隠す" : "表示"}`}
              aria-label="タイムラインの表示切替"
              onClick={() => setTimelineOpen((v) => !v)}
            ><PanelBottom size={15} aria-hidden /></Button>
          </TooltipTrigger><TooltipContent>タイムラインを{timelineOpen ? "隠す" : "表示"}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hIcon"
              data-active={inspOpen}
              title={`右パネル(プロパティ)を${inspOpen ? "隠す" : "表示"}(分割バーを右端へ寄せても閉じられる)`}
              aria-label="右パネルの表示切替"
              onClick={() => setInspOpen((v) => !v)}
            ><PanelRight size={15} aria-hidden /></Button>
          </TooltipTrigger><TooltipContent>右パネルを{inspOpen ? "隠す" : "表示"}</TooltipContent></Tooltip>
        </div>
        <Tooltip><TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={settingsOpen ? "settingsBtn active" : "settingsBtn"}
          aria-label="設定"
          title="設定 (⌘,)。ワイプ・テロップ既定・音声などの全収録共通の設定(config.yaml)"
          onClick={() => (settingsOpen ? cancelSettings() : openSettings())}
        ><Settings size={15} aria-hidden /></Button>
        </TooltipTrigger><TooltipContent>設定 (⌘,)</TooltipContent></Tooltip>
        <Popover open={exportOpen} onOpenChange={setExportOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="default"
              size="sm"
              className="exportTrigger"
              aria-expanded={exportOpen}
            >
              <Download size={14} aria-hidden />
              書き出し
              <ChevronDown size={12} aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="exportPanel" aria-label="書き出し">
                <div className="exportTitle">書き出し</div>
                <label
                  className="approve"
                  title="プレビューで確認できたらチェック(cutplan.json の approved。render の実行に必要)"
                >
                  <input
                    type="checkbox"
                    checked={cutplan.approved}
                    onChange={(e) => {
                      pushHistory();
                      setCutplan((p) => p && { ...p, approved: e.target.checked });
                    }}
                  />
                  承認済み
                </label>
                <Button
                  className="exportAction"
                  disabled={
                    !cutplan.approved || job?.status === "running" || busy !== null
                  }
                  title={
                    cutplan.approved
                      ? "最終レンダー(final.mp4)を生成する。完了すると Finder で開く"
                      : "先に「承認済み」にチェックしてください(render の承認ゲート)"
                  }
                  onClick={() => {
                    setExportOpen(false);
                    void runExport("render");
                  }}
                >
                  レンダー
                </Button>
                <Button
                  variant="outline"
                  className="exportAction"
                  disabled={job?.status === "running" || busy !== null}
                  title="カット確認用の軽い動画(preview.mp4)を生成する。未保存の編集は自動で保存してから走る"
                  onClick={() => {
                    setExportOpen(false);
                    void runExport("preview");
                  }}
                >
                  プレビュー生成
                </Button>
          </PopoverContent>
        </Popover>
      </header>

      {/* 要対応の継続条件(トーストにしない=時間で消えない)。header と stage の
          間に、いずれかが真のときだけ描画する。複数同時は縦積み(T4) */}
      <HeaderBanners
        draftOffer={draftOffer}
        externalChange={externalChange}
        reviewConflictCount={diffReview?.result.conflicts.length ?? 0}
        proxyStale={proxyStale && !proxyStaleDismissed}
        proxyBusy={proxyBusy}
        previewCutRebake={previewCutRebake.state}
        warnings={built?.warnings ?? []}
        onRestore={restoreDraft}
        onDiscard={discardDraft}
        onReload={() => void reloadFromDisk()}
        onReview={() => setDiffPanelOpen(true)}
        onRegenProxy={() => void regenProxyForSettings()}
        onDismissProxyStale={() => setProxyStaleDismissed(true)}
        onRetryPreviewCut={previewCutRebake.retry}
      />

      {hyperframeAuthorOpen && (
        <Dialog
          open
          onOpenChange={(open) => !open && !hyperframeAuthorBusy && setHyperframeAuthorOpen(false)}
        >
          <DialogContent
            asChild
            overlayClassName="aiCommandBackdrop"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => hyperframeAuthorBusy && event.preventDefault()}
            onCloseAutoFocus={(event) => {
              restoreDialogFocus(event, hyperframeAuthorReturnFocusRef.current);
              hyperframeAuthorReturnFocusRef.current = null;
            }}
          >
          <section className="aiCommandModal hfAuthorModal ocHyperframeAuthor" aria-label="AI で素材を作る">
            <div className="aiCommandModalHead">
              <div>
                <div className="aiCommandKicker">AI で作る</div>
                <DialogTitle asChild><h3>新しい素材を作る</h3></DialogTitle>
              </div>
              <DialogClose asChild>
                <button
                  className="icon"
                  aria-label="閉じる"
                  disabled={hyperframeAuthorBusy}
                >
                  ×
                </button>
              </DialogClose>
            </div>
            <label className="hfAuthorNameField">
              <span>ファイル名</span>
              <input
                value={hyperframeAuthorName}
                disabled={hyperframeAuthorBusy}
                placeholder="例: next-preview"
                autoFocus
                onChange={(event) => {
                  setHyperframeAuthorName(event.target.value);
                  setHyperframeAuthorError(null);
                }}
              />
            </label>
            <AiCommand
              disabled={!hyperframeAuthorStatus.ready}
              busy={hyperframeAuthorBusy}
              multiline
              modalStyle
              clearOnSubmit={false}
              disabledReason={hyperframeAuthorStatus.disabledReason}
              placeholder="例: 「次回予告」と大きく出るタイトル素材、5秒"
              submitLabel="作る"
              onSubmit={(brief) => void runHyperframeAuthor(brief)}
            />
            <div
              className={`hfAssetDrop${hyperframeAuthorBusy ? " disabled" : ""}`}
              role="button"
              tabIndex={hyperframeAuthorBusy ? -1 : 0}
              onClick={() => !hyperframeAuthorBusy && hyperframeAssetInputRef.current?.click()}
              onKeyDown={(event) => {
                if (!hyperframeAuthorBusy && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  hyperframeAssetInputRef.current?.click();
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onHyperframeAssetDrop}
            >
              <input
                ref={hyperframeAssetInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.gif,.webp,.woff2,image/png,image/jpeg,image/gif,image/webp,font/woff2"
                multiple
                disabled={hyperframeAuthorBusy}
                onChange={(event) => {
                  addHyperframeAuthorAssets([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <strong>画像・フォントをドロップ、またはクリックして選択</strong>
              <span>
                PNG / JPEG / GIF / WebP / WOFF2
                {hyperframeAssetLimits && (
                  ` · 1枚 ${(hyperframeAssetLimits.maxBytes / 1024 / 1024).toFixed(1)}MB / ` +
                  `font ${(Math.min(hyperframeAssetLimits.maxBytes, hyperframeAssetLimits.fontMaxBytes) / 1024 / 1024).toFixed(1)}MB / ` +
                  `合計 ${(hyperframeAssetLimits.maxTotalBytes / 1024 / 1024).toFixed(1)}MB まで`
                )}
              </span>
            </div>
            {hyperframeAuthorAssets.length > 0 && (
              <ScrollArea className="hfAssetListScroll">
              <ul className="hfAssetList" aria-label="添付素材">
                {hyperframeAuthorAssets.map((file) => (
                  <li key={file.name}>
                    <span>{file.name} · {(file.size / 1024).toFixed(0)}KB</span>
                    <button
                      type="button"
                      disabled={hyperframeAuthorBusy}
                      aria-label={`${file.name}を外す`}
                      onClick={() => setHyperframeAuthorAssets((items) => items.filter((item) => item !== file))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              </ScrollArea>
            )}
            {hyperframeAuthorStatus.disabledReason && (
              <p className="hfAuthorDisabled">{hyperframeAuthorStatus.disabledReason}</p>
            )}
            {hyperframeAuthorError && <p className="hfAuthorError">{hyperframeAuthorError}</p>}
            <DialogDescription asChild>
              <p className="dim hint">
                生成には通常1〜2分かかります。完成すると他の素材と同じように配置できます。
              </p>
            </DialogDescription>
          </section>
          </DialogContent>
        </Dialog>
      )}

      {aiCommandOpen && (
        <Dialog open onOpenChange={(open) => !open && setAiCommandOpen(false)}>
          <DialogContent
            asChild
            overlayClassName="aiCommandBackdrop"
            onCloseAutoFocus={(event) => restoreDialogFocus(event, aiCommandLauncherRef.current)}
          >
          <section className="aiCommandModal ocAiCommandModal" aria-label="AI 一発編集">
            <div className="aiCommandModalHead">
              <div>
                <div className="aiCommandKicker">AI 一発編集</div>
                <DialogTitle asChild><h3>どの範囲を編集するか選んで指示</h3></DialogTitle>
              </div>
              <DialogClose asChild>
                <button className="icon" aria-label="閉じる">×</button>
              </DialogClose>
            </div>
            <Tabs
              value={aiCommandScope}
              onValueChange={(value) => setAiCommandScope(value as AiScope)}
            >
            <TabsList className="aiScopeTabs" aria-label="AI 編集の対象範囲">
              <TabsTrigger
                value="global"
                className={aiCommandScope === "global" ? "on" : ""}
              >
                全体
                <span>構成・テンポ・全体調整</span>
              </TabsTrigger>
              <TabsTrigger
                value="playhead"
                className={aiCommandScope === "playhead" ? "on" : ""}
              >
                現在位置
                <span>再生ヘッド周辺</span>
              </TabsTrigger>
              <TabsTrigger
                value="selection"
                className={aiCommandScope === "selection" ? "on" : ""}
                disabled={!selection}
              >
                選択中
                <span>{selection ? "選択要素だけ" : "未選択"}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="global" className="aiScopePanel">プロジェクト全体を対象にします。</TabsContent>
            <TabsContent value="playhead" className="aiScopePanel">現在の再生位置周辺を対象にします。</TabsContent>
            <TabsContent value="selection" className="aiScopePanel">現在選択している要素を対象にします。</TabsContent>
            </Tabs>
            <AiCommand
              disabled={anyDirty || aiWorkflowLocked}
              busy={aiBusy}
              multiline
              modalStyle
              disabledReason={
                anyDirty
                  ? "保存してから AI 一発編集"
                  : aiWorkflowLocked
                    ? "AI 一発編集を確認中"
                    : undefined
              }
              placeholder={
                aiCommandScope === "global"
                  ? "例: 全体のテンポを上げて冗長な間を削る"
                  : aiCommandScope === "selection"
                    ? "例: この字幕を短く自然にする"
                    : "例: 現在位置の前後を見やすく調整する"
              }
              submitLabel="実行"
              onSubmit={(instruction) => {
                setAiCommandOpen(false);
                void startAiWorkflow(aiCommandScope, instruction);
              }}
            />
            <DialogDescription asChild>
              <p className="dim hint">
                全体はプロジェクト要約を、現在位置と選択中は周辺文脈を使います。
                提案はすぐ保存せず、差分レビューで確認します。
              </p>
            </DialogDescription>
          </section>
          </DialogContent>
        </Dialog>
      )}

      {diffReview && diffPanelOpen && (
        <DiffReview
          hunks={diffReview.result.conflicts}
          resolution={diffResolution}
          onSet={(hunk, side) => {
            setDiffResolution((prev) => {
              const next = new Map(prev);
              next.set(hunk, side);
              return next;
            });
          }}
          onBulk={(side) => {
            setDiffResolution(new Map(diffReview.result.conflicts.map((h) => [h, side] as const)));
          }}
          onApply={applyDiffReview}
          onCancel={() => setDiffPanelOpen(false)}
        />
      )}

      {aiWorkflowReview && (
        <AiVisualReview
          proposalId={aiWorkflowReview.response.proposalId}
          title="AI 一発編集を確認"
          description={
            aiWorkflowReview.response.proposal.summary.length > 0
              ? aiWorkflowReview.response.proposal.summary.join(" / ")
              : "適用する変更だけを選んでください。保存と確認はこの画面から続けて行えます。"
          }
          events={aiReviewEvents}
          hunks={aiWorkflowReview.diff.hunks}
          resolution={aiWorkflowReview.resolution}
          globalWarnings={[
            ...(
              aiWorkflowReview.error
                ? [{ label: "比較エラー", tone: "warn" as const, items: [aiWorkflowReview.error] }]
                : []
            ),
            ...(
              aiWorkflowReview.response.proposal.applyPlan.warnings.length > 0
                ? [{
                    label: "既存の検証警告(この変更由来ではありません)",
                    tone: "muted" as const,
                    items: aiWorkflowReview.response.proposal.applyPlan.warnings.map((w) => `${w.file} ${w.where}: ${w.message}`),
                  }]
                : []
            ),
            ...(
              aiWorkflowReview.response.proposal.review.notes.length > 0
                ? [{ label: "AIメモ", tone: "muted" as const, items: aiWorkflowReview.response.proposal.review.notes }]
                : []
            ),
          ]}
          frameChecks={aiFrameParse}
          reviewBundle={aiWorkflowReview.reviewBundle}
          reviewStale={aiReviewStale}
          warningSummary={aiWarningSummary}
          checkingFrames={aiWorkflowReview.phase === "verifying"}
          refining={aiWorkflowReview.phase === "refining"}
          refiningMode={aiWorkflowReview.refineMode}
          onSetHunks={setAiWorkflowHunks}
          onBulk={(side) => {
            if (!aiWorkflowReview) return;
            setAiWorkflowHunks(aiWorkflowReview.diff.hunks, side);
          }}
          onGenerateReview={({ withVlm }) => void generateAiReview({ withVlm })}
          onRefine={(options) => void refineAiWorkflow(options)}
          onFixWarnings={({ withVlm }) => void refineAiWorkflow({ mode: "warning-fix", withVlm })}
          onApply={() => void applyAiWorkflow({ save: true, reviewFirst: false })}
          onCancel={() => setAiWorkflow(null)}
        />
      )}

      {settingsOpen && (
          <SettingsModal
            cfg={cfgValuesOf(proj)}
            planPerception={proj.planPerception}
            onChange={(patch) => setProj((p) => p && projectWithCfgPatch(p, patch))}
            onSave={() => void saveSettings()}
            onCancel={cancelSettings}
            saving={settingsSaving}
            error={settingsError}
            aiProfiles={proj.aiProfiles}
            aiDoctor={aiDoctorResult}
            aiDoctorBusy={aiDoctorBusy}
            onAiDoctor={(route) => void runAiDoctor(route)}
          />
      )}

      <ResizablePanelGroup
        id="cutflow-shell"
        orientation="vertical"
        className="editorShell"
        elementRef={shellGroupRef}
        onLayoutChanged={onShellLayoutChanged}
      >
        <ResizablePanel
          id="main"
          minSize={STAGE_MIN}
          groupResizeBehavior="preserve-relative-size"
          className="mainShellPanel"
        >
          <ResizablePanelGroup
            id="cutflow-stage"
            orientation="horizontal"
            className="stage"
            elementRef={stageGroupRef}
            onLayoutChanged={onStageLayoutChanged}
          >
            <ResizablePanel
              id="left"
              panelRef={sidePanelRef}
              defaultSize={panelOpen ? panelW : 0}
              minSize={PANEL_MIN}
              collapsedSize={0}
              collapsible
              groupResizeBehavior="preserve-pixel-size"
              className="sideShellPanel"
            >
              <aside className="sidePanel panel shellSurface ocSidePanel">
          <nav className="tabs ocIconRail" role="tablist" aria-label="編集パネル">
            {PANEL_TABS.map(([id, label]) => (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    role="tab"
                    className={tab === id ? "active" : ""}
                    aria-label={label}
                    aria-selected={tab === id}
                    aria-controls={`panel-${id}`}
                    title={label}
                    onClick={() => setTab(id)}
                  >
                    <PanelTabIcon tab={id} />
                    <span className="ocRailLabel">{label}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ))}
          </nav>
          <div
            className="panelBody ocAssetPane"
            id={`panel-${tab}`}
            role="tabpanel"
            aria-label={PANEL_TABS.find(([id]) => id === tab)?.[1]}
          >
            {tab === "materials" && (
              <MaterialsPanel
                materials={materials}
                mediaCodecFacts={mediaCodecFacts}
                hyperframes={hyperframes}
                hyperframesLoading={hyperframesLoading}
                hyperframesError={hyperframesError}
                hyperframeRendering={hyperframeRendering}
                hyperframeErrors={hyperframeErrors}
                hyperframeAuthorDisabledReason={hyperframeAuthorStatus.disabledReason}
                busy={busy !== null || hyperframeRendering !== null || hyperframeAuthorBusy}
                onUploadClick={onUploadClick}
                onUploadFiles={(files) => void uploadOnly(files)}
                onPlace={(f) =>
                  void placeMaterial(f, null, AUDIO_ONLY_RE.test(f) ? "bgm" : "overlay")
                }
                onDelete={(f) => void deleteMaterialFile(f)}
                onDeleteCard={(name) => void deleteHyperframeCard(name)}
                onRenderHyperframe={(name) => void runHyperframeRender(name)}
                onNewHyperframe={openHyperframeAuthor}
                authorPendingName={hyperframeAuthorPendingName}
                onDragBegin={onMaterialDragBegin}
                onDragEnd={onMaterialDragEnd}
              />
            )}
            {tab === "script" && (
              <ScriptPanel
                script={script}
                error={scriptError}
                keeps={shortMode ? shortKeepsMerged : keeps}
                silences={silenceEvidence}
                noBridgeSpans={scriptCutSpans}
                timeline={curTimeline}
                playing={playing}
                editable={!shortMode}
                onSeekSrc={seekToSrc}
                onCutRange={cutScriptRange}
                onRestoreRange={restoreScriptRange}
              />
            )}
            {tab === "captions" && (
              <CaptionsPanel
                transcript={transcript}
                overlays={overlays}
                capTracks={capTracks}
                selectedIndex={selection?.kind === "caption" ? selection.index : null}
                multiSelected={capMulti}
                onRowClick={(i) => selectCaption(i, true)}
                onRowToggle={toggleCaptionMulti}
                onRowFocus={(i) => selectCaption(i, false)}
                // 一覧の textarea は文字入力なので undo をまとめる
                updateCaption={(i, patch) =>
                  updateCaption(i, patch, `caption:${i}:text`)
                }
              />
            )}
            {tab === "shorts" && (
              <ShortsPanel
                shorts={shorts}
                activeShortName={activeShortName}
                onSelect={setActiveShortName}
                onAdd={addShort}
                onRemove={removeShort}
                onRename={renameShort}
              />
            )}
          </div>
              </aside>
            </ResizablePanel>
            <ResizableHandle
              id="left-handle"
              disableDoubleClick
              title={
                panelOpen
                  ? "ドラッグで幅を変更(左端まで寄せると閉じる)。ダブルクリックで開閉"
                  : "右へドラッグ(またはダブルクリック)で左パネルを開く"
              }
              onDoubleClick={() => setPanelOpen((v) => !v)}
            />
            <ResizablePanel
              id="viewer"
              minSize={VIEWER_MIN}
              groupResizeBehavior="preserve-relative-size"
              className="viewerShellPanel"
            >
              <div className="viewerCol panel shellSurface" ref={viewerColRef}>
        <div className="viewer">
          {proj.proxyExists ? (
            <>
              <Player
                key={videoVersion}
                ref={playerRef}
                component={Main}
                inputProps={playerProps ?? built.props}
                durationInFrames={durationInFrames}
                compositionWidth={built.props.width}
                compositionHeight={built.props.height}
                fps={fps}
                loop={loop}
                playbackRate={playbackRate}
                initialVolume={playerVolume}
                // 共有 <audio> タグのプールは AudioContext の作り直しで登録が
                // ずれて落ちる(unregisterAudio の TypeError / No audio ref found)。
                // モバイルの自動再生制限対策の仕組みで、ここでは再生が常に
                // ユーザー操作起点なので不要。0 でプールを無効化する
                numberOfSharedAudioTags={0}
                spaceKeyToPlayOrPause={false}
                style={{ width: "100%", height: "100%" }}
              />
              {/* 素材(部分配置)の移動・リサイズ枠。テロップ枠より下(DOM 前)に
                  置き、重なったときはテロップのドラッグを優先させる */}
              <LiveMaterialOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleOverlayKey}
                getOverlays={getVisibleOverlays}
                selection={selection?.kind === "overlays" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "overlays", index: i })}
                onRectChange={(i, rect) =>
                  updateSpan("overlays", i, { rect }, `overlay:${i}:drag`)
                }
              />
              {/* ズーム区間の rect 枠(素材と同じ移動・リサイズ機構を流用) */}
              <LiveMaterialOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleZoomKey}
                getOverlays={getVisibleZooms}
                selection={selection?.kind === "zoom" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "zoom", index: i })}
                onRectChange={(i, rect) => updateZoom(i, { rect }, `zoom:${i}:drag`)}
              />
              {/* ぼかし区間の rect 枠(効果自体は Player が既に描画。ここは
                  移動・リサイズ用の透明な編集枠だけ=二重掛けしない) */}
              <LiveMaterialOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleBlurKey}
                getOverlays={getVisibleBlurs}
                selection={selection?.kind === "blur" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "blur", index: i })}
                onRectChange={(i, rect) => updateBlur(i, { rect }, `blur:${i}:drag`)}
              />
              {/* 注釈(box/spotlight)の rect 枠。効果は Player が描画済み=編集枠だけ */}
              <LiveMaterialOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleAnnotationRectKey}
                getOverlays={getVisibleAnnotationRects}
                selection={selection?.kind === "annotation" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "annotation", index: i })}
                onRectChange={(i, rect) => updateAnnotation(i, { rect }, `annotation:${i}:drag`)}
              />
              {/* 注釈(arrow)の2点編集枠。透明ハンドル+参考線だけ=二重掛けしない */}
              <LiveArrowOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleAnnotationArrowKey}
                getArrows={getVisibleAnnotationArrows}
                selection={selection?.kind === "annotation" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "annotation", index: i })}
                onChange={(i, patch, coalesceKey) => updateAnnotation(i, patch, coalesceKey)}
              />
              <LiveCaptionOverlay
                width={built.props.width}
                height={built.props.height}
                getKey={visibleCaptionKey}
                getCaptions={getVisibleCaptions}
                selection={selection?.kind === "caption" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "caption", index: i })}
                onMove={(i, pos) => {
                  // ショートモードは transcript ではなく当該ショートの
                  // captionTracks(トラック単位)へ書く(D2/5-4)
                  if (shortMode) {
                    const trk = captionTrack(transcript.segments[i] ?? {});
                    setShortCaptionTrackDefault(trk, { pos });
                  } else {
                    updateCaption(i, { pos }, `caption:${i}:drag`);
                  }
                }}
                // 文言(text)は本編・ショートで共有(pos と違いトラック単位で
                // ないので shortMode でも transcript を直接書く)
                onCommitText={(i, text) =>
                  updateCaption(i, { text }, `caption:${i}:text`)
                }
                // 編集中はプレビューを止めてボックス(=表示中テロップ)を固定する
                onEditStart={() => playerRef.current?.pause()}
              />
            </>
          ) : (
            <div className="noPreview">
              {proxyBusy || !error ? (
                <p>
                  編集用プロキシ(proxy.mp4)を作成しています…
                  <br />
                  初回のみ、元収録の長さに応じて数十秒かかります。
                  この間もタイムラインの編集はできます
                </p>
              ) : (
                <>
                  <p>プロキシの生成に失敗しました(エラーは右下の通知に表示)</p>
                  <button className="primary" onClick={() => void generateProxy()}>
                    プロキシ生成を再試行
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="transport ocTransport">
        {/* 上段: シークバー(クリック/ドラッグでシーク) */}
        <div
          className="scrub"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubTo(e);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e);
          }}
        >
          <ScrubProgress duration={duration} />
        </div>
        {/* 下段: 左=時刻・音量 / 中央=再生まわり / 右=元収録の秒・秒送り */}
        <div className="tRow">
        <div className="tLeft">
          <span className="tcode">
            <PlayheadTimecode />
            <span className="dim tDur"> / {fmtTime(duration)}</span>
          </span>
          {/* ホバーで音量バーが横に伸びる(YouTube 風)。普段はアイコンだけ */}
          <div className="volCtl">
            <Button
              variant="ghost"
              size="icon"
              className="icon mute"
              title={`ミュート切替(プレビューのみ。書き出しには影響しない)。現在 ${volumePct}%`}
              onClick={toggleMute}
            >
              <VolumeIcon
                level={volumePct === 0 ? "mute" : volumePct < 50 ? "low" : "high"}
                size={16}
              />
            </Button>
            <input
              className="volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={volumePct}
              style={{
                // 左側(現在値まで)をアクセント色で塗る
                background: `linear-gradient(to right, hsl(var(--oc-primary)) ${volumePct}%, hsl(var(--oc-border)) ${volumePct}%)`,
              }}
              title={`プレビューの音量 ${volumePct}%(書き出しには影響しない)。ダブルクリックで100%`}
              onChange={(e) => setVolumePct(Number(e.target.value))}
              onDoubleClick={() => setVolumePct(100)}
            />
          </div>
        </div>
        <div className="tCenter">
          <Button variant="ghost" size="icon" className="icon jump" title="先頭へ (Home)" onClick={() => seekOut(0)}>
            <JumpIcon dir="back" />
          </Button>
          <Button variant="ghost" size="icon" className="icon" title="1フレーム戻る (←)" onClick={() => stepFrames(-1)}>
            <StepIcon dir="back" />
          </Button>
          <Button variant="secondary" className="play" title="再生/停止 (Space)" onClick={togglePlay}>
            <PlayPauseIcon playing={playing} size={18} />
          </Button>
          <Button variant="ghost" size="icon" className="icon" title="1フレーム進む (→)" onClick={() => stepFrames(1)}>
            <StepIcon dir="fwd" />
          </Button>
          <Button variant="ghost" size="icon" className="icon jump" title="末尾へ (End)" onClick={() => seekOut(duration)}>
            <JumpIcon dir="fwd" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`icon loop${loop ? " active" : ""}`}
            title="ループ再生(プレビューのみ)"
            onClick={() => setLoop((v) => !v)}
          >
            <LoopIcon />
          </Button>
        </div>
        <div className="tRight">
          {/* 本編/各ショートの切替。プレビュー・タイムラインの表示対象を変える
              操作なので、ヘッダーではなく再生コントロール側に置く */}
          <span className="modeSwitch">
            <select
              value={activeShortName ?? ""}
              title="本編 / 各ショートの切替"
              onChange={(e) => setActiveShortName(e.target.value || null)}
            >
              <option value="">本編</option>
              {(shorts?.shorts ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  ショート: {s.name}
                </option>
              ))}
            </select>
          </span>
          <select
            className="rate"
            value={playbackRate}
            title="再生速度(プレビューのみ。書き出しには影響しない)"
            onChange={(e) => setPlaybackRate(Number(e.target.value))}
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}x
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" className="icon sec" title="1秒戻る (Shift+←)" onClick={() => stepFrames(-fps)}>
            <StepIcon dir="back" double />
          </Button>
          <Button variant="ghost" size="icon" className="icon sec" title="1秒進む (Shift+→)" onClick={() => stepFrames(fps)}>
            <StepIcon dir="fwd" double />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`icon${maximized ? " active" : ""}`}
            title={
              maximized
                ? "元のレイアウトに戻す (⇧F / Esc)"
                : "プレビューを最大化 (⇧F)。左右パネルとタイムラインを一時的に隠す(表示だけの切替で編集内容には影響しない)"
            }
            onClick={() => setMaximized((v) => !v)}
          >
            <MaximizeIcon active={maximized} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`icon${fullscreen ? " active" : ""}`}
            title={
              fullscreen
                ? "フルスクリーンを解除 (F / Esc)"
                : "フルスクリーンで再生 (F)。実寸での最終確認用(操作バーは下端にマウスを寄せると出る)"
            }
            onClick={toggleFullscreen}
          >
            <FullscreenIcon active={fullscreen} />
          </Button>
        </div>
        </div>
        </div>
              </div>
            </ResizablePanel>
            <ResizableHandle
              id="right-handle"
              disableDoubleClick
              title={
                inspOpen
                  ? "ドラッグで幅を変更(右端まで寄せると閉じる)。ダブルクリックで開閉"
                  : "左へドラッグ(またはダブルクリック)で右パネルを開く"
              }
              onDoubleClick={() => setInspOpen((v) => !v)}
            />
            <ResizablePanel
              id="right"
              panelRef={inspectorPanelRef}
              defaultSize={inspOpen ? inspW : 0}
              minSize={INSP_MIN}
              collapsedSize={0}
              collapsible
              groupResizeBehavior="preserve-pixel-size"
              className="inspectorShellPanel"
            >
              <aside className="inspPanel panel shellSurface">
          <div className="panelBody">
            <AiCommand
              compact
              disabled={anyDirty || aiWorkflowLocked}
              busy={aiBusy}
              disabledReason={
                anyDirty
                  ? "保存してから AI 一発編集"
                  : aiWorkflowLocked
                    ? "AI 一発編集を確認中"
                    : undefined
              }
              placeholder={selection ? "選択中の内容を AI で編集" : "現在位置を AI で編集"}
              submitLabel="実行"
              onSubmit={(instruction) => startAiWorkflow(selection ? "selection" : "playhead", instruction)}
            />
            <Inspector
              // 選択が変わったら編集欄ごと作り直す(未確定の入力を持ち越さない)
              key={
                selection
                  ? `${selection.kind}-${selection.index}-${capMulti.join(".")}`
                  : "none"
              }
              selection={selection}
              capMulti={capMulti}
              cutplan={cutplan}
              overlays={overlays}
              transcript={transcript}
              bgm={bgm}
              materials={materials}
              ovTracks={ovTracks}
              capTracks={capTracks}
              stdCaptionPos={stdCaptionPos}
              captionDefaults={built.props.caption}
              output={{ w: built.props.width, h: built.props.height }}
              marginPx={built.props.wipe.marginPx}
              timeline={curTimeline}
              srcDur={srcDur}
              duration={duration}
              getPlayheadSrc={getPlayheadSrc}
              seekToSrc={seekToSrc}
              seekOut={(t) => seekOut(clamp(t, 0, Math.max(0, duration - 0.01)))}
              project={{
                dir: proj.dir,
                approved: cutplan.approved,
                bgmFile: proj.bgmFile,
                bgmTracks: bgm?.tracks?.length ?? 0,
                hasCamera: proj.hasCamera,
              }}
              setCaptionTrackDefault={setCaptionTrackDefault}
              updateCutSeg={updateCutSeg}
              cutKeepSeg={cutKeepSeg}
              restoreCutSeg={restoreCutSeg}
              updateCaption={updateCaption}
              removeCaption={removeCaption}
              updateCaptionsStyle={updateCaptionsStyle}
              updateCaptionsTrack={updateCaptionsTrack}
              removeCaptions={removeCaptions}
              updateSpan={updateSpan}
              removeSpan={removeSpan}
              updateZoom={updateZoom}
              removeZoom={removeZoom}
              updateBlur={updateBlur}
              removeBlur={removeBlur}
              updateAnnotation={updateAnnotation}
              removeAnnotation={removeAnnotation}
              updateInsert={updateInsert}
              removeInsert={removeInsert}
              updateBgm={updateBgm}
              removeBgm={removeBgm}
              shortMode={shortMode}
              activeShort={activeShort}
              setShortCaptionTrackDefault={setShortCaptionTrackDefault}
              updateShortRange={updateShortRange}
              removeShortRange={removeShortRange}
              updateActiveShort={updateActiveShort}
              removeShort={removeShort}
            />
          </div>
              </aside>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle
          id="timeline-handle"
          disableDoubleClick
          title={
            timelineOpen
              ? "ドラッグで高さを変更(下端まで寄せると閉じる)。ダブルクリックで開閉"
              : "上へドラッグ(またはダブルクリック)でタイムラインを開く"
          }
          onDoubleClick={() => setTimelineOpen((v) => !v)}
        />
        <ResizablePanel
          id="timeline"
          panelRef={timelinePanelRef}
          defaultSize={timelineOpen ? timelineH : 0}
          minSize={TIMELINE_MIN}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="timelineShellPanel"
        >
          <div className="timelineSurface panel shellSurface">
            <Timeline
        height={timelineH}
        duration={duration}
        clips={clips}
        cutMarks={cutMarks}
        peaks={peaksMap}
        tracks={timelineTracks}
        selection={selection}
        multiCaption={capMulti}
        onToggleCaptionSel={toggleCaptionMulti}
        onSeek={seekOut}
        onSelect={setSelection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onCreate={onCreate}
        onReorderTrack={onReorderTrack}
        onAddTrack={addTrack}
        canUndo={undoRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
        onUndo={undoEdit}
        onRedo={redoEdit}
        onSplit={splitAtPlayhead}
        getSplitDisabled={getSplitDisabled}
        onDelete={removeSelected}
        // トラック標準の選択は「消せるクリップ」ではない(Delete は何もしない)
        deleteDisabled={!selection || selection.kind === "captionTrack"}
        onRemoveTrack={removeTrack}
        onRenameTrack={setCaptionTrackName}
        onSelectCaptionTrack={(track) => setSelection({ kind: "captionTrack", index: track })}
        onDropFile={onDropFile}
        onDropMaterial={onDropMaterial}
        dragMaterial={dragMaterial}
        trackMuted={trackMuted}
        onToggleTrackMute={toggleTrackMute}
        hiddenLayers={hiddenLayers}
        onToggleTrackHide={toggleTrackHide}
              defaultDurationSec={defaultImgSec}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
    </TooltipProvider>
  );
};

/** ヘッダー直下の要対応バナー行(T4)。draftOffer / externalChange / proxyStale /
 * previewCutRebake /
 * warnings(built.warnings。hideCaption・blurs×zoom重なり・blursのショート非継承・
 * ショートprofileフォールバック等)は「ユーザーが操作するまで真であり続ける条件」で、
 * 時間で消える通知(トースト)とは寿命モデルが違うのでバナーに残す(warnings は
 * 対象の JSON を直せば次の再計算で自然に消える。個別の「後で」は持たない)。
 * いずれも真でなければ何も描かない。複数同時成立(externalChange + proxyStale 等)は
 * .banner を縦積みで自然に扱う */
const HeaderBanners = ({
  draftOffer,
  externalChange,
  reviewConflictCount,
  proxyStale,
  proxyBusy,
  previewCutRebake,
  warnings,
  onRestore,
  onDiscard,
  onReload,
  onReview,
  onRegenProxy,
  onDismissProxyStale,
  onRetryPreviewCut,
}: {
  draftOffer: DraftData | null;
  externalChange: boolean;
  reviewConflictCount: number;
  proxyStale: boolean;
  proxyBusy: boolean;
  previewCutRebake: PreviewCutRebakeState;
  warnings: string[];
  onRestore: () => void;
  onDiscard: () => void;
  onReload: () => void;
  onReview: () => void;
  onRegenProxy: () => void;
  onDismissProxyStale: () => void;
  onRetryPreviewCut: () => void;
}) => {
  if (!draftOffer && !externalChange && !proxyStale &&
      previewCutRebake.status === "idle" && warnings.length === 0) return null;
  return (
    <>
      {warnings.map((w) => (
        <div className="banner" key={w}>
          <span className="msg">⚠ {w}</span>
        </div>
      ))}
      {draftOffer && (
        <div
          className="banner"
          title="前回のセッションが保存せずに終わったため、自動退避された編集が残っています。復元してもファイルは保存(⌘S)するまで書き換わりません"
        >
          <span className="msg">
            保存されなかった編集があります(
            {new Date(draftOffer.savedAt).toLocaleString()} 時点)
          </span>
          <button className="warn" onClick={onRestore}>
            復元する
          </button>
          <button onClick={onDiscard}>破棄</button>
        </div>
      )}
      {externalChange && (
        <div
          className="banner"
          title="Claude Code などがこのフォルダの JSON を書き換えました。読み込み直すとその内容が反映されます(こちらの未保存の編集は消えます)。保存すればこちらの内容で上書きします"
        >
          <span className="msg">ファイルが外部で変更されました</span>
          {reviewConflictCount > 0 && (
            <button className="primary" onClick={onReview}>
              差分をレビュー({reviewConflictCount})
            </button>
          )}
          <button className="warn" onClick={onReload}>
            読み込み直す(未保存の編集は破棄)
          </button>
        </div>
      )}
      {proxyStale && (
        <div
          className="banner"
          title={
            "ラウドネス・システム音声・プレビュー幅は proxy.mp4 に焼き込まれるため、" +
            "再生成するまでエディタのプレビューには反映されません(書き出しには反映済み)"
          }
        >
          <span className="msg">
            設定をプレビューに反映するにはプロキシの再生成が必要です
          </span>
          <button className="warn" disabled={proxyBusy} onClick={onRegenProxy}>
            {proxyBusy ? "再生成中…" : "プロキシを再生成"}
          </button>
          <button onClick={onDismissProxyStale}>後で</button>
        </div>
      )}
      {(previewCutRebake.status === "waiting" || previewCutRebake.status === "building") && (
        <div className="banner" aria-live="polite">
          <span className="msg">プレビュー再ベイク中…</span>
        </div>
      )}
      {previewCutRebake.status === "failed" && (
        <div className="banner" role="alert">
          <span className="msg">
            プレビューの再ベイクに失敗しました: {previewCutRebake.error}
          </span>
          <button className="warn" onClick={onRetryPreviewCut}>再試行</button>
        </div>
      )}
    </>
  );
};

/* ---------------- 再生ヘッド購読の末端コンポーネント ----------------
 * 再生中の毎フレーム更新をこれらの小さな要素に閉じ込める(App 全体は
 * 再レンダーしない)。詳しい理由は playhead.ts のコメント参照 */

/** トランスポートの現在時刻表示 */
const PlayheadTimecode = () => {
  const text = usePlayheadSelector(fmtTime);
  return <b className="mono">{text}</b>;
};

/** シークバーの塗りとつまみ */
const ScrubProgress = ({ duration }: { duration: number }) => {
  const pct = usePlayheadSelector((t) =>
    duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0,
  );
  return (
    <>
      <div className="scrubFill" style={{ width: `${pct}%` }} />
      <div className="scrubThumb" style={{ left: `${pct}%` }} />
    </>
  );
};

/** プレビュー上のテロップ移動レイヤー。「表示中のテロップの組」(キー)だけを
 * 購読し、組が入れ替わったときだけ CaptionOverlay を作り直す */
const LiveCaptionOverlay = ({
  width,
  height,
  getKey,
  getCaptions,
  selection,
  onSelect,
  onMove,
  onCommitText,
  onEditStart,
}: {
  width: number;
  height: number;
  getKey: (outT: number) => string;
  getCaptions: (outT: number) => OverlayCaption[];
  selection: number | null;
  onSelect: (index: number) => void;
  onMove: (index: number, pos: CaptionPos) => void;
  onCommitText: (index: number, text: string) => void;
  onEditStart: () => void;
}) => {
  const key = usePlayheadSelector(getKey);
  const captions = useMemo(
    () => getCaptions(playhead.get()),
    // key は「表示中の組が変わった」の合図(値そのものは使わない)
    [key, getCaptions],
  );
  return (
    <CaptionOverlay
      width={width}
      height={height}
      captions={captions}
      selection={selection}
      onSelect={onSelect}
      onMove={onMove}
      onCommitText={onCommitText}
      onEditStart={onEditStart}
    />
  );
};

/** プレビュー上の素材(部分配置)の移動・リサイズレイヤー。LiveCaptionOverlay と
 * 同じく「表示中の素材の組」(キー)だけを購読し、組が入れ替わったときと rect が
 * 変わったときだけ MaterialOverlay を作り直す */
const LiveMaterialOverlay = ({
  width,
  height,
  getKey,
  getOverlays,
  selection,
  onSelect,
  onRectChange,
}: {
  width: number;
  height: number;
  getKey: (outT: number) => string;
  getOverlays: (outT: number) => OverlayRect[];
  selection: number | null;
  onSelect: (index: number) => void;
  onRectChange: (index: number, rect: Region) => void;
}) => {
  const key = usePlayheadSelector(getKey);
  const overlays = useMemo(
    () => getOverlays(playhead.get()),
    // key = 表示中の組の変化、getOverlays の同一性 = rect の変化
    [key, getOverlays],
  );
  return (
    <MaterialOverlay
      width={width}
      height={height}
      overlays={overlays}
      selection={selection}
      onSelect={onSelect}
      onRectChange={onRectChange}
    />
  );
};

/** プレビュー上の矢印注釈の2点編集レイヤー。LiveMaterialOverlay と同じく
 * 「表示中の矢印の組」(キー)だけを購読する */
const LiveArrowOverlay = ({
  width,
  height,
  getKey,
  getArrows,
  selection,
  onSelect,
  onChange,
}: {
  width: number;
  height: number;
  getKey: (outT: number) => string;
  getArrows: (outT: number) => OverlayArrow[];
  selection: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: AnnotationPatch, coalesceKey?: string) => void;
}) => {
  const key = usePlayheadSelector(getKey);
  const arrows = useMemo(() => getArrows(playhead.get()), [key, getArrows]);
  return (
    <ArrowOverlay
      width={width}
      height={height}
      arrows={arrows}
      selection={selection}
      onSelect={onSelect}
      onChange={onChange}
    />
  );
};
