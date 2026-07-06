import { useState } from "react";
import type { ReactNode } from "react";
import {
  CAPTION_DEFAULT_COLOR,
  CAPTION_DEFAULT_FONT_FAMILY,
  CAPTION_DEFAULT_FONT_WEIGHT,
  CAPTION_DEFAULT_OUTLINE,
  DEFAULT_ZOOM_EASE_SEC,
  captionAnchorOf,
  captionPosOf,
  captionTrack,
  captionTrackName,
  overlayTrack,
} from "../../src/types.ts";
import type {
  Bgm,
  CaptionPos,
  CaptionStyle,
  CutPlan,
  Overlays,
  Region,
  Short,
  Transcript,
} from "../../src/types.ts";
import { insertSpans, remapInterval } from "../../src/lib/timeline.ts";
import type { TimelineEntry } from "../../src/lib/timeline.ts";
import { PROFILES } from "../../src/lib/profile.ts";
import type { RenderProps } from "../../remotion/props.ts";
import type { Selection } from "./model.ts";
import { usePlayheadSelector } from "./playhead.ts";
import {
  NumInput,
  PctSlider,
  Segmented,
  VIDEO_EXT_RE,
  fmtTime,
  joinColor,
  measureCaption,
  splitColor,
  useMaterialMeta,
} from "./widgets.tsx";

type OverlayEntry = NonNullable<Overlays["overlays"]>[number];
type InsertEntry = NonNullable<Overlays["inserts"]>[number];
type BgmTrack = Bgm["tracks"][number];

const round2 = (n: number) => Math.round(n * 100) / 100;
/** 区間がゼロ幅・逆転しないための最小幅(秒)。App の MIN_SPAN と同じ */
const MIN_SPAN = 0.1;

/**
 * 右サイドの常設インスペクタ。タイムラインで選択したクリップの詳細を編集する。
 * 構成は上から「アイデンティティ(何を選んでいるか)→ 内容 → タイミング →
 * 見た目 → 詳細(生の秒。折りたたみ)→ 削除」。タイムラインの直接操作
 * (トリム・移動)やプレビュー上のドラッグで済むものはフォームの一等地に
 * 置かず、パネルにしかできない編集(スタイル・音量・差し替え等)を優先する。
 * 未選択時はプロジェクトの要約を出す。時刻の生値編集はすべて元収録の秒
 * (JSON の規約と同じ)で、「詳細」に畳んである。
 */
