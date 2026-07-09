# P2 キーフレーム基盤 実装設計書

*2026-07-09 / 実装担当: gpt-5.4 想定*

対象:

- `docs/reviews/2026-07-06-ai-native-nle-diagnosis-2026-07-08-update.html`
  の P2「キーフレーム基盤」
- 同レビューの「時間変化の基盤がボトルネック」という診断

この文書は、実装者が新しい仕様判断をせずに実装できることを優先する。曖昧な箇所では
「適当に補完」せず、本書の型、補間規則、時刻写像、エラー条件、実装順、テストケースを
そのまま採用する。

---

## 0. 結論

v1 では `overlays.json` の次の3種類に、共通形式の `keyframes` を追加する。

1. 素材オーバーレイ: `rect.x/y/w/h`、`opacity`
2. blur / mosaic: `rect.x/y/w/h`、`strength`
3. annotation:
   - arrow: `from.x/y`、`to.x/y`、`widthPx`、`headPx`
   - box: `rect.x/y/w/h`、`widthPx`、`radiusPx`
   - spotlight: `rect.x/y/w/h`、`dim`、`featherPx`、`radiusPx`

キーフレームは要素自身の `start` から `end` までの**元収録秒**で書く。
値は数値だけを線形補間し、区間ごとに `linear` / `ease-in` / `ease-out` /
`ease-in-out` / `hold` を選べる。

`zoom`、caption、wipe、color、素材 volume、insert、BGM、速度変更、パス補間は
v1 に含めない。共通評価器は後からそれらへ使える形にするが、同じ PR で移行しない。

---

## 1. 目的

### 1.1 ユーザー価値

- 素材を画面内で移動・拡大縮小・フェードできる。
- blur / mosaic を動く対象へ手動追従させられる。
- 矢印、囲み、スポットライトを時間とともに移動・拡大縮小できる。
- JSON、CLI、GUI、Remotion が同じ補間結果を使う。
- AI は数個のキーフレームを JSON に追加するだけで時間変化を指定できる。

### 1.2 技術的な目的

- 個別機能ごとの `smoothstep` 実装を増やさず、数値補間を純関数1箇所へ集約する。
- raw time と output time の変換を描画層から排除する。
- カットや insert をまたぐアニメーションを決定論的に扱う。
- キーフレーム未指定の既存プロジェクトの `render.props.json` と描画を変えない。

### 1.3 成功条件

- 同じ入力 JSON と同じ時刻から常に同じ数値が得られる。
- `frames`、Editor Player、最終 render が同じ `RenderProps` と評価器を使う。
- カットされた時間内のキーは描画に現れない。
- カット境界の左右で値が異なる場合、境界をまたいで補間しない。
- キーフレーム無しの既存 fixture の snapshot / render key が変わらない。
- `npm test` と `npm run typecheck` が通る。

---

## 2. 非対象

v1 では次を実装しない。

- 速度変更、リタイム、フリーズフレーム
- 自動トラッキング、オプティカルフロー
- Bezier の制御点をユーザーが編集するカスタム曲線
- 2次元の曲線パス、回転、3D transform
- 色、文字列、enum、boolean の補間
- caption の位置、サイズ、opacity のキーフレーム
- zoom の複数キーフレーム化
- wipe / camera、color filter、BGM、音量のキーフレーム
- insert クリップ内のローカル時刻を基準にしたキー
- 複数要素を束ねる親 transform
- keyframe 自体への stable ID
- keyframe 単位の `@id` apply 操作
- shorts への継承

特に速度変更は別設計とする。速度変更を先に混ぜると「元収録秒から出力秒への写像」が
非線形になり、本設計の検証範囲を超える。

---

## 3. 最優先の不変条件

### 3.1 後方互換

`keyframes` が無い要素は、現在と同じコードパス・同じ値で描画する。

- `buildRenderProps` は `keyframes` が無ければ解決済み keyframe 配列を props に載せない。
- `Main.tsx` は `keyframes` が無ければ現在の静的フィールドを直接使う。
- JSON serialization 時に空の `keyframes: []` を自動追加しない。
- GUI save で既存要素へ `keyframes` を勝手に追加しない。
- `render.key.json` の互換を守るため、空配列や既定値を props に増やさない。

### 3.2 時刻

- editable JSON の `keyframes[].at` は**元収録の秒**。
- `RenderProps` の `keyframes[].at` は**カット・insert 適用後の出力秒**。
- `Main.tsx` と共通評価器は出力秒だけを受け取る。
- `at` は要素の閉区間 `[start, end]` 内でなければならない。
- 表示判定は従来どおり半開区間 `[start, end)`。
- `at === end` は終端値を定義するため有効。ただし `t === end` のフレームは描画されない。

### 3.3 座標

座標は既存契約どおり出力 px。zoom には追従しない。shorts には継承しない。

### 3.4 補間対象

- 数値だけを補間する。
- `type`、`shape`、`color`、`fill`、`fit`、`file` は静的値のまま。
- 1つの要素の type を途中で変えない。
- `w` / `h`、線幅など正であるべき値は補間後も正になるよう、全キーを validate する。

### 3.5 安全性

