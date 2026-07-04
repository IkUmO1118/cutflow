import { memo, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { capNum, ovNum } from "../../src/types.ts";
import type { LayerId } from "../../src/types.ts";
import type {
  AudioTrackId,
  Clip,
  CutMark,
  DragMode,
  Selection,
  TrackDef,
  TrackId,
} from "./model.ts";
import { MATERIAL_MIME, ROW_H } from "./model.ts";
import { EyeIcon, UndoIcon, VolumeIcon, fmtTime } from "./widgets.tsx";
import type { Peaks } from "./widgets.tsx";

/** 素材クリップの色。トラック番号で巡回(V1=緑、V2=紫は従来と同じ) */
const OV_COLORS = ["#14532d", "#4c1d95", "#7c2d12", "#134e4a", "#701a75", "#1e3a8a"];
export const ovColor = (track: TrackId): string | undefined => {
  const n = ovNum(track);
  return n !== null ? OV_COLORS[(n - 1) % OV_COLORS.length] : undefined;
};

/** 波形 canvas のデバイスピクセル幅の上限。超えるぶんは CSS で引き伸ばす
 * (高ズームの巨大クリップで canvas メモリが膨れないように。時間軸の比率は
 * 一様な引き伸ばしなので位置はずれない) */
const WAVE_MAX_W = 8192;

/**
 * クリップに重ねる音声の波形。ピーク列の時刻軸(マイク = 元収録の秒、
 * 素材・BGM = ファイル自身の秒)から [srcStart, srcStart+durSec) を
 * 切り出して中央線対称に描く。トリムで端がカット領域へ伸びてもそこの
 * 音が見える。loop はファイル末尾で先頭へ戻る(BGM のループ合成と同じ)。
 * memo: ドラッグ中はクリップ配列が毎回作り直されるので、動かしていない
 * クリップの再描画を props 比較で抑える
 */
const Waveform = memo(
  ({
    peaks,
    srcStart,
    durSec,
    pxWidth,
    pxHeight,
    loop = false,
  }: {
    peaks: Peaks;
    /** クリップ先頭に対応する音声内の秒 */
    srcStart: number;
    /** クリップの長さ(秒) */
    durSec: number;
    /** クリップの表示幅(CSS px) */
    pxWidth: number;
    /** クリップの表示高さ(CSS px)。トラックの高さに追従する */
    pxHeight: number;
    loop?: boolean;
  }) => {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
      const cv = ref.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.min(Math.round(pxWidth * dpr), WAVE_MAX_W));
      const h = Math.max(1, Math.round(pxHeight * dpr));
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(170, 205, 255, 0.5)";
      const mid = h / 2;
      const { rate, data } = peaks;
      if (data.length === 0) return;
      const binsPerPx = (durSec * rate) / w;
      const base = srcStart * rate;
      for (let x = 0; x < w; x++) {
        // この列が覆うピークの最大値(1px 未満のときは最寄りの1本)
        const b0 = Math.floor(base + x * binsPerPx);
        const b1 = Math.max(b0 + 1, Math.ceil(base + (x + 1) * binsPerPx));
        let v = 0;
        for (let b = Math.max(0, b0); b < b1; b++) {
          const i = loop ? b % data.length : b;
          if (i >= data.length) break;
          if (data[i] > v) v = data[i];
        }
        if (v === 0) continue;
        // 小さい音も見えるように緩い圧縮をかける(見た目だけ。^0.7)
        const amp = Math.max(dpr * 0.5, Math.pow(v / 255, 0.7) * (mid - dpr));
        ctx.fillRect(x, mid - amp, 1, amp * 2);
      }
    }, [peaks, srcStart, durSec, pxWidth, pxHeight, loop]);
    return <canvas ref={ref} className="tlWave" />;
  },
);

/** トラック高さの範囲と localStorage キー(最小 = 既定の ROW_H。
 * 既定より低くは潰せず、広げる方向だけ) */
