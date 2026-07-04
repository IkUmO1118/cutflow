import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Player } from "@remotion/player";
import type { CallbackListener, PlayerRef } from "@remotion/player";
import { Main } from "../../remotion/Main.tsx";
import {
  buildRenderProps,
  capCountOf,
  normalizeLayerOrder,
  ovCountOf,
} from "../../src/lib/renderProps.ts";
import {
  buildTimeline,
  insertSpans,
  remapInterval,
  snapToOutput,
  toOutputTime,
  toSourceTime,
} from "../../src/lib/timeline.ts";
import type { TimelineEntry } from "../../src/lib/timeline.ts";
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
  CaptionPos,
  CaptionStyle,
  CutPlan,
  LayerId,
  Overlays,
  Transcript,
} from "../../src/types.ts";
import type { DraftData, ProjectData } from "./apiTypes.ts";
import { CaptionOverlay } from "./CaptionOverlay.tsx";
import type { OverlayCaption } from "./CaptionOverlay.tsx";
import { Inspector } from "./Inspector.tsx";
import { CaptionsPanel, MaterialsPanel } from "./Panels.tsx";
import { Timeline } from "./Timeline.tsx";
import { buildTracks } from "./model.ts";
import type {
  AddKind,
  AudioTrackId,
  Clip,
  CutMark,
  DragMode,
  Selection,
  TrackId,
} from "./model.ts";
import {
  JumpIcon,
  LoopIcon,
  PlayPauseIcon,
  SplitIcon,
  StepIcon,
  VolumeIcon,
  VIDEO_EXT_RE,
  deleteDraft,
  fmtTime,
  getPeaks,
  getProject,
  postDraft,
  postPreview,
  postProxy,
  postRender,
  postSave,
  probeMaterialDuration,
  uploadMaterial,
} from "./widgets.tsx";
import type { Peaks } from "./widgets.tsx";

type OverlayEntry = NonNullable<Overlays["overlays"]>[number];

const isMaterialFile = (f: string) =>
  f.startsWith("materials/") && /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm)$/i.test(f);

const keepsOf = (plan: CutPlan) => plan.segments.filter((s) => s.action === "keep");
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** ドラッグで区間がゼロ幅・逆転しないための最小幅(秒) */
const MIN_SPAN = 0.1;

/** undo/redo の1エントリ。編集対象の3ドキュメントのスナップショットを
 * 丸ごと持つ(どれも小さな JSON なので、操作の逆演算ではなく状態の控えで足りる) */
type HistoryDocs = { cutplan: CutPlan; overlays: Overlays; transcript: Transcript };
/** undo 履歴の上限(それより古い編集は切り捨てる) */
const HISTORY_MAX = 100;
/** 連続する同種の編集(文字入力・カラーピッカー・ドラッグ)を1エントリに
 * まとめる時間窓(ms)。これ以上あいたら別の undo 単位に切る */
const HISTORY_COALESCE_MS = 2000;

/** 退避された下書きがディスクの正のデータと異なるか(同じなら復元不要) */
const draftDiffers = (d: DraftData, p: ProjectData): boolean =>
  JSON.stringify(d.cutplan) !== JSON.stringify(p.cutplan) ||
  JSON.stringify(d.overlays) !== JSON.stringify(p.overlays) ||
  JSON.stringify(d.transcript) !== JSON.stringify(p.transcript);

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
  return true; // wipe / bgm は表示専用の常駐クリップ
};

/** 左パネルのタブ(素材一覧・テロップ一覧・選択クリップのプロパティ) */
const PANEL_TABS = [
  ["materials", "素材"],
  ["captions", "テロップ"],
  ["props", "プロパティ"],
] as const;
type PanelTab = (typeof PANEL_TABS)[number][0];
/** 左パネルとプレビューの最小幅(px)。境界ドラッグでこれ以下には縮まない */
const PANEL_MIN = 280;
const VIEWER_MIN = 360;
/** タイムラインと上部(ステージ)の最小高さ(px)。上下の境界ドラッグ用 */
const TIMELINE_MIN = 140;
const STAGE_MIN = 200;

/**
 * cutflow エディタ本体。動画編集ソフトの標準レイアウト:
 * 上=タブパネル(左: 素材/テロップ/プロパティ)+プレビュー(右)、
 * 中=トランスポート、下=タイムライン。上部の左右比は分割バーで変えられる。
 * プレビューは最終レンダーと同じコンポジション(remotion/Main.tsx)を
 * @remotion/player で再生する。動画ソースは元収録の軽量プロキシ
 * (proxy.mp4)で、カットは焼き込まず Player が keep 区間に従って
 * 飛び飛びに再生する(本物の NLE と同じ方式)。だからカット境界の編集は
 * ファイルの作り直しなしで即プレビューに反映される。
 * 正のデータは cutplan / overlays / transcript の各 JSON(元収録の秒)。
 */
