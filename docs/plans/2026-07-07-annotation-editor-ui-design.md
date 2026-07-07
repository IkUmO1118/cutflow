# 設計書: GUI エディタに「注釈グラフィック(annotations)」編集UIを追加する

Opus 設計子が作成し、コーディネータ(親)が実コードと突き合わせて API 形状を検証済み。
実装は Sonnet 実装子が本書だけを見て行う。

## 0. 前提と全体方針

- **データモデルは既存**。`overlays.json` の `annotations?: Annotation[]`(判別子 `type`:
  `"arrow"` / `"box"` / `"spotlight"`)は `src/types.ts` 567-639 に実装済み。
  **id フィールドは無い**(blurs と違い採番対象外)。描画は `remotion/Main.tsx` /
  `renderProps.ts` に実装済み。**描画側・型定義・validate は一切触らない。editor/ のみに UI を足す。**
- **雛形は blurs UI**。blurs は「1トラック(`blur`)に blur/mosaic 2種を同居」させている。
  注釈も **1トラック(`annotation`)に arrow/box/spotlight 3種を同居**させる。
  box/spotlight は rect を持つので blurs と全く同じ `LiveMaterialOverlay` を流用。
  arrow は `from`/`to` の2点なので **新規オーバーレイ `ArrowOverlay` / `LiveArrowOverlay`**
  を作る(`MaterialOverlay` の scale/onDown 機構 + `CaptionOverlay` の点ドラッグが雛形)。
- **JSON を汚さない**。作成時・既定値一致時は該当キーを undefined で落とす
  (blurs の `addBlurSpan` / `updateBlur` パターン)。空配列は残さずキーごと削除。
- **不変条件**: `annotations` が空/未使用のプロジェクトは全コマンド・保存の出力がバイト等価。
  overlays に `annotations` キーを勝手に足さない。

### コーディネータ検証済みの API 形状(実装子はこれを信頼してよい)
- `updateBlur`(App.tsx 2376-2392)= `pushHistory(coalesceKey ?? null)` →
  `setOverlays((prev) => { ...; delete-undefined; return {...prev, blurs: arr} })`。
- `removeBlur`(2393-2403)= `setOverlays((prev) => 空なら {blurs をキーごと落とす} else {...prev, blurs: arr})` → `setSelection(null)`。
- `addBlurSpan`(1990-2004)= `if (!overlays || !proj) return; pushHistory(); rect は proj.output.w/h から; setOverlays({...overlays, blurs: list}); setSelection(...)`。
- `LiveMaterialOverlay`(3707-3740)= `usePlayheadSelector(getKey)` + `useMemo(() => getOverlays(playhead.get()), [key, getOverlays])`。`LiveArrowOverlay` はこれを厳密に写す。
- `addByKind`(2016-2024)/ `onCreate` の分岐スタイルは blur の1行を足すだけ。

### 触るファイル一覧
| ファイル | 変更 |
|---|---|
| `editor/client/model.ts` | SpanKind/AddKind/SelKind/TrackId に `"annotation"`、`TRACK_DEFS.annotation`、`buildTracks` に1行、`AnnotationPatch` 型を export |
| `editor/client/App.tsx` | selectionValid・warnings・span building・intervals/visible*/getVisible*・updateDrag 分岐・add/update/remove ハンドラ・onCreate/addByKind・removeSelected・LiveMaterialOverlay(rect)配線・LiveArrowOverlay 定義+配線・Inspector props・import |
| `editor/client/Inspector.tsx` | annotation パネル、`AnnotationRectControl`/`ArrowPointControl`/`NumField`/`ColorField`/`FillField`、props 追加、import |
| `editor/client/ArrowOverlay.tsx` | **新規**。arrow の2点ドラッグ編集レイヤー |
| `editor/client/index.html` | CSS: `.tlClip.annotation`、`.arrowOverlay`/`.arrowHandle`/`.arrowLine` |
| `editor/server.ts` | **確認のみ**(変更不要。§6 参照) |

---

## 1. モデル拡張(`editor/client/model.ts`)

