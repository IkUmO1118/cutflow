# 領域ぼかし/モザイク(秘匿情報の目隠し)設計

- 対象: Now ロードマップ項目5「★ 領域ぼかし/モザイク」(表現力 / effort M)
- 用途: 開発スクリーンキャストで API キー・PII・パスワードを隠す。
  現状はカットか外部 PNG 貼りしかなく、事故リスク直結。
- 前提: `overlays.json` に新フィールドを足し、Remotion(`remotion/Main.tsx`)で
  ベース映像(画面クロップ)の指定矩形だけをぼかす。実装すれば `frames` で
  自己確認できる。**未使用時は既存の絵が1ピクセルも変わらないこと**を最重視。
- 実装は別エージェント(Sonnet)。この文書だけで着手できる粒度で書く。

この文書は「設計判断 → 確定スキーマ → 描画実装 → タスク分解 → 実データ検証 →
落とし穴」の順。実装者はタスク分解(§4)を上から順にこなせばよい。

---

## 0. 用語と座標系(最初に固定する)

- **出力px**: final.mp4 の解像度(このプロジェクトでは 1920x1080)上の座標。
  テロップ `pos`・overlays `rect`・zooms `rect` と同じ座標系。blurs の `rect` も
  これに揃える。
- **canvas px**: 収録動画(拡張キャンバス。例 3840x1080)上の座標。
  `manifest.video.screenRegion`(例 `{x:0,y:0,w:1920,h:1080}`)が「出力に使う
  画面領域」= canvas 内の切り出し矩形。
- **元収録の秒 / カット後の秒**: 編集ファイル(overlays.json)は元収録の秒。
  `remapInterval(start, end, timeline)` が props(カット後の秒)へ写像する。
- ぼかし対象は **ベース映像(screen クロップ)の中身**。半透明の板を重ねるだけ
  では下が透けるので、**その領域のベース映像をもう一度クロップ描画してから
  filter を掛ける**方式を採る(後述 §3)。

---

## 1. 設計判断(結論と根拠)

### 判断1: スキーマ(フィールド名と1件の形)

**結論:** `overlays.json` に `blurs?: BlurRegion[]` を足す。1件は

```jsonc
{ "start": 40.0, "end": 52.0, "rect": { "x": 1200, "y": 300, "w": 500, "h": 120 },
  "type": "blur", "strength": 0.5 }
```

- `type`: `"blur"`(CSS ぼかし)/ `"mosaic"`(ピクセル化)。**省略時 `"blur"`**。
- `strength`: 0〜1 の正規化強度。**省略時 0.5**。type ごとに px へ写像する
  (blur=ぼかし半径、mosaic=ブロック辺長)。ユーザーが触るのは 0〜1 の1本の
  つまみだけ。実 px 換算は `src/lib/blur.ts` の純関数に閉じる(§2, §3)。

**フィールド名の選択肢比較:**

| 候補 | 長所 | 短所 |
|---|---|---|
| `blurs`(採用) | チケット名(ぼかし/モザイク)と一致・短い・主効果が blur・zooms/inserts と同じ「効果を名前にする」既存流儀 | 将来 `type:"box"`(単色塗り)を足すと名前と食い違う |
| `redactions` | 用途(秘匿)を的確に表す・box 追加も自然 | 既存フィールド(overlays/zooms/…)の命名流儀と外れる・長い |
| `masks` | 短い | alpha マスクと紛らわしい |

**採用 `blurs`。** 既存フィールドは全て「効果を名前にする」流儀(overlays=素材、
zooms=拡大、wipeFull=ワイプ全画面)で、それに揃う。主効果は blur で mosaic は
その一種と読める。将来の単色塗りは `type:"box"` として `blurs` 内に足せば
「領域を隠す」意味は保たれる(名前替えが要るほど外れない)。もし team が
効果非依存の名前を強く望むなら実装着手前に `redactions` へ替える(その場合
§2/§3/§4 の識別子を一括置換するだけ。ロジックは不変)。

**将来 box を足す余地:** `type` を `"blur" | "mosaic" | "box"` に開けておける
よう、`type` の検査は「許可リストに含まれるか」で書く(§2 の validate)。box は
今回のスコープ外(実装しない)。ただし `type` の型定義に box を今は**入れない**
(YAGNI。入れると validate も描画も未実装分岐を持つことになる)。box が要る
ときに1タスクで足す。

### 判断2: モザイクの実現方法(Remotion=Chromium/CSS 制約下)

**結論:**
- `type:"blur"` … **CSS `filter: blur(Npx)`**(採用・保証パス)。
- `type:"mosaic"` … **領域を縮小レンダー → `image-rendering: pixelated` で拡大**
  (採用・要 frames 検証。失敗時は強ぼかしへフォールバック)。