blur / mosaic は秘匿用途があるため、キーフレームが不正なら warning で無視せず
`validate` error にする。範囲外へ動く blur も error にする。

---

## 4. JSON 仕様

### 4.1 共通形

各対象要素に optional な `keyframes` を追加する。

```ts
export type KeyframeEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "hold";

export interface Keyframe<TValues> {
  /** 元収録の秒。親要素の [start,end] 内 */
  at: number;
  /** このキーから次の同プロパティのキーへ向かう区間の easing。既定 linear */
  easing?: KeyframeEasing;
  /** この時刻で値を固定するプロパティ。最低1キー必須 */
  values: TValues;
}
```

`easing` は**そのキーから次のキーへ向かう区間**へ適用する。最後のキーの `easing` は
評価されないが、JSON と GUI の編集を単純にするため許可する。

### 4.2 値の型

```ts
export interface MaterialKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  opacity?: number;
}

export interface BlurKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  strength?: number;
}

export interface ArrowKeyframeValues {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  widthPx?: number;
  headPx?: number;
}

export interface BoxKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  widthPx?: number;
  radiusPx?: number;
}

export interface SpotlightKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  dim?: number;
  featherPx?: number;
  radiusPx?: number;
}
```

`rect: {x,y,w,h}` のような入れ子を keyframe 内で使わない。疎な更新で
`x` だけを動かせること、共通評価器を `Record<string, number>` として単純に保てること、
JSON Schema の `min/max` を各値へ直接付けられることが理由である。

### 4.3 親要素への追加

```ts
// Overlays["overlays"][number]
keyframes?: Keyframe<MaterialKeyframeValues>[];

// BlurRegion
keyframes?: Keyframe<BlurKeyframeValues>[];

// 各 Annotation union member に別々の型で追加
// ArrowAnnotation
keyframes?: Keyframe<ArrowKeyframeValues>[];
// BoxAnnotation
keyframes?: Keyframe<BoxKeyframeValues>[];
// SpotlightAnnotation
keyframes?: Keyframe<SpotlightKeyframeValues>[];
```

### 4.4 JSON 例

素材を左下から右上へ動かしながら拡大・フェードする例:

```json
{
  "overlays": [
    {
      "id": "mat_a1b2c3",
      "start": 12,
      "end": 18,
      "file": "materials/demo.png",
      "rect": { "x": 80, "y": 700, "w": 480, "h": 270 },
      "opacity": 1,
      "keyframes": [
        {
          "at": 12,
          "easing": "ease-out",
          "values": { "x": 80, "y": 700, "w": 360, "h": 203, "opacity": 0 }
        },
        {
          "at": 13,
          "easing": "ease-in-out",
          "values": { "x": 80, "y": 700, "w": 480, "h": 270, "opacity": 1 }
        },
        {
          "at": 18,
          "values": { "x": 1360, "y": 80 }
        }
      ]
    }
  ]
}
```

動く API キーを mosaic で追う例:

```json
{
  "blurs": [
    {
      "id": "bl_d4e5f6",
      "start": 20,
      "end": 25,
      "rect": { "x": 900, "y": 220, "w": 520, "h": 72 },
      "type": "mosaic",
      "strength": 0.7,
      "keyframes": [
        { "at": 20, "easing": "linear", "values": { "x": 900, "y": 220 } },
        { "at": 22.5, "easing": "hold", "values": { "x": 900, "y": 360 } },
        { "at": 24, "values": { "x": 420, "y": 360, "w": 600 } }
      ]
    }
  ]
}
```

---

## 5. 補間の厳密な意味

### 5.1 プロパティごとの独立 channel

`values` は疎でよい。評価時はプロパティごとに、そのプロパティを持つキーだけを抽出する。

例:

```json
[
  { "at": 10, "values": { "x": 0, "opacity": 0 } },
  { "at": 11, "values": { "opacity": 1 } },
  { "at": 12, "values": { "x": 100 } }
]
```

- `x` channel は `(10, 0) -> (12, 100)`
- `opacity` channel は `(10, 0) -> (11, 1)`

`at=11` の `x` は 50。`at=12` の opacity は 1。

### 5.2 先頭・末尾

- 対象プロパティの最初のキーより前は、最初の値を hold する。
- 最後のキーより後は、最後の値を hold する。
- そのプロパティのキーが1つも無ければ、親要素の静的な基準値を返す。
- 静的値から最初のキーへ自動補間しない。
- 静的値へ最後のキーから自動的に戻さない。

開始時に静的値から別値へ動かしたい場合は、`at: start` のキーを明示する。
この規則により「暗黙の synthetic keyframe」を作らず、JSON だけで結果を説明できる。

### 5.3 同一区間の計算

時刻 `t` を囲む同プロパティのキーを `left`、`right` とする。

```ts
raw = (t - left.at) / (right.at - left.at);
p = easingProgress(left.easing ?? "linear", clamp01(raw));
value = left.value + (right.value - left.value) * p;
```

曲線:

```ts
linear:      p
ease-in:     p * p
ease-out:    1 - (1 - p) * (1 - p)
ease-in-out: p * p * (3 - 2 * p) // smoothstep
hold:        0
```