### 1-1. 型 union に `"annotation"` を追加
- `SpanKind`(19行):`... | "zoom" | "blur" | "annotation"`
- `AddKind`(22行):`... | "zoom" | "blur" | "annotation"`
- `SelKind`(29-39行):union に `| "annotation"`
- `TrackId`(47-56行):`... | "blur" | "annotation" | "cut" | ...`
- `Selection` の index コメント(24-28行):「annotation は overlays.annotations の添字」を追記

### 1-2. `TRACK_DEFS.annotation`(blur の直後、94行の後ろ)
```ts
  annotation: {
    id: "annotation", label: "注釈", createKind: "annotation",
    hint:
      "注釈グラフィック区間(overlays.json の annotations)。矢印・囲み・" +
      "スポットライトで「ここを見ろ」を示す。ドラッグで区間を作成(既定は囲み)。" +
      "最前面(テロップより上)・ズームには追従せず出力px固定(ショートには継承されない)",
  },
```

### 1-3. `buildTracks`(152-170行)にトラックを1本挿入
`TRACK_DEFS.blur,`(166行)と `TRACK_DEFS.cut,` の間に:
```ts
    TRACK_DEFS.annotation,
```
並びは `zoom → blur → annotation → cut → bgm`。**ショートモード経路(`SHORT_TRACK_DEF`)には
注釈を混ぜない**(注釈はショートに継承されない)。buildTracks は本編モードのみで使われる。

### 1-4. `AnnotationPatch` 型を export(App と Inspector 両方から使う)
```ts
import type { AnnotationType, SpotlightShape, CaptionPos, Region } from "../../src/types.ts";
export type AnnotationPatch = {
  type?: AnnotationType;
  start?: number; end?: number;
  from?: CaptionPos; to?: CaptionPos; rect?: Region;
  color?: string; fill?: string;
  widthPx?: number; headPx?: number; radiusPx?: number;
  featherPx?: number; dim?: number;
  shape?: SpotlightShape;
};
```

---

## 2. App.tsx の差分

### 2-1. import
```ts
import { ArrowOverlay } from "./ArrowOverlay.tsx";
import type { OverlayArrow } from "./ArrowOverlay.tsx";
import type { AnnotationPatch } from "./model.ts";           // 既存 model import に足す
import type { Annotation } from "../../src/types.ts";        // 既存 types import に足す
```

### 2-2. selectionValid(165行 blur の直後)
```ts
  if (sel.kind === "annotation") return sel.index < (d.overlays.annotations ?? []).length;
```

### 2-3. warnings(748-766 blur ブロックの直後)
**ショート非継承警告だけ**を push する(validate.ts と parity。**annotation×zoom の重なりは
validate が警告しないのでここでも出さない**):
```ts
    if ((overlays.annotations?.length ?? 0) > 0 && (shorts?.shorts.length ?? 0) > 0) {
      warnings.push(
        "本編に注釈グラフィックがありますが、ショートには継承されません。" +
          "ショートにも指し示したい場合は別途足してください",
      );
    }
```
useMemo 依存配列(既に `overlays`/`shorts` を含む)は変更不要。

### 2-4. span building(1019-1029 blur forEach の直後)
```ts
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
```