const ROW_H_MIN = ROW_H;
const ROW_H_MAX = 96;
const ROW_H_STORE = "cutflow.editor.trackHeights";
/** ドロップ吸着 ON/OFF の保存キー(既定 ON) */
const SNAP_STORE = "cutflow.editor.snapEnabled";

/**
 * 画面下部のマルチトラックタイムライン。横軸はカット後の秒、上=前面。
 * ここは「見た目とポインタ操作」だけを持ち、ドキュメントの変換・更新は
 * すべて App 側のコールバックに委ねる(ドラッグ量はカット後の秒で通知)。
 * トラックのラベルを上下にドラッグすると重なり順を並べ替えられる。
 */
export const Timeline = ({
  height,
  duration,
  playhead,
  clips,
  cutMarks,
  peaks,
  tracks,
  selection,
  onSeek,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCreate,
  onReorderTrack,
  onAddTrack,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onRemoveTrack,
  onRenameTrack,
  onDropFile,
  onDropMaterial,
  dragMaterial,
  trackMuted,
  onToggleTrackMute,
  hiddenLayers,
  onToggleTrackHide,
  defaultDurationSec,
}: {
  /** タイムライン全体の高さ(px)。上部との分割バーのドラッグで変わる */
  height: number;
  duration: number;
  playhead: number;
  clips: Clip[];
  /** 映像トラックの継ぎ目に出す「カットされた区間」の印(クリックで選択
   * → Inspector で復元)。位置はカット後秒なので幅は持たない */
  cutMarks: CutMark[];
  /** 音声の波形ピーク(キー "" = マイク、他 = 素材・BGM の相対パス)。
   * null = 音声なし/取得失敗(そのクリップは波形なし) */
  peaks: Record<string, Peaks | null>;
  /** 表示順(上=前面)。App が layerOrder から組み立てる */
  tracks: TrackDef[];
  selection: Selection;
  onSeek: (outT: number) => void;
  onSelect: (sel: Selection) => void;
  /** clip: 掴んだクリップ(カットで割れたスパンはフラグメントの位置を持つ) */
  onDragStart: (sel: NonNullable<Selection>, mode: DragMode, clip: Clip) => void;
  /** overTrack: move ドラッグ中にポインタが乗っているトラック
   * (素材の V1/V2 レイヤー移動に使う) */
  onDragMove: (deltaOutSec: number, overTrack: TrackId) => void;
  onDragEnd: () => void;
  onCreate: (track: TrackId, outStart: number, outEnd: number) => void;
  /** ラベルのドラッグ先(tracks の添字)。並べ替え可能な範囲へは App が丸める */
  onReorderTrack: (id: TrackId, toIndex: number) => void;
  /** トラックを1本追加する(種類は＋ボタンのメニューで選ぶ) */
  onAddTrack: (kind: "caption" | "overlay") => void;
  /** 編集履歴の有無(undo/redo ボタンの活性)。実体は App 側が持つ */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 空の素材/テロップトラックを削除する(番号は詰め直される) */
  onRemoveTrack: (id: TrackId) => void;
  /** テロップトラックの名前を変更(空文字で自動ラベルに戻す)。
   * track = テロップトラック番号(TrackDef.renamableCaption) */
  onRenameTrack: (track: number, name: string) => void;
  /** 素材トラックへのファイルドロップ(outT = ドロップ位置のカット後秒) */
  onDropFile: (track: TrackId, outT: number, file: File) => void;
  /** 素材パネルのカードのドロップ(file = プロジェクト相対パス) */
  onDropMaterial: (track: TrackId, outT: number, file: string) => void;
  /** 素材パネルからドラッグ中の素材(ドロップゴーストの幅・ラベルに使う)。
   * null = ドラッグしていない/OS のファイルドラッグ(尺は不明なので既定幅) */
  dragMaterial: { file: string; durationSec: number | null } | null;
  /** 音声トラック(映像・BGM)のプレビューミュート状態 */
  trackMuted: Record<AudioTrackId, boolean>;
  onToggleTrackMute: (id: AudioTrackId) => void;
  /** 一時非表示中のレイヤー(ラベルの目トグル。プレビューのみ) */
  hiddenLayers: LayerId[];
  onToggleTrackHide: (id: LayerId) => void;
  /** 画像・尺不明素材の既定の尺(秒)。config の editor.defaultImageDurationSec */
  defaultDurationSec: number;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 左のラベル列(縦スクロールを tlScroll と同期させる) */
  const labelsRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [ghost, setGhost] = useState<{ track: TrackId; a: number; b: number } | null>(null);
  const ghostRef = useRef<typeof ghost>(null);
  const [dragLabel, setDragLabel] = useState<TrackId | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** トラック名の編集中(テロップトラックのラベルをダブルクリック) */
  const [renaming, setRenaming] = useState<{ id: TrackId; value: string } | null>(null);
  /** ドロップ時の吸着(クリップ境界・再生ヘッド・0/末尾)の ON/OFF */
  const [snapOn, setSnapOn] = useState(
    () => localStorage.getItem(SNAP_STORE) !== "false",
  );
  useEffect(() => {
    localStorage.setItem(SNAP_STORE, String(snapOn));
  }, [snapOn]);
  /** トラックごとの高さ(px)。ラベル下端のドラッグで変更、次回起動時も引き継ぐ */
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(ROW_H_STORE) ?? "");
      if (saved && typeof saved === "object") {
        return Object.fromEntries(
          Object.entries(saved as Record<string, unknown>).filter(
            ([, v]) => typeof v === "number" && Number.isFinite(v),
          ),
        ) as Record<string, number>;
      }
    } catch {
      // 保存なし・壊れた JSON は既定の高さから
    }
    return {};
  });
  useEffect(() => {
    localStorage.setItem(ROW_H_STORE, JSON.stringify(trackHeights));
  }, [trackHeights]);
  /** トラックの表示高さ(px)。未設定は既定の ROW_H */
  const rowH = (id: TrackId): number =>
    Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, trackHeights[id] ?? ROW_H));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitPps = viewW > 0 && duration > 0 ? viewW / duration : 50;
  const pps = fitPps * zoom;
  const totalW = Math.max(viewW, Math.ceil(duration * pps));

  /** ズーム後もアンカー位置(カーソル/ビュー中央)の時刻が動かないよう、
   * 再レンダー後に合わせるスクロール位置。t = カット後秒, px = ビュー左端からの距離 */
  const pendingAnchor = useRef<{ t: number; px: number } | null>(null);

  /** factor 倍にズーム(0 で全体表示にリセット)。anchorClientX を渡すと
   * その画面座標、省略時はビュー中央を基準に拡縮する */
  const applyZoom = (factor: number, anchorClientX?: number) => {
    const next = factor === 0 ? 1 : Math.min(64, Math.max(1, zoom * factor));
    if (next === zoom) return;
    const el = scrollRef.current;
    if (el && next > 1) {
      const px =
        anchorClientX !== undefined
          ? anchorClientX - el.getBoundingClientRect().left
          : el.clientWidth / 2;
      pendingAnchor.current = { t: (el.scrollLeft + px) / pps, px };
    }
    setZoom(next);
  };
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;

  useEffect(() => {
    const a = pendingAnchor.current;
    if (!a) return;
    pendingAnchor.current = null;
    if (scrollRef.current) scrollRef.current.scrollLeft = a.t * fitPps * zoom - a.px;
  }, [zoom, fitPps]);

  // ⌘/Ctrl+スクロール(Mac のピンチ含む)でカーソル位置を基準にズーム。
  // preventDefault が必要なので React ではなく passive: false で直接張る
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoomRef.current(Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const posToT = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.min(Math.max(x / pps, 0), duration);
  };

  /** ルーラーの高さ(px)。CSS の .tlRuler / .tlRulerSpacer と一致させる */
  const RULER_H = 24;

  /** コンテンツ座標の縦位置 → トラック添字(高さは可変なので累積で探す) */
  const trackIndexOfY = (y: number): number => {
    let acc = 0;
    for (let i = 0; i < tracks.length; i++) {
      acc += rowH(tracks[i].id);
      if (y < acc) return i;
    }
    return tracks.length - 1;
  };
  /** ポインタ位置 → トラック行側(tlScroll)のトラック添字 */
  const trackIndexAt = (clientY: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    return trackIndexOfY(clientY - el.getBoundingClientRect().top + el.scrollTop - RULER_H);
  };
  /** ポインタ位置 → ラベル列(tlLabelScroll)のトラック添字 */
  const labelIndexAt = (clientY: number): number => {
    const el = labelsRef.current;
    if (!el) return 0;
    return trackIndexOfY(clientY - el.getBoundingClientRect().top + el.scrollTop);
  };

  /** window にリスナーを張るドラッグの共通処理。コンテキストメニュー等で
   * pointerup が届かないことがあるので pointercancel でも必ず後始末する */
  const beginDrag = (
    e: ReactPointerEvent,
    move: (ev: PointerEvent) => void,
    up?: () => void,
  ) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      up?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onRulerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // 右クリックでスクラブが固着しないように
    onSeek(posToT(e.clientX));
    beginDrag(e, (ev) => onSeek(posToT(ev.clientX)));
  };

  const onClipDown = (e: ReactPointerEvent, clip: Clip, mode: DragMode) => {
    e.stopPropagation();
    if (e.button !== 0) return; // 主ボタン以外はドラッグを始めない
    if (!clip.editable) return;
    onSelect({ kind: clip.kind, index: clip.index });
    onDragStart({ kind: clip.kind, index: clip.index }, mode, clip);
    const x0 = e.clientX;
    beginDrag(
      e,
      (ev) => {
        // 縦方向はポインタ下のトラックへの移動として通知
        // (素材の V1/V2 = z-index の入れ替え)
        onDragMove((ev.clientX - x0) / pps, tracks[trackIndexAt(ev.clientY)].id);
      },
      onDragEnd,
    );
  };

  /** トラックのラベルを上下にドラッグして重なり順を並べ替える */
  const onLabelDown = (e: ReactPointerEvent, idx: number) => {
    if (e.button !== 0) return;
    const t = tracks[idx];
    if (!t.reorderable) return;
    let cur = idx;
    setDragLabel(t.id);
    beginDrag(
      e,
      (ev) => {
        const target = labelIndexAt(ev.clientY);
        if (target !== cur) {
          onReorderTrack(t.id, target);
          cur = target;
        }
      },
      () => setDragLabel(null),
    );
  };

  /** ラベル下端のドラッグでトラックの高さを変更(ダブルクリックで既定に戻す) */
  const onResizeDown = (e: ReactPointerEvent, id: TrackId) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 並べ替えドラッグを始めない
    const y0 = e.clientY;
    const h0 = rowH(id);
    beginDrag(e, (ev) => {
      const h = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, h0 + (ev.clientY - y0)));
      setTrackHeights((m) => (m[id] === h ? m : { ...m, [id]: h }));
    });
  };

  const onTrackDown = (e: ReactPointerEvent, track: TrackDef) => {
    if (e.button !== 0) return;
    if (!track.createKind) {
      onSelect(null);
      return;
    }
    // 空き領域のドラッグで新しい区間を作る
    const t0 = posToT(e.clientX);
    const set = (g: typeof ghost) => {
      ghostRef.current = g;
      setGhost(g);
    };
    set({ track: track.id, a: t0, b: t0 });
    beginDrag(
      e,
      (ev) => set(ghostRef.current && { ...ghostRef.current, b: posToT(ev.clientX) }),
      () => {
        const g = ghostRef.current;
        set(null);
        if (!g) return;
        const [s, en] = [Math.min(g.a, g.b), Math.max(g.a, g.b)];
        if ((en - s) * pps > 4) onCreate(g.track, s, en);
        else onSelect(null); // ただのクリックは選択解除
      },
    );
  };

  // ルーラーの目盛り間隔: 1目盛りが 70px 以上になる切りのいい秒数
  const step = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 70) ?? 120;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  const isSel = (c: Clip) =>
    selection !== null && selection.kind === c.kind && selection.index === c.index;

  const ovTrackCount = tracks.filter((t) => ovNum(t.id) !== null).length;
  const capTrackCount = tracks.filter((t) => capNum(t.id) !== null).length;
  /** 空の素材/テロップトラック(その種類が2本以上あるとき)はラベルの × で削除できる */
  const isRemovable = (t: TrackDef) => {
    const count =
      ovNum(t.id) !== null ? ovTrackCount : capNum(t.id) !== null ? capTrackCount : 0;
    return count > 1 && !clips.some((c) => c.track === t.id);
  };

  /* ---- 素材パネル・OS ファイルのドロップ(Premiere 風) ----
   * トラック行に正確に乗せなくても、タイムライン上ならどこでも最寄りの
   * 置けるトラック(素材 V* / 映像)にクリップ形のゴーストを出し、
   * ドロップはゴーストの位置(スナップ済み)に落とす。 */

  /** ドロップ先のゴースト。t = 左端(カット後秒)、snapLine = 吸着した境界 */
  const [drop, setDrop] = useState<{
    track: TrackId;
    t: number;
    snapLine: number | null;
  } | null>(null);

  // ドラッグがキャンセルされた・パネル側で終わったときの消し忘れ防止
  useEffect(() => {
    if (!dragMaterial) setDrop(null);
  }, [dragMaterial]);

  /** ゴーストの幅に使う尺(秒)。画像・不明は配置時の既定と同じ */
  const dragDurSec = dragMaterial?.durationSec ?? defaultDurationSec;
  const dragName = dragMaterial
    ? dragMaterial.file.replace(/^materials\//, "")
    : "ファイル";

  const isDropTrack = (t: TrackDef) => ovNum(t.id) !== null || t.id === "cut";
  /** ポインタに一番近い置けるトラック(行の添字距離で上下に探す) */
  const dropTrackAt = (clientY: number): TrackDef | null => {
    const idx = trackIndexAt(clientY);
    for (let d = 0; d < tracks.length; d++) {
      for (const i of [idx - d, idx + d]) {
        const t = tracks[i];
        if (t && isDropTrack(t)) return t;
      }
    }
    return null;
  };

  /** ゴーストの左右端をクリップ境界・再生ヘッド・0/末尾に吸着する。
   * snapOn が false のときは素通し(細かい位置を狙うとき用のトグル) */
  const SNAP_PX = 8;
  const snapDropT = (t: number): { t: number; snapLine: number | null } => {
    if (!snapOn) return { t, snapLine: null };
    const cands = [0, playhead, duration];
    for (const c of clips) cands.push(c.outStart, c.outEnd);
    let best: { t: number; line: number; px: number } | null = null;
    for (const c of cands) {
      // [左端を c に合わせる, 右端を c に合わせる] の2通りを試す
      for (const start of [c, c - dragDurSec]) {
        if (start < 0) continue;
        const px = Math.abs(start - t) * pps;
        if (px < SNAP_PX && (!best || px < best.px)) best = { t: start, line: c, px };
      }
    }
    return best ? { t: best.t, snapLine: best.line } : { t, snapLine: null };
  };

  /** ドラッグ中に端へ近づいたら自動スクロール(dragover はホバー中も届く) */
  const dragAutoScroll = (x: number, y: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const EDGE = 36;
    const STEP = 14;
    if (x < r.left + EDGE) el.scrollLeft -= STEP;
    else if (x > r.right - EDGE) el.scrollLeft += STEP;
    if (y < r.top + RULER_H + EDGE) el.scrollTop -= STEP;
    else if (y > r.bottom - EDGE) el.scrollTop += STEP;
  };

  const onDragOverTimeline = (e: ReactDragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes("Files") && !types.includes(MATERIAL_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragAutoScroll(e.clientX, e.clientY);
    const track = dropTrackAt(e.clientY);
    if (!track) {
      setDrop(null);
      return;
    }
    const { t, snapLine } = snapDropT(posToT(e.clientX));
    setDrop((cur) =>
      cur && cur.track === track.id && cur.t === t && cur.snapLine === snapLine
        ? cur
        : { track: track.id, t, snapLine },
    );
  };
  const onDragLeaveTimeline = (e: ReactDragEvent) => {
    // 子要素間の移動では消さない(relatedTarget = null はウィンドウ外)
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
  };
  const onDropTimeline = (e: ReactDragEvent) => {
    e.preventDefault();
    // ゴーストの位置に落とす(dragover を経ていない場合はその場で計算)
    const track = drop?.track ?? dropTrackAt(e.clientY)?.id;
    const t = drop?.t ?? posToT(e.clientX);
    setDrop(null);
    if (track === undefined) return;
    const path = e.dataTransfer.getData(MATERIAL_MIME);
    if (path) {
      onDropMaterial(track, t, path);
      return;
    }
    const f = e.dataTransfer.files?.[0];
    if (f) onDropFile(track, t, f);
  };

  return (
    <div className="timeline" style={{ height }}>
      <div className="tlToolbar">
        <span
          className={helpOpen ? "helpTip open" : "helpTip"}
          onClick={() => setHelpOpen((v) => !v)}
        >
          ?
          {helpOpen && (
            <span
              className="menuBackdrop"
              onClick={(e) => {
                e.stopPropagation();
                setHelpOpen(false);
              }}
            />
          )}
          <span className="helpTipPop" onClick={(e) => e.stopPropagation()}>
            {"タイムラインの操作\n" +
              "・横軸はカット後の時間\n" +
              "・上のトラックほど前面に表示\n" +
              "・⌘K: 再生ヘッド位置でクリップを分割\n" +
              "  (割ってから端をトリム / Delete でカット)\n" +
              "・映像トラックの ▼ 印 = カットされた区間\n" +
              "  (クリックで選択 → プロパティから戻せる)\n" +
              "・ラベルの上下ドラッグで並べ替え\n" +
              "・ラベル下端のドラッグで高さを変更\n" +
              "・目のアイコンでトラックを一時非表示\n" +
              "  (プレビュー専用。書き出しには影響せず、\n" +
              "  リロードで全トラック表示に戻る)\n" +
              "・⌘+スクロール(ピンチ)でズーム"}
          </span>
        </span>
        <span className="addTrack">
          <button
            className="icon"
            title="トラックを追加(種類を選択)"
            onClick={() => setAddMenuOpen((v) => !v)}
          >
            ＋
          </button>
          {addMenuOpen && (
            <>
              <div className="menuBackdrop" onClick={() => setAddMenuOpen(false)} />
              <div className="menu">
                {(
                  [
                    ["caption", "テロップトラック"],
                    ["overlay", "素材トラック"],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddTrack(kind);
                    }}
                  >
                    ＋ {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
        <span className="histGroup">
          <button
            aria-label="元に戻す"
            title="元に戻す (⌘Z)"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <UndoIcon dir="undo" size={14} />
          </button>
          <button
            aria-label="やり直す"
            title="やり直す (⇧⌘Z)"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <UndoIcon dir="redo" size={14} />
          </button>
        </span>
        <span className="spacer" />
        <button
          className={snapOn ? "active" : ""}
          title="素材ドロップ時の吸着(クリップ境界・再生ヘッド・0/末尾)。細かい位置を狙うときは OFF に"
          onClick={() => setSnapOn((v) => !v)}
        >
          吸着
        </button>
        <span className="tlZoom">
          <button title="縮小(⌘+スクロールでも可)" disabled={zoom <= 1} onClick={() => applyZoom(1 / 1.5)}>
            −
          </button>
          <button
            title={`全体を表示(現在 ${Math.round(zoom * 100)}%)`}
            disabled={zoom <= 1}
            onClick={() => applyZoom(0)}
          >
            全体
          </button>
          <button title="拡大(⌘+スクロールでも可)" disabled={zoom >= 64} onClick={() => applyZoom(1.5)}>
            ＋
          </button>
        </span>
      </div>
      <div className="tlBody">
        <div className="tlLabels">
          <div className="tlRulerSpacer" />
          <div
            className="tlLabelScroll"
            ref={labelsRef}
            // ラベル列上のホイールでもトラック側を縦スクロール(scroll イベント経由で同期が戻る)
            onWheel={(e) => {
              if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY;
            }}
          >
            {tracks.map((t, i) => {
              const audio = t.audio;
              const layerHidden = t.layer !== undefined && hiddenLayers.includes(t.layer);
              return (
                <div
                  className={`tlLabel${t.reorderable ? " reorderable" : ""}${dragLabel === t.id ? " dragging" : ""}${drop?.track === t.id ? " dropActive" : ""}`}
                  key={t.id}
                  style={{ height: rowH(t.id) }}
                  title={t.hint}
                  onPointerDown={(e) => onLabelDown(e, i)}
                  onDoubleClick={() =>
                    t.renamableCaption !== undefined &&
                    setRenaming({ id: t.id, value: t.label })
                  }
                >
                  {renaming?.id === t.id && t.renamableCaption !== undefined ? (
                    <input
                      className="tlRename"
                      autoFocus
                      value={renaming.value}
                      placeholder="トラック名(空で自動)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                      onBlur={() => {
                        onRenameTrack(t.renamableCaption as number, renaming.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    t.label
                  )}
                  {t.layer !== undefined && (
                    <button
                      className={`trackEye${layerHidden ? " off" : ""}`}
                      title={
                        layerHidden
                          ? "非表示中(クリックで再表示。プレビューのみ)"
                          : "このトラックを一時非表示(プレビューのみ。書き出しには影響しない)"
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleTrackHide(t.layer as LayerId)}
                    >
                      <EyeIcon open={!layerHidden} size={13} />
                    </button>
                  )}
                  {audio && (
                    <button
                      className={`trackMute${trackMuted[audio] ? " muted" : ""}`}
                      title={
                        trackMuted[audio]
                          ? "ミュート中(クリックで解除。プレビューのみ)"
                          : "このトラックをミュート(プレビューのみ。書き出しには影響しない)"
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleTrackMute(audio)}
                    >
                      <VolumeIcon level={trackMuted[audio] ? "mute" : "high"} size={13} />
                    </button>
                  )}
                  {isRemovable(t) && (
                    <button
                      className="trackDel"
                      title="このトラックを削除(空のときだけ表示)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onRemoveTrack(t.id)}
                    >
                      ×
                    </button>
                  )}
                  {t.reorderable && <span className="grip">⠿</span>}
                  <div
                    className="tlResize"
                    title="ドラッグでトラックの高さを変更(ダブルクリックで既定に戻す)"
                    onPointerDown={(e) => onResizeDown(e, t.id)}
                    onDoubleClick={() =>
                      setTrackHeights((m) => {
                        const { [t.id]: _drop, ...rest } = m;
                        return rest;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="tlScroll"
          ref={scrollRef}
          onScroll={(e) => {
            if (labelsRef.current) labelsRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onDragOver={onDragOverTimeline}
          onDragLeave={onDragLeaveTimeline}
          onDrop={onDropTimeline}
        >
          <div className="tlContent" style={{ width: totalW }}>
            <div className="tlRuler" onPointerDown={onRulerDown}>
              {ticks.map((t) => (
                <div className="tlTick" key={t} style={{ left: t * pps }}>
                  {fmtTime(t)}
                </div>
              ))}
              <div className="tlPlayheadCap" style={{ left: playhead * pps }} />
            </div>
            {tracks.map((track) => (
              <div
                className={`tlTrack${
                  track.layer !== undefined && hiddenLayers.includes(track.layer)
                    ? " layerHidden"
                    : ""
                }${
                  drop === null
                    ? ""
                    : drop.track === track.id
                      ? " dropActive"
                      : isDropTrack(track)
                        ? " dropOk"
                        : ""
                }`}
                key={track.id}
                style={{ height: rowH(track.id) }}
                onPointerDown={(e) => onTrackDown(e, track)}
                title={track.hint}
              >
                {clips
                  .filter((c) => c.track === track.id)
                  .map((clip, i) => (
                    <div
                      key={`${clip.kind}-${clip.index}-${i}`}
                      className={`tlClip ${clip.kind}${isSel(clip) ? " sel" : ""}${clip.static ? " static" : ""}`}
                      style={{
                        left: clip.outStart * pps,
                        width: Math.max(6, (clip.outEnd - clip.outStart) * pps),
                        // 素材クリップはトラック番号で色分け(CSS は種別のみ)
                        ...(clip.kind === "overlays"
                          ? { background: ovColor(clip.track) }
                          : {}),
                      }}
                      title={clip.label}
                      onPointerDown={(e) => onClipDown(e, clip, "move")}
                    >
                      {clip.wave && peaks[clip.wave.src] && (
                        <Waveform
                          peaks={peaks[clip.wave.src] as Peaks}
                          srcStart={clip.wave.startSec}
                          durSec={clip.outEnd - clip.outStart}
                          pxWidth={Math.max(6, (clip.outEnd - clip.outStart) * pps)}
                          pxHeight={rowH(track.id) - 6}
                          loop={clip.wave.loop}
                        />
                      )}
                      {clip.editable && !clip.noTrimStart && (
                        <div
                          className="tlEdge l"
                          onPointerDown={(e) => onClipDown(e, clip, "trim-start")}
                        />
                      )}
                      <span className="tlClipLabel">{clip.label}</span>
                      {clip.editable && !clip.noTrimEnd && (
                        <div
                          className="tlEdge r"
                          onPointerDown={(e) => onClipDown(e, clip, "trim-end")}
                        />
                      )}
                    </div>
                  ))}
                {/* 継ぎ目の「カットされた区間」の印。クリップと違い幅を持たない
                    (横軸はカット後の秒で、切られた時間はこの軸上に存在しない) */}
                {track.id === "cut" &&
                  cutMarks.map((m) => (
                    <div
                      key={`cutmark-${m.index}`}
                      className={`tlCutMark${
                        selection?.kind === "cut" && selection.index === m.index
                          ? " sel"
                          : ""
                      }`}
                      style={{ left: m.out * pps + m.stack * 10 }}
                      title={
                        `カットされた区間 ${m.durSec.toFixed(1)}秒` +
                        `${m.reason ? `: ${m.reason}` : ""}` +
                        "(クリックで選択 → プロパティから戻せる)"
                      }
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0) return;
                        onSelect({ kind: "cut", index: m.index });
                      }}
                    />
                  ))}
                {ghost && ghost.track === track.id && (
                  <div
                    className="tlGhost"
                    style={{
                      left: Math.min(ghost.a, ghost.b) * pps,
                      width: Math.abs(ghost.b - ghost.a) * pps,
                    }}
                  />
                )}
                {drop && drop.track === track.id && (
                  <div
                    className={`tlDropGhost${track.id === "cut" ? " insert" : ""}`}
                    style={{
                      left: drop.t * pps,
                      width: Math.max(6, dragDurSec * pps),
                      ...(ovNum(track.id) !== null
                        ? { background: ovColor(track.id) }
                        : {}),
                    }}
                  >
                    <span className="tlClipLabel">
                      {track.id === "cut" ? `インサート: ${dragName}` : dragName}
                    </span>
                  </div>
                )}
              </div>
            ))}
            {drop && drop.snapLine !== null && (
              <div className="tlSnapLine" style={{ left: drop.snapLine * pps }} />
            )}
            <div className="tlPlayhead" style={{ left: playhead * pps }} />
          </div>
        </div>
      </div>
    </div>
  );
};
