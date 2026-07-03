import { useEffect, useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { captionTrack, captionTrackName } from "../../src/types.ts";
import type { Overlays, Transcript } from "../../src/types.ts";
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
 * ダブルクリックで再生ヘッド位置へ配置。
 */
export const MaterialsPanel = ({
  materials,
  busy,
  onUploadClick,
  onPlace,
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
  /** カードのドラッグ開始/終了(タイムラインがドロップゴーストを出す) */
  onDragBegin: (file: string) => void;
  onDragEnd: () => void;
}) => {
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
          収録フォルダの materials/ に画像・動画を置いてください。
        </p>
      ) : (
        <div className="matGrid">
          {materials.map((m) => {
            const name = m.replace(/^materials\//, "");
            const isVideo = VIDEO_EXT_RE.test(m);
            return (
              <div
                className="matCard"
                key={m}
                draggable
                title={
                  `${name}\n` +
                  "ダブルクリック: 再生ヘッド位置へ配置\n" +
                  "ドラッグ: 素材トラック=配置 / 映像トラック=インサート"
                }
                onDragStart={(e) => onDragStart(e, m)}
                onDragEnd={onDragEnd}
                onDoubleClick={() => !busy && onPlace(m)}
              >
                {isVideo ? (
                  // preload=metadata で先頭フレームがサムネイルになる
                  <video className="matThumb" src={`media/${m}`} preload="metadata" muted />
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
        </p>
      )}
    </div>
  );
};

/**
 * 左パネル「テロップ」タブ。transcript.segments を一覧し、その場で文言を
 * 編集できる(タイムラインのテロップクリップと同じデータ)。行クリックで
 * 選択+その位置へシーク。位置・スタイルの詳細は「プロパティ」タブで編集する。
 */
export const CaptionsPanel = ({
  transcript,
  overlays,
  capTracks,
  selectedIndex,
  onRowClick,
  onRowFocus,
  updateCaption,
}: {
  transcript: Transcript;
  overlays: Overlays;
  /** テロップトラックの本数(2本以上のときだけトラック名を出す) */
  capTracks: number;
  /** 選択中のテロップ(transcript.segments の添字)。テロップ以外の選択は null */
  selectedIndex: number | null;
  /** 行クリック: 選択してその開始位置へシーク */
  onRowClick: (i: number) => void;
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
        const sel = i === selectedIndex;
        return (
          <div
            className={`capRow${sel ? " sel" : ""}`}
            key={i}
            ref={sel ? selRef : undefined}
            onClick={() => onRowClick(i)}
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