### 2-5. intervals / visible* / getVisible*(1400-1434 blur ブロックの直後)
box/spotlight(rect)と arrow(点)を**排他フィルタで2系統**に分ける:
```ts
  const annotationIntervals = useMemo(() => {
    if (!overlays || shortMode) return [];
    return (overlays.annotations ?? []).map((a, i) => ({
      index: i, ivs: remapInterval(a.start, a.end, timeline),
    }));
  }, [overlays, timeline, shortMode]);

  const visibleAnnotationRectKey = useCallback((outT: number): string => {
    let key = "";
    for (const a of annotationIntervals) {
      const ann = (overlays?.annotations ?? [])[a.index];
      if (ann && ann.type !== "arrow" && a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${a.index},`;
    }
    return key;
  }, [annotationIntervals, overlays]);
  const getVisibleAnnotationRects = useCallback((outT: number): OverlayRect[] =>
    annotationIntervals.flatMap((a) => {
      const ann = (overlays?.annotations ?? [])[a.index];
      if (!ann || ann.type === "arrow") return [];
      if (!a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
      return [{ index: a.index, rect: ann.rect }];
    }), [annotationIntervals, overlays]);

  const visibleAnnotationArrowKey = useCallback((outT: number): string => {
    let key = "";
    for (const a of annotationIntervals) {
      const ann = (overlays?.annotations ?? [])[a.index];
      if (ann && ann.type === "arrow" && a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) key += `${a.index},`;
    }
    return key;
  }, [annotationIntervals, overlays]);
  const getVisibleAnnotationArrows = useCallback((outT: number): OverlayArrow[] =>
    annotationIntervals.flatMap((a) => {
      const ann = (overlays?.annotations ?? [])[a.index];
      if (!ann || ann.type !== "arrow") return [];
      if (!a.ivs.some((iv) => outT >= iv.start && outT < iv.end)) return [];
      return [{ index: a.index, from: ann.from, to: ann.to }];
    }), [annotationIntervals, overlays]);
```
`ann.type !== "arrow"` narrowing で `ann.rect`、`=== "arrow"` で `ann.from/to` が引ける。

### 2-6. updateDrag(move/trim)分岐(1859-1867 blur 分岐の直後)
```ts
    } else if (sel.kind === "annotation") {
      const arr = [...(ctx.overlays.annotations ?? [])];
      const sp = arr[sel.index];
      if (!sp) return;
      const t = retime(sp);
      if (!t) return;
      arr[sel.index] = { ...sp, ...t };
      setOverlays({ ...ctx.overlays, annotations: arr });
    }
```
`retime` の実引数・戻り値は blur 分岐(1859-1867)と同一。`{ ...sp, ...t }` は start/end 上書きのみ。

### 2-7. `addAnnotationSpan`(addBlurSpan 1990-2004 の後)。既定は box:
```ts
  const addAnnotationSpan = (start: number, end: number) => {
    if (!overlays || !proj) return;
    pushHistory();
    const w = Math.round(proj.output.w / 3);
    const h = Math.round(proj.output.h / 4);
    const rect = { x: Math.round((proj.output.w - w) / 2), y: Math.round((proj.output.h - h) / 2), w, h };
    const list: Annotation[] = [...(overlays.annotations ?? []), { type: "box", start, end, rect }];
    setOverlays({ ...overlays, annotations: list });
    setSelection({ kind: "annotation", index: list.length - 1 });
  };
```

### 2-8. addByKind / onCreate
- `addByKind`(2016-2024):`else if (kind === "annotation") addAnnotationSpan(start, end);`
- `onCreate`(2026-2047):blur 分岐(2038-2039)の後に
  ```ts
      } else if (track === "annotation") {
        addByKind("annotation", round2(s), round2(e));
  ```

### 2-9. updateAnnotation / removeAnnotation(updateBlur 2376 / removeBlur 2393 の後)
union は緩い `AnnotationPatch` で受け、delete-undefined 機構に type 切替も乗せる:
```ts
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
      const { annotations: _drop, ...rest } = prev;
      return arr.length === 0 ? rest : { ...rest, annotations: arr };
    });
    setSelection(null);
  };
```

### 2-10. removeSelected(2488 blur の後)
```ts
    else if (selection.kind === "annotation") removeAnnotation(selection.index);
```

### 2-11. LiveMaterialOverlay(box/spotlight rect)+ LiveArrowOverlay 配線(3263-3271 blur の後)
```tsx
              {/* 注釈(box/spotlight)の rect 枠。効果は Player が描画済み=編集枠だけ */}
              <LiveMaterialOverlay
                width={built.props.width} height={built.props.height}
                getKey={visibleAnnotationRectKey} getOverlays={getVisibleAnnotationRects}
                selection={selection?.kind === "annotation" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "annotation", index: i })}
                onRectChange={(i, rect) => updateAnnotation(i, { rect }, `annotation:${i}:drag`)}
              />
              {/* 注釈(arrow)の2点編集枠。透明ハンドル+参考線だけ=二重掛けしない */}
              <LiveArrowOverlay
                width={built.props.width} height={built.props.height}
                getKey={visibleAnnotationArrowKey} getArrows={getVisibleAnnotationArrows}
                selection={selection?.kind === "annotation" ? selection.index : null}
                onSelect={(i) => setSelection({ kind: "annotation", index: i })}
                onChange={(i, patch, coalesceKey) => updateAnnotation(i, patch, coalesceKey)}
              />