**なぜ blur が保証されるか:** 既存の `colorFilter` が `CroppedVideo` の
コンテナに `filter: brightness()/contrast()/saturate()` を掛けており、これは
最終レンダー(headless Chromium のスクショ)でも `frames`(renderStill)でも
機能している(`src/lib/colorFilter.ts` + `remotion/Main.tsx` の `filter` prop、
`chunkPlan.ts:126` がキャッシュキーに含めている実績)。`blur()` は同じ CSS
filter パスなので **同じ機構でそのまま出る**。これが最も確実。

**選択肢比較(モザイク):**

| 方式 | 実現性 | 備考 |
|---|---|---|
| (a) CSS `filter: blur()` を強く掛ける | 保証(blur と同じパス) | 厳密には「ピクセル格子」でなく滑らかなぼかし。目隠しとしては十分 |
| (b) 縮小 → `image-rendering: pixelated` 拡大(採用) | 要検証(Chromium の video 拡大でニアレストネイバーが効くか) | 本物のモザイク格子。renderStill で効かない可能性あり |
| (c) SVG filter(`feFlood`/`feImage`/モーフ) | 過剰 | video を SVG に流し込むのが煩雑。不採用 |
| (d) `<canvas>` に描いて縮小拡大 | 不可 | renderStill 中の OffthreadVideo は再生中の video ではなくフレーム抽出。canvas に drawImage できない |

**採用方針:** mosaic は (b) を実装するが、**frames 検証で格子が出ることを
確認できなければ (a) の強ぼかしへ自動フォールバック**(§3 に both のコードと
フォールバック条件を書く)。(a) は保証パスなので、最悪でも「隠れる」ことは
担保される。**秘匿目隠しとして重要なのは『読めなくする』ことで、格子か
ぼかしかは二次的**という価値判断に基づく。

### 判断3: レイヤー順(どの高さに置くか)

**結論:** blurs は `layerOrder` に組み込まず、**独立レイヤー**として
「ベース映像 + zoom + 挿入クリップ の直上、`layerOrder`(素材・テロップ)の
直下」に固定で描く。

**根拠:**
- 隠したい秘匿情報が写るのは **ベース映像(screen クロップ)**。素材
  オーバーレイ・挿入は「ユーザーが意図的に上に置いた別メディア」で、それが
  ぼかし矩形を覆っても秘匿情報が露出するわけではない(むしろ覆い隠す側)。
  だから blurs は素材オーバーレイより下でも秘匿は守れる。
- テロップより下に置くことで **テロップの可読性を保つ**(テロップに秘匿情報は
  入らない前提)。
- `layerOrder` には ov<N>(素材)と cap<N>(テロップ)が任意順で混在するため、
  「素材より上・テロップより下」を `layerOrder` 内の1点で表せない。独立
  レイヤーにすれば `normalizeLayerOrder` を一切触らずに済み、**未使用時の絵は
  1px も変わらない**(後方互換の要件を最小コストで満たす)。

描画位置(`remotion/Main.tsx` の `return` 内):ベース+zoom コンテナと挿入
`Sequence` 群の**直後**、`layerOrder.map(layerNode)` の**直前**に blurs の
`.map` を差し込む(§3)。

### 判断4: zoom との相互作用

**結論:** blur の `rect` は **出力px 固定**(zoom に追従しない)。blur 区間と
zoom 区間が**時間的に重なるとき validate で警告**する。

**根拠:**
- blurs を判断3で「zoom コンテナの外(= zoom transform が掛からない独立
  レイヤー)」に置くので、blur 矩形は自動的に出力px固定になる。ぼかしパッチ
  自身も zoom されていない素の screen を再クロップするので、zoom が無い時刻では
  背景と完全一致する。
- しかし zoom 中は背景(ベース映像)が拡大・移動するのに blur 矩形は固定
  → 隠したい情報が矩形からずれて露出しうる。かつ blur パッチは素(非zoom)の
  背景を映すので、周囲(zoom 済み)と二重像になる。**この状態は事故**なので
  validate で警告し、ユーザーに「redaction 区間に zoom を重ねない」か
  「blur 矩形を広げる」を促す。
- 追従実装(zoom transform を blur 矩形にも適用)は複雑さに見合わない。zoom と
  redaction の同時使用は稀で、警告で回避を促せば十分(実装コスト最小)。

### 判断5: カット/挿入によるカット写像の分割

**結論:** `remapInterval(start, end, timeline)` で断片化し、**断片ごとに独立の
props エントリ**として載せる(rect は不変なのでマージ不要)。zooms/wipeFull と
同じ扱い。ただし **wipeFull のような近接マージはしない**。

**根拠:**
- blur には遷移(ease)が無い(秘匿は硬い ON/OFF が正しい。ぼかしがフェードで
  薄く見える瞬間を作ってはいけない)。wipeFull が断片をマージするのは「継ぎ目で
  ワイプが縮んで戻るバウンス」を消すためで、遷移の無い blur には不要。
- rect は全断片で同一なので、断片を別エントリにしても情報は失われない
  (zooms が「rect が違うエントリを1本にまとめない」ためマージしないのと同型)。
- 実装は zoomSpans の写像(`renderProps.ts:175-186`)を素直に踏襲。ease 解決が
  無いぶん更に単純。

