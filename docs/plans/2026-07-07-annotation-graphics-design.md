# 注釈グラフィック層(矢印/囲み/スポットライト)設計

対象: NLE ロードマップ NEXT「注釈グラフィックが皆無」(effort L)。
診断 `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の指摘:

> 注釈グラフィックが皆無(矢印・囲み・スポットライト・図形) — 描画プリミティブが
> 無く、ズーム以外に「ここを見ろ」を示せない。dev screencast の核。

狙い: `overlays.json` に、画面上の一点/矩形を指し示す**注釈グラフィック**の
描画プリミティブを足す。最小セット = **矢印(arrow)・囲み(box)・
スポットライト(spotlight)**。dev screencast で「ここを見ろ」を表現する中核。

## 一次資料と踏襲する型

**blurs(領域ぼかし/モザイク)を強く踏襲する。** blurs が確立した型:

- `overlays.json` の配列 / `start`・`end`(元収録秒)/ `rect`(出力px)
- 独立レイヤー(`layerOrder` に載らない固定順)
- zoom 非追従(出力px固定)/ 挿入で断片分割(`remapInterval` per-fragment)
- ショート非継承(shorts の overlays 白リストに含めない=自動除外)
- 遷移なしの硬い ON/OFF
- 既定は types.ts の定数(`DEFAULT_BLUR_*`)、renderProps で解決
- 純関数は `src/lib/blur.ts`、描画は `remotion/Main.tsx`、検査は
  `src/stages/validate.ts`、props 型は `remotion/props.ts`、テストは
  `test/blur.test.ts` / `test/renderProps.test.ts` / `test/validate.test.ts`

注釈はこの blurs の実装箇所を**並行して**触る。zoom(`src/lib/zoom.ts`)も
「rect・区間・レイヤー適用範囲の限定」の前例として参照する。

## スコープ規律(この Feature でやらない)

- **最小3種だけ**: arrow / box / spotlight。自由図形・多角形・テキスト付き
  吹き出しは Later。
- **汎用キーフレーム基盤・トラッキング(動く対象への追従)・パスアニメは
  やらない**。時刻は blurs と同じ静的 `start`/`end` 区間のみ。
- **登場/退場アニメ(フェード等)は v1 では入れない**(論点5。硬い ON/OFF)。
- **config.yaml への設定追加はしない**(論点4。既定は types 定数)。
- **GUI エディタ対応はやらない**。まず JSON + render + frames + validate で
  完結させる。エディタのトラック UI・プレビュー上のドラッグ編集は別 Feature
  (blurs / zooms が辿ったのと同じ順序。まず描画基盤、UI は後追い)。

---

## 論点ごとの決定(decisions)

### 決定1: スキーマ形状 — union 配列 `annotations[]`

**採用**: 単一配列 `annotations[]` に判別子 `type: "arrow" | "box" | "spotlight"`
の discriminated union でまとめる。

- 種別ごとに別配列(`arrows[]` / `boxes[]` / `spotlights[]`)にしない。
  - blurs は単一種別だったので配列1本で済んだが、注釈は複数種別。別配列に
    すると `overlays.json` のトップレベルキーが3つ増え、`layerOrder` や描画順・
    validate の分岐も3系統に割れる。union 1本なら追加キーは1つ、描画・検査・
    renderProps 写像も1ループで済み、将来の種別追加(Later)も型に1枝
    足すだけになる。
  - 並び順(配列内の順序)がそのまま同一レイヤー内の重なり順になる(後勝ち=
    後ろが上)。種別をまたいだ重なりも配列順で自然に決まる。
- TS の type stripping 制約に抵触しない: interface の `extends`・union type・
  判別子フィールドはすべて型レベルの構成で実行時に消える(enum・namespace・
  パラメータプロパティは使わない)。

座標は既存型を**再利用**する: 矩形は `Region`(`{x,y,w,h}`)、点は `CaptionPos`
(`{x,y}`)。どちらも出力px(テロップ `pos`・zooms/blurs `rect` と同座標系)。

各種別の必須/任意フィールド(既定は決定4):

| type | 必須 | 任意(既定は types 定数) |
|---|---|---|
| `arrow` | `from`(CaptionPos)・`to`(CaptionPos) | `color`・`widthPx`(線の太さ)・`headPx`(矢尻の大きさ) |
| `box` | `rect`(Region) | `color`(線色)・`widthPx`(線幅)・`radiusPx`(角丸)・`fill`(塗り色。省略で塗りなし) |
| `spotlight` | `rect`(Region) | `shape`(`"rect"`(既定)/`"ellipse"`)・`dim`(外側の暗さ0〜1)・`featherPx`(縁のぼかし)・`radiusPx`(`shape:"rect"` の角丸) |

共通: `start`・`end`(元収録秒)。**登場/退場アニメは持たない**(決定5)。

### 決定2: 描画レイヤーの位置 — 独立・最前面(テロップより上)

**採用**: `layerOrder` には**載せない**独立レイヤー。位置は**最前面**
(テロップ = `caption`/`cap<N>` より上)。描画は `layerOrder` の map の**後**、
`cutTransition`(dip-to-black)の**前**。

- blurs は「ベース映像の直上・素材/テロップの下」の独立固定レイヤーだった。
  注釈はその**逆側**、全レイヤーの最前面に置く。
  - 理由: 注釈は最も強い「ここを見ろ」の指示で、何にも隠されてはいけない。
    素材オーバーレイやテロップの下に潜ると指示の意味が壊れる。
- `layerOrder` に載せない理由: `layerOrder` は素材トラック(`ov<N>`)・テロップ
  トラック(`cap<N>`)・`wipe` という**可変個数のトラックの並べ替え**を表す
  仕組み。注釈は blurs/zoom と同じ「演出カテゴリ」で、トラック並べ替えの対象
  ではない。blurs が `layerOrder` の外にある設計と揃える(`LayerId` を増やさない)。
- `cutTransition` の黒フェードは注釈より上のまま(シーン転換は最上位)。BGM は
  視覚要素が無いので順序無関係。
- **トレードオフ(spotlight がテロップを暗くしうる)**: 最前面なので spotlight の
  暗幕はテロップにもかかる。ただしテロップは通常下部中央、spotlight の rect は
  画面内コンテンツを囲むのが普通で、重なりは稀。重なった場合に「フレーム全体を
  暗くしてそこだけ明るく」の一部としてテロップも暗くなるのは直感的に正しい
  挙動なので許容する(docs に明記)。テロップを常に読ませたい設計(注釈をテロップ
  の直下に置く)も可能だが、「矢印がテロップを指せない」等の副作用があり、
  「注釈は常に最前面」という単純なモデルを優先する。

### 決定3: 座標系と zoom 追従 — 出力px固定・zoom 非追従

**採用**: 出力px固定。zoom には追従しない(blurs と同じ)。

- 注釈は zoom の transform div の**外**(独立レイヤー)に描くので出力px固定。
- zoom 追従(矢印の端点・rect を `zoomTransformAt` で変換)は実装可能だが、
  「寄ってから指す」の一般用途では**追従しない方が自然**: ユーザーは `frames`
  で最終フレーム(zoom 適用後)を見て、そこに見えている位置へ注釈を置く。zoom
  hold 中はコンテンツが静止しているので、出力px注釈は正しい位置に載る。
- **zoom 重なり警告は出さない**(blurs との相違・意図的)。blurs は「秘匿情報が
  zoom でずれて露出する」ので警告が正当だった。注釈が zoom ease 中に一瞬ずれる
  のは見た目だけの過渡で、しかも「寄って指す」は主要ユースケース。警告はノイズ
  にしかならないので出さない。zoom ease(遷移)中に注釈がコンテンツと一瞬ずれる
  点だけ docs の注記に留める。

### 決定4: 色・スタイルの既定 — types 定数(config には置かない)

**採用**: 既定は `src/types.ts` の定数。config.yaml `render.annotation.*` は
**足さない**。per-item 上書きは各フィールドの任意指定で行う。

- blurs が `DEFAULT_BLUR_STRENGTH` / `DEFAULT_BLUR_TYPE` を types 定数に置いた
  のと揃える。config を足すのは caption 色/フォント・zoom easeSec のように
  「チャンネル横断で頻繁に変える既定」に限る方針。注釈の見た目は per-item が
  基本で、config 面(config.ts のスキーマ・設定画面 UI・proxy/renderKey の
  全域設定判定)を増やす価値が薄い。将来テーマ化したくなったら追加できる。
- **既定値は renderProps で解決**して `RenderProps.annotations` には具体値を
  焼き込む(blurs が `type`/`strength` を解決したのと同じ)。Main.tsx は
  フォールバックを持たず解決済み値をそのまま描く=解決ロジックを renderProps の
  純関数テストで固定できる。

定数(types.ts):

```ts
export const DEFAULT_ANNOTATION_COLOR = "#ff3b30";     // 鮮やかな赤(注釈の定番)
export const DEFAULT_ARROW_WIDTH_PX = 8;
export const DEFAULT_ARROW_HEAD_PX = 28;
export const DEFAULT_BOX_WIDTH_PX = 6;
export const DEFAULT_BOX_RADIUS_PX = 8;
export const DEFAULT_SPOTLIGHT_DIM = 0.6;              // 外側の暗さ(0=無効, 1=真っ黒)
export const DEFAULT_SPOTLIGHT_FEATHER_PX = 24;
export const DEFAULT_SPOTLIGHT_SHAPE: SpotlightShape = "rect";
```

### 決定5: アニメ — 入れない(硬い ON/OFF)

**採用**: v1 は blurs と同じ**遷移なしの硬い ON/OFF**。`CaptionAnim` も
`fadeInSec`/`fadeOutSec` も持たせない。

- 理由(スコープ規律): 硬い ON/OFF は blurs の確立済み前例で、renderProps 写像を
  blurs ブロックの 1:1 クローンにできる(挿入の first/last 断片へのフェード
  分配・per-frame opacity 計算・専用ヘルパー・そのテストがすべて不要)。「ここを
  見ろ」が瞬時に出るのは期待挙動で許容範囲。
- `CaptionAnim`(slide/pop)の流用は不適: あれはテキスト器の translate/scale
  前提で、矢印/囲み/スポットライトの意味論に合わない。
- 登場/退場フェードは **Later** に回す(必要になれば overlays 流の
  `fadeInSec`/`fadeOutSec` を後付けできる。今は入れない)。

### 決定6: validate 検査 — blurs と同型 + arrow 固有

blurs 検査ブロックを下敷きに、`overlays.json` の各 annotation を検査する。
`KNOWN` 配列に `"annotations"` を追加。

- `checkSpan`(start<end・尺内)は **warn を渡さずエラー**(blurs/zooms と同じ
  厳しさ)。
- `type` が `arrow`/`box`/`spotlight` 以外 → エラー。
- **arrow**:
  - `from`/`to` が `{x,y}` の数値でない → エラー。
  - `from` と `to` が同一点(`EPS` 以内)→ **エラー**(向きが定まらない退化矢印)。
  - `color` が空文字/非文字列 → エラー(checkStyle の色検査と同型)。
  - `widthPx`/`headPx` が正の数でない → エラー。
  - 端点が出力解像度の外 → **警告**(下記の共通方針)。
- **box / spotlight**:
  - `rect` が `{x,y,w,h}` の数値でない・`w`/`h` が正でない → エラー(blurs と同文)。
  - `rect` が出力解像度の外にはみ出す → **警告**(blurs はエラーだが注釈は警告。
    下記)。
  - box の `color`/`fill` は空文字/非文字列でエラー、`widthPx`/`radiusPx` は
    0未満でエラー。
  - spotlight の `shape` が `rect`/`ellipse` 以外 → エラー、`dim` が 0〜1 外 →
    エラー(opacity/strength の範囲検査と同型)、`featherPx`/`radiusPx` は
    0未満でエラー。
- **可視性**: 全体がカット区間内で表示されない → 警告(`visible()` 利用。blurs の
  「表示されません」と同文型)。
- **zoom 重なり警告は出さない**(決定3)。
- **ショート非継承警告**: `annotations` があり `shorts.json` に1件以上あれば
  警告(blurs の「本編に領域ぼかしがありますが…」と同型の一文)。

**はみ出しをエラーでなく警告にする理由**(blurs との相違): blurs のはみ出しは
「隠すべき秘匿が枠外=露出」で危険だからエラーだった。注釈のはみ出しはキャンバス
端で描画がクリップされるだけで render は壊れない(画面外から指す矢印など正当な
用途もある)。「動くが意図と違うかも=警告」の原則どおり警告に留め、render を
止めない。

### 決定7: 描画方式(Main.tsx)と renderProps 解決

**renderProps**(`buildRenderProps`): blurs の `blurSpans` ブロックの直後に
`annotationItems` ブロックを足す。blurs と 1:1 の構造:

```ts
const annotationItems = (overlays.annotations ?? []).flatMap((a) =>
  remapInterval(a.start, a.end, timeline).map((iv) =>
    resolveAnnotation(a, iv.start, iv.end)   // ← src/lib/annotation.ts の純関数
  ),
);
// ...
...(annotationItems.length > 0 ? { annotations: annotationItems } : {}),
```

- `resolveAnnotation` は種別ごとに既定を埋め、`start`/`end` を差し替えた
  **解決済み annotation**(具体値のみ)を返す純関数。
- 挿入で割れた断片は blurs と同じく断片ごとに独立エントリ(rect/端点は不変なので
  マージ不要)。カット内で全消えなら空 → キー自体が出ない(byte 等価)。

**Main.tsx**: `layerOrder` の map の後・`cutTransition` の前に、注釈レイヤーを
足す。本編経路のみ(`hasVideo && !props.layout`。ショート/縦は描かない=決定の
継承ポリシーと一致)。各 annotation は `t >= a.start && t < a.end` で硬く ON/OFF
(blurs と同じゲート)。zoom transform div の外なので出力px固定。

種別ごとの描画手段:

- **arrow — SVG**: フルスクリーンの `<svg style={{position:absolute, inset:0,
  width, height, overflow:"visible"}}>` に `<line>`(from→to、`stroke`=color、
  `strokeWidth`=widthPx、`strokeLinecap:"round"`)と、矢尻を `<polygon>` で
  描く。矢尻は marker 単位系の曖昧さを避け、`from`/`to`/`headPx` から頂点を
  **純関数 `arrowHeadPoints()`**(annotation.ts)で算出して固定する(テスト可能)。
  SVG は線と矢尻を鮮明に出す自然な手段。
- **box — div**: `position:absolute` の `<div>` を rect に置き、`border:
  ${widthPx}px solid ${color}`・`borderRadius: radiusPx`・`boxSizing:
  "border-box"`。`fill` があれば `backgroundColor: fill`。CSS だけで完結。
- **spotlight — SVG mask**: フルスクリーン `<svg>` に、黒(`fill:black
  fill-opacity:dim`)のフルスクリーン矩形を敷き、`<mask>` で rect の穴を開ける
  (`shape:"rect"` は `<rect rx=radiusPx>`、`ellipse` は `<ellipse>`)。`featherPx`
  は穴形状への `feGaussianBlur` で表現。矩形・楕円・縁ぼかしを1手法で統一でき
  headless Chrome でも決定論的にレンダーされる。

**frames は無改造**: frames は同じ `buildRenderProps` 経路で props を作り
`remotion/Main.tsx` をレンダーするので、注釈は `frames` に自動で映る(自己確認
可能)。`frames/index.json` のフィンガープリントは `overlays.json` の内容を含む
ので、注釈を編集して `frames` を撮り直さないと `validate`/`describe` が「古い」
警告を出す仕組みも自動で効く。frames.ts の変更は不要。

---

## スキーマ案(types.ts)

```ts
/** 注釈グラフィックの種別。判別子は type。将来 "line" 等を足す場合はここに
 * 1枝追加する(今はスコープ外)。src/types.ts の Annotation union と揃える */