`hold` は `right.at` の直前まで `left.value`、`t >= right.at` で `right.value`。

### 5.4 浮動小数点

- 評価器内部では丸めない。
- DOM style に渡す直前にも整数化しない。
- raw/output 時刻写像だけは既存 `timeline.ts` と同じく小数第2位へ丸める。
- snapshot test は小数の完全一致ではなく `1e-9` tolerance を使う。
- JSON へ保存する GUI 値は最大小数第2位。ドラッグ中のメモリ値は丸めなくてよい。

### 5.5 静的な基準値

`buildRenderProps` で既定値を解決し、評価器へ必ず具体値を渡す。

| 対象 | property | 基準値 |
|---|---|---|
| material | x/y/w/h | `rect`。rect 無しは `{x:0,y:0,w:outputWidth,h:outputHeight}` |
| material | opacity | `opacity ?? 1` |
| blur | x/y/w/h | `rect` |
| blur | strength | `strength ?? DEFAULT_BLUR_STRENGTH` |
| arrow | fromX/fromY/toX/toY | `from` / `to` |
| arrow | widthPx/headPx | annotation の既定解決後の値 |
| box | x/y/w/h | `rect` |
| box | widthPx/radiusPx | annotation の既定解決後の値 |
| spotlight | x/y/w/h | `rect` |
| spotlight | dim/featherPx/radiusPx | annotation の既定解決後の値 |

### 5.6 fade との合成

素材の既存 `opacity`、`fadeInSec`、`fadeOutSec` と keyframe opacity は次で合成する。

```ts
finalOpacity = keyframedOpacity * fadeFactor(t, start, end, fadeInSec, fadeOutSec);
```

- keyframe opacity の基準値は `opacity ?? 1`。
- keyframe が無ければ現行式と同じ。
- fade は keyframe を書き換えない。
- 音量は従来どおり fade factor だけに連動し、keyframe opacity には連動しない。

---

## 6. カットと insert の時刻写像

ここは実装上もっとも重要である。既存 `remapInterval` をそのまま使ってはいけない。

### 6.1 なぜ既存関数だけでは足りないか

`remapInterval` はカット後に隣接する区間を結合する。静的要素には正しいが、
キーフレームではカット前後の raw time が離れている。

例:

- keep: `[0, 5)` と `[10, 15)`
- animation: raw `x(4)=100`、`x(11)=500`
- output では raw 5 と raw 10 が同じ境界へ詰まる

境界を結合して1本の曲線にすると、カットされた `[5,10)` をまたいで 100 から 500 を
補間してしまう。正しくはカット境界で値が不連続に切り替わることである。

### 6.2 新しい区間写像型

`src/lib/timeline.ts` に次を追加する。

```ts
export interface RemappedPiece {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
}

export function remapIntervalPieces(
  start: number,
  end: number,
  timeline: TimelineEntry[],
): RemappedPiece[];
```

規則:

- timeline entry ごとに1 piece を返す。
- 隣接 piece を結合しない。
- `[start,end)` と entry の積集合が空なら返さない。
- source と output の長さは同じ。
- output 値だけ既存 `round2` と同じ規則で丸める。
- 返却順は output time 昇順。

`remapInterval` 自体は変更しない。caption 等の既存挙動を変えないためである。

### 6.3 キーの写像

各 piece に対して、元の曲線を source 境界でサンプリングしてから output time へ移す。

```ts
function remapKeyframesForPiece(
  sourceKeyframes: Keyframe<NumericValues>[],
  piece: RemappedPiece,
  baseline: NumericValues,
): ResolvedKeyframe[];
```

プロパティごとに次を行う。

1. `sourceStart` 時点の評価値を boundary key として `outputStart` に追加する。
2. `sourceStart < at < sourceEnd` の元キーを `at + offset` へ写す。
3. `sourceEnd` 時点の評価値を boundary key として `outputEnd` に追加する。
4. 同じ output 時刻・同じ property のキーは1つへまとめる。
5. piece 内に元キーが無くても、両境界キーは作る。

境界キーを作る理由は、描画層に raw time の知識を持たせず、元の曲線の途中から始まる
piece を同じ値で再現するためである。

### 6.4 境界の easing

- `sourceStart` の boundary key の easing は、sourceStart を含む元区間の left key の easing。
- 元キーの easing はそのまま保持する。
- `sourceEnd` boundary key の easing は `"linear"` でよい。piece の終端より先は描画しない。
- `hold` 区間の途中から piece が始まる場合も boundary key は `hold` を保持する。

### 6.5 piece の描画優先

piece は半開区間 `[outputStart, outputEnd)`。カット境界で前 piece と次 piece が同じ時刻に
接する場合、前 piece は終了し、次 piece が描画される。これで値のジャンプが一意になる。

### 6.6 素材の再生位置

素材オーバーレイを piece に分割しても、動画素材の再生位置は保持する。

```ts
piece.startFrom =
  original.startFrom
  + piece より前に実際に表示された piece の duration 合計;
```

カットされた raw 時間は合計へ入れない。insert による空白も合計へ入れない。
現在の `shown` の考え方を `remapIntervalPieces` の全 piece に拡張する。