export const App = () => {
  const [proj, setProj] = useState<ProjectData | null>(null);
  const [cutplan, setCutplan] = useState<CutPlan | null>(null);
  const [overlays, setOverlays] = useState<Overlays | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [time, setTime] = useState<{ out: number }>({ out: 0 });
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
  /** 左パネルの幅(px)。分割バーのドラッグで変更し、次回起動時も引き継ぐ */
  const [panelW, setPanelW] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.panelW"));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : 380;
  });
  /** タイムラインの高さ(px)。上下の分割バーのドラッグで変更 */
  const [timelineH, setTimelineH] = useState(() => {
    const saved = Number(localStorage.getItem("cutflow.editor.timelineH"));
    return Number.isFinite(saved) && saved >= TIMELINE_MIN ? saved : 300;
  });
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getProject()
      .then((p) => {
        setProj(p);
        setCutplan(p.cutplan);
        setOverlays(p.overlays);
        setTranscript(p.transcript);
        // 前回のセッションが保存せずに終わっていたら(クラッシュ等)、
        // 退避された編集の復元を人間に選ばせる。中身が正のデータと同じなら
        // 復元するものが無いので黙って片付ける
        if (p.draft) {
          if (draftDiffers(p.draft, p)) setDraftOffer(p.draft);
          else deleteDraft().catch(() => {});
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  /* ---------------- 外部変更のホットリロード ---------------- */

  /** 収録フォルダの JSON が外部(Claude Code や手編集)で変わったのに、
   * こちらにも未保存の編集があって自動では読み込み直せない状態 */
  const [externalChange, setExternalChange] = useState(false);
  /** 前回のセッションの未保存編集(自動退避)。復元するか人間が選ぶまで保持 */
  const [draftOffer, setDraftOffer] = useState<DraftData | null>(null);

  /** ディスクの内容で全ドキュメントを読み込み直す。undo/redo は
   * 古いドキュメント由来で外部の編集を巻き戻してしまうので破棄する */
  const reloadFromDisk = async () => {
    try {
      const p = await getProject();
      setProj(p);
      setCutplan(p.cutplan);
      setOverlays(p.overlays);
      setTranscript(p.transcript);
      undoRef.current = [];
      redoRef.current = [];
      historyKeyRef.current = null;
      setSelectionState(null);
      setExternalChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 外部変更の監視(SSE)。未保存の編集が無ければ黙って読み込み直し、
  // あればバナーを出して人間に選ばせる(自動で上書きすると編集が消えるため)
  const dirtyRef = useRef(false);
  const reloadRef = useRef(reloadFromDisk);
  reloadRef.current = reloadFromDisk;
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      if (dirtyRef.current) setExternalChange(true);
      else void reloadRef.current();
    };
    return () => es.close();
  }, []);

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
    if (proj.bgmFile) requestPeaks(proj.bgmFile);
    // 挿入クリップは音声ごと合成される。動画素材ぶんのピークを取る
    for (const ins of overlays?.inserts ?? []) {
      if (VIDEO_EXT_RE.test(ins.file)) requestPeaks(ins.file);
    }
  }, [proj, overlays]);

  /* ---------------- 編集履歴(undo / redo) ---------------- */

  const undoRef = useRef<HistoryDocs[]>([]);
  const redoRef = useRef<HistoryDocs[]>([]);
  /** 直前に履歴を積んだ編集の種類と時刻(pushHistory の key のまとめ判定用) */
  const historyKeyRef = useRef<{ key: string; at: number } | null>(null);
  /** イベントハンドラから最新のドキュメント3点を参照するための控え */
  const docsRef = useRef<HistoryDocs | null>(null);
  docsRef.current =
    cutplan && overlays && transcript ? { cutplan, overlays, transcript } : null;

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
      top?.transcript === d.transcript
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
    setSelectionState((sel) => (selectionValid(sel, d) ? sel : null));
  };
  const undoEdit = () => applyHistory(undoRef.current, redoRef.current);
  const redoEdit = () => applyHistory(redoRef.current, undoRef.current);

  /** 選択の変更は連続編集のまとめの区切り(同じテロップを2回ドラッグしたら
   * undo も2回に分かれるように)。選択を触る箇所はすべてここを通す */
  const setSelection: typeof setSelectionState = (v) => {
    historyKeyRef.current = null;
    setSelectionState(v);
  };

  const keeps = useMemo(() => (cutplan ? keepsOf(cutplan) : []), [cutplan]);
  const inserts = useMemo(() => overlays?.inserts ?? [], [overlays]);
  const timeline = useMemo(() => buildTimeline(keeps, inserts), [keeps, inserts]);
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
    return buildTracks(layerOrder, (n) =>
      overlays ? captionTrackName(n, overlays, capCount) : undefined,
    );
  }, [layerOrder, overlays]);
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
    () => (proj ? proj.dirFiles.filter(isMaterialFile) : []),
    [proj],
  );

  const built = useMemo(() => {
    if (!proj || !cutplan || !overlays || !transcript) return null;
    const warnings: string[] = [];
    const props = buildRenderProps({
      manifest: proj.manifest,
      keeps,
      transcript,
      overlays,
      renderCfg: proj.renderCfg,
      width: proj.output.w,
      height: proj.output.h,
      // 元収録の軽量プロキシ。カットは Player 側で keep 区間ごとに
      // 飛び飛び再生されるので(videoIsSource)、境界編集は即時反映
      videoFile: "media/proxy.mp4",
      videoIsSource: true,
      bgm: proj.bgmFile
        ? {
            file: `media/${proj.bgmFile}`,
            volumeDb: proj.renderCfg.bgm.volumeDb,
            fadeOutSec: proj.renderCfg.bgm.fadeOutSec,
          }
        : null,
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
    // 素材はローカルサーバーの /media/ 経由で配信される
    const overlayItems = props.overlays.map((o) => ({ ...o, file: `media/${o.file}` }));
    const insertItems = (props.inserts ?? []).map((o) => ({
      ...o,
      file: `media/${o.file}`,
    }));
    return { warnings, props: { ...props, overlays: overlayItems, inserts: insertItems } };
  }, [proj, cutplan, overlays, transcript, keeps]);

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

  const anyDirty =
    !!proj &&
    (JSON.stringify(cutplan) !== JSON.stringify(proj.cutplan) ||
      JSON.stringify(overlays) !== JSON.stringify(proj.overlays) ||
      JSON.stringify(transcript) !== JSON.stringify(proj.transcript));
  // SSE ハンドラ(マウント時に固定)から最新の dirty 状態を見るための控え
  dirtyRef.current = anyDirty;

  /* ---------------- 再生・シーク ---------------- */

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame: CallbackListener<"frameupdate"> = (e) => {
      setTime({ out: e.detail.frame / fps });
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
  /** シークバーの進捗(%)。塗りとつまみの位置に使う */
  const playheadPct = duration > 0 ? clamp(time.out / duration, 0, 1) * 100 : 0;
  /** カット後の時刻を元収録の秒へ(終端は少し内側に丸める) */
  const srcAt = (outT: number): number | null =>
    toSourceTime(clamp(outT, 0, Math.max(0, duration - 0.01)), timeline);

  /* ---------------- タイムラインのクリップ ---------------- */

  const clips = useMemo<Clip[]>(() => {
    if (!cutplan || !overlays || !transcript || !built) return [];
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
    // ワイプ: 常駐レイヤー(表示のみ)+ その上に「全画面」属性スパン
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
    // BGM: 収録フォルダの bgm.*(表示のみ。音量などは config.yaml)。
    // 合成はループ再生なので波形もループで描く
    if (proj?.bgmFile) {
      cs.push({
        kind: "bgm", index: 0, track: "bgm",
        outStart: 0, outEnd: duration, label: proj.bgmFile, editable: false, static: true,
        wave: { src: proj.bgmFile, startSec: 0, loop: true },
      });
    }
    return cs;
  }, [cutplan, overlays, transcript, built, timeline, duration, proj?.bgmFile]);

  /* ---------------- カット編集(分割・keep⇄cut・復元) ----------------
   * cut 区間は削除せず記録として残す(plan の候補と同じ扱い)。だから
   * どの操作も可逆で、映像トラックの継ぎ目の印からいつでも戻せる。 */

  /** 映像トラックの継ぎ目に出す「カットされた区間」の印。cutplan の cut
   * 記録のうち、いまも実際に切られているものだけ(トリムで keep が記録の
   * 上まで伸び直したものは出さない)。同じ継ぎ目に複数の記録があるときは
   * stack で横に少しずらして両方掴めるようにする */
  const cutMarks = useMemo(() => {
    if (!cutplan) return [];
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
  }, [cutplan, timeline, duration]);

  /** 再生ヘッドの位置が keep 区間の内側(境界から MIN_SPAN より内)に
   * あるときだけ分割できる。-1 = 分割できる位置ではない */
  const splitIndex = (() => {
    if (!cutplan) return -1;
    const src = srcAt(time.out);
    if (src === null) return -1;
    return cutplan.segments.findIndex(
      (s) => s.action === "keep" && src > s.start + MIN_SPAN && src < s.end - MIN_SPAN,
    );
  })();

  /** 再生ヘッド位置で keep 区間を2つに割る(⌘K)。割っただけでは映像は
   * 変わらない(隣接 keep はカット後も連続)。割ってから端をトリムして
   * 隙間を作る・片側を Delete でカットする、が「真ん中を抜く」手順になる */
  const splitAtPlayhead = () => {
    if (!cutplan || splitIndex === -1) return;
    const src = srcAt(time.out);
    if (src === null) return;
    pushHistory();
    const segs = [...cutplan.segments];
    const seg = segs[splitIndex];
    segs.splice(
      splitIndex,
      1,
      { ...seg, end: round2(src) },
      { ...seg, start: round2(src) },
    );
    setCutplan({ ...cutplan, segments: segs });
    setSelection({ kind: "cut", index: splitIndex + 1 });
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

  /* ---------------- プレビュー上のテロップ移動 ---------------- */

  /** 位置未指定テロップの標準位置(下部中央のテキスト中心。1行ぶんで近似) */
  const stdCaptionPos = useMemo<CaptionPos>(() => {
    if (!built) return { x: 0, y: 0 };
    const { width, height, wipe, caption } = built.props;
    return {
      x: Math.round((width - wipe.widthPx - wipe.marginPx * 2) / 2),
      y: Math.round(height - wipe.marginPx - caption.fontSizePx * 0.7),
    };
  }, [built]);

  /** 再生ヘッド位置に表示中のテロップ(プレビュー上でドラッグ移動できる) */
  const visibleCaptions = useMemo<OverlayCaption[]>(() => {
    if (!transcript || !overlays || !built) return [];
    return transcript.segments.flatMap((s, i) => {
      const vis = remapInterval(s.start, s.end, timeline).some(
        (iv) => time.out >= iv.start && time.out < iv.end,
      );
      if (!vis || s.text.trim().length === 0) return [];
      // 実効位置が確定しているものはトラックの anchor に従い、
      // 位置未指定(下部中央)は中心座標の近似 stdCaptionPos を掴ませる
      const pos = captionPosOf(s, overlays);
      const style = captionStyleOf(s, overlays);
      return [
        {
          index: i,
          text: s.text.trim(),
          pos: pos ?? stdCaptionPos,
          anchor: pos ? captionAnchorOf(s, overlays) : ("center" as const),
          fontSizePx: style?.fontSizePx ?? built.props.caption.fontSizePx,
          fontFamily: style?.fontFamily,
          fontWeight: style?.fontWeight,
        },
      ];
    });
  }, [transcript, overlays, built, timeline, time.out, stdCaptionPos]);

  /** テロップトラックの標準位置・標準スタイルを設定/解除
   * (overlays.json の captionTracks。null で解除、undefined は現状維持) */
  const setCaptionTrackDefault = (
    track: number,
    patch: { pos?: CaptionPos | null; style?: CaptionStyle | null },
  ) => {
    pushHistory();
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
      const list = (prev.captionTracks ?? []).filter((t) => t.track !== track);
      // 位置・スタイル・名前が全部無くなったらエントリごと消す(JSON を汚さない)
      if (entry.x === undefined && entry.y === undefined) delete entry.anchor;
      if (
        entry.x !== undefined ||
        entry.y !== undefined ||
        entry.style ||
        entry.name !== undefined
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
      if (
        entry.x !== undefined ||
        entry.y !== undefined ||
        entry.style ||
        entry.name !== undefined
      ) {
        list.push(entry);
      }
      list.sort((a, b) => a.track - b.track);
      const next: Overlays = { ...prev, captionTracks: list };
      if (list.length === 0) delete next.captionTracks;
      return next;
    });
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
    /** ドラッグ開始時の写像と、掴んだクリップのカット後位置(Δ の基準) */
    timeline: TimelineEntry[];
    grabOutStart: number;
    grabOutEnd: number;
    /** このドラッグを undo 履歴へ積んだか(最初に動いた瞬間に1回だけ積む) */
    pushed: boolean;
  } | null>(null);

  const onDragStart = (sel: NonNullable<Selection>, mode: DragMode, clip: Clip) => {
    if (!cutplan || !overlays || !transcript) return;
    dragRef.current = {
      sel, mode, cutplan, overlays, transcript,
      timeline, grabOutStart: clip.outStart, grabOutEnd: clip.outEnd, pushed: false,
    };
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };
  const onDragMove = (d: number, overTrack: TrackId) => {
    const ctx = dragRef.current;
    if (!ctx) return;
    // クリックだけ(移動なし)では積まない。ドラッグ中の更新は毎回届くが
    // 履歴はドラッグ開始前の状態1回分だけ(1ドラッグ=1 undo)
    if (!ctx.pushed) {
      ctx.pushed = true;
      pushHistory();
    }
    const { sel, mode } = ctx;
    const tl = ctx.timeline;
    const outDur = tl.length > 0 ? tl[tl.length - 1].end + tl[tl.length - 1].offset : 0;
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
        const durX = tlx.length > 0 ? tlx[tlx.length - 1].end + tlx[tlx.length - 1].offset : 0;
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
      arr[sel.index] = entry;
      setOverlays({ ...ctx.overlays, [kind]: arr });
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
  const addWipeFull = (start: number, end: number) => {
    if (!overlays) return;
    pushHistory();
    const list = [...(overlays.wipeFull ?? []), { start, end }];
    setOverlays({ ...overlays, wipeFull: list });
    setSelection({ kind: "wipeFull", index: list.length - 1 });
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
    mode: "overlay" | "insert",
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
      const outT = at?.outT ?? time.out;
      const s = srcAt(outT);
      if (s === null) return;
      const dur = res.durationSec ?? 4;
      const track = (at ? ovNum(at.track) : null) ?? ovTracks; // 既定は一番手前
      addOverlaySpan(round2(s), round2(Math.min(s + dur, srcDur)), track, res.file);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onUploadClick = () => {
    fileInputRef.current?.click();
  };
  const onDropFile = (track: TrackId, outT: number, f: File) => {
    if (track === "cut") {
      void uploadAndPlace(f, { track, outT }, "insert");
    } else if (ovNum(track) !== null) {
      void uploadAndPlace(f, { track, outT }, "overlay");
    }
  };
  const onFileChosen = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void uploadAndPlace(f, null, "overlay");
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
  const updateCaption = (i: number, patch: Partial<Transcript["segments"][number]>) => {
    // 文字入力・カラーピッカー・プレビュー上の位置ドラッグは1操作で何度も
    // 届くので、同じ項目への連続更新は undo 1回分にまとめる
    const keys = Object.keys(patch).sort();
    const continuous = keys.every((k) => k === "pos" || k === "style" || k === "text");
    pushHistory(continuous ? `caption:${i}:${keys.join(",")}` : null);
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
  const updateSpan = (kind: "overlays" | "wipeFull", i: number, patch: Partial<OverlayEntry>) => {
    pushHistory();
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...((prev[kind] ?? []) as OverlayEntry[])];
      arr[i] = { ...arr[i], ...patch };
      return { ...prev, [kind]: arr };
    });
  };
  const removeSpan = (kind: "overlays" | "wipeFull", i: number) => {
    pushHistory();
    setOverlays((prev) => prev && { ...prev, [kind]: (prev[kind] ?? []).filter((_, j) => j !== i) });
    setSelection(null);
  };
  /** インサート編集: anchorSrc(元収録の秒)の位置に file を素材の実尺で差し込む */
  const placeInsert = (file: string, durationSec: number | null, anchorSrc: number) => {
    if (!overlays) return;
    pushHistory();
    const list = [
      ...(overlays.inserts ?? []),
      { at: round2(anchorSrc), file, durationSec: round2(Math.max(MIN_SPAN, durationSec ?? 4)) },
    ];
    setOverlays({ ...overlays, inserts: list });
    setSelection({ kind: "insert", index: list.length - 1 });
  };
  const updateInsert = (
    i: number,
    patch: Partial<NonNullable<Overlays["inserts"]>[number]>,
  ) => {
    pushHistory();
    setOverlays((prev) => {
      if (!prev) return prev;
      const arr = [...(prev.inserts ?? [])];
      const merged = { ...arr[i], ...patch };
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

  const removeSelected = () => {
    if (!selection) return;
    // ドラッグ中に消した場合、スナップショットからの再構築で復活しないように
    dragRef.current = null;
    if (selection.kind === "caption") removeCaption(selection.index);
    else if (selection.kind === "insert") removeInsert(selection.index);
    else if (selection.kind === "overlays" || selection.kind === "wipeFull") {
      removeSpan(selection.kind, selection.index);
    } else if (selection.kind === "cut") {
      // 映像クリップの Delete は削除ではなくカット(記録に倒すだけ。
      // 継ぎ目の印からいつでも戻せる)
      cutKeepSeg(selection.index);
    }
  };

  /* ---------------- 保存・下書き退避・プロキシ生成 ---------------- */

  const save = async () => {
    if (!proj || !cutplan || !overlays || !transcript) return;
    const body = {
      ...(JSON.stringify(cutplan) !== JSON.stringify(proj.cutplan) ? { cutplan } : {}),
      ...(JSON.stringify(overlays) !== JSON.stringify(proj.overlays) ? { overlays } : {}),
      ...(JSON.stringify(transcript) !== JSON.stringify(proj.transcript) ? { transcript } : {}),
    };
    if (Object.keys(body).length > 0) await postSave(body);
    setProj({ ...proj, cutplan, overlays, transcript });
    // 保存 = こちらの内容で上書きすると選んだということ。外部変更の警告は下げる
    setExternalChange(false);
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
  }, [cutplan, overlays, transcript, anyDirty]);

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
    setSelectionState((sel) => (selectionValid(sel, d) ? sel : null));
    setDraftOffer(null);
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
  const generateProxy = async () => {
    setProxyBusy(true);
    setError(null);
    try {
      await postProxy();
      setProj((p) => p && { ...p, proxyExists: true });
      setVideoVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProxyBusy(false);
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
    try {
      const res = stage === "preview" ? await postPreview() : await postRender();
      setJob({ stage, status: "done", path: res.path });
    } catch (e) {
      setError((e as Error).message);
      setJob(null);
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
    localStorage.setItem("cutflow.editor.timelineH", String(timelineH));
  }, [timelineH]);

  /** 分割バー共通: window にリスナーを張り、pointerup / cancel で必ず外す */
  const beginSplitDrag = (e: ReactPointerEvent, move: (ev: PointerEvent) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const onUp = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** 左右の分割バー: 左パネルの幅を変更(両側の最小幅より内側だけ) */
  const onSplitterDown = (e: ReactPointerEvent) =>
    beginSplitDrag(e, (ev) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelW(
        clamp(ev.clientX - rect.left, PANEL_MIN, Math.max(PANEL_MIN, rect.width - VIEWER_MIN)),
      );
    });

  /** 上下の分割バー: タイムラインの高さを変更(ステージの最小高さは確保) */
  const onHSplitterDown = (e: ReactPointerEvent) => {
    const y0 = e.clientY;
    const h0 = timelineH;
    const stageH0 = stageRef.current?.getBoundingClientRect().height ?? 0;
    const max = Math.max(TIMELINE_MIN, h0 + stageH0 - STAGE_MIN);
    beginSplitDrag(e, (ev) =>
      setTimelineH(clamp(h0 + (y0 - ev.clientY), TIMELINE_MIN, max)),
    );
  };

  // タイムラインで選択したものに応じてタブを切り替える
  // (テロップ→「テロップ」、それ以外→「プロパティ」。手動のタブ切替は上書きしない)
  const prevSelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = selection ? `${selection.kind}-${selection.index}` : null;
    if (key === prevSelKeyRef.current) return;
    prevSelKeyRef.current = key;
    if (!selection) return;
    setTab(selection.kind === "caption" ? "captions" : "props");
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
    mode: "overlay" | "insert",
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
    const outT = at?.outT ?? time.out;
    const s = srcAt(outT);
    if (s === null) return;
    const track = (at ? ovNum(at.track) : null) ?? ovTracks; // 既定は一番手前
    addOverlaySpan(round2(s), round2(Math.min(s + (dur ?? 4), srcDur)), track, file);
  };

  const onDropMaterial = (track: TrackId, outT: number, file: string) => {
    if (track === "cut") void placeMaterial(file, { track, outT }, "insert");
    else if (ovNum(track) !== null) void placeMaterial(file, { track, outT }, "overlay");
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

  /* ---------------- キーボード ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        // 保存・生成・アップロードの実行中は重ねて保存しない
        if (busy === null) void onSave();
        return;
      }
      const t = e.target as HTMLElement;
      // 入力欄の中はブラウザ標準の undo/redo に任せる(下の guard で除外)
      if (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
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

  /* ---------------- 描画 ---------------- */

  if (error && !proj) return <div className="fatal">エラー: {error}</div>;
  if (!proj || !built || !cutplan || !overlays || !transcript) {
    return <div className="fatal dim">読み込み中…</div>;
  }

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/mp4,video/quicktime,video/webm"
        style={{ display: "none" }}
        onChange={(e) => {
          onFileChosen(e.target.files);
          e.target.value = ""; // 同じファイルを続けて選べるように
        }}
      />
      <header>
        <strong>cutflow editor</strong>
        <span className="dim path">{proj.dir}</span>
        <span className="spacer" />
        {error && <span className="error">エラー: {error}</span>}
        {draftOffer && (
          <span
            className="externalChange"
            title="前回のセッションが保存せずに終わったため、自動退避された編集が残っています。復元してもファイルは保存(⌘S)するまで書き換わりません"
          >
            保存されなかった編集があります(
            {new Date(draftOffer.savedAt).toLocaleString()} 時点)
            <button className="warn" onClick={restoreDraft}>
              復元する
            </button>
            <button onClick={discardDraft}>破棄</button>
          </span>
        )}
        {externalChange && (
          <span
            className="externalChange"
            title="Claude Code などがこのフォルダの JSON を書き換えました。読み込み直すとその内容が反映されます(こちらの未保存の編集は消えます)。保存すればこちらの内容で上書きします"
          >
            ファイルが外部で変更されました
            <button className="warn" onClick={() => void reloadFromDisk()}>
              読み込み直す(未保存の編集は破棄)
            </button>
          </span>
        )}
        {job && (
          <span
            className="externalChange"
            title={
              job.status === "running"
                ? "書き出し中です。完了までこのまま編集を続けられます(ファイルはディスクの内容を読みます)"
                : "書き出しが完了しました"
            }
          >
            {job.status === "running"
              ? `${job.stage === "render" ? "レンダー" : "プレビュー生成"}中…` +
                (job.stage === "render" ? "(数分かかることがあります)" : "")
              : `${job.stage === "render" ? "レンダー" : "プレビュー"}完了: ${
                  job.path?.split("/").pop() ?? job.path
                }`}
            {job.status === "done" && (
              <button onClick={() => setJob(null)}>閉じる</button>
            )}
          </span>
        )}
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
        <button
          className="primary"
          disabled={!anyDirty || busy !== null}
          onClick={() => void onSave()}
        >
          {busy === "save" ? "保存中…" : anyDirty ? "保存 ⌘S ●" : "保存済み"}
        </button>
        <button
          disabled={job?.status === "running" || busy !== null}
          title="カット確認用の軽い動画(preview.mp4)を生成する。未保存の編集は自動で保存してから走る"
          onClick={() => void runExport("preview")}
        >
          プレビュー生成
        </button>
        <button
          disabled={!cutplan.approved || job?.status === "running" || busy !== null}
          title={
            cutplan.approved
              ? "最終レンダー(final.mp4)を生成する。完了すると Finder で開く"
              : "先に「承認済み」にチェックしてください(render の承認ゲート)"
          }
          onClick={() => void runExport("render")}
        >
          レンダー
        </button>
      </header>

      <div className="stage" ref={stageRef}>
        <aside
          className="sidePanel"
          style={{ width: panelW, maxWidth: `calc(100% - ${VIEWER_MIN}px)` }}
        >
          <div className="tabs">
            {PANEL_TABS.map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="panelBody">
            {tab === "materials" && (
              <MaterialsPanel
                materials={materials}
                busy={busy !== null}
                onUploadClick={onUploadClick}
                onPlace={(f) => void placeMaterial(f, null, "overlay")}
                onDragBegin={onMaterialDragBegin}
                onDragEnd={onMaterialDragEnd}
              />
            )}
            {tab === "captions" && (
              <CaptionsPanel
                transcript={transcript}
                overlays={overlays}
                capTracks={capTracks}
                selectedIndex={selection?.kind === "caption" ? selection.index : null}
                onRowClick={(i) => selectCaption(i, true)}
                onRowFocus={(i) => selectCaption(i, false)}
                updateCaption={updateCaption}
              />
            )}
            {tab === "props" && (
              <Inspector
                // 選択が変わったら編集欄ごと作り直す(未確定の入力を持ち越さない)
                key={selection ? `${selection.kind}-${selection.index}` : "none"}
                selection={selection}
                cutplan={cutplan}
                overlays={overlays}
                transcript={transcript}
                materials={materials}
                ovTracks={ovTracks}
                capTracks={capTracks}
                stdCaptionPos={stdCaptionPos}
                captionFontSizePx={built.props.caption.fontSizePx}
                setCaptionTrackDefault={setCaptionTrackDefault}
                updateCutSeg={updateCutSeg}
                cutKeepSeg={cutKeepSeg}
                restoreCutSeg={restoreCutSeg}
                updateCaption={updateCaption}
                removeCaption={removeCaption}
                updateSpan={updateSpan}
                removeSpan={removeSpan}
                updateInsert={updateInsert}
                removeInsert={removeInsert}
              />
            )}
          </div>
        </aside>
        <div
          className="splitter"
          title="ドラッグで幅を変更"
          onPointerDown={onSplitterDown}
        />
        <div className="viewerCol">
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
                initialVolume={playerVolume}
                // 共有 <audio> タグのプールは AudioContext の作り直しで登録が
                // ずれて落ちる(unregisterAudio の TypeError / No audio ref found)。
                // モバイルの自動再生制限対策の仕組みで、ここでは再生が常に
                // ユーザー操作起点なので不要。0 でプールを無効化する
                numberOfSharedAudioTags={0}
                spaceKeyToPlayOrPause={false}
                style={{ width: "100%", height: "100%" }}
              />
              <CaptionOverlay
                width={built.props.width}
                height={built.props.height}
                captions={visibleCaptions}
                selection={selection?.kind === "caption" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "caption", index: i })}
                onMove={(i, pos) => updateCaption(i, { pos })}
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
                  <p>プロキシの生成に失敗しました(エラーは上部に表示)</p>
                  <button className="primary" onClick={() => void generateProxy()}>
                    プロキシ生成を再試行
                  </button>
                </>
              )}
            </div>
          )}
          {built.warnings.length > 0 && (
            <div className="warnbox">
              {built.warnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
            </div>
          )}
        </div>

        <div className="transport">
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
          <div className="scrubFill" style={{ width: `${playheadPct}%` }} />
          <div className="scrubThumb" style={{ left: `${playheadPct}%` }} />
        </div>
        {/* 下段: 左=時刻・音量 / 中央=再生まわり / 右=元収録の秒・秒送り */}
        <div className="tRow">
        <div className="tLeft">
          <span className="tcode">
            <b className="mono">{fmtTime(time.out)}</b>
            <span className="dim"> / {fmtTime(duration)}</span>
          </span>
          {/* ホバーで音量バーが横に伸びる(YouTube 風)。普段はアイコンだけ */}
          <div className="volCtl">
            <button
              className="icon mute"
              title={`ミュート切替(プレビューのみ。書き出しには影響しない)。現在 ${volumePct}%`}
              onClick={toggleMute}
            >
              <VolumeIcon
                level={volumePct === 0 ? "mute" : volumePct < 50 ? "low" : "high"}
                size={16}
              />
            </button>
            <input
              className="volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={volumePct}
              style={{
                // 左側(現在値まで)をアクセント色で塗る
                background: `linear-gradient(to right, var(--accent) ${volumePct}%, var(--border) ${volumePct}%)`,
              }}
              title={`プレビューの音量 ${volumePct}%(書き出しには影響しない)。ダブルクリックで100%`}
              onChange={(e) => setVolumePct(Number(e.target.value))}
              onDoubleClick={() => setVolumePct(100)}
            />
          </div>
        </div>
        <div className="tCenter">
          <button className="icon" title="先頭へ (Home)" onClick={() => seekOut(0)}>
            <JumpIcon dir="back" />
          </button>
          <button className="icon" title="1フレーム戻る (←)" onClick={() => stepFrames(-1)}>
            <StepIcon dir="back" />
          </button>
          <button className="play" title="再生/停止 (Space)" onClick={togglePlay}>
            <PlayPauseIcon playing={playing} size={18} />
          </button>
          <button className="icon" title="1フレーム進む (→)" onClick={() => stepFrames(1)}>
            <StepIcon dir="fwd" />
          </button>
          <button className="icon" title="末尾へ (End)" onClick={() => seekOut(duration)}>
            <JumpIcon dir="fwd" />
          </button>
          <button
            className={`icon loop${loop ? " active" : ""}`}
            title="ループ再生(プレビューのみ)"
            onClick={() => setLoop((v) => !v)}
          >
            <LoopIcon />
          </button>
          <button
            className="icon"
            title={
              "この位置でクリップを分割 (⌘K)。割っただけでは映像は変わらず、" +
              "端をトリムして詰める・片側を Delete でカットして使う"
            }
            disabled={splitIndex === -1}
            onClick={splitAtPlayhead}
          >
            <SplitIcon />
          </button>
        </div>
        <div className="tRight">
          <button className="icon" title="1秒戻る (Shift+←)" onClick={() => stepFrames(-fps)}>
            <StepIcon dir="back" double />
          </button>
          <button className="icon" title="1秒進む (Shift+→)" onClick={() => stepFrames(fps)}>
            <StepIcon dir="fwd" double />
          </button>
        </div>
        </div>
        </div>
        </div>
      </div>

      <div
        className="splitter h"
        title="ドラッグで高さを変更"
        onPointerDown={onHSplitterDown}
      />
      <Timeline
        height={timelineH}
        duration={duration}
        playhead={time.out}
        clips={clips}
        cutMarks={cutMarks}
        peaks={peaksMap}
        tracks={tracks}
        selection={selection}
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
        onRemoveTrack={removeTrack}
        onRenameTrack={setCaptionTrackName}
        onDropFile={onDropFile}
        onDropMaterial={onDropMaterial}
        dragMaterial={dragMaterial}
        trackMuted={trackMuted}
        onToggleTrackMute={toggleTrackMute}
        hiddenLayers={hiddenLayers}
        onToggleTrackHide={toggleTrackHide}
      />
    </div>
  );
};