export type AnnotationType = "arrow" | "box" | "spotlight";
export type SpotlightShape = "rect" | "ellipse";

/** 注釈グラフィック(overlays.json の annotations)。画面上の一点/矩形を
 * 指し示して「ここを見ろ」を作る描画プリミティブ。start/end は元収録の秒、
 * 座標はすべて出力px(テロップ pos・zooms/blurs rect と同座標系)。
 * 独立レイヤーで最前面(テロップより上)に描く。zoom には追従せず出力px固定。
 * 遷移は無い硬い ON/OFF。ショート(profile 経路)には継承されない
 * (座標が本編基準のため。shorts があると validate が警告する) */
export type Annotation = ArrowAnnotation | BoxAnnotation | SpotlightAnnotation;

interface AnnotationBase {
  /** 元収録の秒。start < end。挿入・カットの時刻写像はツールが行う */
  start: number;
  end: number;
}

/** 矢印。from から to へ引く線 + 矢尻。色・太さ・矢尻サイズは任意上書き */
export interface ArrowAnnotation extends AnnotationBase {
  type: "arrow";
  /** 始点(出力px) */
  from: CaptionPos;
  /** 終点=矢尻の向き先(出力px)。from と同一点は validate がエラー */
  to: CaptionPos;
  /** 線と矢尻の色(CSS カラー)。省略時 DEFAULT_ANNOTATION_COLOR */
  color?: string;
  /** 線の太さ(px)。省略時 DEFAULT_ARROW_WIDTH_PX */
  widthPx?: number;
  /** 矢尻の大きさ(px)。省略時 DEFAULT_ARROW_HEAD_PX */
  headPx?: number;
}