### 6.7 insert

insert は timeline entry を分割するため、insert 前後は別 piece になる。

- insert 中、親 overlay / blur / annotation は表示しない。現行挙動を維持する。
- insert 後の keyframe 値は insert 前の output 時間ではなく、対応する raw time から再開する。
- insert の尺だけ output `at` が後ろへずれる。
- insert 前後を output 上で補間しない。

---

## 7. 共通評価器

### 7.1 新規ファイル

`src/lib/keyframes.ts` を追加する。このファイルは Node API、React、DOM を import しない。

### 7.2 公開 API

```ts
export type NumericValues = Record<string, number>;

export interface ResolvedKeyframe {
  at: number;
  easing: KeyframeEasing;
  values: NumericValues;
}

export function easingProgress(kind: KeyframeEasing, p: number): number;

export function valueAt(
  property: string,
  baseline: number,
  keyframes: ResolvedKeyframe[] | undefined,
  t: number,
): number;

export function valuesAt<T extends NumericValues>(
  baseline: T,
  keyframes: ResolvedKeyframe[] | undefined,
  t: number,
): T;

export function remapKeyframesForPiece(
  sourceKeyframes: Keyframe<NumericValues>[],
  piece: RemappedPiece,
  baseline: NumericValues,
): ResolvedKeyframe[];
```

### 7.3 実装アルゴリズム

`valueAt`:

1. `keyframes` が無ければ baseline。
2. `values[property] !== undefined` のキーだけを抽出。
3. 0件なら baseline、1件ならその値。
4. `t <= first.at` なら first value。
5. `t >= last.at` なら last value。
6. `lowerBound` で `right.at >= t` の最初のキーを探す。
7. `t === right.at` なら right value。
8. left の easing で補間する。

`valuesAt` は `Object.keys(baseline)` だけを評価する。keyframe に未知キーが来る状態は
schema / validate で拒否済みだが、評価器が未知キーを結果へ追加してはならない。

### 7.4 性能

v1 は1要素あたり最大100キー、1フレームの対象要素は通常数件なので、property ごとの
filter と二分探索で十分。ただし `Main.tsx` で毎フレーム JSON を正規化しない。

- sort、重複検査、piece 生成は `buildRenderProps` で行う。
- `ResolvedKeyframe[]` は at 昇順。
- `Main.tsx` は `valuesAt` の呼び出しだけ行う。
- 初期実装で cache / memoization を追加しない。
- profiler で問題が出た場合だけ channel index を props 生成時に追加する。

---

## 8. RenderProps

### 8.1 共通型

`remotion/props.ts` に Node 非依存の型を置く。

```ts
export interface ResolvedKeyframe {
  at: number; // output seconds
  easing: KeyframeEasing;
  values: Record<string, number>;
}
```

型の循環 import を避けるため、`KeyframeEasing` は `src/types.ts` から type import する。
`src/lib/keyframes.ts` も `ResolvedKeyframe` を `remotion/props.ts` から type import する。

### 8.2 OverlayItem

`OverlayItem` へ追加:

```ts
keyframes?: ResolvedKeyframe[];
```

keyframe がある material は `rect` を必ず具体値で持つ。元 JSON に rect が無い場合も
`{x:0,y:0,w:width,h:height}` を props に載せる。keyframe が無い material は従来どおり
rect 省略を維持する。

### 8.3 blur

匿名 inline type を `ResolvedBlur` interface へ切り出す。

```ts
export interface ResolvedBlur {
  start: number;
  end: number;
  rect: Region;
  type: "blur" | "mosaic";
  strength: number;
  keyframes?: ResolvedKeyframe[];
}
```

### 8.4 annotation

`ResolvedAnnotation` の各 union member に `keyframes?: ResolvedKeyframe[]` を追加する。
`resolveAnnotation` は static default の解決だけを担当し、keyframe の時刻写像は
`renderProps.ts` 側で行う。

### 8.5 JSON サイズ

piece ごとに boundary key を追加するため props は増える。上限は次で抑える。

- editable JSON: 1要素100 keys
- 1 key の `values`: 対象型で許可したキーだけ
- raw 値と resolved 値に文字列 payload を持たせない
- `render.props.json` の全体上限は新設しない

---

## 9. 描画層の変更

### 9.1 素材

素材を描く既存 component 内で:

```ts
const base = {
  x: item.rect?.x ?? 0,
  y: item.rect?.y ?? 0,
  w: item.rect?.w ?? props.width,
  h: item.rect?.h ?? props.height,
  opacity: item.opacity ?? 1,
};
const now = item.keyframes ? valuesAt(base, item.keyframes, t) : base;
```

- `now.x/y/w/h` を container style に使う。
- `now.opacity * fadeFactor` を opacity に使う。
- keyframes が無い分岐では既存 DOM と style object の形を維持する。

### 9.2 blur / mosaic

各 blur の描画直前に `x/y/w/h/strength` を評価する。以後の
`outputRectToCanvasRegion`、mosaic block、blur radius は評価後の値を使う。