```
両レイヤーに同じ `selection.index` を渡すが、visible 集合が type で排他なので二重枠にならない。

`LiveArrowOverlay` は `LiveMaterialOverlay`(3707-3740)の隣に定義(同型):
```tsx
const LiveArrowOverlay = ({ width, height, getKey, getArrows, selection, onSelect, onChange }: {
  width: number; height: number;
  getKey: (outT: number) => string;
  getArrows: (outT: number) => OverlayArrow[];
  selection: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: AnnotationPatch, coalesceKey?: string) => void;
}) => {
  const key = usePlayheadSelector(getKey);
  const arrows = useMemo(() => getArrows(playhead.get()), [key, getArrows]);
  return (
    <ArrowOverlay width={width} height={height} arrows={arrows}
      selection={selection} onSelect={onSelect} onChange={onChange} />
  );
};
```

### 2-12. Inspector への props(既存 `<Inspector` 呼び出し、updateBlur/removeBlur の隣)
```tsx
              updateAnnotation={updateAnnotation}
              removeAnnotation={removeAnnotation}
```

---

## 3. 新規 `editor/client/ArrowOverlay.tsx`(arrow 2点ドラッグ)

雛形は `MaterialOverlay.tsx`(scale 変換・window pointer リスナ・dragging state)+
`CaptionOverlay.tsx`(点ドラッグ・clamp)。効果は Player が描くので、この層は
**透明ハンドル2つ + 破線の参考線 + 参考矢尻**だけを SVG で出す(二重掛けしない)。

### 3-1. 公開型
```ts
export interface OverlayArrow { index: number; from: CaptionPos; to: CaptionPos; }
```

### 3-2. スケール変換(MaterialOverlay 60-62 と同一)
```ts
const scale = box.w > 0 && box.h > 0 ? Math.min(box.w / width, box.h / height) : 0;
const dx = (box.w - width * scale) / 2;
const dy = (box.h - height * scale) / 2;
```
出力px→画面px は `screen = d? + comp * scale`。ドラッグ逆変換は `Δcomp = Δscreen / scale`。

### 3-3. 構造
- ルート `<div className="arrowOverlay" ref={ref}>`(ResizeObserver で box を測る。MaterialOverlay 49-57 を複製)。
- 中に `<svg>` を1枚。各 arrow について:
  - **参考線** `<line className="arrowLine">`(from→to 画面座標。破線・`pointer-events: stroke`=線本体ドラッグ=平行移動)。
  - **参考矢尻** `<polygon>`(to 側に小三角。装飾・`pointer-events: none`)。
  - **ハンドル** `<circle className="arrowHandle">`(from/to。**選択中の arrow だけ**表示。MaterialOverlay 157-158 に倣う。`pointer-events: all`)。
- SVG 全体 `pointer-events: none`、要素ごとに `all`/`stroke` を付ける(非選択部分はクリックを奪わない)。

### 3-4. ドラッグ(MaterialOverlay.onDown 110-137 の window リスナ方式)
- **from ハンドル**: `onSelect(index)` → drag 中 `onChange(index, { from: clampPos(from0 + Δcomp) }, 'annotation:${index}:drag')`。
- **to ハンドル**: 同様に `{ to: ... }`。
- **線本体**: from0/to0 に同じ Δ を足して `{ from, to }`(平行移動)。
- clamp は `clamp(round(v), 0, width/height)`(CaptionOverlay 準拠)。
- **退化防止**: Δ 適用後 `Math.hypot(to.x-from.x, to.y-from.y) < 4` なら適用しない(直前値を返す)。
- pointerdown で `e.preventDefault(); e.stopPropagation();`、`setDragging(true)`。

### 3-5. props
```tsx
export const ArrowOverlay = ({ width, height, arrows, selection, onSelect, onChange }: {
  width: number; height: number; arrows: OverlayArrow[];
  selection: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: AnnotationPatch, coalesceKey?: string) => void;
}) => { /* ... */ };
```
`AnnotationPatch` は `model.ts` から import。`CaptionPos`/`Region` は `src/types.ts` から。

### 3-6. CSS(`editor/client/index.html`、`.matBox`/`.capBox` の近く)
```css
  .arrowOverlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .arrowOverlay.dragging { cursor: grabbing; }
  .arrowOverlay svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .arrowLine { stroke: rgba(96,165,250,0.7); stroke-width: 2; stroke-dasharray: 6 4; fill: none; pointer-events: stroke; cursor: grab; }
  .arrowHandle { fill: rgba(96,165,250,0.9); stroke: #fff; stroke-width: 1.5; pointer-events: all; cursor: grab; }
  .arrowHandle:hover { fill: var(--accent, #60a5fa); }
```

---

## 4. Inspector.tsx の差分

### 4-1. import
- types.ts から:`Annotation`, `AnnotationType`, `SpotlightShape`, `CaptionPos`, `Region` と既定値定数
  (`DEFAULT_ANNOTATION_COLOR`, `DEFAULT_ARROW_WIDTH_PX`, `DEFAULT_ARROW_HEAD_PX`,
   `DEFAULT_BOX_WIDTH_PX`, `DEFAULT_BOX_RADIUS_PX`, `DEFAULT_SPOTLIGHT_DIM`,
   `DEFAULT_SPOTLIGHT_FEATHER_PX`, `DEFAULT_SPOTLIGHT_SHAPE`)。
- model.ts から `AnnotationPatch`。
- 既存 `NumInput` / `Segmented` / `PctSlider` / `splitColor` / `joinColor` はそのまま使う
  (存在は実装子が確認。zoom easeSec 欄・blur パネル・caption background 欄が使用例)。

### 4-2. Inspector props(updateBlur/removeBlur の隣)
```ts
  updateAnnotation: (i: number, patch: AnnotationPatch, coalesceKey?: string) => void;
  removeAnnotation: (i: number) => void;
```

### 4-3. annotation パネル(blur パネル 1612-1683 の後、`return null` 1685 の前)
type 切替は必須ジオメトリを補完し旧 type 固有キーを undefined で落とす。全文:
```tsx
  if (selection.kind === "annotation") {
    const a = (overlays.annotations ?? [])[selection.index];
    if (!a) return null;
    const i = selection.index;
    const kindLabel = a.type === "arrow" ? "矢印" : a.type === "spotlight" ? "スポットライト" : "囲み";

    const changeType = (next: AnnotationType) => {
      if (next === a.type) return;
      if (next === "arrow") {
        const r = "rect" in a ? a.rect : null;
        const from = r ? { x: r.x, y: r.y } : { x: 0, y: 0 };
        const to = r ? { x: r.x + r.w, y: r.y + r.h } : { x: 100, y: 100 };
        updateAnnotation(i, {
          type: "arrow", from, to,
          rect: undefined, fill: undefined, radiusPx: undefined,
          widthPx: undefined, shape: undefined, dim: undefined, featherPx: undefined,
        });
      } else {
        let rect: Region;
        if ("rect" in a) rect = a.rect;
        else {
          const x = Math.min(a.from.x, a.to.x), y = Math.min(a.from.y, a.to.y);
          const w = Math.max(20, Math.abs(a.to.x - a.from.x));
          const h = Math.max(20, Math.abs(a.to.y - a.from.y));
          rect = { x, y, w, h };
        }
        updateAnnotation(i, {
          type: next, rect,
          from: undefined, to: undefined, headPx: undefined, widthPx: undefined,
          ...(next === "box"
            ? { shape: undefined, dim: undefined, featherPx: undefined }
            : { fill: undefined, radiusPx: undefined }),
        });
      }
    };

    return (
      <div className="insp">
        <InspHead kind={kindLabel} title={`${fmtTime(a.start)} 〜 ${fmtTime(a.end)}`}
          chips={[`長さ ${fmtTime(Math.max(0, a.end - a.start))}`]} />
        <p className="dim hint" style={{ marginTop: 0 }}>
          画面上の一点・矩形を指し示して「ここを見ろ」を作ります。最前面(テロップより上)に
          描かれ、ズームには追従せず出力px固定。硬い ON/OFF(遷移なし)。ショートには継承されません。
        </p>
        <TimingSection start={a.start} end={a.end} timeline={timeline}
          getPlayheadSrc={getPlayheadSrc} seekToSrc={seekToSrc}
          onStart={(v) => updateAnnotation(i, { start: v })}
          onEnd={(v) => updateAnnotation(i, { end: v })} />
        <Section title="種別">
          <Segmented value={a.type} onChange={(v: AnnotationType) => changeType(v)}
            options={[
              { value: "arrow", label: "矢印", title: "arrow: from→to へ矢印" },
              { value: "box", label: "囲み", title: "box: 矩形の枠(任意で塗り)" },
              { value: "spotlight", label: "スポット", title: "spotlight: 矩形以外を暗くする" },
            ]} />
        </Section>

        {a.type === "arrow" ? (
          <Section title="始点 / 終点">
            <ArrowPointControl from={a.from} to={a.to}
              onChange={(patch) => updateAnnotation(i, patch, `annotation:${i}:pt`)} />
            <p className="dim hint">
              プレビュー上で始点・終点の丸をドラッグして調整できます(この区間が再生ヘッド上にあるとき)。
            </p>
          </Section>
        ) : (
          <Section title={a.type === "spotlight" ? "明るく残す範囲" : "囲む範囲"}>
            <AnnotationRectControl rect={a.rect}
              onChange={(rect) => updateAnnotation(i, { rect }, `annotation:${i}:rect`)} />
          </Section>
        )}

        {a.type === "arrow" && (
          <Section title="見た目">
            <ColorField label="色" value={a.color ?? DEFAULT_ANNOTATION_COLOR}
              onChange={(c) => updateAnnotation(i, { color: c === DEFAULT_ANNOTATION_COLOR ? undefined : c }, `annotation:${i}:color`)} />
            <NumField label="線の太さ" value={a.widthPx} placeholder={DEFAULT_ARROW_WIDTH_PX}
              onCommit={(v) => updateAnnotation(i, { widthPx: v })} />
            <NumField label="矢尻サイズ" value={a.headPx} placeholder={DEFAULT_ARROW_HEAD_PX}
              onCommit={(v) => updateAnnotation(i, { headPx: v })} />
          </Section>
        )}
        {a.type === "box" && (
          <Section title="見た目">
            <ColorField label="枠の色" value={a.color ?? DEFAULT_ANNOTATION_COLOR}
              onChange={(c) => updateAnnotation(i, { color: c === DEFAULT_ANNOTATION_COLOR ? undefined : c }, `annotation:${i}:color`)} />
            <NumField label="枠の太さ" value={a.widthPx} placeholder={DEFAULT_BOX_WIDTH_PX}
              onCommit={(v) => updateAnnotation(i, { widthPx: v })} />
            <NumField label="角丸" value={a.radiusPx} placeholder={DEFAULT_BOX_RADIUS_PX}
              onCommit={(v) => updateAnnotation(i, { radiusPx: v })} />
            <FillField value={a.fill}
              onChange={(fill) => updateAnnotation(i, { fill }, `annotation:${i}:fill`)} />
          </Section>
        )}
        {a.type === "spotlight" && (
          <Section title="見た目">
            <div className="field">
              <label>形状</label>
              <Segmented value={a.shape ?? DEFAULT_SPOTLIGHT_SHAPE}
                onChange={(v: SpotlightShape) => updateAnnotation(i, { shape: v === DEFAULT_SPOTLIGHT_SHAPE ? undefined : v })}
                options={[
                  { value: "rect", label: "矩形", title: "rect(既定)" },
                  { value: "ellipse", label: "楕円", title: "ellipse" },
                ]} />
            </div>
            <div className="field">
              <label>外側の暗さ</label>
              <PctSlider pct={Math.round((a.dim ?? DEFAULT_SPOTLIGHT_DIM) * 100)}
                title="0=効果なし〜100=真っ黒。省略時 60%(既定)"
                onChange={(pct) => updateAnnotation(i,
                  { dim: pct === Math.round(DEFAULT_SPOTLIGHT_DIM * 100) ? undefined : pct / 100 },
                  `annotation:${i}:dim`)} />
            </div>
            <NumField label="縁のぼかし" value={a.featherPx} placeholder={DEFAULT_SPOTLIGHT_FEATHER_PX}
              onCommit={(v) => updateAnnotation(i, { featherPx: v })} />
            {(a.shape ?? DEFAULT_SPOTLIGHT_SHAPE) === "rect" && (
              <NumField label="角丸" value={a.radiusPx} placeholder={0}
                onCommit={(v) => updateAnnotation(i, { radiusPx: v })} />
            )}
          </Section>
        )}

        <Section title="">
          <button className="danger" onClick={() => removeAnnotation(i)}>この注釈を削除</button>
        </Section>
      </div>
    );
  }
```

### 4-4. 小部品(Inspector.tsx 内、`BlurRectControl` 2189 の近く)
- **`AnnotationRectControl`**: `BlurRectControl`(2189-2232)を複製し hint を注釈向けに調整(rect x/y/w/h を `NumInput` で編集)。
- **`ArrowPointControl`**: from/to の x/y を `NumInput` で編集し `onChange(patch: {from?|to?})`:
  ```tsx
  const ArrowPointControl = ({ from, to, onChange }: {
    from: CaptionPos; to: CaptionPos;
    onChange: (patch: { from?: CaptionPos; to?: CaptionPos }) => void;
  }) => (
    <>
      <div className="field">
        <label>始点 X / Y</label>
        <NumInput value={from.x} title="矢印の始点 X(出力px)"
          onCommit={(v) => v !== undefined && onChange({ from: { ...from, x: Math.round(v) } })} />
        <NumInput value={from.y} title="矢印の始点 Y(出力px)"
          onCommit={(v) => v !== undefined && onChange({ from: { ...from, y: Math.round(v) } })} />
      </div>
      <div className="field">
        <label>終点 X / Y</label>
        <NumInput value={to.x} title="矢印の終点(矢尻)X(出力px)"
          onCommit={(v) => v !== undefined && onChange({ to: { ...to, x: Math.round(v) } })} />
        <NumInput value={to.y} title="矢印の終点(矢尻)Y(出力px)"
          onCommit={(v) => v !== undefined && onChange({ to: { ...to, y: Math.round(v) } })} />
      </div>
    </>
  );
  ```
  ※ `NumInput` の実シグネチャ(`onCommit` の引数が `number | undefined` か等)は実装子が
  BlurRectControl/zoom 欄の使用例で確認し、それに合わせる。
- **`NumField`**: `{ label, value, placeholder, onCommit }`。zoom easeSec 欄と同型
  (`<NumInput value allowEmpty placeholder={String(placeholder)} onCommit>` を `.field`/`<label>` で包む)。
  **placeholder と一致した値は undefined を渡してキー削除**(JSON を汚さない)。空欄も undefined。
- **`ColorField`**: `<input type="color">`(Inspector の caption color と同じ)を `.field`/`<label>` で包む。
  既定色一致時の undefined 判定は呼び出し側で実施済み。
- **`FillField`**(box の塗り。任意 + alpha):caption background の `splitColor`/`joinColor` を流用。
  トグル OFF → `onChange(undefined)`(キー削除)、ON → 最初は半透明色(例 `"rgba(255,59,48,0.25)"`)。
  ON 時は `type="color"`(hex)+ `PctSlider`(alpha)を `joinColor(hex, alpha)` で組み立てる。

---

## 5. Timeline.tsx / CSS

**ロジック変更は不要**。`className={`tlClip ${clip.kind}...`}` で kind がそのまま CSS クラスになるので、
`kind: "annotation"` は自動で `.tlClip.annotation`。span building(§2-4)と buildTracks(§1-3)で
トラック行にクリップが並ぶ。

**CSS だけ追加**(`editor/client/index.html`、blur の tlClip 色の後):
```css
  .tlClip.annotation { background: #b91c1c; top: 5px; bottom: 5px; }
```
実装子確認:annotation トラックが空きドラッグで区間作成できる / ショートモードで annotation トラックが出ない。

---

## 6. 不変条件(バイト等価)

1. `annotations` 未使用時:buildTracks に空トラック1本が増えるだけ。保存 JSON に影響しない。
   `addAnnotationSpan` が呼ばれたときだけ `annotations` が付く。
2. **`server.ts` は変更不要**。`saveProject`(678-703)の overlays 再構築は
   `{ ...body.overlays, overlays, inserts, wipeFull, hideCaption, zooms, blurs, captionTracks }` で、
   `annotations` は明示リストに無く**先頭 `...body.overlays` で素通し**される(id 無しなので正しい)。
   **`annotations` を `ensureIds` のリストへ絶対に足さない**(足すと存在しない id を注入しバイト等価を壊す)。
3. `removeAnnotation` は最後の1件で `annotations` キーごと削除。
4. 作成は `{ type:"box", start, end, rect }` のみ。各フィールドは既定一致で undefined→キー削除。
   type 切替は旧 type 固有キーを undefined で落とす。
5. draftDiffers / History は overlays 全体比較に自動的に含まれる(追加コード不要)。

---

## 7. 検証観点(親=コーディネータが実測)

1. `npx tsc --noEmit`:`AnnotationPatch` merge の `as unknown as Annotation`、
   `ann.type !== "arrow"` narrowing、`"rect" in a` narrowing、type stripping 制約
   (enum/namespace/パラメータプロパティ/デコレータ不使用)。
2. `npm test`:既存緑維持(annotations は types/validate 不変なので schema/agentsMd は無関係)。
3. **エディタ headless 起動**(サーバ再起動必須。muted video freeze 注意):
   - annotation トラック空きドラッグ→「囲み(box)」中央矩形が1件。Player 実効果+青編集枠。
   - Inspector で box→arrow→spotlight→box を一巡し、毎回ジオメトリ補完・旧 type 固有キー消去を保存 JSON で確認。
   - arrow の from/to ハンドルをプレビュー上でドラッグ→ from/to 更新。線本体ドラッグで平行移動。
   - box/spotlight の rect をプレビュー枠でドラッグ/リサイズ→ rect 更新。
   - 見た目フィールド(色・太さ・角丸・fill・shape・dim・feather・head)を触り、既定値に戻すとキーが消える。
   - 削除→最後の1件で `annotations` キーごと消える。undo/redo が drag/フィールドで効く。
   - ショートモードで annotation トラックが出ない・注釈がショートプレビューに乗らない。
   - 本編に注釈+shorts で warnings に「ショートには継承されません」が1本(zoom 重なりでは出ない)。
4. **バイト等価**:注釈を作って全削除→ `overlays.json` に git diff なし。未使用プロジェクトを開いて保存→ diff なし。

### 実装子が壊しやすい箇所
- **`annotations` を `ensureIds` に足さない**(server.ts 696-698 の blurs の隣に足したくなるが id 無し)。
- **rect/arrow オーバーレイの排他フィルタ**(`ann.type === "arrow"`)を getVisible の両方で必ず入れる(片方漏らすと二重枠)。
- **type 切替の必須フィールド補完**(arrow=from/to、box/spotlight=rect)。補完漏れは validate エラー/描画不能。
- **退化矢印(from===to)**:ArrowOverlay ドラッグは最小距離クランプ、数値入力はそのまま(保存時 error で気づかせる)。
- **coalesce キー**:canvas ドラッグ=`annotation:${i}:drag`、Inspector=`annotation:${i}:<field>`。混ぜると undo 粒度が崩れる。
- **buildTracks 挿入位置**:ショートモード経路(SHORT_TRACK_DEF)に混ぜない。