### 判断6: 検証(validate)

**結論(zooms に倣い、秘匿ゆえ厳しめ):**

| 項目 | 結果 | 根拠 |
|---|---|---|
| `rect` が出力解像度の外にはみ出す | **エラー** | zooms と同じ。秘匿矩形が画面外に外れるのは配置ミス |
| `rect.w / h <= 0` | **エラー** | zooms と同じ |
| `start >= end` / 収録尺外 | **エラー**(`checkSpan` に warn を渡さない) | zooms と同じ厳しさ |
| `type` が `blur`/`mosaic` 以外 | **エラー** | 未知の効果は描けない |
| `strength` が 0〜1 の範囲外 | **エラー** | 範囲を外すと px 換算が破綻 |
| blur 区間 × zoom 区間の時間重なり | **警告** | 判断4。露出事故の注意喚起 |
| 全体がカット区間内(表示されない) | **警告** | 他フィールドと同様 |
| blurs 同士の重なり | **検査しない**(許可) | 複数箇所を同時に隠すのは正当。重ねても害なし |
| `rect` のアスペクト比 | **検査しない** | zooms と違い blur 矩形は任意形状の部分窓。全画面拡大先ではないので比率制約なし |

`KNOWN` 配列(`validate.ts:220`)に `"blurs"` を追加。shorts が存在し blurs も
存在するとき **「本編の blurs はショートに継承されない」警告**を出す(判断7)。

### 判断7: ショート(縦)への継承

**結論:** **継承しない。** ただし shorts.json と blurs が両方あるとき validate で
**大きく警告**する(「本編に領域ぼかしがありますが、ショートには継承され
ません。ショートに秘匿情報が写る場合は別途隠してください」)。

**根拠(安全性 vs 実装コストのトレードオフ):**
- colorFilter は**座標を持たない全域補正**なのでショートへ無条件継承できる。
  blurs は **出力px 座標(本編 1920x1080 基準)に束縛**される。ショートは
  profile(縦・別解像度・panel で screen を再クロップ)なので、本編の blur 矩形
  座標はショートの座標系に一致しない。
- **座標がずれた矩形を黙って継承する方が、継承しないより危険**(隠したい場所を
  外し、秘匿情報を露出させたまま「隠したつもり」にさせる)。よって
  colorFilter の前例はここには転用できない。
- 正しく継承するには「blur 矩形 → どの panel が該当 screen 領域を映すか → panel
  変換でショート座標へ写像」が要り、effort M を大きく超える。
- v1 は **継承せず・loud に警告** が最も安全で低コスト。将来はショート専用の
  `blurs`(shorts.json 側)か panel 自動写像で対応する(別チケット)。
- 実装保証: buildRenderProps へショート経路(`render.ts` / `frames.ts` の
  shortOverlays)は blurs を渡さない(colorFilter だけ拾う現状のまま)。加えて
  Main.tsx の blur 描画は `!props.layout`(本編経路)でゲートする(二重の安全)。

---

## 2. 確定スキーマ

### 2-1. `src/types.ts`(Overlays に追加)

`Overlays` interface(264行目付近)に `blurs?` を追加し、`BlurRegion` と
`BlurType` を新設する。`Zoom` の直後あたりに置く。

```ts
/** 領域ぼかし/モザイクの効果種別。省略時 "blur"。
 * 将来 "box"(単色塗り)を足す場合はここに追加する(今はスコープ外) */
export type BlurType = "blur" | "mosaic";

/** 領域ぼかし/モザイク1件(overlays.json の blurs)。開発画面の API キー・
 * PII・パスワードなど、ベース映像(画面クロップ)の一部を隠す。start/end は
 * 元収録の秒、rect は出力px({x,y,w,h}。テロップ pos・zooms rect と同座標系)。
 * かかるのはベース映像だけ。zoom には追従せず出力px固定(zoom と時間が重なる
 * と validate が警告する)。ショート(profile 経路)には継承されない */
export interface BlurRegion {
  start: number;
  end: number;
  /** 隠す矩形(出力px)。画面外へはみ出すと validate がエラーにする */
  rect: Region;
  /** 効果種別。省略時 "blur"(CSS ぼかし)。"mosaic" はピクセル化 */
  type?: BlurType;
  /** 強度(0〜1)。省略時 0.5。type ごとに px へ写像する
   * (blur=ぼかし半径 / mosaic=ブロック辺長。src/lib/blur.ts) */
  strength?: number;
}

/** BlurRegion.strength / type 未指定時の既定。renderProps と描画・検査で共有 */
export const DEFAULT_BLUR_STRENGTH = 0.5;
export const DEFAULT_BLUR_TYPE: BlurType = "blur";
```

`Overlays` 本体への追加(`colorFilter?` の隣):

