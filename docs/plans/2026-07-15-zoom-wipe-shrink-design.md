# ズーム中のワイプ縮小(zoom wipe shrink)設計

親ドキュメント: なし(単発)
依存: `2026-07-14-design-fastpath-design.md`(FAST 基底)/ 既存の zoom 演出
(`src/lib/zoom.ts`)・wipeFull(`src/lib/wipe.ts`)

## 1. 目的

画面ズーム(`overlays.json` の `zooms`)が効いている間、右下のカメラワイプを
80%(既定)へ縮小する。ズームで画面が拡大されるぶんワイプが相対的に大きく・
うるさく見えるのを抑える。

要件は3つ。

- 縮小率は 0.8 前後(config で変えられる)
- **縮小してもワイプの右・下の余白は変わらない**(= 右下アンカーで縮む。
  素の経路は `right:0/bottom:0` の flush のまま、design 経路は
  `design.camera.marginPx` の余白がそのまま残る)
- **縮小のトランジション(掛ける時間・カーブ)は zoom と同じ**。ズームインと
  同時に縮み、ズームアウトと同時に戻る

## 2. 現状の構造(実装前に読む)

- ズームの絵は `remotion/Main.tsx:113` の `zoomTransformAt` が返す
  `scale/translate` を**ベース映像レイヤーだけ**に掛けている。ワイプは
  layerOrder 上の別レイヤー(`Main.tsx:256-292`)で、zoom transform の外にある
  = 現在はズームしても寸法が一切変わらない
- ワイプの寸法はいま2経路。
  - design 無し: `wipeW`/`wipeHNow`(`Main.tsx:90-91`)。`right:0/bottom:0` の
    flush。`props.wipe.marginPx` は**ワイプの余白ではなくテロップの回避量**
    (`CaptionLayer.tsx:252`)なので混同しないこと
  - design 有り: `wipeRectAt(designCamera, width, height, wipeEase)`
    (`src/lib/design.ts:209`)が返す rect + 角丸
- どちらも `wipeEase`(= `wipeProgressAt`。0=通常の右下ワイプ、1=全画面)で
  wipeFull へ補間されている。ズーム縮小はこの上に**もう1つの係数**として乗る

## 3. 設計判断

### D1. 進行度 p を返す純関数を `src/lib/zoom.ts` に足す

`zoomTransformAt` と同じ区間探索・同じ ease クランプ(区間の半分まで)・同じ
smoothstep から、進行度 p ∈ [0,1] だけを返す `zoomProgressAt(t, zooms)` を
新設する。区間外は 0。

```ts
export function zoomProgressAt(t: number, zooms: ZoomSpan[]): number
```

**`zoomTransformAt` は p を使う形へ内部リファクタして式を1本に保つ**
(p の定義が2箇所に増えると「トランジションが zoom と同じ」という要件が将来
壊れる)。リファクタ後も `zoomTransformAt` の出力は 1 ビットも変えないこと
(既存 `test/zoom.test.ts` が固定している)。

要件「トランジションは同じ」はこれで自動的に満たされる: 縮小は zoom と同じ
`easeSec`/`easeOutSec`・同じカーブ・同じ区間を共有し、**縮小専用の時間設定は
導入しない**。

### D2. 縮小率は config → props に解決(コードにハードコードしない)

- `config.yaml` の `render.zoom.wipeScale`(既定 0.8)。`easeSec` の隣に置く
- 既定定数は `src/types.ts` の `DEFAULT_ZOOM_EASE_SEC`(`types.ts:660`)の隣に
  `DEFAULT_ZOOM_WIPE_SCALE = 0.8`
- **`overlays.json` のスキーマは変えない**(zoom 1件ごとの上書きは非目標。
  §7)。したがって編集ファイルの5点セット更新は不要

### D3. props への載せ場所は `zooms[].wipeScale`(`props.wipe` ではない)