/** 囲み。rect の枠線。任意で塗り(fill)も置ける */
export interface BoxAnnotation extends AnnotationBase {
  type: "box";
  /** 囲む矩形(出力px) */
  rect: Region;
  /** 枠線の色(CSS カラー)。省略時 DEFAULT_ANNOTATION_COLOR */
  color?: string;
  /** 枠線の幅(px)。省略時 DEFAULT_BOX_WIDTH_PX */
  widthPx?: number;
  /** 角丸半径(px)。省略時 DEFAULT_BOX_RADIUS_PX */
  radiusPx?: number;
  /** 塗り色(CSS カラー。半透明の rgba() 推奨)。省略時は塗りなし(枠線だけ) */
  fill?: string;
}

/** スポットライト。rect 以外を暗くして注目を集める */
export interface SpotlightAnnotation extends AnnotationBase {
  type: "spotlight";
  /** 明るく残す矩形(出力px) */
  rect: Region;
  /** 明部の形状。省略時 "rect"("ellipse" で楕円) */
  shape?: SpotlightShape;
  /** 外側の暗さ(0〜1、0=無効・1=真っ黒)。省略時 DEFAULT_SPOTLIGHT_DIM */
  dim?: number;
  /** 縁のぼかし幅(px)。省略時 DEFAULT_SPOTLIGHT_FEATHER_PX */
  featherPx?: number;
  /** shape:"rect" の角丸半径(px)。省略時 DEFAULT_SPOTLIGHT_FEATHER_PX 相当は
   * 持たず、角丸なし相当の既定は下記定数。ellipse では無視 */
  radiusPx?: number;
}
```

`Overlays` に1フィールド追加(blurs の直後):

```ts
  /** 注釈グラフィック(矢印/囲み/スポットライト)。画面の一点/矩形を指し示す
   * 「ここを見ろ」の描画。独立レイヤーで最前面(テロップより上)。zoom 非追従の
   * 出力px固定。硬い ON/OFF。ショート(profile 経路)には継承されない
   * (座標が本編基準のため。shorts があると validate が警告する) */
  annotations?: Annotation[];