```ts
  /** 領域ぼかし/モザイク(秘匿情報の目隠し)。かかるのはベース映像
   * (画面クロップ)だけで、素材・挿入・テロップは対象外。zoom には追従せず
   * 出力px固定。ショート(profile 経路)には継承されない(座標が本編基準の
   * ため。shorts があると validate が警告する) */
  blurs?: BlurRegion[];
```

### 2-2. `remotion/props.ts`(RenderProps に追加)

`zooms?` の定義(139行目付近)の直後に足す。**buildRenderProps が type/strength を
解決済みで載せる**ので props 側は必須値(zooms が easeSec を解決済みで載せるのと
同型)。

```ts
  /** 領域ぼかし/モザイク(overlays.json の blurs。カット後の秒へ写像・
   * type/strength 解決済み)。ベース映像(画面クロップ)の rect 部分だけを
   * 隠す。zoom 追従なしの出力px固定。省略時(空)は現行の描画と完全に同じ。
   * props.layout(ショート/縦)経路では描画しない(本編のみ) */
  blurs?: { start: number; end: number; rect: Region; type: "blur" | "mosaic"; strength: number }[];
```

`import type { CaptionStyle, ColorFilter, LayerId }` に型追加は不要(blur 用の
type は props.ts 内でインライン定義。既存 zooms も同様にインライン)。

### 2-3. `src/lib/blur.ts`(新規・純関数)

zoom.ts / colorFilter.ts と同じ「描画側が使う純関数を lib に切り出す」流儀。
単体テストで固定する。

```ts
// lib/blur.ts — 領域ぼかし/モザイク(overlays.json の blurs)の座標変換と
// 強度→px 換算。remotion/Main.tsx が使う純関数。テストで数値を固定する。
import type { Region } from "../types.ts";

/** 出力px の rect を、ベース映像を再クロップするための canvas 領域へ写像する。
 * screenRegion(canvas 内の画面切り出し)を出力(width×height)へ一様に
 * 引き伸ばしている前提。返り値を CroppedVideo の region に渡すと、rect 部分の
 * ベース映像がそのまま出る(scale は base と同じ width/screenRegion.w)。 */
export function outputRectToCanvasRegion(
  rect: Region,
  screenRegion: Region,
  width: number,
  height: number,
): Region {
  return {
    x: screenRegion.x + (rect.x / width) * screenRegion.w,
    y: screenRegion.y + (rect.y / height) * screenRegion.h,
    w: (rect.w / width) * screenRegion.w,
    h: (rect.h / height) * screenRegion.h,
  };
}

/** blur のぼかし半径(出力px)。strength 0→軽い、1→強い。開発画面の等幅
 * フォントが読めなくなる程度を 0.5 の既定に置く。出力幅にほぼ依存しない
 * 絶対 px(小さい矩形でも十分ぼける) */
export function blurRadiusPx(strength: number): number {
  return Math.round(4 + clamp01(strength) * 36); // 0→4px, 0.5→22px, 1→40px
}

/** mosaic のブロック(セル)辺長(出力px)。strength 0→細かい、1→粗い */
export function mosaicBlockPx(strength: number): number {
  return Math.round(8 + clamp01(strength) * 56); // 0→8px, 0.5→36px, 1→64px
}

/** mosaic フォールバック(pixelated が効かない環境)用の等価ぼかし半径。
 * ブロック辺長の約 0.5 倍が視覚的に近い */
export function mosaicFallbackBlurPx(strength: number): number {
  return Math.round(mosaicBlockPx(strength) * 0.5);
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
```

---

## 3. 描画実装(remotion/Main.tsx)

### 3-1. CroppedVideo に `imageRendering` を1個足す(mosaic 用)

`CroppedVideo`(730行目付近)の props に `imageRendering?: "pixelated"` を追加し、
`mediaStyle` に流す。既存呼び出し(未指定)は挙動不変。

```ts
const CroppedVideo = ({
  src, canvas, region, width, height, muted,
  startFromFrames = 0, fit = "cover", filter,
  imageRendering,               // ← 追加
}: {
  /* ...既存... */
  imageRendering?: "pixelated"; // ← 追加。mosaic の縮小→拡大でニアレストネイバー
}) => {
  /* ... */
  const mediaStyle = {
    position: "absolute" as const,
    width: fitted.width, height: fitted.height,
    left: fitted.left, top: fitted.top,
    maxWidth: "none",
    ...(imageRendering ? { imageRendering } : {}),  // ← 追加
  };
  /* ...以降不変。<OffthreadVideo style={mediaStyle}> にそのまま乗る... */
};
```

### 3-2. renderBase に `imageRendering` を通す(mosaic 用)

`renderBase`(150行目付近)へオプション引数を1個足し、両分岐(continuous /
split)の `CroppedVideo` に渡す。既存呼び出しは省略で挙動不変。

```ts
const renderBase = (
  region: Region, width: number, height: number, muted: boolean,
  fit: "contain" | "cover" = "cover",
  imageRendering?: "pixelated",     // ← 追加
) =>
  continuous ? (
    <CroppedVideo /* ...既存... */ filter={filterCss} imageRendering={imageRendering} />
  ) : (
    baseSegs.map((seg, i) => (
      <Sequence /* ... */>
        <CroppedVideo /* ...既存... */ filter={filterCss} imageRendering={imageRendering} />
      </Sequence>
    ))
  );
```