export const Inspector = ({
  selection,
  capMulti,
  cutplan,
  overlays,
  transcript,
  bgm,
  materials,
  ovTracks,
  capTracks,
  stdCaptionPos,
  captionDefaults,
  output,
  marginPx,
  timeline,
  srcDur,
  duration,
  getPlayheadSrc,
  seekToSrc,
  seekOut,
  project,
  setCaptionTrackDefault,
  updateCutSeg,
  cutKeepSeg,
  restoreCutSeg,
  updateCaption,
  removeCaption,
  updateCaptionsStyle,
  updateCaptionsTrack,
  removeCaptions,
  updateSpan,
  removeSpan,
  updateZoom,
  removeZoom,
  updateInsert,
  removeInsert,
  updateBgm,
  removeBgm,
  shortMode,
  activeShort,
  setShortCaptionTrackDefault,
  updateShortRange,
  removeShortRange,
  updateActiveShort,
  removeShort,
}: {
  selection: Selection;
  /** 複数選択中のテロップ(transcript.segments の添字。2件以上のときだけ) */
  capMulti: number[];
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  /** BGM の区間配置(bgm.json)。null = 区間配置なし */
  bgm: Bgm | null;
  materials: string[];
  /** 素材トラックの本数(トラック選択肢 V1..VN) */
  ovTracks: number;
  /** テロップトラックの本数(トラック選択肢 T1..TN) */
  capTracks: number;
  /** 位置未指定テロップの標準位置(数値欄のプレースホルダに使う) */
  stdCaptionPos: CaptionPos;
  /** スタイル未指定テロップの既定の見た目(config の render.caption* を
   * buildRenderProps が解決したもの = built.props.caption) */
  captionDefaults: RenderProps["caption"];
  /** 出力解像度(位置・rect プリセットの計算に使う) */
  output: { w: number; h: number };
  /** 画面端からの余白(config の render.wipeMarginPx。プリセットに使う) */
  marginPx: number;
  /** カット後写像(出力時刻の表示に使う) */
  timeline: TimelineEntry[];
  /** 元収録の長さ(秒) */
  srcDur: number;
  /** カット後の長さ(秒) */
  duration: number;
  /** 再生ヘッド位置の元収録の秒(カット外・挿入クリップ上は null)を返す。
   * 毎フレーム変わる値なのでレンダー中の固定値では受け取らず、クリック時に
   * 読む(ボタンの活性は usePlayheadSelector で null かどうかだけ購読) */
  getPlayheadSrc: () => number | null;
  /** 元収録の秒へ再生ヘッドを移動(カット内なら直後の keep へスナップ) */
  seekToSrc: (src: number) => void;
  /** カット後の秒へ再生ヘッドを移動(挿入クリップの頭出しに使う) */
  seekOut: (outT: number) => void;
  /** 未選択時のプロジェクト要約に使う */
  project: { dir: string; approved: boolean; bgmFile: string | null; bgmTracks: number };
  /** テロップトラックの標準位置・スタイル・座標基準を設定
   * (null で解除、undefined は現状維持) */
  setCaptionTrackDefault: (
    track: number,
    patch: {
      pos?: CaptionPos | null;
      style?: CaptionStyle | null;
      anchor?: "center" | "topLeft" | null;
    },
  ) => void;
  updateCutSeg: (i: number, patch: Partial<CutPlan["segments"][number]>) => void;
  /** keep 区間をカットへ倒す(記録として残り、継ぎ目の印から戻せる) */
  cutKeepSeg: (i: number) => void;
  /** カットされた区間を keep に戻す(隣の keep と重なる分は縮めて戻る) */
  restoreCutSeg: (i: number) => void;
  /** coalesceKey は連続入力(文字・カラーピッカー・スライダー)の undo まとめ用。
   * ボタンやトグルのような独立した操作では渡さない */
  updateCaption: (
    i: number,
    patch: Partial<Transcript["segments"][number]>,
    coalesceKey?: string,
  ) => void;
  removeCaption: (i: number) => void;
  /** 複数テロップの style を項目単位で一括変更(null で個別スタイル全解除) */
  updateCaptionsStyle: (
    indices: number[],
    patch: Partial<CaptionStyle> | null,
    coalesceKey?: string,
  ) => void;
  updateCaptionsTrack: (indices: number[], track: number) => void;
  removeCaptions: (indices: number[]) => void;
  updateSpan: (
    kind: "overlays" | "wipeFull",
    i: number,
    patch: Partial<OverlayEntry>,
    coalesceKey?: string,
  ) => void;
  removeSpan: (kind: "overlays" | "wipeFull", i: number) => void;
  updateZoom: (
    i: number,
    patch: Partial<NonNullable<Overlays["zooms"]>[number]>,
    coalesceKey?: string,
  ) => void;
  removeZoom: (i: number) => void;
  updateInsert: (i: number, patch: Partial<InsertEntry>, coalesceKey?: string) => void;
  removeInsert: (i: number) => void;
  updateBgm: (i: number, patch: Partial<BgmTrack>, coalesceKey?: string) => void;
  removeBgm: (i: number) => void;
  /** ショートモードか(選択中のショートがある)。true のとき「caption」選択は
   * 位置/スタイル編集を transcript ではなくショートの captionTracks へ書く */
  shortMode: boolean;
  /** ショートモード中の選択中ショート(null = 本編モード) */
  activeShort: Short | null;
  /** ショートモードのテロップトラック標準位置/スタイル/座標基準の設定
   * (null で解除、undefined は現状維持)。setCaptionTrackDefault のショート版 */
  setShortCaptionTrackDefault: (
    track: number,
    patch: {
      pos?: CaptionPos | null;
      style?: CaptionStyle | null;
      anchor?: "center" | "topLeft" | null;
    },
  ) => void;
  updateShortRange: (i: number, patch: Partial<{ start: number; end: number }>) => void;
  removeShortRange: (i: number) => void;
  /** 選択中ショートを部分更新する(ショートの「プロパティ」節=profile/承認の編集用) */
  updateActiveShort: (updater: (s: Short) => Short) => void;
  /** ショートを1本削除する(確認はこのパネル側で挟む) */
  removeShort: (name: string) => void;
}) => {
  /** 再生ヘッドが映像クリップの上にあるか(「ここへ」系ボタンの活性)。
   * boolean に落として購読するので、境界をまたいだ時だけ再レンダーされる
   * (元収録の秒そのものを購読すると毎フレーム再レンダーに戻ってしまう) */
  const playheadOnClip = usePlayheadSelector(() => getPlayheadSrc() !== null);
  if (selection === null) {
    return (
      <ProjectPanel
        cutplan={cutplan}
        transcript={transcript}
        materials={materials}
        srcDur={srcDur}
        duration={duration}
        project={project}
        shortSection={
          activeShort && (
            <ShortPropertiesSection
              activeShort={activeShort}
              updateActiveShort={updateActiveShort}
              removeShort={removeShort}
            />
          )
        }
      />
    );
  }

  /* ---------------- ショート範囲(ranges) ---------------- */

  if (selection.kind === "short") {
    const r = activeShort?.ranges[selection.index];
    if (!r || !activeShort) return null;
    return (
      <div className="insp">
        <InspHead
          kind="ショート範囲"
          title={activeShort.name}
          chips={[`長さ ${fmtTime(Math.max(0, r.end - r.start))}`]}
        />
        <TimingSection
          start={r.start}
          end={r.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) => updateShortRange(selection.index, { start: v })}
          onEnd={(v) => updateShortRange(selection.index, { end: v })}
        />
        <Section title="">
          <button className="danger" onClick={() => removeShortRange(selection.index)}>
            この区間を削除
          </button>
          <p className="dim hint">
            本編の cutplan とは独立の、このショート専用の keep 区間です
            (shorts.json の ranges)。飛び区間を複数追加して連結できます。
          </p>
        </Section>
        <ShortPropertiesSection
          activeShort={activeShort}
          updateActiveShort={updateActiveShort}
          removeShort={removeShort}
        />
      </div>
    );
  }

  /* ---------------- テロップ(複数選択の一括編集) ---------------- */

  if (selection.kind === "caption" && capMulti.length > 1) {
    return (
      <BatchCaptionPanel
        indices={capMulti}
        transcript={transcript}
        overlays={overlays}
        capTracks={capTracks}
        captionDefaults={captionDefaults}
        updateCaptionsStyle={updateCaptionsStyle}
        updateCaptionsTrack={updateCaptionsTrack}
        removeCaptions={removeCaptions}
      />
    );
  }

  /* ---------------- テロップ(単体・ショートモード) ----------------
   * ショートは per-segment の pos/style 上書きを持たない(D2: 常に
   * トラック単位。captionTracks の解決機構に相乗り)。本編の transcript の
   * pos/style は書き換えない(5-4)。文言・タイミングは本編と共有なので
   * そのまま transcript へ書く */

  if (selection.kind === "caption" && shortMode) {
    const s = transcript.segments[selection.index];
    if (!s) return null;
    return (
      <ShortCaptionPanel
        s={s}
        index={selection.index}
        overlays={overlays}
        capTracks={capTracks}
        activeShort={activeShort}
        captionDefaults={captionDefaults}
        stdCaptionPos={stdCaptionPos}
        output={output}
        marginPx={marginPx}
        timeline={timeline}
        getPlayheadSrc={getPlayheadSrc}
        seekToSrc={seekToSrc}
        updateCaption={updateCaption}
        removeCaption={removeCaption}
        setShortCaptionTrackDefault={setShortCaptionTrackDefault}
      />
    );
  }

  /* ---------------- テロップ(単体) ---------------- */

  if (selection.kind === "caption") {
    const s = transcript.segments[selection.index];
    if (!s) return null;
    const track = captionTrack(s);
    const trackDef = (overlays.captionTracks ?? []).find((t) => t.track === track);
    const anchor = captionAnchorOf(s, overlays);
    /** 実効位置(個別指定 → トラック標準 → 下部中央)。数値欄の既定値に使う */
    const eff: CaptionPos = captionPosOf(s, overlays) ?? stdCaptionPos;
    const posLabel = anchor === "topLeft" ? "テキスト左上" : "テキスト中心";
    /** 個別指定の無い項目の値(トラック標準 → config の既定 → 定数)。
     * サンプル描画・色入力・placeholder に使う */
    const base: CaptionStyle = {
      fontSizePx: captionDefaults.fontSizePx,
      color: captionDefaults.color ?? CAPTION_DEFAULT_COLOR,
      outlineColor: captionDefaults.outlineColor ?? CAPTION_DEFAULT_OUTLINE,
      fontFamily: captionDefaults.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
      fontWeight: captionDefaults.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
      ...trackDef?.style,
    };
    /** いま効いている見た目(個別 → 標準)。サンプルとプリセット計測に使う */
    const effStyle: CaptionStyle = { ...base, ...s.style };
    const defaultFamily = base.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY;
    const effFamily = s.style?.fontFamily ?? defaultFamily;
    /** 先頭は「標準」。同値のプリセットは除外(option の key 重複防止)し、
     * プリセットに無い手書きのフォント種はそのまま選択肢に足して残す */
    const familyOptions = [
      { label: "標準", value: defaultFamily },
      ...FONT_PRESETS.filter((p) => p.value !== defaultFamily),
      ...(effFamily !== defaultFamily && !FONT_PRESETS.some((p) => p.value === effFamily)
        ? [{ label: "(その他)", value: effFamily }]
        : []),
    ];
    /** セグメントの style を項目単位で更新(undefined で項目を消し、空なら key ごと消す)。
     * key はカラーピッカー・スライダーの連続変更を undo 1回にまとめる用 */
    const patchStyle = (p: Partial<CaptionStyle>, key?: string) => {
      const st: CaptionStyle = { ...s.style, ...p };
      for (const k of Object.keys(st) as (keyof CaptionStyle)[]) {
        if (st[k] === undefined) delete st[k];
      }
      updateCaption(
        selection.index,
        { style: Object.keys(st).length > 0 ? st : undefined },
        key,
      );
    };
    /** 9点プリセット。テキストの実測寸法で画面端に marginPx を空けて置く */
    const applyPosPreset = (h: "l" | "c" | "r", v: "t" | "m" | "b") => {
      const { w: tw, h: th } = measureCaption(
        s.text,
        effStyle.fontSizePx ?? captionDefaults.fontSizePx,
        effStyle.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
        effStyle.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
      );
      const m = marginPx;
      const x =
        anchor === "topLeft"
          ? h === "l" ? m : h === "c" ? Math.round((output.w - tw) / 2) : output.w - m - tw
          : h === "l"
            ? m + Math.round(tw / 2)
            : h === "c"
              ? Math.round(output.w / 2)
              : output.w - m - Math.round(tw / 2);
      const y =
        anchor === "topLeft"
          ? v === "t" ? m : v === "m" ? Math.round((output.h - th) / 2) : output.h - m - th
          : v === "t"
            ? m + Math.round(th / 2)
            : v === "m"
              ? Math.round(output.h / 2)
              : output.h - m - Math.round(th / 2);
      updateCaption(selection.index, { pos: { x, y } });
    };
    const outlineOn = (effStyle.outlineColor ?? CAPTION_DEFAULT_OUTLINE) !== "none";
    const bg = s.style?.background;
    const bgColor = bg ? splitColor(bg.color) : null;
    return (
      <div className="insp">
        <InspHead
          kind={captionTrackName(track, overlays, capTracks)}
          title={s.text.trim().split("\n")[0] || "(空のテロップ)"}
          chips={[`長さ ${fmtTime(Math.max(0, s.end - s.start))}`]}
        />
        <textarea
          className="capEdit"
          rows={3}
          value={s.text}
          onChange={(e) =>
            updateCaption(
              selection.index,
              { text: e.target.value },
              `caption:${selection.index}:text`,
            )
          }
        />
        <CaptionSample text={s.text} eff={effStyle} />
        <TimingSection
          start={s.start}
          end={s.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) => updateCaption(selection.index, { start: v })}
          onEnd={(v) => updateCaption(selection.index, { end: v })}
        />
        <Section title="配置">
          <div className="posRow">
            <div className="posGrid" title="画面9箇所への配置プリセット(テキストの実測幅で余白を確保)">
              {(
                [
                  ["l", "t", "↖"], ["c", "t", "↑"], ["r", "t", "↗"],
                  ["l", "m", "←"], ["c", "m", "・"], ["r", "m", "→"],
                  ["l", "b", "↙"], ["c", "b", "↓"], ["r", "b", "↘"],
                ] as const
              ).map(([h, v, label]) => (
                <button key={`${h}${v}`} onClick={() => applyPosPreset(h, v)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="posFields">
              <div className="field">
                <label>X / Y</label>
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
              <div className="field">
                <label>座標の基準</label>
                <select
                  value={anchor}
                  title={`トラック T${track} 全体の設定(overlays.json の captionTracks.anchor)。位置指定のあるテロップの座標の解釈が変わる`}
                  onChange={(e) =>
                    setCaptionTrackDefault(track, {
                      anchor: e.target.value === "topLeft" ? "topLeft" : null,
                    })
                  }
                >
                  <option value="center">テキスト中心</option>
                  <option value="topLeft">左上(章タイトル向き)</option>
                </select>
              </div>
              <p className="dim hint" style={{ margin: "0 0 4px" }}>
                基準は{captionTrackName(track, overlays, capTracks)}トラック全体に
                効きます(位置指定のあるテロップすべて)
              </p>
            </div>
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
          {trackDef?.x !== undefined && (
            <p className="dim hint">
              トラック T{track} の標準位置: X {trackDef.x} / Y {trackDef.y}{" "}
              <button
                className="linkish"
                onClick={() => setCaptionTrackDefault(track, { pos: null })}
              >
                解除
              </button>
            </p>
          )}
        </Section>
        <Section title="スタイル">
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
            <label>文字色</label>
            <input
              type="color"
              value={s.style?.color ?? base.color}
              title="文字色。指定すると transcript.json の style に保存"
              onChange={(e) =>
                patchStyle({ color: e.target.value }, `caption:${selection.index}:color`)
              }
            />
          </div>
          <div className="field">
            <label>縁取り</label>
            <input
              type="checkbox"
              checked={outlineOn}
              title="文字の縁取りの有無(なし=outlineColor: none)"
              onChange={(e) =>
                patchStyle(
                  e.target.checked
                    ? {
                        outlineColor:
                          base.outlineColor && base.outlineColor !== "none"
                            ? undefined // 標準の縁色に戻す
                            : CAPTION_DEFAULT_OUTLINE,
                      }
                    : { outlineColor: "none" },
                )
              }
            />
            {outlineOn && (
              <input
                type="color"
                value={
                  (s.style?.outlineColor !== "none" ? s.style?.outlineColor : undefined) ??
                  (base.outlineColor !== "none" ? base.outlineColor : CAPTION_DEFAULT_OUTLINE)
                }
                title="縁取り色。指定すると transcript.json の style に保存"
                onChange={(e) =>
                  patchStyle(
                    { outlineColor: e.target.value },
                    `caption:${selection.index}:outlineColor`,
                  )
                }
              />
            )}
          </div>
          <div className="field">
            <label>フォント</label>
            <select
              value={effFamily}
              style={{ flex: 1, minWidth: 0 }}
              title="このテロップのフォント種。標準=トラック標準 → config の既定"
              onChange={(e) =>
                patchStyle({
                  fontFamily:
                    e.target.value === defaultFamily ? undefined : e.target.value,
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
              checked={!!bg}
              title="テキストの背後に帯を敷く(YouTube テロップの定番)。縁取りは自動で消える"
              onChange={(e) =>
                patchStyle(
                  e.target.checked
                    ? { background: { color: "#000000" }, outlineColor: "none" }
                    : { background: undefined, outlineColor: undefined },
                )
              }
            />
            {bg && bgColor && (
              <input
                type="color"
                value={bgColor.hex}
                title="帯の色"
                onChange={(e) =>
                  patchStyle(
                    {
                      background: {
                        ...bg,
                        color: joinColor(e.target.value, bgColor.alpha),
                      },
                    },
                    `caption:${selection.index}:bgColor`,
                  )
                }
              />
            )}
          </div>
          {bg && bgColor && (
            <>
              <div className="field">
                <label>帯の不透明度</label>
                <PctSlider
                  pct={Math.round(bgColor.alpha * 100)}
                  title="帯の透け具合(rgba として transcript.json に保存)"
                  onChange={(pct) =>
                    patchStyle(
                      {
                        background: { ...bg, color: joinColor(bgColor.hex, pct / 100) },
                      },
                      `caption:${selection.index}:bgAlpha`,
                    )
                  }
                />
              </div>
              <div className="field">
                <label>帯の余白(px)</label>
                <NumInput
                  value={bg.paddingPx}
                  allowEmpty
                  placeholder={String(
                    Math.round((effStyle.fontSizePx ?? base.fontSizePx ?? 44) * 0.35),
                  )}
                  title="テキスト周りの余白(横方向。縦はこの半分)。空欄=フォントサイズの0.35倍"
                  onCommit={(v) =>
                    patchStyle({
                      background: {
                        ...bg,
                        paddingPx: v !== undefined ? Math.max(0, Math.round(v)) : undefined,
                      },
                    })
                  }
                />
                <label style={{ width: "auto" }}>角丸</label>
                <NumInput
                  value={bg.radiusPx}
                  allowEmpty
                  placeholder="8"
                  title="帯の角丸の半径(px)。空欄=8"
                  onCommit={(v) =>
                    patchStyle({
                      background: {
                        ...bg,
                        radiusPx: v !== undefined ? Math.max(0, Math.round(v)) : undefined,
                      },
                    })
                  }
                />
              </div>
            </>
          )}
          {s.style && (
            <div className="btnRow">
              <button onClick={() => updateCaption(selection.index, { style: undefined })}>
                スタイルを標準に戻す
              </button>
              <button
                title={`この見た目をトラック T${track} の標準スタイルとして overlays.json に保存し、` +
                  "個別指定の無いテロップすべてに適用する"}
                onClick={() => {
                  setCaptionTrackDefault(track, {
                    style: { ...trackDef?.style, ...s.style },
                  });
                  updateCaption(selection.index, { style: undefined });
                }}
              >
                トラックの標準スタイルにする
              </button>
            </div>
          )}
          {trackDef?.style && (
            <p className="dim hint">
              トラック T{track} の標準スタイル: {fmtStyle(trackDef.style)}{" "}
              <button
                className="linkish"
                onClick={() => setCaptionTrackDefault(track, { style: null })}
              >
                解除
              </button>
            </p>
          )}
        </Section>
        {capTracks > 1 && (
          <Section title="トラック">
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
          </Section>
        )}
        <Section title="">
          <button className="danger" onClick={() => removeCaption(selection.index)}>
            このテロップを削除
          </button>
          <p className="dim hint">
            プレビュー上のテロップはドラッグで移動できます。幅はテキストに自動で
            合い、折り返したい位置には文言に改行を入れます。⌘クリックで複数選択
            して一括でスタイルを変えられます。変更は transcript.json に保存されます
            (whisper の誤認識もここで直す)。
          </p>
        </Section>
      </div>
    );
  }

  /* ---------------- 挿入クリップ(インサート) ---------------- */

  if (selection.kind === "insert") {
    const ins = (overlays.inserts ?? [])[selection.index];
    if (!ins) return null;
    const isVideo = VIDEO_EXT_RE.test(ins.file);
    const keeps = cutplan.segments.filter((s) => s.action === "keep");
    const span = insertSpans(keeps, overlays.inserts ?? []).find(
      (sp) => sp.index === selection.index,
    );
    const volPct = Math.round((ins.volume ?? 1) * 100);
    return (
      <div className="insp">
        <MaterialHead
          kind="挿入クリップ(インサート)"
          file={ins.file}
          startFrom={ins.startFrom}
          chips={[`尺 ${fmtTime(ins.durationSec)}`]}
          materials={materials}
          onReplace={(f) => updateInsert(selection.index, { file: f })}
        />
        <p className="dim hint" style={{ marginTop: 0 }}>
          この位置に素材を差し込み、後続の映像・テロップ・章・素材を
          尺のぶんだけ後ろへずらします(音声込みで全面に出ます)。
        </p>
        <Section title="タイミング">
          <div className="field">
            <label>挿入位置</label>
            <span className="mono">{span ? fmtTime(span.start) : "—"}</span>
            <span className="dim hint">(出力の時刻)</span>
          </div>
          <div className="btnRow">
            <button
              disabled={!playheadOnClip}
              title={
                !playheadOnClip
                  ? "再生ヘッドが映像クリップの上にあるときだけ移動できます"
                  : "挿入位置を再生ヘッドの位置へ移動する"
              }
              onClick={() => {
                const p = getPlayheadSrc();
                if (p !== null) updateInsert(selection.index, { at: round2(p) });
              }}
            >
              再生ヘッド位置へ移動
            </button>
            <button
              title="この挿入クリップの頭へ再生ヘッドを移動"
              onClick={() => span && seekOut(span.start)}
            >
              頭から再生
            </button>
          </div>
          <div className="field">
            <label>尺(秒)</label>
            <NumInput
              value={ins.durationSec}
              title="挿入する長さ。素材の実尺より長いと最後のフレームで止まる。右端ドラッグでも調整できる"
              onCommit={(v) =>
                v !== undefined &&
                updateInsert(selection.index, { durationSec: Math.max(MIN_SPAN, round2(v)) })
              }
            />
          </div>
          {isVideo && (
            <div className="field">
              <label>頭出し(秒)</label>
              <NumInput
                value={ins.startFrom ?? 0}
                title="素材ファイル内の再生開始位置。0=頭から。左端ドラッグでも調整できる"
                onCommit={(v) =>
                  v !== undefined &&
                  updateInsert(selection.index, { startFrom: Math.max(0, round2(v)) })
                }
              />
            </div>
          )}
          {isVideo && (
            <SourceRangeBar
              file={ins.file}
              startFrom={ins.startFrom ?? 0}
              usedSec={ins.durationSec}
            />
          )}
          <details className="inspDetails">
            <summary>詳細(元収録の秒)</summary>
            <div className="field">
              <label>挿入位置 at</label>
              <NumInput
                value={ins.at}
                title="挿入位置のアンカー(元収録の秒)。この時刻の手前に挿入される"
                onCommit={(v) => v !== undefined && updateInsert(selection.index, { at: round2(v) })}
              />
            </div>
          </details>
        </Section>
        <Section title="見た目と音">
          <FitControl
            fit={ins.fit ?? "contain"}
            file={ins.file}
            box={{ w: output.w, h: output.h }}
            onChange={(v) => updateInsert(selection.index, { fit: v })}
          />
          {isVideo && (
            <div className="field">
              <label>音量</label>
              <PctSlider
                pct={volPct}
                max={200}
                title="挿入クリップの音量(100%=素材のまま、0%=無音)。書き出しにも効く"
                onChange={(pct) =>
                  updateInsert(
                    selection.index,
                    { volume: pct === 100 ? undefined : pct / 100 },
                    `insert:${selection.index}:volume`,
                  )
                }
              />
            </div>
          )}
          <div className="field">
            <label>フェード(秒)</label>
            <NumInput
              value={ins.fadeInSec}
              allowEmpty
              placeholder="0"
              title="イン(黒からの明転。音量も連動)"
              onCommit={(v) =>
                updateInsert(selection.index, {
                  fadeInSec: v !== undefined && v > 0 ? round2(v) : undefined,
                })
              }
            />
            <NumInput
              value={ins.fadeOutSec}
              allowEmpty
              placeholder="0"
              title="アウト(黒への暗転。音量も連動)"
              onCommit={(v) =>
                updateInsert(selection.index, {
                  fadeOutSec: v !== undefined && v > 0 ? round2(v) : undefined,
                })
              }
            />
          </div>
        </Section>
        <Section title="">
          <button className="danger" onClick={() => removeInsert(selection.index)}>
            この挿入を削除
          </button>
        </Section>
      </div>
    );
  }

  /* ---------------- BGM 区間 ---------------- */

  if (selection.kind === "bgm") {
    const t = bgm?.tracks[selection.index];
    if (!t) return null;
    const name = t.file.replace(/^materials\//, "");
    const parts = remapInterval(t.start, t.end, timeline);
    const outStart = parts[0]?.start ?? null;
    const playedSec = parts.reduce((s, iv) => s + (iv.end - iv.start), 0);
    const fadeSum = (t.fadeInSec ?? 0) + (t.fadeOutSec ?? 0);
    return (
      <div className="insp">
        <InspHead kind="BGM 区間" title={name} chips={[`尺 ${fmtTime(t.end - t.start)}`]} />
        <p className="dim hint" style={{ marginTop: 0 }}>
          この区間だけ BGM を流します(ループ再生)。覆っていない時間は無音。
          別ファイルの区間を並べれば曲の切り替え、重ねれば重奏になります。
          タイムラインの移動・トリムでも位置と長さを変えられます。
        </p>
        <Section title="タイミング">
          <div className="field">
            <label>出力の時刻</label>
            <span className="mono">{outStart !== null ? fmtTime(outStart) : "—"}</span>
            {playedSec < t.end - t.start - 0.05 && (
              <span className="dim hint">(一部がカット区間)</span>
            )}
          </div>
          <div className="btnRow">
            <button
              disabled={outStart === null}
              title="この区間の頭へ再生ヘッドを移動"
              onClick={() => outStart !== null && seekOut(outStart)}
            >
              頭から再生
            </button>
          </div>
          <div className="field">
            <label>頭出し(秒)</label>
            <NumInput
              value={t.startFrom ?? 0}
              title="BGM ファイル内の再生開始位置。0=頭から"
              onCommit={(v) =>
                v !== undefined &&
                updateBgm(selection.index, { startFrom: Math.max(0, round2(v)) })
              }
            />
          </div>
          <details className="inspDetails">
            <summary>詳細(元収録の秒)</summary>
            <div className="field">
              <label>開始</label>
              <NumInput
                value={t.start}
                title="BGM を流し始める時刻(元収録の秒)。左端ドラッグでも調整できる"
                onCommit={(v) =>
                  v !== undefined &&
                  updateBgm(selection.index, {
                    start: Math.max(0, Math.min(round2(v), round2(t.end - MIN_SPAN))),
                  })
                }
              />
            </div>
            <div className="field">
              <label>終了</label>
              <NumInput
                value={t.end}
                title="BGM を流し終わる時刻(元収録の秒)。右端ドラッグでも調整できる"
                onCommit={(v) =>
                  v !== undefined &&
                  updateBgm(selection.index, { end: Math.max(round2(t.start + MIN_SPAN), round2(v)) })
                }
              />
            </div>
          </details>
        </Section>
        <Section title="音">
          <div className="field">
            <label>音量(dB)</label>
            <NumInput
              value={t.volumeDb}
              allowEmpty
              placeholder="既定"
              title="0=原音量。空欄で config の既定(render.bgm.volumeDb)。声より 20dB 前後小さめが目安"
              onCommit={(v) =>
                updateBgm(selection.index, { volumeDb: v }, `bgm:${selection.index}:vol`)
              }
            />
          </div>
          <div className="field">
            <label>フェード(秒)</label>
            <NumInput
              value={t.fadeInSec}
              allowEmpty
              placeholder="0"
              title="イン(区間の頭で 0→音量へ)"
              onCommit={(v) =>
                updateBgm(selection.index, {
                  fadeInSec: v !== undefined && v > 0 ? round2(v) : undefined,
                })
              }
            />
            <NumInput
              value={t.fadeOutSec}
              allowEmpty
              placeholder="0"
              title="アウト(区間の末尾で 音量→0へ。終端を動画の終わりに合わせると従来の終端フェード)"
              onCommit={(v) =>
                updateBgm(selection.index, {
                  fadeOutSec: v !== undefined && v > 0 ? round2(v) : undefined,
                })
              }
            />
          </div>
          {fadeSum > playedSec + 0.005 && (
            <p className="warnText">フェードが再生時間より長く、途中までしか鳴りません</p>
          )}
        </Section>
        <Section title="">
          <button className="danger" onClick={() => removeBgm(selection.index)}>
            この BGM 区間を削除
          </button>
        </Section>
      </div>
    );
  }

  /* ---------------- 映像クリップ / カットされた区間 ---------------- */

  if (selection.kind === "cut") {
    const s = cutplan.segments[selection.index];
    if (!s) return null;
    const isKeep = s.action === "keep";
    // 前後の keep との間隔(=カットされている時間)。継ぎ目の把握用
    const keepIdx = cutplan.segments
      .map((seg, i) => ({ seg, i }))
      .filter((x) => x.seg.action === "keep");
    const pos = keepIdx.findIndex((x) => x.i === selection.index);
    const gapBefore = isKeep
      ? round2(s.start - (pos > 0 ? keepIdx[pos - 1].seg.end : 0))
      : 0;
    const gapAfter = isKeep
      ? round2((pos < keepIdx.length - 1 ? keepIdx[pos + 1].seg.start : srcDur) - s.end)
      : 0;
    // keep の境界は隣の keep とぶつからない範囲へクランプする(タイムラインの
    // トリムドラッグと同じ規則)。重なった keep は validate がエラーにして
    // 保存できなくなるので、「開始/終了をここへ」や生秒入力でも作らせない。
    // cut 記録は重なりを許すので収録の範囲だけ守る
    const lo = isKeep && pos > 0 ? keepIdx[pos - 1].seg.end : 0;
    const hi = isKeep && pos >= 0 && pos < keepIdx.length - 1
      ? keepIdx[pos + 1].seg.start
      : srcDur;
    // この区間で喋っている内容(transcript の重なるセグメント)。
    // keep/cut を判断する材料としてそのまま見せる(describe と同じ発想)
    const speech = transcript.segments
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.end > s.start + 0.05 && t.start < s.end - 0.05);
    return (
      <div className="insp">
        <InspHead
          kind={isKeep ? "映像クリップ" : "カットされた区間"}
          title={`${fmtTime(s.start)} 〜 ${fmtTime(s.end)}`}
          chips={[
            `長さ ${fmtTime(Math.max(0, s.end - s.start))}`,
            !isKeep ? "非表示" : null,
          ]}
        />
        {!isKeep && (
          <p className="dim hint" style={{ marginTop: 0 }}>
            この区間はいまカットされていて、動画に含まれていません。
          </p>
        )}
        {s.reason && <p className="dim hint">plan の理由: {s.reason}</p>}
        <TimingSection
          start={s.start}
          end={s.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) =>
            updateCutSeg(selection.index, {
              start: round2(Math.min(Math.max(v, lo), s.end - MIN_SPAN)),
            })
          }
          onEnd={(v) =>
            updateCutSeg(selection.index, {
              end: round2(Math.max(Math.min(v, hi), s.start + MIN_SPAN)),
            })
          }
          extra={
            isKeep && (gapBefore > 0.05 || gapAfter > 0.05) ? (
              <p className="dim hint" style={{ margin: "4px 0 0" }}>
                {gapBefore > 0.05 ? `直前に ${gapBefore.toFixed(1)}秒カット` : ""}
                {gapBefore > 0.05 && gapAfter > 0.05 ? " ・ " : ""}
                {gapAfter > 0.05 ? `直後に ${gapAfter.toFixed(1)}秒カット` : ""}
              </p>
            ) : null
          }
        />
        {speech.length > 0 && (
          <Section title="この区間の発言">
            <div className="speechList">
              {speech.map(({ t, i }) => (
                <div
                  key={i}
                  className="speechRow"
                  title="クリックでこの発言の位置へ再生ヘッドを移動"
                  onClick={() => seekToSrc(Math.max(t.start, s.start))}
                >
                  <span className="t mono">{fmtTime(t.start)}</span>
                  <span>{t.text}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Section title="">
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
        </Section>
      </div>
    );
  }

  /* ---------------- 素材(オーバーレイ) ---------------- */

  if (selection.kind === "overlays") {
    const ov = (overlays.overlays ?? [])[selection.index];
    if (!ov) return null;
    const isVideo = VIDEO_EXT_RE.test(ov.file);
    const box = ov.rect ?? { x: 0, y: 0, w: output.w, h: output.h };
    const volPct = Math.round((ov.volume ?? 0) * 100);
    const opacityPct = Math.round((ov.opacity ?? 1) * 100);
    const patch = (p: Partial<OverlayEntry>, key?: string) =>
      updateSpan("overlays", selection.index, p, key);
    return (
      <div className="insp">
        <MaterialHead
          kind={`素材 V${overlayTrack(ov)}`}
          file={ov.file}
          startFrom={ov.startFrom}
          chips={[
            `長さ ${fmtTime(Math.max(0, ov.end - ov.start))}`,
            ov.rect ? "部分配置" : "全画面",
          ]}
          materials={materials}
          onReplace={(f) => patch({ file: f })}
        />
        <TimingSection
          start={ov.start}
          end={ov.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) => patch({ start: v })}
          onEnd={(v) => patch({ end: v })}
        />
        <Section title="配置">
          <RectControl
            rect={ov.rect}
            file={ov.file}
            output={output}
            marginPx={marginPx}
            onChange={(rect) => patch({ rect })}
          />
          <FitControl
            fit={ov.fit ?? "contain"}
            file={ov.file}
            box={{ w: box.w, h: box.h }}
            onChange={(v) => patch({ fit: v })}
          />
          {ovTracks > 1 && (
            <div className="field">
              <label>トラック</label>
              <select
                value={overlayTrack(ov)}
                title="タイムラインの素材トラックと連動(前面/背面はトラックの並び順)"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  // 旧式の layer 指定はここで track へ移行する
                  patch({ track: n > 1 ? n : undefined, layer: undefined });
                }}
              >
                {Array.from({ length: ovTracks }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    素材 V{i + 1}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Section>
        <Section title="見た目と音">
          {isVideo && (
            <div className="field">
              <label>頭出し(秒)</label>
              <NumInput
                value={ov.startFrom ?? 0}
                title="素材ファイル内の再生開始位置。0=頭から"
                onCommit={(v) =>
                  v !== undefined &&
                  patch({ startFrom: v > 0 ? Math.max(0, round2(v)) : undefined })
                }
              />
            </div>
          )}
          {isVideo && (
            <SourceRangeBar
              file={ov.file}
              startFrom={ov.startFrom ?? 0}
              // 素材の実消費はカット後に実際に映る秒数(途中がカットされて
              // いれば区間長より短い)。元収録の区間長で描くと「末尾で静止」を
              // 誤って警告する
              usedSec={round2(
                remapInterval(ov.start, ov.end, timeline).reduce(
                  (a, iv) => a + (iv.end - iv.start),
                  0,
                ),
              )}
            />
          )}
          {isVideo && (
            <div className="field">
              <label>音量</label>
              <PctSlider
                pct={volPct}
                max={200}
                title="素材の音量(0%=無音が既定。マイク音声・BGM はそのまま重なる)。書き出しにも効く"
                onChange={(pct) =>
                  patch(
                    { volume: pct > 0 ? pct / 100 : undefined },
                    `ov:${selection.index}:volume`,
                  )
                }
              />
            </div>
          )}
          <div className="field">
            <label>不透明度</label>
            <PctSlider
              pct={opacityPct}
              title="素材の透け具合(100%=不透明)"
              onChange={(pct) =>
                patch(
                  { opacity: pct < 100 ? pct / 100 : undefined },
                  `ov:${selection.index}:opacity`,
                )
              }
            />
          </div>
          <div className="field">
            <label>フェード(秒)</label>
            <NumInput
              value={ov.fadeInSec}
              allowEmpty
              placeholder="0"
              title="イン(表示区間の頭でふわっと出す。音量も連動)"
              onCommit={(v) =>
                patch({ fadeInSec: v !== undefined && v > 0 ? round2(v) : undefined })
              }
            />
            <NumInput
              value={ov.fadeOutSec}
              allowEmpty
              placeholder="0"
              title="アウト(表示区間の末尾でふわっと消す。音量も連動)"
              onCommit={(v) =>
                patch({ fadeOutSec: v !== undefined && v > 0 ? round2(v) : undefined })
              }
            />
          </div>
          {!isVideo && (
            <p className="dim hint" style={{ margin: 0 }}>
              画像素材です(音はありません)。音声込みで全面に出したいときは
              インサート(映像トラックへドロップ)を使います。
            </p>
          )}
        </Section>
        <Section title="">
          <button className="danger" onClick={() => removeSpan("overlays", selection.index)}>
            この素材を削除
          </button>
        </Section>
      </div>
    );
  }

  /* ---------------- ワイプ全画面 ---------------- */

  if (selection.kind === "wipeFull") {
    const sp = (overlays.wipeFull ?? [])[selection.index];
    if (!sp) return null;
    return (
      <div className="insp">
        <InspHead
          kind="ワイプ全画面"
          title={`${fmtTime(sp.start)} 〜 ${fmtTime(sp.end)}`}
          chips={[`長さ ${fmtTime(Math.max(0, sp.end - sp.start))}`]}
        />
        <p className="dim hint" style={{ marginTop: 0 }}>
          この区間はワイプ(カメラ)が画面全体に広がり、背景を隠します。
          出入りの遷移時間は設定(⌘,)の「ワイプ全画面の遷移」で変えられます。
        </p>
        <TimingSection
          start={sp.start}
          end={sp.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) => updateSpan("wipeFull", selection.index, { start: v })}
          onEnd={(v) => updateSpan("wipeFull", selection.index, { end: v })}
        />
        <Section title="">
          <button className="danger" onClick={() => removeSpan("wipeFull", selection.index)}>
            この区間を削除
          </button>
        </Section>
      </div>
    );
  }

  /* ---------------- ズーム ---------------- */

  if (selection.kind === "zoom") {
    const z = (overlays.zooms ?? [])[selection.index];
    if (!z) return null;
    return (
      <div className="insp">
        <InspHead
          kind="ズーム"
          title={`${fmtTime(z.start)} 〜 ${fmtTime(z.end)}`}
          chips={[`長さ ${fmtTime(Math.max(0, z.end - z.start))}`]}
        />
        <p className="dim hint" style={{ marginTop: 0 }}>
          画面の一部を拡大して見せます。かかるのはベース映像の背景レイヤーだけで、
          ワイプ・テロップ・素材オーバーレイ・挿入クリップは動きません。
        </p>
        <TimingSection
          start={z.start}
          end={z.end}
          timeline={timeline}
          getPlayheadSrc={getPlayheadSrc}
          seekToSrc={seekToSrc}
          onStart={(v) => updateZoom(selection.index, { start: v })}
          onEnd={(v) => updateZoom(selection.index, { end: v })}
        />
        <Section title="拡大範囲">
          <ZoomRectControl
            rect={z.rect}
            output={output}
            onChange={(rect) =>
              updateZoom(selection.index, { rect }, `zoom:${selection.index}:rect`)
            }
          />
        </Section>
        <Section title="遷移">
          <div className="field">
            <label>遷移(秒)</label>
            <NumInput
              value={z.easeSec}
              allowEmpty
              placeholder={String(DEFAULT_ZOOM_EASE_SEC)}
              title="区間の頭でズームイン・末尾でズームアウトする秒数。空欄=config の既定(render.zoom.easeSec)"
              onCommit={(v) => updateZoom(selection.index, { easeSec: v })}
            />
          </div>
        </Section>
        <Section title="">
          <button className="danger" onClick={() => removeZoom(selection.index)}>
            このズームを削除
          </button>
        </Section>
      </div>
    );
  }

  return null;
};

/* ================= 共通の部品 ================= */

/** アイデンティティヘッダー。何を選んでいるかを最初の1秒で答える */
const InspHead = ({
  kind,
  title,
  chips,
  thumb,
}: {
  kind: string;
  title: string;
  chips?: (string | null)[];
  thumb?: ReactNode;
}) => (
  <div className="inspHead">
    {thumb}
    <div className="inspHeadText">
      <span className="inspKind">{kind}</span>
      <span className="inspTitle" title={title}>
        {title}
      </span>
      {chips && (
        <span className="inspChips">
          {chips
            .filter((c): c is string => c !== null)
            .map((c) => (
              <span className="chip" key={c}>
                {c}
              </span>
            ))}
        </span>
      )}
    </div>
  </div>
);

/** セクション(小見出し+罫線)。title 空文字は罫線だけ(削除ボタン置き場) */
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="inspSec">
    {title !== "" && <h4>{title}</h4>}
    {children}
  </div>
);

/**
 * タイミングの共通表示。編集の本線はタイムラインのトリム/移動なので、
 * ここは「長さ・出力上の位置」の把握と「再生ヘッドに合わせる」精密操作に
 * 絞り、生の秒(元収録)は「詳細」に畳む。
 */
const TimingSection = ({
  start,
  end,
  timeline,
  getPlayheadSrc,
  seekToSrc,
  onStart,
  onEnd,
  extra,
}: {
  start: number;
  end: number;
  timeline: TimelineEntry[];
  /** 再生ヘッド位置の元収録の秒(カット外・挿入上は null)を返す。
   * クリック時に読む(活性は null かどうかだけ購読) */
  getPlayheadSrc: () => number | null;
  seekToSrc: (src: number) => void;
  onStart: (v: number) => void;
  onEnd: (v: number) => void;
  extra?: ReactNode;
}) => {
  const playheadOnClip = usePlayheadSelector(() => getPlayheadSrc() !== null);
  const parts = remapInterval(start, end, timeline);
  const visible = parts.length > 0;
  return (
    <Section title="タイミング">
      <div className="field">
        <label>長さ</label>
        <span className="mono">{fmtTime(Math.max(0, end - start))}</span>
        {visible ? (
          <span className="dim hint">
            出力 {fmtTime(parts[0].start)} 〜 {fmtTime(parts[parts.length - 1].end)}
          </span>
        ) : (
          <span className="warnText hint">カット内(表示されない)</span>
        )}
      </div>
      <div className="btnRow">
        <button
          disabled={!playheadOnClip}
          title={
            !playheadOnClip
              ? "再生ヘッドがカット外・挿入クリップ上にあるため使えません"
              : "開始を再生ヘッドの位置に合わせる"
          }
          onClick={() => {
            const p = getPlayheadSrc();
            if (p !== null) onStart(round2(Math.min(p, end - MIN_SPAN)));
          }}
        >
          開始をここへ
        </button>
        <button
          disabled={!playheadOnClip}
          title={
            !playheadOnClip
              ? "再生ヘッドがカット外・挿入クリップ上にあるため使えません"
              : "終了を再生ヘッドの位置に合わせる"
          }
          onClick={() => {
            const p = getPlayheadSrc();
            if (p !== null) onEnd(round2(Math.max(p, start + MIN_SPAN)));
          }}
        >
          終了をここへ
        </button>
        <button title="この区間の頭へ再生ヘッドを移動" onClick={() => seekToSrc(start)}>
          頭から再生
        </button>
      </div>
      {extra}
      <details className="inspDetails">
        <summary>詳細(元収録の秒)</summary>
        {/* 逆転・負値は validate がエラーにする(保存も止まる)ので、
            入力の時点でクランプする */}
        <div className="field">
          <label>開始</label>
          <NumInput
            value={start}
            onCommit={(v) =>
              v !== undefined && onStart(round2(Math.max(0, Math.min(v, end - MIN_SPAN))))
            }
          />
        </div>
        <div className="field">
          <label>終了</label>
          <NumInput
            value={end}
            onCommit={(v) => v !== undefined && onEnd(round2(Math.max(v, start + MIN_SPAN)))}
          />
        </div>
      </details>
    </Section>
  );
};

/** 素材のアイデンティティヘッダー(サムネイル+名前+メタ情報)と差し替え。
 * ファイルの差し替えは「配置とタイミングを保ったまま素材だけ変える」操作
 * (Premiere の Replace Footage 相当)なので、常設の select ではなく
 * ボタンからのピッカーにする */
const MaterialHead = ({
  kind,
  file,
  startFrom,
  chips,
  materials,
  onReplace,
}: {
  kind: string;
  file: string;
  /** 動画のサムネイルを頭出し位置のフレームにする(#t= フラグメント) */
  startFrom?: number;
  chips?: (string | null)[];
  materials: string[];
  onReplace: (file: string) => void;
}) => {
  const meta = useMaterialMeta(file);
  const isVideo = VIDEO_EXT_RE.test(file);
  const name = file.replace(/^materials\//, "");
  const [picking, setPicking] = useState(false);
  const metaText = [
    isVideo ? "動画" : "画像",
    meta?.width && meta?.height ? `${meta.width}x${meta.height}` : null,
    meta?.durationSec ? `実尺 ${fmtTime(meta.durationSec)}` : null,
  ]
    .filter(Boolean)
    .join(" ・ ");
  return (
    <>
      <InspHead
        kind={kind}
        title={name}
        chips={[metaText, ...(chips ?? [])]}
        thumb={
          isVideo ? (
            <video
              key={`${file}#${startFrom ?? 0}`}
              className="inspThumb"
              src={`media/${file}${startFrom ? `#t=${startFrom}` : ""}`}
              preload="metadata"
              muted
            />
          ) : (
            <img className="inspThumb" src={`media/${file}`} alt={name} />
          )
        }
      />
      <div className="btnRow" style={{ marginTop: 0 }}>
        <button
          className={picking ? "active" : ""}
          title="配置とタイミングを保ったまま素材ファイルだけを差し替える"
          onClick={() => setPicking((v) => !v)}
        >
          差し替え…
        </button>
      </div>
      {picking && (
        <div className="inspPicker">
          {materials.map((m) => (
            <button
              key={m}
              className={`pickItem${m === file ? " on" : ""}`}
              title={m}
              onClick={() => {
                setPicking(false);
                if (m !== file) onReplace(m);
              }}
            >
              {VIDEO_EXT_RE.test(m) ? (
                <video src={`media/${m}`} preload="metadata" muted />
              ) : (
                <img src={`media/${m}`} alt="" loading="lazy" />
              )}
              <span>{m.replace(/^materials\//, "")}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
};

/** フィット(contain/cover)。素材と表示領域の縦横比が同じなら差が出ないので
 * 無効化して理由を添える(意味のない選択肢を出さない) */
const FitControl = ({
  fit,
  file,
  box,
  onChange,
}: {
  fit: "contain" | "cover";
  file: string;
  box: { w: number; h: number };
  onChange: (v: "contain" | "cover") => void;
}) => {
  const meta = useMaterialMeta(file);
  const same =
    meta?.width && meta?.height
      ? Math.abs(meta.width / meta.height - box.w / box.h) < 0.02
      : false;
  return (
    <>
      <div className="field">
        <label>フィット</label>
        <Segmented
          value={fit}
          disabled={same}
          onChange={onChange}
          options={[
            {
              value: "contain",
              label: "全体を見せる",
              title: "contain: 素材全体が収まるように置く(余白が出る)",
            },
            {
              value: "cover",
              label: "埋める",
              title: "cover: 領域いっぱいに広げる(端が切れる)",
            },
          ]}
        />
      </div>
      {/* 無効理由はボタンと同じ行に押し込むと文字折れで潰れるので次の行に出す */}
      {same && (
        <p className="dim hint" style={{ margin: "-4px 0 9px" }}>
          縦横比が同じため差なし
        </p>
      )}
    </>
  );
};

/** 素材の表示領域(全画面 / rect 部分配置)。プリセット+数値微調整 */
const RectControl = ({
  rect,
  file,
  output,
  marginPx,
  onChange,
}: {
  rect: Region | undefined;
  file: string;
  output: { w: number; h: number };
  marginPx: number;
  onChange: (rect: Region | undefined) => void;
}) => {
  const meta = useMaterialMeta(file);
  const ar = meta?.width && meta?.height ? meta.width / meta.height : 16 / 9;
  const m = marginPx;
  /** 角配置のサイズ(横 42%、高さは素材の縦横比なり) */
  const cw = Math.round(output.w * 0.42);
  const ch = Math.round(cw / ar);
  const presets: { label: string; title: string; make: () => Region | undefined }[] = [
    { label: "全画面", title: "画面いっぱいに表示(rect 指定を解除)", make: () => undefined },
    {
      label: "左上",
      title: "左上に部分配置",
      make: () => ({ x: m, y: m, w: cw, h: ch }),
    },
    {
      label: "右上",
      title: "右上に部分配置",
      make: () => ({ x: output.w - m - cw, y: m, w: cw, h: ch }),
    },
    {
      label: "左下",
      title: "左下に部分配置",
      make: () => ({ x: m, y: output.h - m - ch, w: cw, h: ch }),
    },
    {
      label: "右下",
      title: "右下に部分配置",
      make: () => ({ x: output.w - m - cw, y: output.h - m - ch, w: cw, h: ch }),
    },
    {
      label: "左半分",
      title: "画面の左半分",
      make: () => ({ x: 0, y: 0, w: Math.round(output.w / 2), h: output.h }),
    },
    {
      label: "右半分",
      title: "画面の右半分",
      make: () => ({
        x: Math.round(output.w / 2),
        y: 0,
        w: Math.round(output.w / 2),
        h: output.h,
      }),
    },
    {
      label: "中央",
      title: "中央に大きめに配置",
      make: () => {
        const w = Math.round(output.w * 0.6);
        const h = Math.round(w / ar);
        return {
          x: Math.round((output.w - w) / 2),
          y: Math.round((output.h - h) / 2),
          w,
          h,
        };
      },
    },
  ];
  const patchRect = (p: Partial<Region>) => {
    const cur = rect ?? { x: 0, y: 0, w: output.w, h: output.h };
    onChange({ ...cur, ...p });
  };
  return (
    <>
      <div className="field">
        <label>表示領域</label>
        <div className="rectPresets">
          {presets.map((p) => (
            <button
              key={p.label}
              className={
                (p.label === "全画面" && !rect) ? "on" : undefined
              }
              title={p.title}
              onClick={() => onChange(p.make())}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {rect && (
        <>
          <div className="field">
            <label>X / Y</label>
            <NumInput
              value={rect.x}
              title="表示領域の左上 X(出力px)"
              onCommit={(v) => v !== undefined && patchRect({ x: Math.round(v) })}
            />
            <NumInput
              value={rect.y}
              title="表示領域の左上 Y(出力px)"
              onCommit={(v) => v !== undefined && patchRect({ y: Math.round(v) })}
            />
          </div>
          <div className="field">
            <label>幅 / 高さ</label>
            <NumInput
              value={rect.w}
              title="表示領域の幅(出力px)"
              onCommit={(v) => v !== undefined && patchRect({ w: Math.max(1, Math.round(v)) })}
            />
            <NumInput
              value={rect.h}
              title="表示領域の高さ(出力px)"
              onCommit={(v) => v !== undefined && patchRect({ h: Math.max(1, Math.round(v)) })}
            />
          </div>
          <p className="dim hint">
            プレビュー上で枠をドラッグして移動、四隅・辺のハンドルでリサイズできます
            (この区間が再生ヘッド上にあるとき)。
          </p>
        </>
      )}
    </>
  );
};

/** ズームの拡大範囲(rect)。overlays.overlays の RectControl と違い「全画面」は
 * 無い(rect は必須)。拡大率プリセット(中央 N 倍)+ 位置プリセット(4分割)+
 * 数値微調整。プレビュー上の枠ドラッグ・リサイズは MaterialOverlay を流用する
 * (App.tsx の LiveMaterialOverlay 経由) */
const ZoomRectControl = ({
  rect,
  output,
  onChange,
}: {
  rect: Region;
  output: { w: number; h: number };
  onChange: (rect: Region) => void;
}) => {
  const centeredScale = (scale: number): Region => {
    const w = Math.round(output.w / scale);
    const h = Math.round(output.h / scale);
    return { x: Math.round((output.w - w) / 2), y: Math.round((output.h - h) / 2), w, h };
  };
  const halfW = Math.round(output.w / 2);
  const halfH = Math.round(output.h / 2);
  const quadPresets: { label: string; title: string; make: () => Region }[] = [
    { label: "左上", title: "画面左上を2倍に拡大", make: () => ({ x: 0, y: 0, w: halfW, h: halfH }) },
    { label: "右上", title: "画面右上を2倍に拡大", make: () => ({ x: output.w - halfW, y: 0, w: halfW, h: halfH }) },
    { label: "左下", title: "画面左下を2倍に拡大", make: () => ({ x: 0, y: output.h - halfH, w: halfW, h: halfH }) },
    { label: "右下", title: "画面右下を2倍に拡大", make: () => ({ x: output.w - halfW, y: output.h - halfH, w: halfW, h: halfH }) },
  ];
  const patchRect = (p: Partial<Region>) => onChange({ ...rect, ...p });
  const scale = output.w / rect.w;
  return (
    <>
      <div className="field">
        <label>拡大率</label>
        <div className="rectPresets">
          {[2, 3, 4].map((s) => (
            <button key={s} title={`画面中央を${s}倍に拡大`} onClick={() => onChange(centeredScale(s))}>
              中央 {s}倍
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>位置</label>
        <div className="rectPresets">
          {quadPresets.map((p) => (
            <button key={p.label} title={p.title} onClick={() => onChange(p.make())}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>X / Y</label>
        <NumInput
          value={rect.x}
          title="拡大する矩形の左上 X(出力px)"
          onCommit={(v) => v !== undefined && patchRect({ x: Math.round(v) })}
        />
        <NumInput
          value={rect.y}
          title="拡大する矩形の左上 Y(出力px)"
          onCommit={(v) => v !== undefined && patchRect({ y: Math.round(v) })}
        />
      </div>
      <div className="field">
        <label>幅 / 高さ</label>
        <NumInput
          value={rect.w}
          title="拡大する矩形の幅(出力px)。scale = 出力幅 / 幅 が一意に決まる(倍率は書けない)"
          onCommit={(v) => v !== undefined && patchRect({ w: Math.max(1, Math.round(v)) })}
        />
        <NumInput
          value={rect.h}
          title="拡大する矩形の高さ(出力px)"
          onCommit={(v) => v !== undefined && patchRect({ h: Math.max(1, Math.round(v)) })}
        />
      </div>
      <p className="dim hint">
        現在の拡大率: {scale.toFixed(2)}倍。プレビュー上で枠をドラッグして移動、
        四隅・辺のハンドルでリサイズできます(この区間が再生ヘッド上にあるとき)。
      </p>
    </>
  );
};

/** 素材ファイルのどこを使っているかのバー(頭出し+使用尺 vs 実尺)。
 * 使用尺が実尺を超える分は「最後のフレームで静止」になることも示す */
const SourceRangeBar = ({
  file,
  startFrom,
  usedSec,
}: {
  file: string;
  startFrom: number;
  usedSec: number;
}) => {
  const meta = useMaterialMeta(file);
  if (!meta?.durationSec) return null;
  const total = meta.durationSec;
  const a = (Math.min(startFrom, total) / total) * 100;
  const b = (Math.min(startFrom + usedSec, total) / total) * 100;
  const over = startFrom + usedSec > total + 0.05;
  return (
    <div className="field">
      <label>使用範囲</label>
      <div
        className="srcRange"
        title={
          `素材 ${fmtTime(total)} のうち ${fmtTime(Math.min(startFrom, total))}〜` +
          `${fmtTime(Math.min(startFrom + usedSec, total))} を使用` +
          (over ? "(足りない分は最後のフレームで静止)" : "")
        }
      >
        <div
          className="srcRangeUse"
          style={{ left: `${a}%`, width: `${Math.max(1, b - a)}%` }}
        />
      </div>
      {over && <span className="warnText hint">末尾で静止</span>}
    </div>
  );
};

/** テロップの実効スタイルのサンプル(本編と同じ描き方: 縁取りは下層の
 * text-stroke、座布団は外側の帯)。大きさは読める程度に縮めた目安で、
 * 実寸の確認はプレビューに任せる */
const CaptionSample = ({ text, eff }: { text: string; eff: CaptionStyle }) => {
  const fontSize = eff.fontSizePx ?? 44;
  const size = Math.max(14, Math.min(30, fontSize * 0.45));
  const ratio = size / fontSize;
  const color = eff.color ?? CAPTION_DEFAULT_COLOR;
  const outline = eff.outlineColor ?? CAPTION_DEFAULT_OUTLINE;
  const hasStroke = outline !== "none" && outline !== "transparent";
  const line = text.trim().split("\n")[0] || "テロップ";
  const stack = (
    <div
      style={{
        position: "relative",
        fontFamily: eff.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
        fontSize: size,
        fontWeight: eff.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {hasStroke && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            color: outline,
            WebkitTextStroke: `${size * 0.25}px ${outline}`,
          }}
        >
          {line}
        </span>
      )}
      <span style={{ position: "relative", color }}>{line}</span>
    </div>
  );
  const bg = eff.background;
  const padX = Math.round((bg?.paddingPx ?? Math.round(fontSize * 0.35)) * ratio);
  return (
    <div
      className="capSample"
      title="実際の合成と同じ描き方のサンプル(大きさは目安。実寸はプレビューで確認)"
    >
      {bg ? (
        <div
          style={{
            backgroundColor: bg.color,
            padding: `${Math.round(padX * 0.5)}px ${padX}px`,
            borderRadius: Math.round((bg.radiusPx ?? 8) * ratio),
          }}
        >
          {stack}
        </div>
      ) : (
        stack
      )}
    </div>
  );
};

/* ================= 複数テロップの一括編集 ================= */

const BatchCaptionPanel = ({
  indices,
  transcript,
  overlays,
  capTracks,
  captionDefaults,
  updateCaptionsStyle,
  updateCaptionsTrack,
  removeCaptions,
}: {
  indices: number[];
  transcript: Transcript;
  overlays: Overlays;
  capTracks: number;
  captionDefaults: RenderProps["caption"];
  updateCaptionsStyle: (
    indices: number[],
    patch: Partial<CaptionStyle> | null,
    coalesceKey?: string,
  ) => void;
  updateCaptionsTrack: (indices: number[], track: number) => void;
  removeCaptions: (indices: number[]) => void;
}) => {
  const segs = indices
    .map((i) => transcript.segments[i])
    .filter((s): s is Transcript["segments"][number] => s !== undefined);
  /** 全選択で共通の値。mixed = 値がバラバラ(そのときだけ value は undefined)。
   * 「全件とも未指定(=標準で統一)」は mixed ではない点に注意 */
  const common = <T,>(
    get: (s: Transcript["segments"][number]) => T,
  ): { value: T | undefined; mixed: boolean } => {
    const vals = segs.map(get);
    const mixed = !vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]));
    return { value: mixed ? undefined : vals[0], mixed };
  };
  const sizeC = common((s) => s.style?.fontSizePx);
  const colorC = common((s) => s.style?.color);
  const weightC = common((s) => s.style?.fontWeight);
  const trackC = common((s) => captionTrack(s));
  return (
    <div className="insp">
      <InspHead kind="複数選択" title={`テロップ ${segs.length} 件`} />
      <p className="dim hint" style={{ marginTop: 0 }}>
        ⌘クリックで選択に追加/解除できます(タイムライン・テロップ一覧の両方)。
        ここでの変更は選択中のすべてのテロップに適用されます。
      </p>
      <Section title="スタイル(一括)">
        <div className="field">
          <label>サイズ(px)</label>
          <NumInput
            value={sizeC.value}
            allowEmpty
            // 「混在」は値が実際にバラバラのときだけ。全件未指定なら標準サイズ
            placeholder={sizeC.mixed ? "混在" : String(captionDefaults.fontSizePx)}
            title={
              sizeC.mixed
                ? "選択中のテロップでサイズがバラバラです。入力すると全件そろえ、空欄で標準に戻す"
                : "選択中の全テロップのフォントサイズ。空欄=標準"
            }
            onCommit={(v) =>
              updateCaptionsStyle(indices, {
                fontSizePx: v !== undefined ? Math.round(v) : undefined,
              })
            }
          />
        </div>
        <div className="field">
          <label>文字色</label>
          <input
            type="color"
            value={colorC.value ?? captionDefaults.color ?? CAPTION_DEFAULT_COLOR}
            title={colorC.mixed ? "いま色はバラバラです(変更すると全件そろえます)" : undefined}
            onChange={(e) =>
              updateCaptionsStyle(
                indices,
                { color: e.target.value },
                `capBatch:${indices.join(".")}:color`,
              )
            }
          />
        </div>
        <div className="field">
          <label>太さ</label>
          <select
            value={weightC.mixed ? "__mixed" : weightC.value ?? ""}
            onChange={(e) =>
              e.target.value !== "__mixed" &&
              updateCaptionsStyle(indices, {
                fontWeight: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          >
            {weightC.mixed && (
              <option value="__mixed" disabled>
                混在
              </option>
            )}
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
            checked={segs.every((s) => !!s.style?.background)}
            onChange={(e) =>
              updateCaptionsStyle(
                indices,
                e.target.checked
                  ? { background: { color: "#000000" }, outlineColor: "none" }
                  : { background: undefined, outlineColor: undefined },
              )
            }
          />
        </div>
        <div className="btnRow">
          <button
            title="選択中の全テロップの個別スタイル指定を消して標準に戻す"
            onClick={() => updateCaptionsStyle(indices, null)}
          >
            スタイルを標準に戻す
          </button>
        </div>
      </Section>
      {capTracks > 1 && (
        <Section title="トラック(一括)">
          <div className="field">
            <label>トラック</label>
            <select
              value={trackC.value ?? ""}
              onChange={(e) =>
                e.target.value !== "" &&
                updateCaptionsTrack(indices, Number(e.target.value))
              }
            >
              {trackC.value === undefined && <option value="">混在</option>}
              {Array.from({ length: capTracks }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {captionTrackName(i + 1, overlays, capTracks)}
                </option>
              ))}
            </select>
          </div>
        </Section>
      )}
      <Section title="">
        <button className="danger" onClick={() => removeCaptions(indices)}>
          選択中の {segs.length} 件を削除
        </button>
      </Section>
    </div>
  );
};

/* ================= ショートモードのテロップ編集(位置/スタイルのみ) ================= */

/**
 * ショートモードで選択中のテロップの編集パネル。本編の単体テロップ編集
 * (上の巨大なブロック)とは別コンポーネントに分けてある(D6: 既存の
 * 本編パスは1バイトも変えない)。文言・タイミングは transcript(本編と共有)
 * へ、位置・スタイルは常にトラック単位で当該ショートの captionTracks へ書く
 * (per-segment 上書きは持たない。D2)。
 */
const ShortCaptionPanel = ({
  s,
  index,
  overlays,
  capTracks,
  activeShort,
  captionDefaults,
  stdCaptionPos,
  output,
  marginPx,
  timeline,
  getPlayheadSrc,
  seekToSrc,
  updateCaption,
  removeCaption,
  setShortCaptionTrackDefault,
}: {
  s: Transcript["segments"][number];
  index: number;
  overlays: Overlays;
  capTracks: number;
  activeShort: Short | null;
  captionDefaults: RenderProps["caption"];
  stdCaptionPos: CaptionPos;
  output: { w: number; h: number };
  marginPx: number;
  timeline: TimelineEntry[];
  getPlayheadSrc: () => number | null;
  seekToSrc: (src: number) => void;
  updateCaption: (
    i: number,
    patch: Partial<Transcript["segments"][number]>,
    coalesceKey?: string,
  ) => void;
  removeCaption: (i: number) => void;
  setShortCaptionTrackDefault: (
    track: number,
    patch: {
      pos?: CaptionPos | null;
      style?: CaptionStyle | null;
      anchor?: "center" | "topLeft" | null;
    },
  ) => void;
}) => {
  const track = captionTrack(s);
  const trackDef = (activeShort?.captionTracks ?? []).find((t) => t.track === track);
  const anchor = trackDef?.anchor ?? "center";
  const eff: CaptionPos =
    trackDef?.x !== undefined && trackDef?.y !== undefined
      ? { x: trackDef.x, y: trackDef.y }
      : stdCaptionPos;
  const base: CaptionStyle = {
    fontSizePx: captionDefaults.fontSizePx,
    color: captionDefaults.color ?? CAPTION_DEFAULT_COLOR,
    outlineColor: captionDefaults.outlineColor ?? CAPTION_DEFAULT_OUTLINE,
    fontFamily: captionDefaults.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
    fontWeight: captionDefaults.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
    ...trackDef?.style,
  };
  const posLabel = anchor === "topLeft" ? "テキスト左上" : "テキスト中心";
  const outlineOn = (base.outlineColor ?? CAPTION_DEFAULT_OUTLINE) !== "none";
  /** ショートのトラック標準スタイルを項目単位で更新(undefined で項目を消す) */
  const patchStyle = (p: Partial<CaptionStyle>) => {
    const st: CaptionStyle = { ...trackDef?.style, ...p };
    for (const k of Object.keys(st) as (keyof CaptionStyle)[]) {
      if (st[k] === undefined) delete st[k];
    }
    setShortCaptionTrackDefault(track, { style: Object.keys(st).length > 0 ? st : null });
  };
  /** 9点プリセット。テキストの実測寸法で画面端に marginPx を空けて置く
   * (本編の applyPosPreset と同じ式) */
  const applyPosPreset = (h: "l" | "c" | "r", v: "t" | "m" | "b") => {
    const { w: tw, h: th } = measureCaption(
      s.text,
      base.fontSizePx ?? captionDefaults.fontSizePx,
      base.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY,
      base.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT,
    );
    const m = marginPx;
    const x =
      anchor === "topLeft"
        ? h === "l" ? m : h === "c" ? Math.round((output.w - tw) / 2) : output.w - m - tw
        : h === "l"
          ? m + Math.round(tw / 2)
          : h === "c"
            ? Math.round(output.w / 2)
            : output.w - m - Math.round(tw / 2);
    const y =
      anchor === "topLeft"
        ? v === "t" ? m : v === "m" ? Math.round((output.h - th) / 2) : output.h - m - th
        : v === "t"
          ? m + Math.round(th / 2)
          : v === "m"
            ? Math.round(output.h / 2)
            : output.h - m - Math.round(th / 2);
    setShortCaptionTrackDefault(track, { pos: { x, y } });
  };
  return (
    <div className="insp">
      <InspHead
        kind={`${captionTrackName(track, overlays, capTracks)}・ショート用配置`}
        title={s.text.trim().split("\n")[0] || "(空のテロップ)"}
        chips={[`長さ ${fmtTime(Math.max(0, s.end - s.start))}`]}
      />
      <textarea
        className="capEdit"
        rows={3}
        value={s.text}
        onChange={(e) =>
          updateCaption(index, { text: e.target.value }, `caption:${index}:text`)
        }
      />
      <CaptionSample text={s.text} eff={base} />
      <TimingSection
        start={s.start}
        end={s.end}
        timeline={timeline}
        getPlayheadSrc={getPlayheadSrc}
        seekToSrc={seekToSrc}
        onStart={(v) => updateCaption(index, { start: v })}
        onEnd={(v) => updateCaption(index, { end: v })}
      />
      <Section title="配置(このショート専用・トラック単位)">
        <div className="posRow">
          <div className="posGrid" title="画面9箇所への配置プリセット(テキストの実測幅で余白を確保)">
            {(
              [
                ["l", "t", "↖"], ["c", "t", "↑"], ["r", "t", "↗"],
                ["l", "m", "←"], ["c", "m", "・"], ["r", "m", "→"],
                ["l", "b", "↙"], ["c", "b", "↓"], ["r", "b", "↘"],
              ] as const
            ).map(([h, v, label]) => (
              <button key={`${h}${v}`} onClick={() => applyPosPreset(h, v)}>
                {label}
              </button>
            ))}
          </div>
          <div className="posFields">
            <div className="field">
              <label>X / Y</label>
              <NumInput
                value={trackDef?.x}
                allowEmpty
                placeholder={String(eff.x)}
                title={`${posLabel}の出力px。空欄=このショートの既定位置`}
                onCommit={(v) =>
                  setShortCaptionTrackDefault(track, {
                    pos: v !== undefined ? { ...eff, x: Math.round(v) } : null,
                  })
                }
              />
              <NumInput
                value={trackDef?.y}
                allowEmpty
                placeholder={String(eff.y)}
                title={`${posLabel}の出力px。空欄=このショートの既定位置`}
                onCommit={(v) =>
                  setShortCaptionTrackDefault(track, {
                    pos: v !== undefined ? { ...eff, y: Math.round(v) } : null,
                  })
                }
              />
            </div>
            <div className="field">
              <label>座標の基準</label>
              <select
                value={anchor}
                title="このショートのトラック全体の座標の解釈"
                onChange={(e) =>
                  setShortCaptionTrackDefault(track, {
                    anchor: e.target.value === "topLeft" ? "topLeft" : null,
                  })
                }
              >
                <option value="center">テキスト中心</option>
                <option value="topLeft">左上(章タイトル向き)</option>
              </select>
            </div>
          </div>
        </div>
        {trackDef?.x !== undefined && (
          <p className="dim hint">
            現在位置: X {trackDef.x} / Y {trackDef.y}{" "}
            <button
              className="linkish"
              onClick={() => setShortCaptionTrackDefault(track, { pos: null })}
            >
              標準位置に戻す
            </button>
          </p>
        )}
      </Section>
      <Section title="スタイル(このショート専用・トラック単位)">
        <div className="field">
          <label>サイズ(px)</label>
          <NumInput
            value={trackDef?.style?.fontSizePx}
            allowEmpty
            placeholder={String(base.fontSizePx)}
            title="このショートでのフォントサイズ"
            onCommit={(v) => patchStyle({ fontSizePx: v !== undefined ? Math.round(v) : undefined })}
          />
        </div>
        <div className="field">
          <label>文字色</label>
          <input
            type="color"
            value={base.color}
            onChange={(e) => patchStyle({ color: e.target.value })}
          />
        </div>
        <div className="field">
          <label>縁取り</label>
          <input
            type="checkbox"
            checked={outlineOn}
            onChange={(e) =>
              patchStyle(
                e.target.checked
                  ? { outlineColor: undefined }
                  : { outlineColor: "none" },
              )
            }
          />
          {outlineOn && (
            <input
              type="color"
              value={base.outlineColor !== "none" ? base.outlineColor : CAPTION_DEFAULT_OUTLINE}
              onChange={(e) => patchStyle({ outlineColor: e.target.value })}
            />
          )}
        </div>
        <div className="field">
          <label>フォント</label>
          <select
            value={base.fontFamily ?? CAPTION_DEFAULT_FONT_FAMILY}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => patchStyle({ fontFamily: e.target.value })}
          >
            {FONT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>太さ</label>
          <select
            value={base.fontWeight ?? CAPTION_DEFAULT_FONT_WEIGHT}
            onChange={(e) => patchStyle({ fontWeight: Number(e.target.value) })}
          >
            <option value={400}>普通 (400)</option>
            <option value={700}>太字 (700)</option>
            <option value={900}>極太 (900)</option>
          </select>
        </div>
        {trackDef?.style && (
          <p className="dim hint">
            <button className="linkish" onClick={() => setShortCaptionTrackDefault(track, { style: null })}>
              スタイルを標準に戻す
            </button>
          </p>
        )}
      </Section>
      <Section title="">
        <button className="danger" onClick={() => removeCaption(index)}>
          このテロップを削除(本編にも反映されます)
        </button>
        <p className="dim hint">
          位置・スタイルはこのショート専用(shorts.json のトラック単位設定)。
          文言・タイミングは本編と共有の transcript.json に保存されます。
          プレビュー上のドラッグでも位置を動かせます。
        </p>
      </Section>
    </div>
  );
};

/* ================= ショートのプロパティ(profile / 承認 / 削除) =================
 * ヘッダーの shortBar(#5/T5, docs/decisions.md 2026-07-06 論点3)を移設したもの。
 * activeShort が非 null の間(未選択時のプロジェクト要約/ショート範囲選択時)に
 * 差し込む。profile 選択肢は将来 hasCamera でフィルタする前提で PROFILES から
 * 組み立てる箇所をここ1つに集約している(現状は絞り込みなし=全件) */
const ShortPropertiesSection = ({
  activeShort,
  updateActiveShort,
  removeShort,
}: {
  activeShort: Short;
  updateActiveShort: (updater: (s: Short) => Short) => void;
  removeShort: (name: string) => void;
}) => (
  <>
    <Section title="ショート">
      <div className="field">
        <label title="出力プロファイル(レイアウトプリセット)">プロファイル</label>
        <Segmented
          value={activeShort.profile ?? "vertical"}
          options={Object.keys(PROFILES).map((name) => ({ value: name, label: name }))}
          onChange={(name) => {
            updateActiveShort((s) => {
              const next = { ...s };
              if (name === "vertical") delete next.profile;
              else next.profile = name;
              return next;
            });
          }}
        />
      </div>
      <div className="field">
        <label title="このショート(縦動画)を人間が確認したか。render --short のゲート">
          承認済み
        </label>
        <input
          type="checkbox"
          checked={activeShort.approved}
          onChange={(e) => {
            const checked = e.target.checked;
            updateActiveShort((s) => ({ ...s, approved: checked }));
          }}
        />
      </div>
    </Section>
    <Section title="">
      <button
        className="danger"
        onClick={() => {
          if (
            window.confirm(
              `ショート「${activeShort.name}」を削除しますか?\n` +
                "shorts.json から削除され、元に戻せません(⌘Z も効きません)。",
            )
          ) {
            removeShort(activeShort.name);
          }
        }}
      >
        このショートを削除
      </button>
    </Section>
  </>
);

/* ================= 未選択時: プロジェクトの要約 ================= */

const ProjectPanel = ({
  cutplan,
  transcript,
  materials,
  srcDur,
  duration,
  project,
  shortSection,
}: {
  cutplan: CutPlan;
  transcript: Transcript;
  materials: string[];
  srcDur: number;
  duration: number;
  project: { dir: string; approved: boolean; bgmFile: string | null; bgmTracks: number };
  /** ショートモード中(activeShort が非 null)に上部へ差し込む「ショート」節。
   * 本編モードでは undefined(#5/T5: ヘッダーの shortBar を右インスペクタへ移設) */
  shortSection?: ReactNode;
}) => {
  const keepsN = cutplan.segments.filter((s) => s.action === "keep").length;
  const cutsN = cutplan.segments.length - keepsN;
  const cutPct = srcDur > 0 ? Math.max(0, Math.round((1 - duration / srcDur) * 100)) : 0;
  return (
    <div className="insp">
      <InspHead
        kind="プロジェクト"
        title={project.dir.replace(/\/+$/, "").split("/").pop() ?? project.dir}
      />
      {shortSection}
      <dl className="projRows">
        <dt>収録</dt>
        <dd className="mono">{fmtTime(srcDur)}</dd>
        <dt>出力</dt>
        <dd className="mono">
          {fmtTime(duration)} <span className="dim">(カット {cutPct}%)</span>
        </dd>
        <dt>映像クリップ</dt>
        <dd>
          {keepsN} <span className="dim">/ カット記録 {cutsN}</span>
        </dd>
        <dt>テロップ</dt>
        <dd>{transcript.segments.length}</dd>
        <dt>素材</dt>
        <dd>{materials.length}</dd>
        <dt>BGM</dt>
        <dd>
          {project.bgmTracks > 0 ? (
            `bgm.json(${project.bgmTracks} 区間)`
          ) : (
            project.bgmFile ?? <span className="dim">なし</span>
          )}
        </dd>
        <dt>承認</dt>
        <dd>
          {project.approved ? (
            "承認済み"
          ) : (
            <span className="warnText">未承認(ヘッダーの「書き出し ▾」から)</span>
          )}
        </dd>
      </dl>
      <p className="dim hint">
        タイムラインのクリップを選ぶと、ここで詳細を編集できます。
      </p>
      <details className="inspDetails">
        <summary>操作ガイド</summary>
        <div className="guide">
          <h5>タイムラインの見方</h5>
          <ul>
            <li>横軸はカット後の時間(書き出される動画と同じ時間軸)</li>
            <li>上のトラックほど前面に表示</li>
            <li>
              映像トラックの ▼ 印 = カットされた区間
              (クリックで選択 → プロパティから戻せる)
            </li>
          </ul>
          <h5>クリップの編集</h5>
          <ul>
            <li>ドラッグで移動 / 端をつまんでトリム / 上下のトラックへ移動</li>
            <li>トラックの空きをドラッグしてテロップ・素材を追加</li>
            <li>
              <kbd>⌘K</kbd> 再生ヘッド位置でクリップを分割
              (割ってから端をトリム / Delete でカット)
            </li>
            <li>
              <kbd>Delete</kbd> 削除(映像クリップはカットに倒れ、▼ 印から戻せる)
            </li>
            <li>テロップは ⌘クリックで複数選択 → 一括でスタイル変更</li>
          </ul>
          <h5>トラック</h5>
          <ul>
            <li>ラベルの上下ドラッグで並べ替え(重なり順が変わる)</li>
            <li>ラベル下端のドラッグで高さを変更(ダブルクリックで既定)</li>
            <li>
              目のアイコンでトラックを一時非表示(プレビュー専用。
              書き出しには影響せず、リロードで全トラック表示に戻る)
            </li>
          </ul>
          <h5>再生・表示</h5>
          <ul>
            <li>
              <kbd>Space</kbd> 再生 / <kbd>← →</kbd> 1フレーム送り(Shift で1秒)
            </li>
            <li>⌘+スクロール(ピンチ)でズーム、ダブルクリックで全体表示に戻る</li>
            <li>
              <kbd>⇧F</kbd> プレビュー最大化 / <kbd>F</kbd> フルスクリーン
            </li>
            <li>
              <kbd>⌘Z</kbd> 元に戻す / <kbd>⌘S</kbd> 保存 / <kbd>⌘,</kbd> 設定
            </li>
          </ul>
        </div>
      </details>
    </div>
  );
};

/** フォント種のプリセット(macOS 標準の日本語フォント)。
 * 値はそのまま CSS font-family として使う(設定モーダルとも共有) */
export const FONT_PRESETS: { label: string; value: string }[] = [
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
