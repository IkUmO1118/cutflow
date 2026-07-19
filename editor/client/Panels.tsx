import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  SyntheticEvent as ReactSyntheticEvent,
} from "react";
import { captionTrack, captionTrackName } from "../../src/types.ts";
import type { Interval, Overlays, Shorts, Transcript } from "../../src/types.ts";
import { toSourceTime } from "../../src/lib/timeline.ts";
import type { TimelineEntry } from "../../src/lib/timeline.ts";
import type { HyperframeCard, ScriptData } from "./apiTypes.ts";
import { usePlayheadSelector } from "./playhead.ts";
import { MATERIAL_MIME, buildScriptBlocks, scriptKeptFlags } from "./model.ts";
import type { ScriptBlock } from "./model.ts";
import { VIDEO_EXT_RE, fmtTime } from "./widgets.tsx";

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
  return (
    <div
      className={`matPanel${dragOver ? " dragOver" : ""}`}
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
      <div className="panelHead materialPanelHead">
        <span className="dim">素材 {materialCount} 件</span>
        {hyperframesLoading && <span className="materialLoading">更新中…</span>}
        <div className="materialHeadActions">
          <button className="icon" disabled={busy} onClick={onUploadClick}>
            素材を読み込む…
          </button>
          <button
            className="icon"
            disabled={busy || !!hyperframeAuthorDisabledReason}
            title={
              authorPendingName
                ? `AI が素材「${authorPendingName}」を作成中…`
                : hyperframeAuthorDisabledReason ?? "AI で新しい素材を作る"
            }
            onClick={onNewHyperframe}
          >
            {authorPendingName && (
              <img className="aiAuthorPendingIcon" src="/particle_loop_icon.svg" alt="" />
            )}
            AI で素材を作る…
          </button>
        </div>
      </div>
      {hyperframeAuthorDisabledReason && (
        <p className="dim hint materialAuthorGate">{hyperframeAuthorDisabledReason}</p>
      )}
      {hyperframesError && <p className="materialError materialListError">{hyperframesError}</p>}
      {materialCount === 0 ? (
        <p className="dim hint" style={{ padding: "0 14px" }}>
          素材がまだありません。「素材を読み込む…」で追加するか、
          「AI で素材を作る…」から新しく作成できます。
          ファイルはここへドラッグ&ドロップしても追加できます。
        </p>
      ) : (
        <div className="matGrid">
          {authorPendingName && (
            <div
              className="matCard aiMaterialCard"
              aria-live="polite"
              title={`AI が素材「${authorPendingName}」を作成中…(通常1〜2分)`}
            >
              <div className="materialThumbWrap">
                <div className="matThumb aiMaterialPending" aria-hidden>
                  <img src="/particle_loop_icon.svg" alt="" />
                </div>
              </div>
              <div className="matName" title={authorPendingName}>
                {midTrunc(authorPendingName)}
              </div>
            </div>
          )}
          {hyperframes.map((card) => {
            const file = card.mp4Path;
            const badCodec = file ? mediaCodecFacts[file] : undefined;
            const isRendering = hyperframeRendering === card.name;
            const needsUpdate = card.htmlExists && (!card.rendered || card.stale);
            const inlineError = hyperframeErrors[card.name] ?? card.error;
            return (
              <div
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
                onMouseEnter={playTileVideo}
                onMouseLeave={pauseTileVideo}
              >
                <div className="materialThumbWrap">
                  {file ? (
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
                  )}
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
                </div>
                <div className="matName" title={card.name}>{midTrunc(card.name)}</div>
                {inlineError && <p className="materialError">{inlineError}</p>}
              </div>
            );
          })}
          {materials.map((m) => {
            const name = m.replace(/^materials\//, "");
            const isVideo = VIDEO_EXT_RE.test(m);
            const isAudio = /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(m);
            const badCodec = mediaCodecFacts[m]; // undefined = 表示可能 or 未判定
            return (
              <div
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
                onMouseEnter={playTileVideo}
                onMouseLeave={pauseTileVideo}
              >
                {isVideo ? (
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
                )}
                <div className="matName">{midTrunc(name)}</div>
              </div>
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
  capTracks,
  selectedIndex,
  multiSelected,
  onRowClick,
  onRowToggle,
  onRowFocus,
  updateCaption,
}: {
  transcript: Transcript;
  overlays: Overlays;
  /** テロップトラックの本数(2本以上のときだけトラック名を出す) */
  capTracks: number;
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

  if (transcript.segments.length === 0) {
    return (
      <p className="dim hint" style={{ padding: "14px" }}>
        テロップがまだありません。タイムラインのテロップトラックの空きを
        ドラッグすると追加できます。
      </p>
    );
  }
  return (
    <div className="capList">
      {transcript.segments.map((s, i) => {
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
              {capTracks > 1 && (
                <span className="capTrackBadge">
                  {captionTrackName(captionTrack(s), overlays, capTracks)}
                </span>
              )}
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
      <div className="panelHead">
        <span className="dim">ショート {list.length} 件</span>
        <span className="spacer" />
        <button className="icon" onClick={onAdd}>
          ＋ ショートを追加
        </button>
      </div>
      {list.length === 0 ? (
        <p className="dim hint" style={{ padding: "0 14px" }}>
          ショートがまだありません。「＋ ショートを追加」で作成すると、
          プレビュー下のセレクタが自動でそのショートに切り替わります。
        </p>
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
      <p className="dim hint" style={{ padding: "14px" }}>
        スクリプトがありません(文字起こし(whisper)が未実行の収録かもしれません)。
      </p>
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