> **なぜ renderBase を再利用するか:** renderBase は continuous(最終レンダーの
> cut.mp4)と split(エディタの proxy.mp4。挿入・カットで区間分割)を自動で
> 出し分け、colorFilter とフレームホールドも内包する。blur パッチがこれを
> 再利用すれば、最終レンダー・frames・エディタの全経路でベース映像と**同じ
> 動画時刻**を映し、ズレない。colorFilter も自動で乗る(本編とパッチの色が
> 揃う)。

### 3-3. blur レイヤーの描画(Main の return 内)

挿入 `Sequence` 群の直後・`layerOrder.map` の直前に差し込む。**本編経路のみ**
(`!props.layout` && `hasVideo`)。時刻ゲートは既存の `inSpan` を流用
(props.blurs は Span 互換の start/end を持つ)。

```tsx
{/* 領域ぼかし/モザイク。ベース映像+zoom+挿入の直上・素材/テロップの直下。
    zoom transform の外(独立レイヤー)なので出力px固定。本編経路のみ */}
{hasVideo && !props.layout &&
  (props.blurs ?? []).map((b, i) => {
    if (t < b.start || t >= b.end) return null;            // 硬い ON/OFF(遷移なし)
    const cr = outputRectToCanvasRegion(b.rect, props.screenRegion, props.width, props.height);
    const container = {
      position: "absolute" as const,
      left: b.rect.x, top: b.rect.y, width: b.rect.w, height: b.rect.h,
      overflow: "hidden" as const,
    };
    if (b.type === "mosaic") {
      const block = mosaicBlockPx(b.strength);
      // 縮小レンダー → pixelated 拡大。box を block で割った小箱に描き、
      // その箱を scale(block) で拡大(ニアレストネイバー)。端数は ceil して
      // 余りをはみ出させ overflow:hidden で切る(隙間を作らない)
      const smallW = Math.max(1, Math.ceil(b.rect.w / block));
      const smallH = Math.max(1, Math.ceil(b.rect.h / block));
      return (
        <div key={`blur-${i}`} style={container}>
          <div style={{
            position: "absolute", left: 0, top: 0,
            width: smallW, height: smallH,
            transform: `scale(${block})`, transformOrigin: "0 0",
            imageRendering: "pixelated",
          }}>
            {renderBase(cr, smallW, smallH, true, "cover", "pixelated")}
          </div>
        </div>
      );
    }
    // type === "blur"(既定): コンテナに blur() を掛ける。colorFilter は
    // 内側 CroppedVideo に既に乗っているので、コンテナ blur は色補正済みの
    // 映像にさらに合成される(CSS filter は積み重なる)
    return (
      <div key={`blur-${i}`} style={{ ...container, filter: `blur(${blurRadiusPx(b.strength)}px)` }}>
        {renderBase(cr, b.rect.w, b.rect.h, true, "cover")}
      </div>
    );
  })}
```

import 追加(Main.tsx 冒頭):

```ts
import { blurRadiusPx, mosaicBlockPx, outputRectToCanvasRegion } from "../src/lib/blur.ts";
```

> **blur() のはみ出し対策:** `filter: blur()` は矩形の縁がぼやけて外へにじむ。
> コンテナに `overflow: hidden` があるので**にじみは矩形内に収まる**(縁が
> 素の背景と急に切り替わる硬いエッジになる)。これは秘匿目隠しとして正しい
> (にじみが矩形外へ漏れて「ぼかしの帯」が見えるのを防ぐ)。ただし縁 1〜2px は
> ぼかしが弱くなるので、確実に隠すには rect を秘匿範囲より数px 大きめに取る
> よう usage に一言添える。

### 3-4. mosaic フォールバック(pixelated が renderStill で効かない場合)

§5 の frames 検証で mosaic の格子が出ない(=滑らかに拡大されている)ことが
分かったら、mosaic 分岐を**強ぼかしに差し替える**:

```tsx
if (b.type === "mosaic") {
  // フォールバック: pixelated が renderStill で効かない環境。強ぼかしで隠す
  return (
    <div key={`blur-${i}`} style={{ ...container, filter: `blur(${mosaicFallbackBlurPx(b.strength)}px)` }}>
      {renderBase(cr, b.rect.w, b.rect.h, true, "cover")}
    </div>
  );
}
```

判断は frames の実出力を見てから。**まず 3-3 の pixelated 版で実装し、frames で
検証→ダメならこの差し替え**、の順(タスク5の受け入れ条件)。

---

## 4. タスク分解(1タスク=1コミット・依存順)