`renderProps.ts:311-323` の zoomSpans 解決で、`easeSec` と同じ流儀で
`wipeScale: renderCfg.zoom?.wipeScale ?? DEFAULT_ZOOM_WIPE_SCALE` を各 span に
載せる(`remotion/props.ts:224` の zooms 型にも追加)。

**`props.wipe` に足してはいけない**: `props.wipe` は
`chunkPlan.ts:112-130` の `globalVideoProps` に入っているため、そこに置くと
値を変えるたび**全チャンクが失効**して差分レンダーが効かなくなる。
`zooms[]` は `chunkPlan.ts:202` の**局所キー**なので、その zoom に重なる
チャンクだけが再レンダーされる。

### D4. 係数の合成式(wipeFull との共存)

時刻 t での縮小係数:

```
p = zoomProgressAt(t, props.zooms)          // 0..1(zoom の smoothstep)
k = 該当 zoom span の wipeScale             // 既定 0.8
s = 1 - (1 - k) * p * (1 - wipeEase)        // 1=等倍, k=最小
```

`(1 - wipeEase)` を掛けることで、**wipeFull で全画面になっている間は縮まない**
(全画面ワイプを 80% に縮めるのは無意味なため)。zoom と wipeFull が重ならない
通常ケースでは `wipeEase = 0` なので `s = 1 - (1-k)·p` と等しい。

zoom が無ければ p=0 → s=1 → **現行と 1 ピクセルも変わらない**(この機能導入前と
バイト等価)。

### D5. 右下アンカーで縮める

- design 無し経路(`Main.tsx:276-292`): `width: wipeW * s`, `height: wipeHNow * s`
  を丸めて渡すだけ。コンテナが `right:0/bottom:0` なので右下が固定され、
  余白(=0)は不変
- design 経路(`Main.tsx:256-274`): `wipeRectAt` が返した rect に対し、
  **右下角を保ったまま** w/h に s を掛ける:

```
w' = round(rect.w * s)
h' = round(rect.h * s)
x' = rect.x + (rect.w - w')     // 右辺 = rect.x + rect.w を保存
y' = rect.y + (rect.h - h')     // 下辺 = rect.y + rect.h を保存
radius' = round(radiusPx * s)   // 角丸は相対的な丸みを保つため同じ s を掛ける
```

これは `wipeRectAt` の**呼び出し側**(Main.tsx)ではなく `src/lib/design.ts` に
純関数 `shrinkRectBottomRight(rect, radiusPx, s)` として置き、単体テストする。
`wipeRectAt` 自体のシグネチャ・出力は変えない(design FAST 基底
(`fastSegment.ts` / `designStill.ts`)が同じ値を使っているため)。

内側の `renderBase(cameraRegion, w', h', true)` にも縮小後の寸法を渡す
(`fit="cover"` なのでカメラ映像は縮んだ箱に center-crop され、歪まない)。

### D6. テロップの回避量(reserve)は縮小に追従させない

`CaptionLayer.tsx:252` の `reserve = wipe.widthPx + wipe.marginPx * 2` は
**据え置き**。理由は2つ。

- テロップが「縮んだワイプ」に合わせて zoom のたびに左右へ動くと落ち着かない
- reserve は `CaptionStill` の PNG キャッシュキー(`captionStillPropsOf` が
  `props.wipe` を含む)に効くので、追従させると FAST のテロップ PNG が
  zoom の有無で作り分けられてしまう。据え置けばキーは不変

縮む方向なので、被り(テロップがワイプに重なる)は増えない。

## 4. render 最適化: **再実装は不要**(重要)

3層すべてが zoom の存在をすでに知っていて道を譲るので、最適化コードは
1行も変えない。