```ts
const now = b.keyframes
  ? valuesAt(
      { x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h, strength: b.strength },
      b.keyframes,
      t,
    )
  : null;
const rect = now ? { x: now.x, y: now.y, w: now.w, h: now.h } : b.rect;
const strength = now?.strength ?? b.strength;
```

### 9.3 annotation

type ごとに baseline object を組み立て、評価後に既存描画へ戻す。

- arrow: 評価後の from/to で `arrowHeadPoints` を呼ぶ。
- box: 評価後 rect / width / radius を CSS へ渡す。
- spotlight: 評価後 rect / dim / feather / radius を SVG へ渡す。
- color、fill、shape は静的値を使う。

評価ロジックを JSX 内へ重複して書かない。`src/lib/keyframes.ts` の `valuesAt` だけを使う。

### 9.4 zoom との関係

v1 の keyframe 座標は現行 blur / annotation と同じく output px 固定で、zoom transform の
外側に描かれる。material も現在の layer placement を維持し、base zoom には追従しない。

---

## 10. Schema

### 10.1 `schemas/common.schema.json`

`$defs.KeyframeEasing` だけを追加する。

```json
{
  "enum": ["linear", "ease-in", "ease-out", "ease-in-out", "hold"]
}
```

values は対象ごとに許可キーと範囲が違うため、共通の loose object は作らない。

### 10.2 `schemas/overlays.schema.json`

対象ごとに `$defs` を追加する。

- `MaterialKeyframe`
- `BlurKeyframe`
- `ArrowKeyframe`
- `BoxKeyframe`
- `SpotlightKeyframe`

各 keyframe:

- required: `at`, `values`
- `additionalProperties: false`
- `values.additionalProperties: false`
- `values.minProperties: 1`

値の範囲:

| 値 | Schema |
|---|---|
| x/y/fromX/fromY/toX/toY | number |
| w/h | number, `exclusiveMinimum: 0` |
| opacity/dim/strength | number, `minimum: 0`, `maximum: 1` |
| widthPx/headPx | number, `exclusiveMinimum: 0` |
| radiusPx/featherPx | number, `minimum: 0` |

配列は `minItems: 1`, `maxItems: 100`。時系列順・重複は JSON Schema で表せないため
`validate.ts` が検査する。

annotation は既存 `common.schema.json#/$defs/Annotation` の type ごとの branch に、
対応する keyframe schema だけを追加する。arrow に `x`、box に `fromX` のような
他 type の値を許可しない。

### 10.3 最大例

`schemas/examples/overlays.max.json` に次を最低1つずつ追加する。

- material: rect + opacity
- blur: rect + strength
- arrow
- box
- spotlight
- `hold` を含む easing

---

## 11. Validate

### 11.1 共通 helper

`src/stages/validate.ts` にローカル helper を追加する。

```ts
function checkKeyframes(args: {
  file: string;
  path: string;
  value: unknown;
  start: number;
  end: number;
  allowedKeys: readonly string[];
  outputRegion: Region | null;
  kind: "material" | "blur" | "arrow" | "box" | "spotlight";
}): void;
```

既存 validator の `err` / `warn` callback 形式に合わせてもよいが、検査内容は以下から
減らさない。

### 11.2 error 条件

- `keyframes` が配列でない。
- 0件または101件以上。
- keyframe が object でない。
- `at` が finite number でない。
- `at < start - EPS` または `at > end + EPS`。
- 配列が `at` 昇順でない。
- 隣接キーの `at` 差が `EPS` 未満。重複時刻は許可しない。
- `easing` が許可 enum でない。
- `values` が object でない、空、未知キーを含む。
- 値が finite number でない。
- opacity / dim / strength が `[0,1]` 外。
- w / h / widthPx / headPx が0以下。
- radiusPx / featherPx が0未満。
- 各キーを反映した rect が出力範囲外。
- arrow の各キーを反映した from と to が同一点。

### 11.3 疎な値を含む geometry 検査

各 key を単体で検査してはいけない。直前までの値を保持して、時系列に state を更新する。

```ts
let state = staticBaseline;
for (const keyframe of keyframes) {
  state = { ...state, ...keyframe.values };
  checkResolvedState(state);
}
```

線形・easing 補間は端点の範囲内に収まるため、全端点が有効なら中間値も有効である。
`hold` も同様。したがって全フレーム走査は不要。

material で元 `rect` が無い場合の baseline は output 全画面。output 解像度が読めない場合は
数値範囲だけ検査し、既存 validator の構造に合わせて geometry 検査を省略する。

### 11.4 warning

- 最初の keyframe が `start` より後: 「最初の値が start まで前方 hold される」。
- 最後の keyframe が `end` より前: warning は出さない。末尾 hold は一般的。
- material の keyframed rect の aspect ratio が元 rect から10%以上変わる:
  `fit` により見切れ方が変わる旨を warning。
- 1秒未満に20 keys 超: 編集ミスまたは tracker 出力過多として warning。

---

## 12. Editor

GUI は renderer 完成後の別 slice で実装する。JSON/render 対応を GUI と同じ PR に混ぜない。

### 12.1 表示