### タスク1: スキーマ型を足す(挙動不変)
- **変更ファイル:** `src/types.ts`(BlurType / BlurRegion / DEFAULT_BLUR_* /
  Overlays.blurs)、`remotion/props.ts`(RenderProps.blurs)、`docs/usage.md`
  (overlays.json の表に blurs 行)、CLAUDE.md の「どのファイルが何を決めるか」表の
  overlays.json 行に blurs を追記。
- **テスト方針:** `npx tsc --noEmit` が通ること。挙動変更なし(型と定数の追加
  のみ)。`npm test` が既存のまま緑。
- **壊してはいけない:** 既存フィールドの型・既定。props.ts の defaultProps に
  blurs を**足さない**(未指定=空で現行と同一。zooms/colorFilter も defaultProps に
  無いのと同じ)。

### タスク2: `src/lib/blur.ts`(純関数)+ 単体テスト
- **変更ファイル:** `src/lib/blur.ts`(新規)、`test/blur.test.ts`(新規)。
- **テスト方針(unit):** `outputRectToCanvasRegion` が
  screenRegion={0,0,1920,1080}/width=1920/height=1080 のとき恒等
  (rect==region)になること、screenRegion にオフセット/縮尺がある場合の写像、
  `blurRadiusPx(0/0.5/1)`・`mosaicBlockPx(0/0.5/1)` の固定値、clamp(負・1超)。
- **壊してはいけない:** 他ファイルへの副作用なし(新規純関数のみ)。

### タスク3: validate に blurs ブロックを足す
- **変更ファイル:** `src/stages/validate.ts`(KNOWN に `"blurs"`、blurs 検査
  ブロック、zoom×blur 時間重なり警告、shorts×blurs 警告)、`test/validate.test.ts`。
- **実装詳細:** zooms ブロック(368-414行)を型紙に。
  - `checkSpan(f, w, b, dur, err)`(warn を渡さない=start<end/尺内はエラー)。
  - rect: `isObj`+4数値、`w/h<=0` エラー、`outputRegion` に対する
    はみ出しエラー(zooms と同じ式。**アスペクト比警告は入れない**)。
  - `type`: `undefined | "blur" | "mosaic"` 以外はエラー。
  - `strength`: `undefined` 可、数値かつ `0<=strength<=1` 以外はエラー。
  - カット内で表示されない場合の warn(既存 `visible` を使う)。
  - **zoom×blur 重なり警告:** 収集済みの `zoomSpans`(既に validate 内にある)と
    各 blur の [start,end) が交差したら warn。
  - **shorts×blurs 警告:** blurs が1件以上あり、かつ shorts.json が存在
    (`shorts.shorts?.length`)するとき、`warn(f, "blurs", "ショートには継承され
    ません…")`。
- **テスト方針(unit):** はみ出し rect→エラー、w<=0→エラー、type 不正→エラー、
  strength=1.5→エラー、正常 blurs→エラーなし、zoom と重なる blur→警告1件。
- **壊してはいけない:** 既存 zooms/overlays の検査結果。KNOWN への追加で
  既存キーの「不明なキー」警告が変わらないこと。

### タスク4: buildRenderProps で blurs を写像
- **変更ファイル:** `src/lib/renderProps.ts`、`test/renderProps.test.ts`。
- **実装詳細:** zoomSpans(175-186行)の直後に blurSpans を作る。
  ```ts
  const blurSpans = (overlays.blurs ?? []).flatMap((b) =>
    remapInterval(b.start, b.end, timeline).map((iv) => ({
      start: iv.start, end: iv.end, rect: b.rect,
      type: b.type ?? DEFAULT_BLUR_TYPE,
      strength: b.strength ?? DEFAULT_BLUR_STRENGTH,
    })),
  );
  ```
  返り値に `...(blurSpans.length > 0 ? { blurs: blurSpans } : {})`(zooms と同じく
  空なら載せない=props.json を汚さない)。`DEFAULT_BLUR_*` を types.ts から import。
  - **断片は独立エントリ**(wipeFull のようなマージをしない。判断5)。
  - **ショート経路への非継承:** `render.ts`・`frames.ts` の `shortOverlays` は
    現状 blurs を拾わない(colorFilter だけ)。**変更不要**。念のためコメントで
    「blurs は継承しない(座標が本編基準)」と一言添える。
- **テスト方針(unit):** blurs 1件が挿入/カットで2断片に割れると props.blurs が
  2エントリ(同一 rect・同一 type/strength)、type/strength 省略時に既定が入る、
  空なら props に blurs キーが無い。
- **壊してはいけない:** 既存の props 出力(zooms/overlays/wipeFull の写像)。

### タスク5: Main.tsx で描画(+ CroppedVideo/renderBase の引数追加)
- **変更ファイル:** `remotion/Main.tsx`。
- **実装詳細:** §3-1(CroppedVideo に imageRendering)、§3-2(renderBase に
  imageRendering)、§3-3(blur レイヤーの .map)、import 追加。
