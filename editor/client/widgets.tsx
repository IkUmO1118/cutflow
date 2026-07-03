import { useState } from "react";
import type {
  DraftData,
  PeaksData,
  ProjectData,
  SaveRequest,
  UploadResult,
} from "./apiTypes.ts";

export async function getProject(): Promise<ProjectData> {
  return (await request("/api/project", undefined)) as ProjectData;
}

/** タイムラインに描く音声の波形ピーク。時刻軸はマイク = 元収録の秒、
 * 素材・BGM = そのファイル自身の秒 */
export interface Peaks {
  rate: number;
  data: Uint8Array;
}

/** file 省略 = マイク音声。指定時は収録フォルダ内の素材・BGM のピーク。
 * 音声が無いファイルは data が空で返る(呼び出し側は波形を描かない) */
export async function getPeaks(file?: string): Promise<Peaks> {
  const path = file ? `/api/peaks?file=${encodeURIComponent(file)}` : "/api/peaks";
  const res = (await request(path, undefined)) as PeaksData;
  const bin = atob(res.peaks);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { rate: res.rate, data };
}

export async function postSave(body: SaveRequest): Promise<void> {
  await request("/api/save", body);
}

/** 未保存編集の自動退避(.editor-draft.json)。クラッシュへの保険で、
 * 正のデータには触らない。保存が成功したら deleteDraft で消す */
export async function postDraft(body: DraftData): Promise<void> {
  await request("/api/draft", body);
}

export async function deleteDraft(): Promise<void> {
  await request("/api/draft", undefined, "DELETE");
}

/** proxy.mp4(元収録の軽量プロキシ)の生成。収録ごとに1回でよい */
export async function postProxy(): Promise<void> {
  await request("/api/proxy", {});
}

/** カット確認用プレビュー(preview.mp4)の生成。完了までに時間がかかる。
 * 入力はディスクの JSON を読むので、呼ぶ前に保存しておくこと */
export async function postPreview(): Promise<{ path: string }> {
  return (await request("/api/preview", {})) as { path: string };
}

/** 最終レンダー(final.mp4)。approved: true が必要で、数分かかることがある。
 * 入力はディスクの JSON を読むので、呼ぶ前に保存しておくこと */
export async function postRender(): Promise<{ path: string }> {
  return (await request("/api/render", {})) as { path: string };
}

/** 素材ファイルを収録フォルダの materials/ へアップロードする */
export async function uploadMaterial(f: File): Promise<UploadResult> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
    method: "POST",
    body: f,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText;
    throw new Error(msg);
  }
  return data as UploadResult;
}

async function request(
  path: string,
  body: unknown,
  method?: "DELETE",
): Promise<unknown> {
  const res = await fetch(path, body === undefined && method === undefined
    ? undefined
    : {
        method: method ?? "POST",
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText;
    throw new Error(msg);
  }
  return data;
}

/** 動画素材の拡張子(尺の取得・サムネイル表示の分岐に使う) */
export const VIDEO_EXT_RE = /\.(mp4|mov|webm)$/i;

/** 既存素材の尺(秒)をブラウザのメタデータ読み込みで調べる。
 * 画像・取得失敗は null(呼び出し側で既定の 4 秒などにする) */
export function probeMaterialDuration(file: string): Promise<number | null> {
  if (!VIDEO_EXT_RE.test(file)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => resolve(null);
    v.src = `media/${file}`;
  });
}

