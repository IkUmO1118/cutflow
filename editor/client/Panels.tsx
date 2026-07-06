import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { captionTrack, captionTrackName } from "../../src/types.ts";
import type { Overlays, Shorts, Transcript } from "../../src/types.ts";
import { MATERIAL_MIME } from "./model.ts";
import { VIDEO_EXT_RE, fmtTime } from "./widgets.tsx";

/** ファイル名を中央省略する("B025_C012_0521MEbs" → "B025_C…21MEbs") */
const midTrunc = (s: string, max = 18) =>
  s.length <= max
    ? s
    : `${s.slice(0, Math.ceil((max - 1) / 2))}…${s.slice(-Math.floor((max - 1) / 2))}`;

/**
 * 左パネル「素材」タブ。アップロード済みの画像・動画(materials/)を
 * サムネイル+ファイル名だけのシンプルなグリッドで一覧する。
 * タイムラインへ直接ドラッグ(素材トラック=配置、映像トラック=インサート)、
 * ダブルクリックで再生ヘッド位置へ配置、右クリックでメニュー(配置・削除)。
 */
export const MaterialsPanel = ({
  materials,
  busy,
  onUploadClick,
  onPlace,
  onDelete,
  onDragBegin,
  onDragEnd,
}: {
  /** プロジェクト相対パス("materials/...")の一覧 */
  materials: string[];
  busy: boolean;
  /** 「素材を読み込む…」(App のファイル選択を開く) */
  onUploadClick: () => void;
  /** 再生ヘッド位置・一番手前の素材トラックへ配置 */
  onPlace: (file: string) => void;
  /** ファイルの削除(使用中チェック・確認ダイアログは App 側) */
  onDelete: (file: string) => void;
  /** カードのドラッグ開始/終了(タイムラインがドロップゴーストを出す) */
  onDragBegin: (file: string) => void;
  onDragEnd: () => void;
}) => {
  /** 右クリックメニュー(対象ファイルと表示位置)。null = 非表示 */
  const [menu, setMenu] = useState<{ file: string; x: number; y: number } | null>(null);
  const openMenu = (e: ReactMouseEvent, file: string) => {
    e.preventDefault();
    // 画面端ではみ出さないように少し内側へ寄せる
    setMenu({
      file,
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 96),
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
  return (
    <div className="matPanel">
      <div className="panelHead">
        <span className="dim">素材 {materials.length} 件</span>
        <span className="spacer" />
        <button className="icon" disabled={busy} onClick={onUploadClick}>
          素材を読み込む…
        </button>
      </div>
      {materials.length === 0 ? (
        <p className="dim hint" style={{ padding: "0 14px" }}>
          素材がまだありません。「素材を読み込む…」でアップロードするか、
          収録フォルダの materials/ に画像・動画・音声(BGM 用)を置いてください。
        </p>
      ) : (
        <div className="matGrid">
          {materials.map((m) => {
            const name = m.replace(/^materials\//, "");
            const isVideo = VIDEO_EXT_RE.test(m);
            const isAudio = /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(m);
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
                onContextMenu={(e) => openMenu(e, m)}
              >
                {isVideo ? (
                  // preload=metadata で先頭フレームがサムネイルになる
                  <video className="matThumb" src={`media/${m}`} preload="metadata" muted />
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
      {materials.length > 0 && (
        <p className="dim hint" style={{ padding: "0 14px" }}>
          ダブルクリックで配置、タイムラインへドラッグでも配置できます
          (素材トラック=その位置に配置、映像トラック=インサート)。
          削除は右クリックから。
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
            <button
              disabled={busy}
              onClick={() => {
                setMenu(null);
                onPlace(menu.file);
              }}
            >
              再生ヘッド位置へ配置
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenu(null);
                onDelete(menu.file);
              }}
            >
              削除…
            </button>
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
 * (5-5)。ranges・プリセット・承認・字幕配置はヘッダーのショートモード
 * (App.tsx の本編/ショートセレクタ + プリセット/承認バー)とタイムライン・
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
  /** 現在編集中のショート名(ヘッダーのセレクタと同じ状態) */
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
          ヘッダーのセレクタが自動でそのショートに切り替わります。
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
        行クリックでそのショートの編集モードへ切り替わります(ヘッダーの
        セレクタと同じ)。ranges・レイアウト・承認・字幕配置はショート
        モードのヘッダー・タイムライン・プレビューで編集します。
      </p>
    </div>
  );
};