- **テスト方針(frames 実データ確認・必須):** §5 の手順で whisper-bench に blurs を
  足し、`frames --t` で PNG を目視。
  - blur: 矩形内のベース映像がぼけ、矩形外は素のまま、テロップが上に残る。
  - mosaic: 格子(ピクセル)が出るか確認。**出なければ §3-4 のフォールバックへ
    差し替えて再検証**(これもこのタスク内で完結させる)。
  - blurs 未指定のプロジェクトで既存 frames が**1px も変わらない**こと
    (原状の overlays.json で frames を撮り、この変更の前後で diff)。
- **壊してはいけない:** props.blurs が空/未指定のときの全描画。props.layout
  (ショート)経路で blur を描かないこと。zoom/wipeFull/inserts の既存挙動。

### タスク6: チャンク差分レンダーのキャッシュキーに blurs を反映
- **変更ファイル:** `src/lib/chunkPlan.ts`、`test/chunkPlan.test.ts`。
- **実装詳細:** blurs は**時間局所**の映像要素(zooms と同型)。`chunkKey` の
  `local`(189-204行)に、そのチャンクと重なる blurs だけを射影して足す:
  ```ts
  blurs: sortStable((props.blurs ?? []).filter((b) => overlaps(b.start, b.end))),
  ```
  `globalVideoProps`(全域キー)には**入れない**(zooms が local 側にあるのと
  同じ。全域ではなく局所なのでチャンク単位で差分が効く)。
- **テスト方針(unit):** ある blur を足す/rect を変えると、その blur に重なる
  チャンクのキーだけ変わり、重ならないチャンクのキーは不変。
- **壊してはいけない:** blurs 無しのときチャンクキーが現行と一致すること
  (キャッシュ総無効化を起こさない)。zooms/overlays の局所射影。

> **依存順:** 1 → 2 → {3, 4}(3と4は1・2の後なら並行可)→ 5(2・4の後)→ 6(4・5の後)。
> 各タスクの後で `npx tsc --noEmit` と `npm test`、5 の後は §5 の frames 実データ確認。

---

## 5. 実データ検証手順(whisper-bench)

検証データ: `~/Movies/cutflow/2026-07-02-whisper-bench`
(obs-canvas / 出力 1920x1080 / camera あり / 既に overlays.json に overlays・
zooms・wipeFull・inserts が入っている実データ)。

**⚠️ 既存の overlays.json を壊さないこと。`overlays.json.bak` が既にあるので
上書きしない。別名で退避する。**

```sh
DIR=~/Movies/cutflow/2026-07-02-whisper-bench

# 0) 原状退避(.bak は既存の別物なので使わない。専用の退避名にする)
cp "$DIR/overlays.json" "$DIR/overlays.blur-verify-backup.json"

# 1) overlays.json に blurs を1件足す(既存 keep 区間内の時刻を選ぶ。
#    例: 20.57-33.03 が keep なので 24-30 に置く。rect は画面中央あたり)
#    → jq か手編集で overlays に "blurs":[{...}] を追記:
#    "blurs": [
#      { "start": 24.0, "end": 30.0, "rect": {"x":700,"y":400,"w":520,"h":140}, "type":"blur",   "strength":0.6 },
#      { "start": 24.0, "end": 30.0, "rect": {"x":700,"y":600,"w":520,"h":140}, "type":"mosaic", "strength":0.6 }
#    ]

# 2) 検査(必ず。エラーなく通ること。zoom 48.62-63.02 とは時間が重ならない
#    ので zoom×blur 警告は出ない。shorts.json があるので継承なし警告は出る)
node src/cli.ts validate "$DIR"

# 3) frames で最終合成の見た目を PNG に(元収録の秒。24-30 の中で 27 を指定)
node src/cli.ts frames "$DIR" --t 27

# 4) Read で $DIR/frames/*.png を目視:
#    - 上の矩形(blur)= ベース映像がぼけている / 矩形外は素のまま
#    - 下の矩形(mosaic)= 格子(ピクセル)が出ているか
#      → 出ていなければ §3-4 のフォールバックに差し替えて 3〜4 を再実行
#    - テロップ・素材が blur の上に残っている(レイヤー順の確認)

# 5) 後方互換の確認(未使用時 1px も変わらない):
#    退避した原状 overlays に戻して frames を撮り、変更前の PNG と一致すること
cp "$DIR/overlays.blur-verify-backup.json" "$DIR/overlays.json"
node src/cli.ts frames "$DIR" --t 27   # blurs 無し。既存と同じ絵になる

# 6) 原状復帰(退避ファイルを戻し、退避ファイルと frames の残骸を掃除)
cp "$DIR/overlays.blur-verify-backup.json" "$DIR/overlays.json"
rm -f "$DIR/overlays.blur-verify-backup.json"
#    frames/ は中間生成物なので残っていても可(次回 frames 実行で全消去される)
```

- zoom×blur 警告も確認したい場合は、一時的に blur の区間を 50-60(zoom
  48.62-63.02 と重なる)にして `validate` し、警告が1件出ることを見る
  (確認後 24-30 に戻す)。
- **`plan` / `run` / `render` は実行しない**(手編集の cutplan 等を壊さない。
  検証は validate と frames だけで完結する)。