```

## props スキーマ案(remotion/props.ts)

renderProps が既定を解決した**具体値のみ**を運ぶ。空なら key を出さない
(byte 等価)。

```ts
export type ResolvedAnnotation =
  | { type: "arrow"; start: number; end: number;
      from: { x: number; y: number }; to: { x: number; y: number };
      color: string; widthPx: number; headPx: number }
  | { type: "box"; start: number; end: number; rect: Region;
      color: string; widthPx: number; radiusPx: number; fill?: string }
  | { type: "spotlight"; start: number; end: number; rect: Region;
      shape: "rect" | "ellipse"; dim: number; featherPx: number; radiusPx: number };

// RenderProps に追加:
  /** 注釈グラフィック(overlays.json の annotations。カット後の秒へ写像・
   * 既定解決済み)。最前面に出力px固定で描く。省略時(空)は現行の描画と
   * 完全に同じ。props.layout(ショート/縦)経路では描画しない(本編のみ) */
  annotations?: ResolvedAnnotation[];
```

## config スキーマ案

**追加なし**(決定4)。既定は types 定数のみ。

---

## タスク分解(1タスク=1コミット)

各タスク完了時にテスト緑・`npx tsc --noEmit` 通過を保つ。**不変条件**:
`annotations` 未指定時、render / frames / validate は**バイト等価**(props.json に
key が出ない・DOM 追加ゼロ・検査結果不変)。

### タスク1: 純関数ライブラリ `src/lib/annotation.ts` + テスト

- 触るファイル(新規): `src/lib/annotation.ts`。関数:
  - `resolveAnnotation(a: Annotation, start: number, end: number): ResolvedAnnotation`
    — 種別ごとに既定(`DEFAULT_ANNOTATION_*` 等)を埋め、start/end を差し替える。
  - `arrowHeadPoints(from, to, headPx): { p1, p2 }` — 矢尻ポリゴンの2つの
    バーブ頂点を from/to/headPx から算出(角度計算)。
- 触るファイル: `src/types.ts`(定数 `DEFAULT_ANNOTATION_*` と型 `Annotation`
  union・`AnnotationType`・`SpotlightShape` を先に追加。`Overlays.annotations` も
  ここで追加してよい=型だけなら未使用で無害)。`remotion/props.ts` に
  `ResolvedAnnotation` を追加(annotation.ts の返り値型として要る)。
- テスト(新規 `test/annotation.ts`): `resolveAnnotation` の既定埋め(3種)・
  per-item 上書き優先・start/end 差し替え。`arrowHeadPoints` の固定値(水平・
  垂直・斜めの矢印で頂点座標を数値固定。`blur.test.ts` の数値固定と同じ流儀)。
- 壊してはいけない挙動: 誰も呼ばない純追加なので既存挙動ゼロ影響。`tsc` 通過。

### タスク2: renderProps 写像 + テスト(props に annotations を載せる)

- 触るファイル: `src/lib/renderProps.ts`(`buildRenderProps`)。blurs の
  `blurSpans` 直後に `annotationItems` ブロックを足し、返り値へ
  `...(annotationItems.length > 0 ? { annotations: annotationItems } : {})`。
  import に `resolveAnnotation` を追加。
- テスト(`test/renderProps.test.ts`、blurs の各テストを下敷きに):
  - `annotations` 未指定 → props に `annotations` キーが出ない(既存 props と
    完全一致=byte 等価)。
  - arrow/box/spotlight 各1件が既定解決される(色・widthPx 等が定数で埋まる)。
  - per-item 上書きが既定より優先。
  - 1件が挿入で2断片に割れると2エントリ(同一 geometry・start/end だけ違う)。
  - カット内で全消え → `annotations` キーが出ない。
- 壊してはいけない挙動: blurs/zooms/overlays の既存 renderProps テストが全緑。
  空時 byte 等価。

### タスク3: validate 検査 + docs + テスト

- 触るファイル: `src/stages/validate.ts`。`KNOWN` に `"annotations"` 追加。
  overlays の blurs 検査ブロックの後ろに annotations 検査ブロックを足す
  (決定6の全項目)。ショート非継承警告・可視性警告も blurs と同型で。
  arrow の同一点エラー・種別別フィールド検査を追加。
- 触るファイル: `docs/usage.md`。overlays.json の表(44行目付近)に annotations を
  追記、演出セクションに **annotations** の箇条書き(blurs の直後)、例 JSON に
  `annotations` を1〜2件追加。CLAUDE.md の「どのファイルが何を決めるか」表の
  `overlays.json` 行にも annotations を一言足す(スキーマ変更の三点セット規約:
  types コメント=タスク1/2、validate=本タスク、docs=本タスク)。
- テスト(`test/validate.test.ts`): 妥当な arrow/box/spotlight でエラー0。
  退化矢印(from==to)エラー・不正 type エラー・`dim` 範囲外エラー・rect w/h
  非正エラー・はみ出し**警告**・shorts 併存の非継承**警告**・カット内不表示警告。
- 壊してはいけない挙動: 既存 validate テスト全緑。`annotations` 未指定の
  overlays は検査結果不変(未知キー警告が誤発火しないこと=`KNOWN` 追加の確認)。

### タスク4: Main.tsx 描画

- 触るファイル: `remotion/Main.tsx`。`layerOrder` の map(455–459行)の後・
  `cutTransition`(461行)の前に注釈レイヤーを足す。`hasVideo && !props.layout`
  ガードで本編のみ。各 annotation を `t >= start && t < end` で ON/OFF。
  - arrow: インライン `<svg>` に `<line>` + `<polygon>`(頂点は
    `arrowHeadPoints`)。
  - box: `<div>` に border/borderRadius/backgroundColor。
  - spotlight: `<svg>` + `<mask>`(rect は rx、ellipse は `<ellipse>`)+
    `feGaussianBlur`(featherPx)。
  - import に `arrowHeadPoints` を `src/lib/annotation.ts` から追加。
- テスト: Main.tsx は単体テスト対象外(描画は frames で目視確認)。手順:
  arrow/box/spotlight を1件ずつ入れた overlays.json で `frames --t` を撮り、
  最前面・出力px固定・種別の見た目を Read で確認。
- 壊してはいけない挙動: `annotations` 空時は要素を1つも出さない(DOM 完全一致=
  既存レンダー不変)。frames 経路は無改造で注釈が映る。ショート(`props.layout`)
  経路では描かれない。既存の blurs/zoom/caption/cutTransition の描画順・見た目
  不変。

### タスク5(任意・確認のみ): ショート非継承と frames 鮮度の実地確認

- コード変更なし。`render.ts`/`frames.ts` のショート経路が overlays を
  `{ captionTracks, colorFilter? }` に白リストしているため annotations は自動
  除外される(blurs と同じ)。念のため `frames --short` で注釈が出ないこと、
  `frames/index.json` が overlays 変更で stale 判定することを確認して doc 化。
  実質タスク3/4のテストに吸収できるなら独立コミット不要。

---

## 不変条件チェックリスト(実装子向け)

- [ ] `annotations` 無しの既存プロジェクトで `render.props.json` が1バイトも
      変わらない(renderProps の空時キー省略)。
- [ ] `annotations` 無しで `remotion/Main.tsx` の出力 DOM が不変(要素追加ゼロ)。
- [ ] `annotations` 無しで `validate` の errors/warnings/summary が不変。
- [ ] `frames` は無改造で注釈を描き、`frames/index.json` の overlays 鮮度判定が
      効く。
- [ ] ショート(`--short` / `render --shorts`)には注釈が出ない(白リストで自動
      除外)。
- [ ] `npx tsc --noEmit` 通過。type stripping 非対応構文(enum/namespace/
      パラメータプロパティ)を使っていない。
