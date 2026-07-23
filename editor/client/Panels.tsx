import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SyntheticEvent as ReactSyntheticEvent,
} from "react";
import { captionTrack } from "../../src/types.ts";
import type { Interval, Overlays, Shorts, Transcript } from "../../src/types.ts";
import { toSourceTime } from "../../src/lib/timeline.ts";
import type { TimelineEntry } from "../../src/lib/timeline.ts";
import type { HyperframeCard, ScriptData } from "./apiTypes.ts";
import { usePlayheadSelector } from "./playhead.ts";
import { MATERIAL_MIME, buildScriptBlocks, scriptKeptFlags } from "./model.ts";
import type { ScriptBlock } from "./model.ts";
import { VIDEO_EXT_RE, fmtTime } from "./widgets.tsx";
import { Button } from "./components/ui/button.tsx";
import { Slider } from "./components/ui/slider.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import {
  ArrowDownUp,
  ArrowLeftRight,
  Captions,
  EyeOff,
  FileText,
  LayoutGrid,
  List,
  MessageSquareText,
  Plus,
  Scissors,
  UploadCloud,
  ZoomIn,
} from "lucide-react";

/** OpenCut の PanelView ヘッダー相当(高さ44px・薄タイトル・下境界・右アクション)。
 * 各左タブの先頭に置く。スクロールで消えないよう sticky。 */