---

## 6. 落とし穴

1. **CSS blur は renderStill で効くか → 効く。** colorFilter が同じ CSS filter
   パスで最終レンダー・frames とも機能している実績がある(`chunkPlan.ts:126`、
   `colorFilter.ts`)。blur() も同じ。ここは心配不要。**mosaic の pixelated だけ
   要検証**(§5 タスク5)。

2. **pixelated 拡大のアーティファクト:** `image-rendering: pixelated` は
   Chromium で `<img>`/`<video>`/変形要素に効くが、**「小さくレンダーした video を
   CSS transform で拡大」した合成レイヤーにニアレストネイバーが効くかは環境依存**。
   効かないと格子でなく滑らかなぼかしになる(それでも隠れてはいる)。§3-4 の
   強ぼかしフォールバックを用意済み。**まず pixelated で実装 → frames で判定 →
   ダメなら差し替え**。深追い禁止(隠れれば目的達成)。

3. **座標系の取り違え:** rect は**出力px**(1920x1080)。`outputRectToCanvasRegion`
   で canvas px(screenRegion 基準)へ写像してから CroppedVideo に渡す。ここを
   出力px のまま CroppedVideo.region に渡すと、canvas 座標として解釈され
   ズレる(screenRegion にオフセットがある obs-canvas で特に顕著)。純関数に
   閉じ込め、テストで恒等ケース(screenRegion=全画面)と非恒等ケースを固定する。

4. **zoom transform の影響:** blur レイヤーは zoom コンテナの**外**に置く
   (判断3/4)。中に入れると zoom で矩形ごと動いてしまう。かつ blur パッチが
   再クロップするベース映像も**素(非zoom)**なので、zoom が無い時刻では背景と
   完全一致し、zoom と重なる時刻は validate 警告で回避を促す。差し込み位置を
   間違えて zoom コンテナ内に入れないこと。

5. **blur() のにじみと硬いエッジ:** `overflow: hidden` でにじみを矩形内に
   閉じ込める(矩形外へぼかし帯が漏れない)。副作用として矩形の縁1〜2px は
   ぼかしが弱い。**秘匿範囲より数px 大きめの rect** を推奨(usage に明記)。

6. **音声の二重再生:** blur パッチの renderBase 呼び出しは必ず `muted=true`。
   ベース映像本体が音を持つので、パッチは無音にする(そうしないと同じ素材の
   音が重なる)。`useFrameHold` はミュート時 feed しない実装なので、パッチが
   共有フレームホールドを汚すこともない。

7. **後方互換(最重要):** blurs 未指定なら props に blurs キーが載らず
   (renderProps の `bllength>0 ? {blurs} : {}`)、Main の `.map` は空配列で
   何も描かない。defaultProps にも blurs を足さない。**この不変条件を frames の
   前後 diff(§5 タスク5・手順5)で必ず確認**。

8. **チャンクキャッシュの取り扱い:** blurs は**局所**要素なので chunkKey の
   `local` に入れる(globalVideoProps に入れると全チャンク無効化=毎回フル
   レンダーになり遅くなる)。zooms と同じ扱い。逆に local に入れ忘れると、
   blur を編集しても再レンダーされず絵が更新されない(ズームが出ない診断
   チェックリストと同じ「計算は正しいのに絵に出ない」症状)。

9. **エディタ(proxy)での境界フラッシュ:** blur は `t∈span` の条件描画で
   mount/unmount するため、エディタ preview で span の境目に一瞬 video が
   再マウントされうる。**最終レンダー・frames には無関係**(独立フレーム)。
   気になるなら将来 opacity ゲートへ変えるが、v1 はスコープ外。

10. **shorts への非継承を忘れない:** Main の blur 描画は `!props.layout` で
    ゲート。renderProps のショート経路は blurs を渡さない(現状のまま)。両方で
    塞ぐこと(片方だけだと将来 props を渡し始めたとき座標ズレ事故になる)。

---

## 付録: 変更ファイル一覧(実装者チェックリスト)

- [ ] `src/types.ts` — BlurType / BlurRegion / DEFAULT_BLUR_* / Overlays.blurs(T1)
- [ ] `remotion/props.ts` — RenderProps.blurs(T1)
- [ ] `docs/usage.md` + `CLAUDE.md` 表 — blurs 行追記(T1)
- [ ] `src/lib/blur.ts`(新規)+ `test/blur.test.ts`(新規)(T2)
- [ ] `src/stages/validate.ts` — KNOWN / blurs 検査 / zoom重なり警告 / shorts警告 + `test/validate.test.ts`(T3)
- [ ] `src/lib/renderProps.ts` — blurSpans 写像 + `test/renderProps.test.ts`(T4)
- [ ] `remotion/Main.tsx` — CroppedVideo/renderBase の imageRendering + blur レイヤー(T5)
- [ ] `src/lib/chunkPlan.ts` — local に blurs 射影 + `test/chunkPlan.test.ts`(T6)
