import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  captionAnchorOf,
  captionPosOf,
  captionTrack,
  captionTrackName,
  overlayTrack,
} from "../../src/types.ts";
import type {
  CaptionPos,
  CaptionStyle,
  CutPlan,
  Overlays,
  Transcript,
} from "../../src/types.ts";
import type { Selection } from "./model.ts";
import { NumInput, fmtTime } from "./widgets.tsx";

type OverlayEntry = NonNullable<Overlays["overlays"]>[number];
type InsertEntry = NonNullable<Overlays["inserts"]>[number];

/**
 * 右サイドのインスペクタ。タイムラインで選択したクリップの詳細を編集する。
 * 未選択時は操作ガイドだけを出す(承認チェックはヘッダーにある)。
 * 時刻の編集欄はすべて元収録の秒(JSON の規約と同じ)。
 */
export const Inspector = ({
  selection,
  cutplan,
  overlays,
  transcript,
  materials,
  ovTracks,
  capTracks,
  stdCaptionPos,
  captionFontSizePx,
  setCaptionTrackDefault,
  updateCutSeg,
  cutKeepSeg,
  restoreCutSeg,
  updateCaption,
  removeCaption,
  updateSpan,
  removeSpan,
  updateInsert,
  removeInsert,
}: {
  selection: Selection;
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  materials: string[];
  /** 素材トラックの本数(トラック選択肢 V1..VN) */
  ovTracks: number;
  /** テロップトラックの本数(トラック選択肢 T1..TN) */
  capTracks: number;
  /** 位置未指定テロップの標準位置(数値欄のプレースホルダに使う) */
  stdCaptionPos: CaptionPos;
  /** スタイル未指定テロップのフォントサイズ(config の render.captionFontSizePx) */
  captionFontSizePx: number;
  /** テロップトラックの標準位置・標準スタイルを設定(null で解除、undefined は現状維持) */
  setCaptionTrackDefault: (
    track: number,
    patch: { pos?: CaptionPos | null; style?: CaptionStyle | null },
  ) => void;
  updateCutSeg: (i: number, patch: Partial<CutPlan["segments"][number]>) => void;
  /** keep 区間をカットへ倒す(記録として残り、継ぎ目の印から戻せる) */
  cutKeepSeg: (i: number) => void;
  /** カットされた区間を keep に戻す(隣の keep と重なる分は縮めて戻る) */
  restoreCutSeg: (i: number) => void;
  updateCaption: (i: number, patch: Partial<Transcript["segments"][number]>) => void;
  removeCaption: (i: number) => void;
  updateSpan: (kind: "overlays" | "wipeFull", i: number, patch: Partial<OverlayEntry>) => void;
  removeSpan: (kind: "overlays" | "wipeFull", i: number) => void;
  updateInsert: (i: number, patch: Partial<InsertEntry>) => void;
  removeInsert: (i: number) => void;
}) => {
  if (selection === null) {
    return (
      <div className="insp">
        <p className="dim hint" style={{ marginTop: 0 }}>
          タイムラインのクリップを選ぶと、ここで詳細を編集できます。
        </p>
        <p className="dim hint">
          クリップはドラッグで移動・端をつまんでトリム。テロップは選択して
          文言を編集、素材はクリップの上下ドラッグで別トラックへ。トラックの
          ラベルを上下にドラッグすると重なり順を並べ替え。Delete で削除
          (映像クリップはカットに倒れ、▼ 印からいつでも戻せる)。
        </p>
        <p className="dim hint">
          Space 再生 / ←→ 1フレーム(Shift で 1秒) / ⌘K 再生ヘッドで分割 /
          ⌘Z 元に戻す / ⌘S 保存
        </p>
      </div>
    );
  }

  if (selection.kind === "caption") {
    const s = transcript.segments[selection.index];
    if (!s) return null;
    const track = captionTrack(s);
    const trackDef = (overlays.captionTracks ?? []).find((t) => t.track === track);
    /** 実効位置(個別指定 → トラック標準 → 下部中央)。数値欄の既定値に使う */
    const eff: CaptionPos = captionPosOf(s, overlays) ?? stdCaptionPos;
    /** 座標の解釈(トラック標準の anchor)。数値欄の説明に使う */
    const posLabel =
      captionAnchorOf(s, overlays) === "topLeft" ? "テキスト左上" : "テキスト中心";
    /** 個別指定の無い項目の値(トラック標準 → 既定)。色入力・placeholder に使う */
    const base: CaptionStyle = {
      fontSizePx: captionFontSizePx,
      color: CAPTION_DEFAULT_COLOR,
      outlineColor: CAPTION_DEFAULT_OUTLINE,
      fontFamily: CAPTION_DEFAULT_FONT_FAMILY,
      fontWeight: CAPTION_DEFAULT_FONT_WEIGHT,
      ...trackDef?.style,
    };
    /** いま効いているフォント種(個別 → トラック標準 → 既定)。select の値に使う */
    const effFamily = s.style?.fontFamily ?? base.fontFamily;
    /** プリセットに無い手書きのフォント種はそのまま選択肢に足して残す */
    const familyOptions = FONT_PRESETS.some((p) => p.value === effFamily)
      ? FONT_PRESETS
      : [...FONT_PRESETS, { label: "(その他)", value: effFamily! }];
    /** セグメントの style を項目単位で更新(undefined で項目を消し、空なら key ごと消す) */
    const patchStyle = (p: Partial<CaptionStyle>) => {
      const st: CaptionStyle = { ...s.style, ...p };
      for (const k of Object.keys(st) as (keyof CaptionStyle)[]) {
        if (st[k] === undefined) delete st[k];
      }
      updateCaption(selection.index, {
        style: Object.keys(st).length > 0 ? st : undefined,
      });
    };
    return (
      <div className="insp">
        <h3>テロップ</h3>
        <textarea
          className="capEdit"
          rows={3}
          value={s.text}
          onChange={(e) => updateCaption(selection.index, { text: e.target.value })}
        />
        <TimeFields
          start={s.start}
          end={s.end}
          onStart={(v) => updateCaption(selection.index, { start: v })}
          onEnd={(v) => updateCaption(selection.index, { end: v })}
        />
        {capTracks > 1 && (
          <div className="field">
            <label>トラック</label>
            <select
              value={track}
              title="タイムラインのテロップトラックと連動(前面/背面はトラックの並び順)"
              onChange={(e) => {
                const n = Number(e.target.value);
                updateCaption(selection.index, { track: n > 1 ? n : undefined });
              }}
            >
              {Array.from({ length: capTracks }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {captionTrackName(i + 1, overlays, capTracks)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>位置 X / Y</label>
          <NumInput
            value={s.pos?.x}
            allowEmpty
            placeholder={String(eff.x)}
            title={`${posLabel}の出力px。空欄=標準位置。プレビュー上のドラッグでも動かせる`}
            onCommit={(v) =>
              updateCaption(selection.index, {
                pos: v !== undefined ? { ...eff, x: Math.round(v) } : undefined,
              })
            }
          />
          <NumInput
            value={s.pos?.y}
            allowEmpty
            placeholder={String(eff.y)}
            title={`${posLabel}の出力px。空欄=標準位置。プレビュー上のドラッグでも動かせる`}
            onCommit={(v) =>
              updateCaption(selection.index, {
                pos: v !== undefined ? { ...eff, y: Math.round(v) } : undefined,
              })
            }
          />
        </div>
        {s.pos && (
          <div className="btnRow">
            <button onClick={() => updateCaption(selection.index, { pos: undefined })}>
              位置を標準に戻す
            </button>
            <button
              title={`この位置をトラック T${track} の標準位置として overlays.json に保存し、` +
                "位置未指定のテロップすべてに適用する"}
              onClick={() => {
                if (s.pos) setCaptionTrackDefault(track, { pos: s.pos });
                updateCaption(selection.index, { pos: undefined });
              }}
            >
              トラックの標準位置にする
            </button>
          </div>
        )}
        <div className="field">
          <label>サイズ(px)</label>
          <NumInput
            value={s.style?.fontSizePx}
            allowEmpty
            placeholder={String(base.fontSizePx)}
            title="このテロップだけのフォントサイズ。空欄=標準(トラック標準 → config.yaml)"
            onCommit={(v) =>
              patchStyle({ fontSizePx: v !== undefined ? Math.round(v) : undefined })
            }
          />
        </div>
        <div className="field">
          <label>文字色 / 縁色</label>
          <input
            type="color"
            value={s.style?.color ?? base.color}
            title="文字色。指定すると transcript.json の style に保存"
            onChange={(e) => patchStyle({ color: e.target.value })}
          />
          <input
            type="color"
            value={s.style?.outlineColor ?? base.outlineColor}
            title="縁取り色。指定すると transcript.json の style に保存"
            onChange={(e) => patchStyle({ outlineColor: e.target.value })}
          />
          {(s.style?.color || s.style?.outlineColor) && (
            <button
              className="linkish"
              title="このテロップの色指定を消して標準に戻す"
              onClick={() => patchStyle({ color: undefined, outlineColor: undefined })}
            >
              標準に
            </button>
          )}
        </div>
        <div className="field">
          <label>フォント</label>
          <select
            value={effFamily}
            style={{ flex: 1, minWidth: 0 }}
            title="このテロップのフォント種。空欄=標準(トラック標準 → 既定のゴシック)"
            onChange={(e) =>
              patchStyle({
                fontFamily:
                  e.target.value === CAPTION_DEFAULT_FONT_FAMILY ? undefined : e.target.value,
              })
            }
          >
            {familyOptions.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>太さ</label>
          <select
            value={s.style?.fontWeight ?? ""}
            title="文字の太さ。標準=トラック標準 → 既定(太字 700)"
            onChange={(e) =>
              patchStyle({
                fontWeight: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          >
            <option value="">標準</option>
            <option value={400}>普通 (400)</option>
            <option value={700}>太字 (700)</option>
            <option value={900}>極太 (900)</option>
          </select>
        </div>
        <div className="field">
          <label>座布団(背景帯)</label>
          <input
            type="checkbox"
            checked={!!s.style?.background}
            title="テキストの背後に帯を敷く(YouTube テロップの定番)。縁取りは自動で消える"
            onChange={(e) =>
              patchStyle(
                e.target.checked
                  ? { background: { color: "#000000" }, outlineColor: "none" }
                  : { background: undefined, outlineColor: undefined },
              )
            }
          />
          {s.style?.background && (
            <input
              type="color"
              value={s.style.background.color}
              title="帯の色。透明度の指定は overlays/transcript の JSON で rgba() を書く"
              onChange={(e) =>
                patchStyle({
                  background: { ...s.style!.background!, color: e.target.value },
                })
              }
            />
          )}
        </div>
        {s.style && (
          <div className="btnRow">
            <button onClick={() => updateCaption(selection.index, { style: undefined })}>
              スタイルを標準に戻す
            </button>
            <button
              title={`この見た目をトラック T${track} の標準スタイルとして overlays.json に保存し、` +
                "個別指定の無いテロップすべてに適用する"}
              onClick={() => {
                setCaptionTrackDefault(track, { style: { ...trackDef?.style, ...s.style } });
                updateCaption(selection.index, { style: undefined });
              }}
            >
              トラックの標準スタイルにする
            </button>
          </div>
        )}
        {trackDef?.x !== undefined && (
          <p className="dim hint">
            トラック T{track} の標準位置: X {trackDef.x} / Y {trackDef.y}{" "}
            <button className="linkish" onClick={() => setCaptionTrackDefault(track, { pos: null })}>
              解除
            </button>
          </p>
        )}
        {trackDef?.style && (
          <p className="dim hint">
            トラック T{track} の標準スタイル: {fmtStyle(trackDef.style)}{" "}
            <button className="linkish" onClick={() => setCaptionTrackDefault(track, { style: null })}>
              解除
            </button>
          </p>
        )}
        <button className="danger" onClick={() => removeCaption(selection.index)}>
          このテロップを削除
        </button>
        <p className="dim hint">
          プレビュー上のテロップはドラッグで移動できます(PowerPoint のテキスト風)。
          幅はテキストに自動で合い、折り返したい位置には文言に改行を入れます。
          変更は transcript.json に保存されます(whisper の誤認識もここで直す)。
        </p>
      </div>
    );
  }

  if (selection.kind === "insert") {
    const ins = (overlays.inserts ?? [])[selection.index];
    if (!ins) return null;
    return (
      <div className="insp">
        <h3>挿入クリップ(インサート)</h3>
        <p className="dim hint" style={{ marginTop: 0 }}>
          この位置に素材を差し込み、後続の映像・テロップ・章・素材を
          尺のぶんだけ後ろへずらします。
        </p>
        <div className="field">
          <label>挿入位置(元収録 秒)</label>
          <NumInput
            value={ins.at}
            onCommit={(v) => v !== undefined && updateInsert(selection.index, { at: v })}
          />
        </div>
        <div className="field">
          <label>尺(秒)</label>
          <NumInput
            value={ins.durationSec}
            onCommit={(v) =>
              v !== undefined &&
              updateInsert(selection.index, { durationSec: Math.max(0.1, v) })
            }
          />
        </div>
        <div className="field">
          <label>ファイル</label>
          <select
            value={ins.file}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => updateInsert(selection.index, { file: e.target.value })}
          >
            {!materials.includes(ins.file) && <option value={ins.file}>{ins.file}</option>}
            {materials.map((m) => (
              <option key={m} value={m}>
                {m.replace(/^materials\//, "")}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>フィット</label>
          <select
            value={ins.fit ?? "contain"}
            onChange={(e) =>
              updateInsert(selection.index, { fit: e.target.value as "contain" | "cover" })
            }
          >
            <option value="contain">contain(全体を見せる)</option>
            <option value="cover">cover(画面を埋める)</option>
          </select>
        </div>
        <button className="danger" onClick={() => removeInsert(selection.index)}>
          この挿入を削除
        </button>
      </div>
    );
  }

  if (selection.kind === "cut") {
    const s = cutplan.segments[selection.index];
    if (!s) return null;
    const isKeep = s.action === "keep";
    return (
      <div className="insp">
        <h3>{isKeep ? "映像クリップ" : "カットされた区間"}</h3>
        {!isKeep && (
          <p className="dim hint" style={{ marginTop: 0 }}>
            この区間はいまカットされていて、動画に含まれていません。
          </p>
        )}
        <TimeFields
          start={s.start}
          end={s.end}
          onStart={(v) => updateCutSeg(selection.index, { start: v })}
          onEnd={(v) => updateCutSeg(selection.index, { end: v })}
        />
        {s.reason && <p className="dim">plan の理由: {s.reason}</p>}
        {isKeep ? (
          <button
            className="danger"
            title="削除ではなく記録として残る。映像トラックの ▼ 印からいつでも戻せる (Delete)"
            onClick={() => cutKeepSeg(selection.index)}
          >
            この区間をカットする
          </button>
        ) : (
          <button
            className="primary"
            title="この区間を動画に戻す(隣のクリップと重なる分は縮めて戻る)"
            onClick={() => restoreCutSeg(selection.index)}
          >
            この区間を動画に戻す
          </button>
        )}
        <p className="dim hint">
          カット境界の変更は即プレビューに反映されます。
          ⌘K で再生ヘッド位置のクリップを分割できます。
        </p>
      </div>
    );
  }

  if (selection.kind === "overlays") {
    const ov = (overlays.overlays ?? [])[selection.index];
    if (!ov) return null;
    return (
      <div className="insp">
        <h3>素材</h3>
        <TimeFields
          start={ov.start}
          end={ov.end}
          onStart={(v) => updateSpan("overlays", selection.index, { start: v })}
          onEnd={(v) => updateSpan("overlays", selection.index, { end: v })}
        />
        <div className="field">
          <label>ファイル</label>
          <select
            value={ov.file}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => updateSpan("overlays", selection.index, { file: e.target.value })}
          >
            {/* 手書き JSON が消えた素材を指すこともあるので選択肢に残す */}
            {!materials.includes(ov.file) && <option value={ov.file}>{ov.file}</option>}
            {materials.map((m) => (
              <option key={m} value={m}>
                {m.replace(/^materials\//, "")}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>トラック</label>
          <select
            value={overlayTrack(ov)}
            title="タイムラインの素材トラックと連動(前面/背面はトラックの並び順)"
            onChange={(e) => {
              const n = Number(e.target.value);
              // 旧式の layer 指定はここで track へ移行する
              updateSpan("overlays", selection.index, {
                track: n > 1 ? n : undefined,
                layer: undefined,
              });
            }}
          >
            {Array.from({ length: ovTracks }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                素材 V{i + 1}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>フィット</label>
          <select
            value={ov.fit ?? "contain"}
            onChange={(e) =>
              updateSpan("overlays", selection.index, {
                fit: e.target.value as "contain" | "cover",
              })
            }
          >
            <option value="contain">contain(全体を見せる)</option>
            <option value="cover">cover(画面を埋める)</option>
          </select>
        </div>
        <button className="danger" onClick={() => removeSpan("overlays", selection.index)}>
          この素材を削除
        </button>
      </div>
    );
  }

  if (selection.kind === "wipeFull") {
    const sp = (overlays.wipeFull ?? [])[selection.index];
    if (!sp) return null;
    return (
      <div className="insp">
        <h3>ワイプ全画面</h3>
        <p className="dim hint" style={{ marginTop: 0 }}>
          この区間はワイプ(カメラ)が画面全体に広がり、背景を隠します。
        </p>
        <TimeFields
          start={sp.start}
          end={sp.end}
          onStart={(v) => updateSpan("wipeFull", selection.index, { start: v })}
          onEnd={(v) => updateSpan("wipeFull", selection.index, { end: v })}
        />
        <button className="danger" onClick={() => removeSpan("wipeFull", selection.index)}>
          この区間を削除
        </button>
      </div>
    );
  }

  return null;
};

/** フォント種のプリセット(macOS 標準の日本語フォント)。
 * 値はそのまま CSS font-family として使う */
const FONT_PRESETS: { label: string; value: string }[] = [
  { label: "ゴシック(標準)", value: CAPTION_DEFAULT_FONT_FAMILY },
  {
    label: "丸ゴシック",
    value: '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif',
  },
  { label: "明朝", value: '"Hiragino Mincho ProN", "Yu Mincho", serif' },
];

/** トラック標準スタイルのヒント表示用(指定のある項目だけ並べる) */
const fmtStyle = (st: CaptionStyle): string =>
  [
    st.fontSizePx !== undefined ? `${st.fontSizePx}px` : null,
    st.color ? `文字 ${st.color}` : null,
    st.outlineColor ? `縁 ${st.outlineColor}` : null,
    st.fontFamily ? "フォント指定" : null,
    st.fontWeight !== undefined ? `太さ ${st.fontWeight}` : null,
    st.background ? `座布団 ${st.background.color}` : null,
  ]
    .filter((v) => v !== null)
    .join(" / ");

const TimeFields = ({
  start,
  end,
  onStart,
  onEnd,
}: {
  start: number;
  end: number;
  onStart: (v: number) => void;
  onEnd: (v: number) => void;
}) => (
  <>
    <div className="field">
      <label>開始(元収録 秒)</label>
      <NumInput value={start} onCommit={(v) => v !== undefined && onStart(v)} />
    </div>
    <div className="field">
      <label>終了(元収録 秒)</label>
      <NumInput value={end} onCommit={(v) => v !== undefined && onEnd(v)} />
    </div>
    <div className="field">
      <label>長さ</label>
      <span className="mono dim">{fmtTime(Math.max(0, end - start))}</span>
    </div>
  </>
);