export const PanelHeader = ({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) => (
  <div className="ocPanelHead">
    <span className="ocPanelHeadTitle">{title}</span>
    {actions ? <div className="ocPanelHeadActions">{actions}</div> : null}
  </div>
);

/** ファイル名を中央省略する("B025_C012_0521MEbs" → "B025_C…21MEbs") */
const midTrunc = (s: string, max = 18) =>
  s.length <= max
    ? s
    : `${s.slice(0, Math.ceil((max - 1) / 2))}…${s.slice(-Math.floor((max - 1) / 2))}`;

/** 動画素材は先頭が黒いことが多いので、一覧では中間フレームを静止画にする。 */
const seekVideoToMidpoint = (video: HTMLVideoElement) => {
  if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration / 2;
};

const onVideoMetadata = (event: ReactSyntheticEvent<HTMLVideoElement>) => {
  seekVideoToMidpoint(event.currentTarget);
};

const playTileVideo = (event: ReactMouseEvent<HTMLElement>) => {
  const video = event.currentTarget.querySelector("video");
  if (video) void video.play().catch(() => {});
};

const pauseTileVideo = (event: ReactMouseEvent<HTMLElement>) => {
  const video = event.currentTarget.querySelector("video");
  if (!video) return;
  video.pause();
  seekVideoToMidpoint(video);
};

/** OpenCut の DraggableItem 相当(`apps/web/src/components/editor/panels/assets/draggable-item.tsx`)。
 * 左タブのアセット1件を「サムネ + 名前 + ホバーの `+` + ドラッグ」という
 * 同じ語彙で描く共有シェル。素材カード3種(生成待ち / HyperFrames / 通常素材)
 * から抽出したもので、DOM とクラス名は抽出前と同一(styles.css と
 * test/editorPanelDesign.test.ts の `.ocMaterialsPanel .matCard` がそのまま効く)。
 *
 * OpenCut からの改変: ドラッグ像は React ポータルのゴーストではなく CutFlow 既存の
 * `dragChip`(呼び出し側の onDragStart が setDragImage する)のままにする=タイムラインの
 * ドロップゴーストと二重に出さないため。配置先の時刻は App 側の再生ヘッドが持つので
 * `onAdd` は引数を取らない(OpenCut は `onAddToTimeline({currentTime})`)。 */
export const DraggableItem = ({
  className,
  title,
  name,
  nameTitle,
  preview,
  overlay,
  footer,
  draggable,
  onAdd,
  addTitle = "再生ヘッド位置へ配置",
  addLabel,
  onDragStart,
  onDragEnd,
  onDoubleClick,
  onContextMenu,
  ariaLive,
}: {
  /** カードのクラス(`matCard` を含める。バリアントは呼び出し側が足す) */
  className: string;
  /** カード全体の title(改行区切りの操作説明) */
  title?: string;
  /** サムネ下の表示名。省略時は名前行を出さない */
  name?: ReactNode;
  /** 名前行の title(省略なしの原文) */
  nameTitle?: string;
  /** サムネ本体(video / img / プレースホルダ) */
  preview: ReactNode;
  /** サムネに重ねるバッジ類(AI チップ・要更新・スピナー等)。`+` の手前に入る */
  overlay?: ReactNode;
  /** 名前行の後ろに続ける要素(インラインエラー等) */
  footer?: ReactNode;
  draggable?: boolean;
  /** 省略すると `+` ボタン自体を出さない(配置できないカード) */
  onAdd?: () => void;
  addTitle?: string;
  addLabel?: string;
  onDragStart?: (e: ReactDragEvent) => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  /** 生成待ちカードのように、状態変化を読み上げたいときだけ指定する */
  ariaLive?: "polite" | "assertive";
}) => (
  <div
    className={className}
    title={title}
    aria-live={ariaLive}
    draggable={draggable}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onDoubleClick={onDoubleClick}
    onContextMenu={onContextMenu}
    onMouseEnter={playTileVideo}
    onMouseLeave={pauseTileVideo}
  >
    <div className="materialThumbWrap">
      {preview}
      {overlay}
      {onAdd && (
        <button
          type="button"
          className="matAddBtn"
          title={addTitle}
          aria-label={addLabel}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          <Plus size={13} aria-hidden />
        </button>
      )}
    </div>
    {name !== undefined && (
      <div className="matName" title={nameTitle}>
        {name}
      </div>
    )}
    {footer}
  </div>
);

/**
 * 左パネル「素材」タブ。アップロード済みの画像・動画(materials/)を
 * サムネイル+ファイル名だけのシンプルなグリッドで一覧する。
 * タイムラインへ直接ドラッグ(素材トラック=配置、映像トラック=インサート)、
 * ダブルクリックで再生ヘッド位置へ配置、右クリックでメニュー(配置・削除)。
 */
export const MaterialsPanel = ({
  materials,
  mediaCodecFacts,
  hyperframes,
  hyperframesLoading,
  hyperframesError,
  hyperframeRendering,
  hyperframeErrors,
  hyperframeAuthorDisabledReason,
  busy,
  onUploadClick,
  onUploadFiles,
  onPlace,
  onDelete,
  onDeleteCard,
  onRenderHyperframe,
  onNewHyperframe,
  authorPendingName,
  onDragBegin,
  onDragEnd,
}: {
  /** プロジェクト相対パス("materials/...")の一覧 */
  materials: string[];
  /** codec 由来のブラウザ表示不可の疎な map(キー = materials の相対パス)。
   * 無い/未判定のキー = 表示可能扱い。既定 {} なら全ブランチ現状どおり */
  mediaCodecFacts: Record<string, { codec: string; reason: string }>;
  hyperframes: HyperframeCard[];
  hyperframesLoading: boolean;
  hyperframesError: string | null;
  hyperframeRendering: string | null;
  hyperframeErrors: Record<string, string>;
  hyperframeAuthorDisabledReason?: string;
  busy: boolean;
  /** 「素材を読み込む…」(App のファイル選択を開く) */
  onUploadClick: () => void;
  /** OS ファイルをパネルへドロップ = プールへアップロード(配置しない・複数可) */
  onUploadFiles: (files: File[]) => void;
  /** 再生ヘッド位置・一番手前の素材トラックへ配置 */
  onPlace: (file: string) => void;
  /** ファイルの削除(使用中チェック・確認ダイアログは App 側) */
  onDelete: (file: string) => void;
  /** AI 生成素材のカード単位の削除(使用中チェック・確認ダイアログは App 側) */
  onDeleteCard: (name: string) => void;
  /** AI 生成素材を既存の生成経路で作り直す */
  onRenderHyperframe: (name: string) => void;
  onNewHyperframe: () => void;
  /** AI が作成中のカード名(モーダル送信後の pending 表示)。null = 作成中なし */
  authorPendingName: string | null;
  /** カードのドラッグ開始/終了(タイムラインがドロップゴーストを出す) */
  onDragBegin: (file: string) => void;
  onDragEnd: () => void;
}) => {
  /** 右クリックメニュー(対象素材と表示位置)。null = 非表示 */
  const [menu, setMenu] = useState<{
    file?: string;
    generatedName?: string;
    canRebuild?: boolean;
    x: number;
    y: number;
  } | null>(null);
  /** OS ファイルのドラッグがパネル上にあるか(ドロップ受け口の枠を光らせる) */
  const [dragOver, setDragOver] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "type" | "duration" | "size">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [fileSizes, setFileSizes] = useState<Record<string, number>>({});
  const [fileDurations, setFileDurations] = useState<Record<string, number>>({});
  const dragDepth = useRef(0); // dragenter/leave が子要素で何度も届くのを相殺

  const onZoneDragOver = (e: ReactDragEvent) => {
    // OS ファイルのドラッグだけ受ける(カード内ドラッグは MATERIAL_MIME なので無視)
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onZoneDragEnter = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  };
  const onZoneDragLeave = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onZoneDrop = (e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onUploadFiles(files);
  };
  const openMenu = (
    e: ReactMouseEvent,
    target: { file?: string; generatedName?: string; canRebuild?: boolean },
  ) => {
    e.preventDefault();
    // 画面端ではみ出さないように少し内側へ寄せる
    setMenu({
      ...target,
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 140),
    });
  };
  const onDragStart = (e: ReactDragEvent, file: string) => {
    e.dataTransfer.setData(MATERIAL_MIME, file);
    e.dataTransfer.effectAllowed = "copy";
    // 既定のドラッグ像(カード全体の半透明像)はタイムライン側のゴーストに
    // 重なって邪魔なので、小さなクリップ形のチップに差し替える
    const chip = document.createElement("div");
    chip.className = "dragChip";
    chip.textContent = file.replace(/^materials\//, "");
    document.body.appendChild(chip);
    e.dataTransfer.setDragImage(chip, 12, 12);
    requestAnimationFrame(() => chip.remove());
    onDragBegin(file);
  };
  const materialCount = materials.length + hyperframes.length + (authorPendingName ? 1 : 0);
  const materialFiles = useMemo(
    () => [
      ...materials,
      ...hyperframes.flatMap((card) => (card.mp4Path ? [card.mp4Path] : [])),
    ],
    [hyperframes, materials],
  );
  useEffect(() => {
    let cancelled = false;
    const missingSizes = materialFiles.filter((file) => fileSizes[file] === undefined);
    if (missingSizes.length > 0) {
      void Promise.all(
        missingSizes.map(async (file) => {
          const res = await fetch(`media/${file}`, { method: "HEAD" }).catch(() => null);
          const size = Number(res?.headers.get("content-length") ?? NaN);
          return Number.isFinite(size) ? [file, size] as const : null;
        }),
      ).then((entries) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const entry of entries) if (entry) next[entry[0]] = entry[1];
        if (Object.keys(next).length > 0) setFileSizes((prev) => ({ ...prev, ...next }));
      });
    }
    const missingDurations = materialFiles.filter((file) => fileDurations[file] === undefined);
    if (missingDurations.length > 0) {
      void Promise.all(
        missingDurations.map(
          (file) =>
            new Promise<readonly [string, number] | null>((resolve) => {
              const media = document.createElement(/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(file) ? "audio" : "video");
              media.preload = "metadata";
              media.onloadedmetadata = () =>
                resolve(Number.isFinite(media.duration) ? [file, media.duration] as const : null);
              media.onerror = () => resolve(null);
              media.src = `media/${file}`;
            }),
        ),
      ).then((entries) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const entry of entries) if (entry) next[entry[0]] = entry[1];
        if (Object.keys(next).length > 0) setFileDurations((prev) => ({ ...prev, ...next }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [fileDurations, fileSizes, materialFiles]);
  const compareName = (a: string, b: string) =>
    a.replace(/^materials\//, "").localeCompare(b.replace(/^materials\//, ""));
  const fileTypeRank = (file: string) => {
    if (/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(file)) return 2;
    if (VIDEO_EXT_RE.test(file)) return 1;
    return 0;
  };
  const sortedHyperframes = useMemo(
    () =>
      [...hyperframes].sort((a, b) => {
        const direction = sortAsc ? 1 : -1;
        const fileA = a.mp4Path ?? "";
        const fileB = b.mp4Path ?? "";
        const primary =
          sortKey === "duration"
            ? (fileDurations[fileA] ?? 0) - (fileDurations[fileB] ?? 0)
            : sortKey === "size"
              ? (fileSizes[fileA] ?? 0) - (fileSizes[fileB] ?? 0)
              : sortKey === "type"
                ? fileTypeRank(fileA) - fileTypeRank(fileB)
                : a.name.localeCompare(b.name);
        return (primary || a.name.localeCompare(b.name)) * direction;
      }),
    [fileDurations, fileSizes, hyperframes, sortAsc, sortKey],
  );
  const sortedMaterials = useMemo(
    () => {
      const direction = sortAsc ? 1 : -1;
      return [...materials].sort((a, b) => {
        const primary =
          sortKey === "type"
            ? fileTypeRank(a) - fileTypeRank(b)
            : sortKey === "duration"
              ? (fileDurations[a] ?? 0) - (fileDurations[b] ?? 0)
              : sortKey === "size"
                ? (fileSizes[a] ?? 0) - (fileSizes[b] ?? 0)
            : compareName(a, b);
        return (primary || compareName(a, b)) * direction;
      });
    },
    [fileDurations, fileSizes, materials, sortAsc, sortKey],
  );
  const sortLabel =
    sortKey === "type"
      ? "Type"
      : sortKey === "duration"
        ? "Duration"
        : sortKey === "size"
          ? "File size"
          : "Name";
  return (
    <div
      className={`matPanel ocMaterialsPanel${dragOver ? " dragOver" : ""}`}
      onDragEnter={onZoneDragEnter}
      onDragOver={onZoneDragOver}
      onDragLeave={onZoneDragLeave}
      onDrop={onZoneDrop}
    >
      {dragOver && (
        <div className="matDropOverlay" aria-hidden>
          ここにドロップして素材を追加
        </div>
      )}
      <PanelHeader
        title="素材"
        actions={
          <>
            {hyperframesLoading && <span className="materialLoading">更新中…</span>}
            <button
              type="button"
              className="ocMaterialHeaderIcon"
              aria-label={viewMode === "grid" ? "リスト表示に切り替え" : "グリッド表示に切り替え"}
              title={viewMode === "grid" ? "リスト表示" : "グリッド表示"}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode((mode) => (mode === "grid" ? "list" : "grid"))}
            >
              {viewMode === "grid" ? (
                <LayoutGrid size={14} strokeWidth={1.75} aria-hidden />
              ) : (
                <List size={14} strokeWidth={1.75} aria-hidden />
              )}
            </button>
            <div className="ocMaterialSortWrap">
              <button
                type="button"
                className="ocMaterialHeaderIcon"
                aria-label="並び替え"
                title="並び替え"
                aria-expanded={sortMenuOpen}
                onClick={() => setSortMenuOpen((v) => !v)}
              >
                <ArrowDownUp size={14} strokeWidth={1.75} aria-hidden />
              </button>
              {sortMenuOpen && (
                <div className="ocMaterialSortMenu" role="menu">
                  {([
                    ["name", `Name ${sortKey === "name" && sortAsc ? "↑" : ""}`],
                    ["type", "Type"],
                    ["duration", "Duration"],
                    ["size", "File size"],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (sortKey === key) setSortAsc((v) => !v);
                        else {
                          setSortKey(key);
                          setSortAsc(true);
                        }
                        setSortMenuOpen(false);
                      }}
                    >
                      {sortKey === key && key !== "name" ? `${label}${sortAsc ? " ↑" : " ↓"}` : label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ocMaterialImport"
              disabled={busy}
              onClick={onUploadClick}
            >
              <UploadCloud size={13} strokeWidth={1.75} aria-hidden />
              Import
            </Button>
          </>
        }
      />
      {hyperframeAuthorDisabledReason && (
        <p className="dim hint materialAuthorGate">{hyperframeAuthorDisabledReason}</p>
      )}
      {hyperframesError && <p className="materialError materialListError">{hyperframesError}</p>}
      {materialCount === 0 ? (
        <button
          type="button"
          className="ocMaterialEmptyDrop"
          disabled={busy}
          onClick={onUploadClick}
        >
          <UploadCloud size={34} strokeWidth={1.75} aria-hidden />
          <span>Drag and drop videos, photos, and audio files here</span>
        </button>
      ) : (
        <div className={`matGrid ${viewMode}`} aria-label={`${sortLabel}${sortAsc ? " ascending" : " descending"}`}>
          {authorPendingName && (
            <DraggableItem
              className="matCard aiMaterialCard"
              ariaLive="polite"
              title={`AI が素材「${authorPendingName}」を作成中…(通常1〜2分)`}
              preview={
                <div className="matThumb aiMaterialPending" aria-hidden>
                  <img src="/particle_loop_icon.svg" alt="" />
                </div>
              }
              name={midTrunc(authorPendingName)}
              nameTitle={authorPendingName}
            />
          )}
          {sortedHyperframes.map((card) => {
            const file = card.mp4Path;
            const badCodec = file ? mediaCodecFacts[file] : undefined;
            const isRendering = hyperframeRendering === card.name;
            const needsUpdate = card.htmlExists && (!card.rendered || card.stale);
            const inlineError = hyperframeErrors[card.name] ?? card.error;
            return (
              <DraggableItem
                className={`matCard aiMaterialCard${file ? " rendered" : ""}`}
                key={`generated:${card.name}`}
                draggable={!!file && !busy}
                title={
                  `AI で生成した素材: ${card.name}\n` +
                  (file
                    ? "ダブルクリックまたはドラッグでタイムラインへ配置\n"
                    : "右クリックして作り直してください\n") +
                  "右クリック: メニュー"
                }
                onDragStart={file ? (event) => onDragStart(event, file) : undefined}
                onDragEnd={file ? onDragEnd : undefined}
                onDoubleClick={() => file && !busy && onPlace(file)}
                onContextMenu={(event) => openMenu(event, {
                  ...(file ? { file } : {}),
                  generatedName: card.name,
                  canRebuild: card.htmlExists,
                })}
                preview={
                  file ? (
                    badCodec ? (
                      <div
                        className="matThumb matThumbUnplayable"
                        aria-label={badCodec.reason}
                        title={badCodec.reason}
                      >
                        <span>プレビュー不可</span>
                        <span className="dim">{badCodec.codec.toUpperCase()}</span>
                      </div>
                    ) : (
                      <video
                        className="matThumb"
                        src={`media/${file}`}
                        preload="metadata"
                        muted
                        playsInline
                        onLoadedMetadata={onVideoMetadata}
                      />
                    )
                  ) : (
                    <div className="matThumb aiMaterialPlaceholder" aria-hidden>✨</div>
                  )
                }
                overlay={
                  <>
                    <span className="aiMaterialChip" title="AI で生成した素材">AI</span>
                    {needsUpdate && (
                      <button
                        className="aiMaterialUpdateBadge"
                        disabled={!card.htmlExists || busy || hyperframeRendering !== null}
                        title="押すと素材を作り直します"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRenderHyperframe(card.name);
                        }}
                      >
                        要更新
                      </button>
                    )}
                    {isRendering && (
                      <span className="aiMaterialBusy" role="status" aria-label="作り直し中">
                        <span className="aiMaterialSpinner" aria-hidden />
                      </span>
                    )}
                  </>
                }
                onAdd={file ? () => {
                  if (!busy) onPlace(file);
                } : undefined}
                addLabel={`${card.name} を配置`}
                name={midTrunc(card.name)}
                nameTitle={card.name}
                footer={inlineError ? <p className="materialError">{inlineError}</p> : undefined}
              />
            );
          })}
          {sortedMaterials.map((m) => {
            const name = m.replace(/^materials\//, "");
            const isVideo = VIDEO_EXT_RE.test(m);
            const isAudio = /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(m);
            const badCodec = mediaCodecFacts[m]; // undefined = 表示可能 or 未判定
            return (
              <DraggableItem
                className="matCard"
                key={m}
                draggable
                title={
                  `${name}\n` +
                  "ダブルクリック: 再生ヘッド位置へ配置\n" +
                  "ドラッグ: 素材トラック=配置 / 映像トラック=インサート / BGMトラック=BGM区間\n" +
                  "右クリック: メニュー(配置・削除)"
                }
                onDragStart={(e) => onDragStart(e, m)}
                onDragEnd={onDragEnd}
                onDoubleClick={() => !busy && onPlace(m)}
                onContextMenu={(e) => openMenu(e, { file: m })}
                preview={
                  isVideo ? (
                    badCodec ? (
                      // codec が非対応=<video> は空のまま映る(ブラウザに
                      // デコーダが無い)ので、空サムネの代わりに明示プレースホルダ。
                      // ドラッグ・配置は従来どおり可能(最終レンダーには
                      // 問題なく使える素材=disabled にはしない)
                      <div
                        className="matThumb matThumbUnplayable"
                        aria-label={badCodec.reason}
                        title={badCodec.reason}
                      >
                        <span>プレビュー不可</span>
                        <span className="dim">{badCodec.codec.toUpperCase()}</span>
                      </div>
                    ) : (
                      <video
                        className="matThumb"
                        src={`media/${m}`}
                        preload="metadata"
                        muted
                        playsInline
                        onLoadedMetadata={onVideoMetadata}
                      />
                    )
                  ) : isAudio ? (
                    // 音声はサムネイルが無いので種別アイコンを出す(BGM トラックへ
                    // ドラッグして使う)
                    <div
                      className="matThumb"
                      aria-label="音声ファイル"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 22,
                        opacity: 0.5,
                      }}
                    >
                      ♪
                    </div>
                  ) : (
                    <img className="matThumb" src={`media/${m}`} alt={name} loading="lazy" />
                  )
                }
                onAdd={() => {
                  if (!busy) onPlace(m);
                }}
                addLabel={`${name} を配置`}
                name={midTrunc(name)}
              />
            );
          })}
        </div>
      )}
      {materialCount > 0 && (
        <p className="dim hint" style={{ padding: "0 14px" }}>
          ダブルクリックで配置、タイムラインへドラッグでも配置できます
          (素材トラック=その位置に配置、映像トラック=インサート)。
          通常素材の削除は右クリックから。
        </p>
      )}
      {menu && (
        <>
          <div
            className="ctxBackdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctxMenu" style={{ left: menu.x, top: menu.y }}>
            {menu.file && (
              <button
                disabled={busy}
                onClick={() => {
                  setMenu(null);
                  onPlace(menu.file!);
                }}
              >
                再生ヘッド位置へ配置
              </button>
            )}
            {menu.generatedName && (
              <button
                disabled={!menu.canRebuild || busy || hyperframeRendering !== null}
                onClick={() => {
                  const name = menu.generatedName!;
                  setMenu(null);
                  onRenderHyperframe(name);
                }}
              >
                作り直す
              </button>
            )}
            {menu.file && !menu.generatedName && (
              <button
                className="danger"
                onClick={() => {
                  setMenu(null);
                  onDelete(menu.file!);
                }}
              >
                削除…
              </button>
            )}
            {menu.generatedName && (
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  const name = menu.generatedName!;
                  setMenu(null);
                  onDeleteCard(name);
                }}
              >
                削除…
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

/**
 * 左パネル「テロップ」タブ。transcript.segments を一覧し、その場で文言を
 * 編集できる(タイムラインのテロップクリップと同じデータ)。行クリックで
 * 選択+その位置へシーク。位置・スタイルの詳細は右側のインスペクタで編集する。
 */
export const CaptionsPanel = ({
  transcript,
  overlays,
  selectedIndex,
  multiSelected,
  onRowClick,
  onRowToggle,
  onRowFocus,
  updateCaption,
}: {
  transcript: Transcript;
  overlays: Overlays;
  /** 選択中のテロップ(transcript.segments の添字)。テロップ以外の選択は null */
  selectedIndex: number | null;
  /** 複数選択中のテロップ(2件以上のときだけ) */
  multiSelected: number[];
  /** 行クリック: 選択してその開始位置へシーク */
  onRowClick: (i: number) => void;
  /** 行の⌘クリック: 複数選択への追加/解除(一括スタイル変更用) */
  onRowToggle: (i: number) => void;
  /** textarea フォーカス: 選択だけする(シークで再生位置を飛ばさない) */
  onRowFocus: (i: number) => void;
  updateCaption: (i: number, patch: Partial<Transcript["segments"][number]>) => void;
}) => {
  const selRef = useRef<HTMLDivElement>(null);
  // タイムライン側でクリップを選んだときは該当行まで自動スクロール
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // 「章」トラック(overlays.captionTracks の name === "章")は章タイトルの
  // カード専用で、通常のテロップとは役割が別なのでこのタブには出さない
  // (章の内容は「設定」→章、または chapters.json で編集する)
  const chapterTrack = overlays.captionTracks?.find((t) => t.name === "章")?.track;
  const rows = transcript.segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => captionTrack(s) !== chapterTrack);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Captions size={20} />}
        title="テロップはまだありません"
        description="タイムラインのテロップトラックの空きをドラッグすると追加できます。"
      />
    );
  }
  return (
    <div className="capList">
      {rows.map(({ s, i }) => {
        const sel = i === selectedIndex || multiSelected.includes(i);
        return (
          <div
            className={`capRow${sel ? " sel" : ""}`}
            key={i}
            ref={i === selectedIndex ? selRef : undefined}
            onClick={(e) =>
              e.metaKey || e.ctrlKey ? onRowToggle(i) : onRowClick(i)
            }
          >
            <div className="capRowMeta mono">
              <span>{fmtTime(s.start)}</span>
              <span className="dim">→ {fmtTime(s.end)}</span>
            </div>
            <textarea
              className="capEdit"
              rows={Math.min(4, Math.max(1, s.text.split("\n").length))}
              value={s.text}
              onClick={(e) => e.stopPropagation()}
              onFocus={() => onRowFocus(i)}
              onChange={(e) => updateCaption(i, { text: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
};

/**
 * 左パネル「ショート」タブ。shorts.json の一覧・追加・削除・リネームを行う
 * (5-5)。ranges・プリセット・承認・字幕配置はプレビュー下のショートモード
 * (App.tsx の本編/ショートセレクタ)とタイムライン・
 * インスペクタで編集する(D6: このタブは CRUD だけに絞る)。
 */
export const ShortsPanel = ({
  shorts,
  activeShortName,
  onSelect,
  onAdd,
  onRemove,
  onRename,
}: {
  shorts: Shorts | null;
  /** 現在編集中のショート名(プレビュー下のセレクタと同じ状態) */
  activeShortName: string | null;
  /** 行クリックでそのショートの編集モードへ切り替える */
  onSelect: (name: string) => void;
  /** ショートを1本追加する(既定 ranges 付き。App 側で自動生成した名前) */
  onAdd: () => void;
  onRemove: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
}) => {
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const list = shorts?.shorts ?? [];
  return (
    <div className="shortsPanel">
      <PanelHeader
        title={`${list.length} 件`}
        actions={<button className="icon" onClick={onAdd}>＋ ショートを追加</button>}
      />
      {list.length === 0 ? (
        <EmptyState
          icon={<Scissors size={20} />}
          title="最初のショートを作成"
          description="作成すると、プレビュー下のセレクタが自動でそのショートに切り替わります。"
          actions={(
            <Button variant="secondary" size="sm" onClick={onAdd}>
              <Plus size={13} aria-hidden />
              ショートを追加
            </Button>
          )}
        />
      ) : (
        <div className="capList">
          {list.map((s) => {
            const totalSec = s.ranges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0);
            return (
              <div
                className={`capRow${s.name === activeShortName ? " sel" : ""}`}
                key={s.name}
                onClick={() => onSelect(s.name)}
              >
                <div className="capRowMeta mono">
                  {renaming?.name === s.name ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ name: s.name, value: e.target.value })}
                      onBlur={() => {
                        onRename(s.name, renaming.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenaming({ name: s.name, value: s.name });
                      }}
                      title="ダブルクリックで名前を変更"
                    >
                      {s.name}
                    </span>
                  )}
                  <span className="dim">{s.profile ?? "vertical"}</span>
                  <span className="dim">{fmtTime(totalSec)}</span>
                  {!s.approved && <span className="warnText">未承認</span>}
                </div>
                <div className="btnRow" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm(`ショート「${s.name}」を削除しますか?`)) {
                        onRemove(s.name);
                      }
                    }}
                  >
                    削除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="dim hint" style={{ padding: "0 14px" }}>
        行クリックでそのショートの編集モードへ切り替わります(プレビュー下の
        セレクタと同じ)。ranges・レイアウト・承認・字幕配置はショート
        モードのタイムライン・プレビュー・インスペクタで編集します。
      </p>
    </div>
  );
};

/* ---------------- スクリプトタブ(文字ベース編集) ---------------- */

/** カット後の秒 → 「ここまでに再生した元収録の位置」。keep の上はその元秒、
 * 挿入クリップの上では直前の keep の終端(カラオケの塗りが挿入の間に
 * 巻き戻らないように)、タイムライン末尾以降は最後の keep の終端 */
const srcProgressAt = (outT: number, timeline: readonly TimelineEntry[]): number => {
  if (timeline.length === 0) return 0;
  let lo = 0;
  let hi = timeline.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (timeline[m].outputEnd > outT) hi = m;
    else lo = m + 1;
  }
  const e = timeline[lo];
  if (e === undefined) return timeline[timeline.length - 1].sourceEnd;
  if (outT >= e.outputStart) return e.sourceStart + (outT - e.outputStart) * e.speed;
  return lo > 0 ? timeline[lo - 1].sourceEnd : 0;
};

/**
 * スクリプトの1ブロック(keep 後の尺+文字数で作る話のまとまり。
 * model.ts の buildScriptBlocks)。
 * カラオケ(発話済みの語の色替え)はブロックごとに playhead を購読して自前で
 * 計算する(App / パネル全体を毎フレーム再レンダーしないための末端購読。
 * 返り値は「発話位置コード」のプリミティブ1個 = 変わったフレームだけ再描画)。
 * コード: -1 = 再生ヘッドがこのブロックより前 / それ以外 = 要素添字*2 +
 * (要素の内側なら+1)。ブロックより後ろは常に「全要素発話済み」の一定値に
 * なる(過去のブロックの塗りが保たれ、値が変わらないので再レンダーもされない)
 */
const ScriptRow = memo(function ScriptRow({
  row,
  rowIdx,
  kept,
  timeline,
  active,
  follow,
  onSeekSrc,
}: {
  row: ScriptBlock;
  rowIdx: number;
  /** 要素ごとの「いまの keep 集合に残っているか」(false = グレー取り消し線) */
  kept: boolean[];
  timeline: TimelineEntry[];
  /** 再生ヘッドがこのブロックの中にある(左枠のハイライト) */
  active: boolean;
  /** 再生中だけ true(active なブロックへの自動スクロールを再生追従に限る) */
  follow: boolean;
  onSeekSrc: (src: number) => void;
}) {
  const code = usePlayheadSelector((outT) => {
    const src = srcProgressAt(outT, timeline);
    if (src < row.start) return -1;
    if (src >= row.end) return (row.items.length - 1) * 2;
    let lo = 0;
    let hi = row.items.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (row.items[m].start > src) hi = m;
      else lo = m + 1;
    }
    const idx = lo - 1;
    if (idx < 0) return -1;
    return idx * 2 + (src < row.items[idx].end ? 1 : 0);
  });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !follow) return;
    // 文字選択の途中では勝手にスクロールしない(選択が流れて見えるため)
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [active, follow]);
  const spoken = code >> 1; // 直近に発話した要素の添字(-1 = まだ)
  const inWord = (code & 1) === 1;
  return (
    <div className={`scriptRow${active ? " active" : ""}`} ref={ref}>
      <div
        className="scriptRowMeta mono"
        title="クリックでこのブロックの先頭へシーク"
        onClick={() => onSeekSrc(row.start)}
      >
        <span>{fmtTime(row.start)}</span>
        <span className="dim">→ {fmtTime(row.end)}</span>
      </div>
      <div className="scriptText">
        {row.items.map((it, j) => {
          const seek = () => {
            // ドラッグ選択を終えた click では飛ばない(単クリックだけシーク)
            const sel = document.getSelection();
            if (sel && !sel.isCollapsed) return;
            onSeekSrc(it.start);
          };
          if (it.kind === "gap") {
            // 発話の切れ目(無音・文字起こしに残らなかったフィラー等)。
            // カラオケの塗りは載せない(チップの色が騒がしくなるだけ)
            return (
              <span
                key={j}
                data-sw={`${rowIdx}:${j}`}
                className={`scriptGap${kept[j] ? "" : " cut"}`}
                title="発話の切れ目(無音、または文字起こしに残らなかったフィラー等)"
                onClick={seek}
              >
                {(it.end - it.start).toFixed(1)}s
              </span>
            );
          }
          const sung =
            code >= 0 && (j < spoken || (j === spoken && !inWord)) ? " sung" : "";
          const now = code >= 0 && j === spoken && inWord ? " now" : "";
          return (
            <span
              key={j}
              data-sw={`${rowIdx}:${j}`}
              className={`scriptWord${sung}${now}${kept[j] ? "" : " cut"}`}
              onClick={seek}
            >
              {it.leadingSpace ? " " : null}
              {it.text}
            </span>
          );
        })}
      </div>
    </div>
  );
});

/**
 * 左パネル「スクリプト」タブ。元収録の全文文字起こし(AI が編集する前の
 * ベース。GET /api/script)を文ごとに一覧し、映像ではなく文字を選択して
 * カットする(Descript 型の文字ベース編集)。編集はすべて cutplan.json の
 * keep/cut へ落ち、カットされた語はグレーの取り消し線で残る(可逆)。
 * 再生中はカラオケのように発話済みの語へ色が乗り、語クリックでその時刻へ
 * シークする。
 */
export const ScriptPanel = ({
  script,
  error,
  keeps,
  silences,
  noBridgeSpans,
  timeline,
  playing,
  editable,
  onSeekSrc,
  onCutRange,
  onRestoreRange,
}: {
  /** GET /api/script の結果。null = 読み込み中 */
  script: ScriptData | null;
  /** 読み込み失敗(null 以外なら script より優先して表示) */
  error: string | null;
  /** いまのモードの keep 区間(時系列・重なりなし)。取り消し線の判定 */
  keeps: Interval[];
  /** cuts.auto.json の実測無音(虚構タイムスタンプ語の判定材料)。
   * null = detect 未実行(虚構判定なしで幾何判定だけになる) */
  silences: Interval[] | null;
  /** スクリプトからのカット記録(この穴は微小でも橋渡しせず即取り消し線) */
  noBridgeSpans: Interval[];
  /** いまのモードの元秒→カット後秒の写像(カラオケ・シーク用) */
  timeline: TimelineEntry[];
  playing: boolean;
  /** false(ショートモード)は表示・シークのみでカット編集を出さない */
  editable: boolean;
  onSeekSrc: (src: number) => void;
  /** 選択した語の範囲(元収録の秒)をカットへ */
  onCutRange: (start: number, end: number) => void;
  /** 選択した語の範囲(元収録の秒)を keep へ戻す */
  onRestoreRange: (start: number, end: number) => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  /** 現在の文字選択(語 span に解決できたときだけ)。a/b = 元収録の秒 */
  const [sel, setSel] = useState<{
    a: number;
    b: number;
    anyKept: boolean;
    anyCut: boolean;
  } | null>(null);

  /** whisper の細かい segment を keep 後の尺+文字数で「話のまとまり」へ
   * 束ねた表示ブロック(発話の切れ目は間チップとして混ざる。
   * model.ts の buildScriptBlocks) */
  const rows = useMemo(
    () => buildScriptBlocks(script?.segments ?? [], keeps),
    [script, keeps],
  );
  /** 要素ごとの「keep に残っているか」(取り消し線の反転)。whisper の語
   * タイムスタンプの既知の嘘(ポーズへの塗り広げ・境界の数百msズレ)を
   * 実測無音と微小穴の橋渡しで補正する決定論判定(§model.ts scriptKeptFlags)。
   * rows と同形 */
  const keptFlags = useMemo(
    () => scriptKeptFlags(rows, keeps, silences, noBridgeSpans, script?.aligned === true),
    [rows, keeps, silences, noBridgeSpans, script],
  );

  // 再生ヘッドのあるブロック(自動スクロール用。ブロック単位でしか値が
  // 変わらないのでパネルの再レンダーはブロックの切り替わり時だけ)
  const activeRow = usePlayheadSelector((outT) => {
    const src = toSourceTime(outT, timeline);
    if (src === null) return -1;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (rows[m].start > src) hi = m;
      else lo = m + 1;
    }
    const idx = lo - 1;
    return idx >= 0 && src < rows[idx].end ? idx : -1;
  });

  // 文字選択を監視して「どの語からどの語まで選ばれているか」へ解決する
  useEffect(() => {
    const resolve = (node: Node | null): { seg: number; word: number } | null => {
      if (!node || !rootRef.current) return null;
      const el = node instanceof Element ? node : node.parentElement;
      const span = el?.closest?.("[data-sw]") as HTMLElement | null | undefined;
      if (!span || !rootRef.current.contains(span)) return null;
      const [seg, word] = (span.dataset.sw ?? "").split(":").map(Number);
      if (!Number.isInteger(seg) || !Number.isInteger(word)) return null;
      return { seg, word };
    };
    const onSelChange = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed) {
        setSel(null);
        return;
      }
      const anchor = resolve(s.anchorNode);
      const focus = resolve(s.focusNode);
      if (!anchor || !focus) {
        setSel(null);
        return;
      }
      const [lo, hi] =
        anchor.seg < focus.seg || (anchor.seg === focus.seg && anchor.word <= focus.word)
          ? [anchor, focus]
          : [focus, anchor];
      const first = rows[lo.seg]?.items[lo.word];
      const last = rows[hi.seg]?.items[hi.word];
      if (!first || !last) {
        setSel(null);
        return;
      }
      let anyKept = false;
      let anyCut = false;
      for (let i = lo.seg; i <= hi.seg; i++) {
        const flags = keptFlags[i] ?? [];
        const from = i === lo.seg ? lo.word : 0;
        const to = i === hi.seg ? hi.word : flags.length - 1;
        for (let j = from; j <= to; j++) {
          if (flags[j]) anyKept = true;
          else anyCut = true;
        }
      }
      setSel({ a: first.start, b: last.end, anyKept, anyCut });
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [rows, keptFlags]);

  const clearSelection = () => {
    document.getSelection()?.removeAllRanges();
    setSel(null);
  };
  const doCut = () => {
    if (!sel || !sel.anyKept || !editable) return;
    onCutRange(sel.a, sel.b);
    clearSelection();
  };
  const doRestore = () => {
    if (!sel || !sel.anyCut || !editable) return;
    onRestoreRange(sel.a, sel.b);
    clearSelection();
  };

  if (error) {
    return (
      <p className="dim hint" style={{ padding: "14px" }}>
        スクリプトを読み込めませんでした: {error}
      </p>
    );
  }
  if (!script) {
    return (
      <p className="dim hint" style={{ padding: "14px" }}>
        スクリプトを読み込み中…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={20} />}
        title="スクリプトがありません"
        description="文字起こし（whisper）が未実行の収録かもしれません。"
      />
    );
  }
  return (
    <div
      className="scriptPanel"
      ref={rootRef}
      tabIndex={-1}
      onPointerUp={() => rootRef.current?.focus({ preventScroll: true })}
      onKeyDown={(e) => {
        if ((e.key === "Backspace" || e.key === "Delete") && editable && sel?.anyKept) {
          // 選択中はタイムラインのクリップ削除(グローバルの Delete)ではなく
          // スクリプトのカットとして扱う
          e.preventDefault();
          e.stopPropagation();
          doCut();
        }
      }}
    >
      <div className="scriptBar">
        {sel ? (
          <>
            <span className="mono dim">
              {fmtTime(sel.a)} → {fmtTime(sel.b)}
            </span>
            <span className="spacer" />
            <button className="danger" disabled={!editable || !sel.anyKept} onClick={doCut}>
              選択をカット
            </button>
            <button disabled={!editable || !sel.anyCut} onClick={doRestore}>
              カットを戻す
            </button>
          </>
        ) : (
          <span className="dim">
            {editable
              ? "文字をドラッグで選択 → カット(Delete でも)。クリックでシーク"
              : "ショート編集中は表示・シークのみ(カット編集は本編モードで)"}
          </span>
        )}
      </div>
      <div className="scriptList">
        {rows.map((r, i) => (
          <ScriptRow
            key={i}
            row={r}
            rowIdx={i}
            kept={keptFlags[i]}
            timeline={timeline}
            active={i === activeRow}
            follow={playing}
            onSeekSrc={onSeekSrc}
          />
        ))}
      </div>
      {script.source === "transcript" && (
        <p className="dim hint" style={{ padding: "0 14px 10px" }}>
          whisper の生出力(whisper-out.json)が無いため、現在のテロップ
          (transcript.json)からスクリプトを表示しています(テロップの
          手編集の影響を受けます)。
        </p>
      )}
    </div>
  );
};

/** 左レール「設定」タブ。OpenCut の Settings(Project info)相当。ただし本編の
 * 解像度・アスペクト比・fps は収録で決まるため読み取り専用で表示する
 * (縦・別アスペクトはショートで作る)。詳細な編集は既存の設定モーダルを開く。 */
export const SettingsPanel = ({
  projectName,
  output,
  fps,
  shortsCount,
  onOpenFullSettings,
  onGoShorts,
}: {
  /** プロジェクト名(収録フォルダ名) */
  projectName: string;
  /** 最終レンダー出力の解像度(px) */
  output: { w: number; h: number };
  /** 合成 fps(整数) */
  fps: number;
  /** 定義済みショート数(縦動画への導線用) */
  shortsCount: number;
  /** 既存の設定モーダルを開く */
  onOpenFullSettings: () => void;
  /** ショートタブへ切り替える */
  onGoShorts: () => void;
}) => {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = output.w > 0 && output.h > 0 ? gcd(output.w, output.h) : 1;
  const ratio = g > 0 ? `${Math.round(output.w / g)}:${Math.round(output.h / g)}` : "—";
  return (
    <div className="panelBody ocSettingsPanel">
      <div className="ocSettingsRow">
        <span className="ocSettingsLabel">プロジェクト名</span>
        <span className="ocSettingsValue" title={projectName}>{projectName}</span>
      </div>
      <div className="ocSettingsRow">
        <span className="ocSettingsLabel">解像度</span>
        <span className="ocSettingsValue mono">{output.w}×{output.h}</span>
      </div>
      <div className="ocSettingsRow">
        <span className="ocSettingsLabel">アスペクト比</span>
        <span className="ocSettingsValue mono">{ratio}</span>
      </div>
      <div className="ocSettingsRow">
        <span className="ocSettingsLabel">フレームレート</span>
        <span className="ocSettingsValue mono">{fps} fps</span>
      </div>
      <p className="ocPaneNote">
        解像度・アスペクト比・fps は収録(録画)で決まり、本編では変更できません。
        縦動画や別アスペクトは「ショート」で作成します({shortsCount} 件)。
      </p>
      <div className="ocPaneStack">
        <Button variant="outline" size="sm" onClick={onGoShorts}>ショートを開く</Button>
        <Button variant="outline" size="sm" onClick={onOpenFullSettings}>詳細設定を開く…</Button>
      </div>
    </div>
  );
};

/** 左パネル: 全編一律カラー調整(overlays.colorFilter)。P7.3a で追加した
 * この機能の最初の UI。かかるのはベース映像(画面+カメラ)だけで、
 * 素材・挿入には効かない */
export const AdjustmentPanel = ({
  colorFilter,
  onChange,
  onReset,
}: {
  colorFilter: { brightness?: number; contrast?: number; saturate?: number } | undefined;
  onChange: (patch: { brightness?: number; contrast?: number; saturate?: number }, coalesceKey?: string) => void;
  onReset: () => void;
}) => {
  const rows = [
    ["brightness", "明るさ"],
    ["contrast", "コントラスト"],
    ["saturate", "彩度"],
  ] as const;
  return (
    <div className="panelBody ocAdjustPanel">
      <p className="ocPaneNote">
        全編一律の色調整。かかるのはベース映像(画面+カメラ)だけで、素材・挿入には効きません。
      </p>
      {rows.map(([k, label]) => (
        <label key={k} className="ocAdjustRow">
          <span>{label}</span>
          <Slider
            min={0}
            max={2}
            step={0.01}
            value={colorFilter?.[k] ?? 1}
            onChange={(e) => onChange({ [k]: Number(e.currentTarget.value) }, "overlays:colorFilter")}
          />
          <output>{(colorFilter?.[k] ?? 1).toFixed(2)}</output>
        </label>
      ))}
      <div className="ocPaneAction">
        <Button variant="secondary" size="sm" disabled={!colorFilter} onClick={onReset}>
          リセット
        </Button>
      </div>
    </div>
  );
};

/** 左レール「エフェクト」タブ。既存の zoom/blur/annotation 追加(addByKind)を
 * 再生ヘッド位置へ薄く呼び出すだけの起動ボタン群。座標・尺の詳細調整は
 * 追加後にインスペクタで行う */
export const EffectsPanel = ({
  onAdd,
}: {
  onAdd: (kind: "zoom" | "blur" | "annotation") => void;
}) => (
  <div className="panelBody ocLauncherPanel">
    <ul className="ocLauncherList">
      <li>
        <button type="button" className="ocLauncherItem" onClick={() => onAdd("zoom")}>
          <ZoomIn size={15} strokeWidth={1.75} />
          <span>ズームを追加</span>
        </button>
      </li>
      <li>
        <button type="button" className="ocLauncherItem" onClick={() => onAdd("blur")}>
          <EyeOff size={15} strokeWidth={1.75} />
          <span>ぼかしを追加</span>
        </button>
      </li>
      <li>
        <button type="button" className="ocLauncherItem" onClick={() => onAdd("annotation")}>
          <MessageSquareText size={15} strokeWidth={1.75} />
          <span>注釈を追加</span>
        </button>
      </li>
    </ul>
    <p className="ocPaneNote">
      位置・種別・サイズは追加後にインスペクタで調整します。AI にまとめて演出させるには
      ターミナルで <code>node src/cli.ts plan-effects &lt;dir&gt;</code>。
    </p>
  </div>
);

/** 左レール「トランジション」タブ。既存の wipeFull 追加を再生ヘッド位置へ
 * 薄く呼び出すだけの起動リスト */
export const TransitionsPanel = ({
  onAddWipe,
}: {
  onAddWipe: () => void;
}) => (
  <div className="panelBody ocLauncherPanel">
    <ul className="ocLauncherList">
      <li>
        <button type="button" className="ocLauncherItem" onClick={onAddWipe}>
          <ArrowLeftRight size={15} strokeWidth={1.75} />
          <span>ワイプを再生位置に追加</span>
        </button>
      </li>
    </ul>
    <p className="ocPaneNote">
      入り/戻りの遷移秒はインスペクタで調整。フェードは各素材・挿入クリップの
      fadeIn/Out で設定します。
    </p>
  </div>
);

/** 左レール「サウンド」/「ステッカー」タブ。既存の materials(素材一覧)を
 * 音声/非音声で絞り込んだだけの薄いピッカー。配置は既存 placeMaterial を使う */
export const AssetPickerPanel = ({
  files,
  onPlace,
  emptyHint,
  note,
}: {
  files: string[];
  onPlace: (file: string) => void;
  emptyHint: string;
  note: string;
}) => (
  <div className="panelBody ocAssetPanel">
    {files.length === 0 ? (
      <p className="ocPaneNote">{emptyHint}</p>
    ) : (
      <ul className="ocAssetList">
        {files.map((f) => (
          <li key={f}>
            <button
              type="button"
              className="ocAssetItem"
              onDoubleClick={() => onPlace(f)}
              onClick={() => onPlace(f)}
              title="クリックで再生位置に配置"
            >
              <span className="ocAssetName">{f.split("/").pop()}</span>
            </button>
          </li>
        ))}
      </ul>
    )}
    <p className="ocPaneNote">{note}</p>
  </div>
);