| 層 | zoom があるときの現状 | 本変更の影響 |
|---|---|---|
| ワイプ焼き込み(composite) | `canBurnWipe`(`src/stages/render.ts:126`)が `zooms.length > 0` で `false` → ワイプは焼き込まれず Remotion が毎フレーム描く | なし。動くワイプはそのまま表現できる |
| FAST パス | `fastPlan.ts:333` が zoom 区間をまるごと **SLOW(Remotion)** へ送る | なし。縮小は必ず SLOW 区間で起こる。FAST 区間は p=0 = 恒等でバイト等価 |
| design FAST 基底 | ffmpeg がカメラを静的 rect で描くが、zoom 区間には入らない(同上) | なし |
| キャッシュキー | `render.key.json` / `render.chunks` / `cut.keeps.json` はすべて props 由来 | D3 に従い props に載せれば自動追随。**config を Main.tsx から直接読むと壊れる** |

境界の連続性: SLOW 区間は `[z.start, z.end)` で、`t = z.start` では p=0 =
縮小なし。直前の FAST 区間も縮小なし。よって FAST/SLOW 境界で絵は連続する。

`fastSegment.ts:170` / `:347` のワイプに関するコメント・分岐も変更不要。

## 5. 変更ファイル

| ファイル | 変更 |
|---|---|
| `src/lib/zoom.ts` | `zoomProgressAt` 新設 + `zoomTransformAt` を p 経由へ内部リファクタ(出力不変) |
| `src/lib/design.ts` | `shrinkRectBottomRight` 新設(`wipeRectAt` は不変) |
| `remotion/props.ts` | `zooms[]` の型に `wipeScale: number` を追加 |
| `remotion/Main.tsx` | 縮小係数 s を計算し、両ワイプ経路の寸法へ適用(D4/D5) |
| `src/lib/renderProps.ts` | zoomSpans に `wipeScale` を解決して載せる(`easeSec` と同じ流儀) |
| `src/lib/config.ts` | `render.zoom.wipeScale?: number` + コメント |
| `src/types.ts` | `DEFAULT_ZOOM_WIPE_SCALE = 0.8` |
| `config.yaml` | `render.zoom.wipeScale: 0.8` をコメント付きで |
| `docs/usage.md` | zoom の項に「ズーム中はワイプが `render.zoom.wipeScale` まで縮む(トランジションは zoom と同じ・右下アンカー)」 |

`src/stages/validate.ts` / `schemas/*` は**変更しない**(編集ファイルの
スキーマは不変。§D2)。

## 6. テスト

- `test/zoom.test.ts`(追記)
  - `zoomProgressAt`: 区間外=0 / 区間頭で 0 / ease 完了後 1 / ease 短縮
    (区間長の半分)/ easeOutSec 個別指定 / smoothstep 値が
    `zoomTransformAt` の scale から逆算した進行度と一致すること
  - 既存の `zoomTransformAt` の期待値が**リファクタ後も 1 つも変わらない**こと
    (回帰の要)
- `test/design.test.ts`(追記)
  - `shrinkRectBottomRight`: s=1 で恒等 / s=0.8 で右辺・下辺が保存される /
    丸めても右下角がずれない / radius にも s が掛かる
- `test/renderProps.test.ts`(追記)
  - config の `wipeScale` が各 zoom span に解決されて載る / 未設定時は 0.8 /
    **zoom が無ければ props はこの機能導入前とバイト等価**
- `test/chunkPlan.test.ts`(追記)
  - `wipeScale` の変更が**その zoom に重なるチャンクのキーだけ**を変え、
    `globalVideoKey` は変えないこと(D3 の回帰)

`npm test` と `npx tsc --noEmit` が緑であること。

## 7. 非目標(やらないこと)

- `overlays.json` の zoom 1件ごとの `wipeScale` 上書き(将来必要になったら
  5点セット更新とともに)。今回は config 全体の1値だけ
- ワイプの**位置**を zoom 中に動かす(左下へ逃がす等)。縮むだけ
- テロップ reserve の zoom 追従(D6)
- ショート(`props.layout` あり)への適用。ショートにはワイプという概念自体が
  無い(`Main.tsx:325`)
- 最適化コード(`fastPlan` / `fastSegment` / `canBurnWipe`)への変更(§4)