- 対象 clip を選択したとき、その clip の keyframe を timeline 上へ菱形で表示する。
- keyframe の `at` を output time へ写像して表示する。
- カット内の key は timeline に表示しない。
- 同じ時刻の複数 property は1つの菱形。JSON も1 keyframe object。
- 選択中 key は accent color、未選択は muted color。
- clip を未選択なら keyframe marker を出さない。全要素分を常時出すと密度が高すぎるため。

### 12.2 選択モデル

既存 `Selection` は clip 選択のまま維持し、別 state を追加する。

```ts
type KeyframeSelection = {
  ownerKind: "overlays" | "blur" | "annotation";
  ownerIndex: number;
  keyframeIndex: number;
} | null;
```

clip selection が変わったら keyframe selection を `null` にする。

### 12.3 Inspector

対象 clip に「キーフレーム」section を追加する。

- `現在位置に追加`
- keyframe 時刻
- easing
- type に応じた property checkbox と数値入力
- `削除`

「現在位置に追加」の処理:

1. Player の output time を `toSourceTime` で raw time へ変換する。
2. insert 上で `toSourceTime` が null なら button disabled。
3. raw time を親 `[start,end]` へ clamp。
4. 既存 keyframe と0.01秒以内なら新規追加せず、それを選択。
5. 現在の補間値を全 property 入り `values` として追加する。
6. `at` 昇順へ sort。
7. easing は `"linear"`。

全 property 入りで追加するのは、追加直後に前後の疎な channel が意図せず変わることを防ぐため。
ユーザーは Inspector の checkbox で不要 property を後から外せる。

### 12.4 Preview 上の直接操作

- playhead が keyframe と0.01秒以内で、かつその key が選択中なら、既存の overlay /
  blur / annotation handle drag は keyframe values を更新する。
- keyframe を選択していない場合は、従来どおり static baseline を更新する。
- static baseline を更新しても既存 keyframe 値は変更しない。
- 補間途中の時刻で drag を開始しても keyframe を自動追加しない。意図しないキー増殖を防ぐ。
- 「現在位置に追加」を先に押すよう UI hint を出す。

### 12.5 undo / redo

keyframe の add/update/remove は既存 document history に1操作として積む。
drag 中は既存 coalesce key に owner と keyframe index を含める。

```text
keyframe:<ownerKind>:<ownerIndex>:<keyframeIndex>:geometry
```

### 12.6 Save

- keyframe 配列を `at` 昇順にする。
- 空 `values` の key は保存前に削除せず、save error にする。黙って直さない。
- 空 `keyframes` は property ごと削除する。
- stable ID の採番規則は親要素だけ。keyframe に ID を付けない。

---

## 13. apply / MCP / AI

### 13.1 v1 の write path

親要素は既存 `@id` で address できる。v1 は keyframe 個別 ID を追加せず、
親の `keyframes` 全体を `set` する。

例:

```json
{
  "ops": [
    {
      "op": "set",
      "target": "@mat_a1b2c3",
      "path": "keyframes",
      "value": [
        { "at": 12, "values": { "x": 80, "y": 700 } },
        { "at": 18, "values": { "x": 1360, "y": 80 } }
      ]
    }
  ]
}
```

`applyEdits.ts` の set path が nested object / array を既に受ける場合は allowlist だけを更新する。
受けない場合も、keyframe 専用 op は新設せず `set` を拡張する。

### 13.2 add collection

`overlays.*[].keyframes` を `add` collection allowlist へ入れない。親配列の index や
keyframe ID が無く、安全に append する address が定義できないため。

### 13.3 describe

`describe --json` の対象要素 projection に、次を追加する。

```json
{
  "keyframeCount": 3,
  "keyframes": [
    {
      "sourceAt": 12,
      "outputTimes": [8.4],
      "easing": "ease-out",
      "values": { "x": 80, "y": 700 }
    }
  ]
}
```

- カット内の key は `outputTimes: []` として残す。AI が「書いたのに見えない」理由を追える。
- sourceAt は raw、outputTimes は output で名前を曖昧にしない。
- human-readable describe は `keyframes=3` の要約だけでよい。

### 13.4 高水準 AI tool

v1 では新しい MCP tool を作らない。既存 `cutflow_edit` / apply の set を使う。
task-level intent は renderer と GUI が安定した後に追加する。

---

## 14. キャッシュと review

### 14.1 render key

`RenderProps` に resolved keyframes が入るため、既存 render key の props hashing に自然に含まれる。
keyframe が無い場合は optional field を載せず、既存 key を変えない。

### 14.2 chunk cache

`src/lib/chunkPlan.ts` の `chunkVideoKey` は時間局所要素を chunk と重なるかで絞っている。

- material / blur / annotation の親 piece が chunk と重なる場合、keyframes を含む全 piece を hash。
- keyframe 1件の変更で親 piece と重なる chunk だけが invalidation される。
- 初期実装では keyframe の影響時刻をさらに細かく切らない。
- chunk 境界前後の補間値が変わる可能性があるため、親 piece 全体を対象にするのが安全。

annotation が現在 `chunkVideoKey` の局所 payload に含まれていない場合は、この slice で追加する。
keyframe 対応だけ hash して static annotation を漏らす実装にしない。

### 14.3 review / frames