/** スピーカーアイコン(線画 SVG)。mute は ×、low/high は波の数で音量を表す */
export const VolumeIcon = ({
  level,
  size = 14,
}: {
  level: "mute" | "low" | "high";
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    {level === "mute" ? (
      <>
        <line x1="16" y1="9" x2="22" y2="15" />
        <line x1="22" y1="9" x2="16" y2="15" />
      </>
    ) : (
      <>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        {level === "high" && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
      </>
    )}
  </svg>
);

/** 目アイコン(線画 SVG)。トラックの一時非表示トグル用。
 * open=false は斜線入り(非表示中)を表す */
export const EyeIcon = ({
  open,
  size = 14,
}: {
  open: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {!open && <line x1="4.5" y1="3.5" x2="19.5" y2="20.5" />}
  </svg>
);

/** トランスポートの送りアイコン(線画 SVG)。
 * シェブロン1枚 = 1フレーム、2枚 = 1秒(大きい送り)を表す */
export const StepIcon = ({
  dir,
  double = false,
  size = 16,
}: {
  dir: "back" | "fwd";
  double?: boolean;
  size?: number;
}) => {
  const flip = dir === "back" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        {double ? (
          <>
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </>
        ) : (
          <polyline points="14.5 17 9.5 12 14.5 7" />
        )}
      </g>
    </svg>
  );
};

/** 先頭/末尾へジャンプするアイコン(縦棒+シェブロンの線画 SVG) */
export const JumpIcon = ({
  dir,
  size = 16,
}: {
  dir: "back" | "fwd";
  size?: number;
}) => {
  const flip = dir === "back" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        <line x1="7" y1="7" x2="7" y2="17" />
        <polyline points="17.5 17 12.5 12 17.5 7" />
      </g>
    </svg>
  );
};

/** 元に戻す/やり直すアイコン(曲がり矢印の線画 SVG)。redo は左右反転 */
export const UndoIcon = ({
  dir,
  size = 16,
}: {
  dir: "undo" | "redo";
  size?: number;
}) => {
  const flip = dir === "undo" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        <polyline points="9 13.5 4 9 9 4.5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10" />
      </g>
    </svg>
  );
};

/** 分割(razor)アイコン(ハサミの線画 SVG)。再生ヘッド位置でのクリップ分割用 */
export const SplitIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </svg>
);

/** ループ再生アイコン(線画 SVG) */
export const LoopIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="16.5 3 20 6.5 16.5 10" />
    <path d="M4 12.5v-2a4 4 0 0 1 4-4h12" />
    <polyline points="7.5 21 4 17.5 7.5 14" />
    <path d="M20 11.5v2a4 4 0 0 1-4 4H4" />
  </svg>
);

/** 再生/一時停止アイコン(塗りつぶし SVG)。playing のとき一時停止マーク */
export const PlayPauseIcon = ({
  playing,
  size = 16,
}: {
  playing: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinejoin="round"
    aria-hidden
  >
    {playing ? (
      <>
        <rect x="6.5" y="5.5" width="3.5" height="13" rx="1" />
        <rect x="14" y="5.5" width="3.5" height="13" rx="1" />
      </>
    ) : (
      <polygon points="8.5 5.5 18.5 12 8.5 18.5" />
    )}
  </svg>
);

/** 秒を「分:秒.xx」で表示する(生の秒数は編集欄で見えるので表示用) */
export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

/**
 * 秒数の編集欄。入力中はローカルのテキストを保持し、blur / Enter で確定する
 * (小数の途中入力で親の state が壊れないようにするため)。
 * allowEmpty のときは空欄で undefined を返す(章の cardSec のような省略可の値用)
 */
export const NumInput = ({
  value,
  onCommit,
  allowEmpty = false,
  placeholder,
  title,
}: {
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  allowEmpty?: boolean;
  placeholder?: string;
  title?: string;
}) => {
  const [text, setText] = useState<string | null>(null);
  // 外から value が変わったら(選択切替・ドラッグ)未確定のテキストは破棄する。
  // 残すと blur 時に古い入力が別のクリップへ commit されてしまう
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setText(null);
  }
  const shown = text ?? (value === undefined ? "" : String(value));
  const parsed = shown.trim() === "" ? (allowEmpty ? undefined : NaN) : Number(shown);
  const invalid = typeof parsed === "number" && !Number.isFinite(parsed);

  const commit = () => {
    if (!invalid && text !== null) onCommit(parsed);
    setText(null);
  };
  return (
    <input
      className={`num${invalid ? " invalid" : ""}`}
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
};