追加 API は不要。`buildRenderProps` が共通なので、以下は自動的に同じ絵になる。

- `frames`
- `frames-serve`
- editor Player
- deterministic before/after review
- final render

ただし keyframe 変更の review frame 自動選定は追加する。

- changed key の `sourceAt`
- その前後 `±0.1 sec`
- 隣接 key との中点
- 上限に収める既存 review frame clamp を通す

---

## 15. ファイル別変更一覧

### Slice 1: 型、Schema、validate

- `src/types.ts`
  - `KeyframeEasing`
  - generic `Keyframe<TValues>`
  - 5種類の values interface
  - 対象要素の `keyframes?`
- `schemas/common.schema.json`
  - easing enum
- `schemas/overlays.schema.json`
  - 対象別 keyframe schema
- `schemas/examples/overlays.max.json`
  - 最大例
- `src/stages/validate.ts`
  - `checkKeyframes`
- `test/schema.test.ts`
- `test/validate.test.ts`
- `test/types.test.ts`

### Slice 2: 評価器と時刻写像

- 新規 `src/lib/keyframes.ts`
- `src/lib/timeline.ts`
  - `RemappedPiece`
  - `remapIntervalPieces`
- 新規 `test/keyframes.test.ts`
- `test/timeline.test.ts`

### Slice 3: RenderProps

- `remotion/props.ts`
  - resolved 型
- `src/lib/renderProps.ts`
  - 対象要素の piece 化
  - boundary sampling
- `src/lib/annotation.ts`
  - static defaults を保ったまま keyframes を通すための最小変更
- `test/renderProps.test.ts`
- `test/renderSnapshot.test.ts`

### Slice 4: Remotion 描画と cache

- `remotion/Main.tsx`
- 必要なら素材 component
- `src/lib/chunkPlan.ts`
- `test/keyframes.test.ts`
- `test/chunkPlan.test.ts`
- render/frame snapshot test

### Slice 5: describe / apply / docs

- `src/stages/describe.ts`
- `src/lib/applyEdits.ts`
- `schemas/apply-patch.schema.json` は必要な場合だけ
- `docs/usage.md`
- `AGENTS_CONTRACT.md`
  - `overlays.json` の説明に keyframe を追記
- describe / apply / contract drift tests

### Slice 6: Editor

- `editor/client/model.ts`
- `editor/client/App.tsx`
- `editor/client/Timeline.tsx`
- `editor/client/Inspector.tsx`
- preview overlay components
- `editor/client/apiTypes.ts`
- `editor/server.ts`
- editor tests

---

## 16. 実装手順

弱いモデルは必ず Slice 1 から順に実装する。複数 slice を同時に変更しない。

### S1: 型と入力境界

1. `src/types.ts` に型を追加する。
2. annotation union の各 branch に正しい values 型だけを割り当てる。
3. Schema を追加する。
4. max example を更新する。
5. schema tests を追加する。
6. `validate.ts` の共通 helper を追加する。
7. type ごとの baseline state を渡して geometry を検査する。
8. validate tests を追加する。
9. `npm run typecheck` と対象 tests を実行する。

完了条件: keyframe JSON を読み込めるが、まだ描画は変わらない。不正 JSON は render 前に拒否される。

### S2: 純関数

1. `remapIntervalPieces` を追加する。
2. cut、insert、完全 cut、境界一致の tests を先に書く。
3. easing 5種を実装する。
4. `valueAt`、`valuesAt` を実装する。
5. sparse values、先頭/末尾 hold、exact key time を test する。
6. boundary sampling を実装する。
7. cut 前後で補間しない test を追加する。

完了条件: React なしで raw keyframe から任意 output 時刻の期待値を検証できる。

### S3: props 生成

1. resolved props 型を追加する。
2. material だけを先に対応する。
3. material の static regression tests を通す。
4. blur を対応する。
5. annotation 3 type を対応する。
6. keyframe 無しの props golden が不変であることを確認する。
7. cut / insert をまたぐ props test を追加する。

完了条件: `render.props.json` だけを見て全 animation を再生できる。raw time は残らない。

### S4: 描画

1. material geometry。
2. material opacity と fade 合成。
3. blur geometry / strength。
4. arrow。
5. box。
6. spotlight。
7. chunk cache payload。
8. 各対象を `frames` で start / midpoint / end 近傍確認する。

完了条件: Player、frames、render が同じ見た目。static fixture は変化なし。

### S5: agent-facing surface

1. describe projection。
2. apply set path。
3. dry-run diff test。
4. usage と contract。
5. review frame selection。

完了条件: AI が `describe -> apply --dry-run -> apply -> validate -> frames` を完走できる。

### S6: GUI

1. marker 表示だけ。
2. marker 選択。
3. Inspector add/edit/delete。
4. undo/redo。
5. preview handle から選択中キーを更新。
6. save/reload。
7. mobile / narrow layout で Inspector が壊れないことを確認。

完了条件: JSON を直接書かずに keyframe を作成・調整・保存できる。

---

## 17. 必須テスト

### 17.1 評価器

- linear の 0%、25%、50%、100%。
- ease-in / ease-out / ease-in-out の固定値。
- hold は right.at でだけ切り替わる。
- exact first / middle / last key。
- 最初より前と最後より後は hold。
- property が0件なら baseline。
- sparse property を独立 channel として評価。
- 負値の座標を数学的には補間できる。拒否は validate の責務。
- input array を mutate しない。

### 17.2 時刻写像

- cut 無し。
- animation の中央が完全 cut。
- key 自体が cut 内。
- key が keep start / end と一致。
- 2つの keep が output 上で隣接しても別 piece。
- insert 前後。
- animation 全体が cut なら0 pieces。
- boundary sample が元 curve と一致。
- hold 区間途中の boundary。

### 17.3 validate

- 全対象 type の正常系。
- empty keyframes。
- 101 keys。
- unsorted / duplicate at。
- start 前 / end 後。
- NaN / Infinity 相当は JSON parse 前提では作れないため unit helper で検査。
- empty values。
- 他 type の未知 property。
- opacity / dim / strength 範囲外。
- w/h ゼロ。
- 疎な key による rect 範囲外。
- arrow from == to。
- moving blur の途中端点が画面外。

### 17.4 props

- keyframe 無しは既存 output と deepEqual。
- rect 無し material + geometry key は全画面 baseline。
- fade + keyframed opacity。
- cut piece は別配列要素。
- video material の startFrom が piece ごとに継続。
- missing material は従来どおり除外。
- annotation defaults と keyframe が両方解決される。

### 17.5 render

各 type で3時刻の still または純関数 snapshot を固定する。

- start
- 2 keys の中点
- end の1フレーム前

blur は秘匿安全性のため、移動中の中点でも対象 rect を覆うことを visual assertion または
pixel test で確認する。

### 17.6 cache

- keyframe 値変更で重なる chunk key だけ変わる。
- easing 変更でも key が変わる。
- keyframe 無し fixture の key は不変。
- audio key は不変。

### 17.7 Editor

- add は output -> raw time に変換する。
- insert 上では add disabled。
- 既存時刻なら重複追加しない。
- sort して保存。
- add/update/remove の undo/redo。
- clip selection 変更で key selection clear。
- static drag と keyframe drag を混同しない。
- reload 後に同じ keyframe が表示される。

---

## 18. 手動確認シナリオ

fixture recording に次を作る。生成物を手編集せず、`overlays.json` を編集して validate する。

1. 6秒の material を左から右へ移動。
2. opacity 0 -> 1 と既存 fadeIn を同時指定。
3. mosaic を3点で移動。
4. arrow の from/to を別々の時刻で変更。
5. box を拡大。
6. spotlight の rect と dim を変更。
7. animation 中央を cut。
8. animation 中央へ insert。

確認コマンド:

```sh
node src/cli.ts validate <dir>
node src/cli.ts describe <dir> --json
node src/cli.ts frames <dir> --t <start>,<mid>,<end-near>
```

GUI 実装後:

1. clip を選ぶ。
2. playhead を移動。
3. keyframe を追加。
4. preview handle で移動。
5. undo / redo。
6. 保存。
7. Editor を再読み込み。
8. 同じ位置・値・easing が復元されることを確認。

---

## 19. ドキュメント更新

`docs/usage.md` に次を追加する。

- 対象要素一覧
- raw time であること
- easing は left key から next key へ適用されること
- sparse values と先頭/末尾 hold
- fade opacity との積
- cut 境界で補間しないこと
- shorts / zoom 非追従
- JSON 例
- AI 向け apply 例

`AGENTS_CONTRACT.md` の座標・時刻規約は変更しない。editable file 表の
`overlays.json` の説明へ「material / blur / annotation の keyframe」を追記する。
generated files と approval boundary は変更しない。

---

## 20. 受け入れ条件

以下をすべて満たしたとき P2「キーフレーム基盤」v1 完了とする。

- material、blur、arrow、box、spotlight の対象数値をキーフレームで動かせる。
- JSON Schema と runtime validate が同じ許可キー・範囲を強制する。
- raw time で書いたキーが cut / insert 後に正しく output time へ写像される。
- cut 境界をまたいだ誤補間がない。
- `frames`、Editor、final render の見た目が一致する。
- keyframe 無しの既存 props / render snapshot / render key が不変。
- apply dry-run と apply で親要素の keyframes 全体を安全に更新できる。
- describe JSON で source/output time と cut 内 key を確認できる。
- GUI で add/edit/remove、marker、undo/redo、save/reload が動く。
- chunk cache は映像の必要部分だけ invalidation し、audio key を変えない。
- `npm test` と `npm run typecheck` が成功する。

---

## 21. 将来拡張の順序

v1 完了後は、同時に広げず次の順で1対象ずつ追加する。

1. zoom の target rect を複数 key 化し、既存 ease-in/out を互換変換する。
2. caption の x/y/fontSize/opacity。
3. material volume と audio cache key。
4. wipe geometry。
5. color interpolation。
6. tracker が生成した key の間引きと import。
7. custom cubic-bezier。

速度変更はこの列へ入れない。非線形 time mapping を先に独立設計し、その設計から
`remapIntervalPieces` / `remapKeyframesForPiece` の置換または一般化を指示する。
