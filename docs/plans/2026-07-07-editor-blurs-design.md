# GUI エディタに「領域ぼかし/モザイク(overlays.blurs[])」編集を足す設計

- 対象: `editor/client/`(GUI エディタ)。レンダー側(`src/lib/blur.ts` /
  `src/lib/renderProps.ts` / `remotion/`)と検査(`src/stages/validate.ts`)は
  実装済み。今回は **エディタ UI だけ**。
- スキーマ `BlurRegion`(`src/types.ts`)は確定・変更禁止。
- 診断: `docs/reviews/2026-07-06-ai-native-nle-diagnosis.md` の Now ロードマップ。

---

## 0. 前提として確定した事実(再調査不要)

この設計は次の実測に立脚する。

1. **プレビュー Player は既にぼかし効果を描画している。**
   `App.tsx` の `built` は `buildRenderProps({... overlays ...})` を呼び、
   `renderProps.ts:222-230` が `overlays.blurs` をカット後タイムラインへ写像して
   `props.blurs`(`remotion/props.ts:153`)に載せる。`remotion/Main.tsx:405-448` は
   その `props.blurs` を CSS `filter: blur()` / モザイクで描く。エディタの
   `<Player inputProps={playerProps ?? built.props}>` は同じ `Main` を使うので、
   **overlays.json に blurs があれば効果は今もプレビューに出ている**(編集 UI が
   無いだけ)。→ 判断1のコストが大きく下がる。

2. **ショートは blurs を継承しない(自動)。** ショートモードの `built` は
   `overlays: { captionTracks: activeShort.captionTracks }` だけを渡す
   (`App.tsx:701-702`)ので `props.blurs` は空。ショートのプレビューにぼかしは
   出ない。この非継承は追加実装なしで既に正しい。

3. **効果の描画はゼーム(zoom)とほぼ同型。** blur も `{start,end,rect}`+出力px
   固定 rect。zoom は「プレビュー上の rect ドラッグ(`LiveMaterialOverlay`)+
   専用タイムライントラック+Inspector パネル」で編集できている。**この zoom
   経路を写経するのが最小コストで確実**。相違は (a) rect が拡大率ではなく
   目隠し領域、(b) 追加フィールドが `easeSec` ではなく `type` / `strength`、
   (c) layerOrder に載らない(zoom も載っていない — 同じ)。

4. **rect はみ出し等の不正は保存時に既にブロックされる。** `/api/save` →
   `saveProject`(`editor/server.ts:659-673`)が `validateDocs` を前置し、
   `validate.ts:526-555` が rect 範囲外・type 不正・strength 範囲外を **error** に
   する(保存拒否 → GUI はエラートースト)。blur/zoom 時間重なり・
   blur+shorts は **warn**(`validate.ts:562-583`)で保存は通る。

5. **`buildRenderProps` は blur/zoom 重なりを warn しない。** その warn は
   `validate.ts` にしか無い。GUI の `built.warnings`(→ `.warnbox`)は
   `buildRenderProps` の `warn` コールバックと、`App.tsx:738-743` の hideCaption の
   ように `built` useMemo 内で明示 push した文言だけを映す。→ 判断5は
   hideCaption と同じ「useMemo 内で push」パターンで GUI に出す。

---

## 1. 6つの設計判断(論点 / 選択肢 / トレードオフ / 結論)

### 判断1: プレビュー上の表現(効果込み vs 枠だけ)

- 選択肢
  - (a) zoom と同じく **枠線+8ハンドルだけ**を重ね、効果は出さない。
  - (b) エディタ側で CSS `filter:blur`/モザイクを **効果込み**で重ねる。
- トレードオフ
  - 事実0-1 より、効果は **Player が既に描いている**。つまり (b) の「効果を
    見せる」部分は追加実装ゼロで達成済み。エディタが別途 filter を重ねると
    **二重掛け**になり、プロキシ(幅1280アップスケール)上の見た目が最終出力と
    ずれる(px 写像は `src/lib/blur.ts` が持つが、エディタで再現するのは重複実装で
    陳腐化リスク)。
  - 必要なのは「掴んで動かす/リサイズする透明な編集枠」だけ。これは zoom が
    使う `LiveMaterialOverlay`(`MaterialOverlay.tsx`)がそのまま流用できる
    (`OverlayRect { index, rect }` を出し、`onRectChange(index, rect)` で
    出力px の rect を返す。座標変換は同コンポーネントが持つ)。
- **結論: (a)+事実0-1。効果は Player 任せ(既存)、編集は zoom と同じ
  `LiveMaterialOverlay` の枠+ハンドルを1枚重ねる。** エディタ独自の filter は
  足さない(二重掛け・写像の二重管理を避ける)。枠の見た目は素材/zoom と共通の
  `.matBox`。zoom の枠と同時表示になる可能性は低い(別トラック・別選択)ため、
  当面は色分けせず流用する(必要なら `.matBox.blur` を後追いで足せる。任意)。

### 判断2: タイムライントラック(専用 vs zoom 同居)

- 選択肢
  - (a) blurs 専用トラックを1本足す。
  - (b) zoom トラックに同居させる。
- トレードオフ
  - blurs は `layerOrder` に **載らない独立レイヤー**(出力px固定・素材/テロップの
    下)。zoom も layerOrder 非対象で、`model.ts` の `buildTracks` が末尾に
    `TRACK_DEFS.zoom, TRACK_DEFS.cut, TRACK_DEFS.bgm` を **固定追加**している
    (`reorderable`/`layer` 無し)。blur は同じ「固定・非 reorderable」トラックとして
    zoom の隣に足すのが素直。
  - 同居(b)は選択 addressing(`kind:"zoom"` と `kind:"blur"`)を1トラックに
    混在させ、クリップ色や作成種別(`createKind`)が二択になって複雑。利得なし。
- **結論: (a) 専用トラック `blur`。** `buildTracks` の末尾固定群に
  `TRACK_DEFS.blur` を zoom の直後で追加。`createKind:"blur"`・非 reorderable・
  `layer` 無し(layerOrder に書かない)。selection kind は独立の `"blur"`。

### 判断3: 追加/削除の導線

- 選択肢
  - (a) blur トラックの空き領域ドラッグで作成(zoom と同じ)。
  - (b) 追加ボタン+再生ヘッド位置に既定尺で挿入。
- トレードオフ
  - zoom/wipeFull/overlays/bgm はすべて **トラックの空きドラッグ**(`onCreate` →
    `addByKind`)で作る。既定尺は「ドラッグした区間」。blur だけ別導線にすると
    一貫性を欠く。既定 rect は zoom の `addZoomSpan`(出力中央の 1/2 サイズ)を
    踏襲するが、blur は目隠しなので **中央の小さめ矩形**(例: 出力の 1/3 幅 ×
    1/6 高、中央)を叩き台にし、Inspector/枠ドラッグで詰めさせる。
  - 削除は選択して Delete キー(`removeSelected`)+ Inspector の削除ボタン
    (zoom と同じ)。
- **結論: (a)。** `addBlurSpan(start, end)` を追加、`addByKind`/`onCreate` に
  `"blur"` を配線。start/end はドラッグ区間(元収録の秒、`srcAt` 経由)。
  既定 type は省略(=blur)、strength も省略(=0.5)で JSON を汚さない。
  削除は `removeBlur` + `removeSelected` の分岐。

### 判断4: Inspector の編集項目

- 既存の zoom Inspector(`Inspector.tsx:1378-1428`)の構成
  (`InspHead` → 説明 → `TimingSection` → rect → 追加フィールド → 削除)を踏襲。
- blur 固有:
  - **rect**: X/Y/W/H の `NumInput` 4つ+プレビュー枠ドラッグ。zoom の
    `ZoomRectControl` は「拡大率/四隅プリセット」が主で blur には意味が薄い
    (blur は倍率概念なし)。→ **plain な X/Y/W/H フィールド**にする
    (`ZoomRectControl` 下半の X/Y・幅/高さ部分と同じ作り。倍率/中央プリセットは
    出さない)。新規小コンポーネント `BlurRectControl`(or 既存の rect 数値
    フィールドを薄く共有)。
  - **type**: `blur`/`mosaic` の2択。セグメントボタン(既存の pos プリセット
    ボタンと同じ `rectPresets` スタイル)。既定 `blur` のときはキーを書かない
    (undefined を渡して `updateBlur` がキー削除)。
  - **strength**: 0〜1 のスライダー(`<input type="range" min=0 max=1 step=0.05>`)
    +現在値表示。既定 0.5 のときはキーを書かない(undefined でキー削除)。
    「0=効果なし〜1=最大」のヒント。
  - **start/end**: `TimingSection`(zoom と同じ。`getPlayheadSrc`/`seekToSrc` 連携)。
- **結論: zoom パネルの骨格 + `BlurRectControl`(X/Y/W/H)+ type セグメント +
  strength スライダー。** 既定値(type=blur / strength=0.5)は「undefined を
  `updateBlur` に渡してキーごと消す」で JSON を最小化(zoom の easeSec・
  insert/bgm の undefined 削除と同じ流儀。`updateZoom`/`updateInsert` の
  `if (patch[k] === undefined) delete entry[k]` を踏襲)。

### 判断5: validate 警告(blur/zoom 重なり・blur+shorts)の GUI 表出

- 事実0-5 より、この2つの warn は `validate.ts` にしか無く、`buildRenderProps` は
  出さない。保存時には `validateDocs` の warn は保存を止めない(error だけ止める)
  ので、放置するとユーザーは GUI 上で気づけない。
- 既存の受け皿: `App.tsx` の `built` useMemo が `warnings: string[]` を作り、
  `.warnbox`(プレビュー右下)に出す。hideCaption は `built` 内で明示 push している
  (`App.tsx:738-743`)。
- **結論: `built`(本編ブランチ)useMemo 内で、hideCaption と同じ流儀で2つの
  警告を計算して push する。**
  - blur×zoom 時間重なり: `overlays.blurs` と `overlays.zooms` の
    `[start,end)` が交差するペアがあれば「ぼかしが zoom に追従せず露出しうる」旨。
  - blur かつ shorts あり: 「ぼかしはショートに継承されない」旨。
  文言は `validate.ts` の warn に合わせる。rect はみ出し等の **error** は保存時に
  既にトーストで出る(重複させない)。ショートブランチには blur 警告を出さない。

### 判断6: ショートモードでの扱い

- blurs は座標が本編基準で **ショートに継承されない**(事実0-2)。
- zoom の前例: `zoomIntervals` は `if (!overlays || shortMode) return []`
  (`App.tsx:1323`)で shortMode を弾き、`clips` のショートブランチは zoom を
  積まない。`timelineTracks` は shortMode で `[SHORT_TRACK_DEF, ...caption]` に
  絞る(`App.tsx:676-679`)ので zoom/blur トラックは自然に消える。
- **結論: blur も全面的に shortMode で非表示・非編集。**
  `blurIntervals` は `shortMode` で `[]`、`clips` のショートブランチに blur を
  積まない、blur トラックは本編 `tracks` にだけ入る(timelineTracks の絞り込みで
  ショートからは自動除外)、`built` の blur 警告は本編ブランチだけ。効果も出ない
  (事実0-2)。

---

## 2. 変更するファイルと関数/コンポーネント(シンボルで特定)

行番号は使わない(先行変更でズレるため)。

### `editor/client/model.ts`
- `SpanKind` に `"blur"` 追加。
- `AddKind` に `"blur"` 追加。
- `SelKind` に `"blur"` 追加(→ `Selection`/`Clip.kind` が自動追随)。
- `TrackId` に `"blur"` 追加。
- `TRACK_DEFS` に `blur` エントリ追加(`id:"blur"`, `label:"ぼかし"`,
  `createKind:"blur"`, `hint:...`。`reorderable`/`layer` は付けない)。
- `buildTracks` の末尾固定群を `..., TRACK_DEFS.zoom, TRACK_DEFS.blur,
  TRACK_DEFS.cut, TRACK_DEFS.bgm` にする(zoom の直後)。

### `editor/client/App.tsx`
- `selectionValid`: `if (sel.kind === "blur") return sel.index < (d.overlays.blurs ?? []).length;`
- `clips` useMemo(本編ブランチ): `(overlays.blurs ?? []).forEach(...)` で
  `kind:"blur", track:"blur"` のクリップを積む(zoom の forEach を写経。
  `remapInterval(b.start,b.end,timeline)`、label は "ぼかし"/"モザイク")。
  ショートブランチには積まない。
- `blurIntervals` / `visibleBlurKey` / `getVisibleBlurs`: `zoomIntervals` /
  `visibleZoomKey` / `getVisibleZooms` の写経(`shortMode` で `[]`)。
- `onDragMove`: `sel.kind === "zoom"` ブランチの直後に `sel.kind === "blur"`
  ブランチを追加(rect/type/strength は動かさず `retime` で move/trim のみ。
  zoom ブランチと同一形)。
- `addBlurSpan(start, end)`: `addZoomSpan` を写経(既定 rect は中央小矩形)。
- `updateBlur(i, patch, coalesceKey?)` / `removeBlur(i)`: `updateZoom` /
  `removeZoom` を写経。**追加点**: `removeBlur` と、`updateBlur` で
  patch が全キー消し等になった場合、**blurs 配列が空なら `blurs` キーごと削除**
  (`bgm` の `removeBgm` が空で null に戻すのと同じ精神。判断3・完了基準のため)。
- `addByKind`: `else if (kind === "blur") addBlurSpan(start, end);`
- `onCreate`: `else if (track === "blur") addByKind("blur", round2(s), round2(e));`
- `removeSelected`: `else if (selection.kind === "blur") removeBlur(selection.index);`
- `built` useMemo(本編ブランチ): 判断5の2警告を push。
- JSX プレビュー: zoom の `<LiveMaterialOverlay .../>` の直後に blur 用の
  `<LiveMaterialOverlay getKey={visibleBlurKey} getOverlays={getVisibleBlurs}
  selection={selection?.kind==="blur"?...} onSelect={...blur} onRectChange={(i,rect)=>updateBlur(i,{rect},`blur:${i}:drag`)} />`
  を追加(caption オーバーレイより前=下に置く)。
- JSX Inspector: `updateBlur`/`removeBlur` を props で渡す。

### `editor/client/Inspector.tsx`
- props 型に `updateBlur` / `removeBlur` を追加(`updateZoom`/`removeZoom` と同型)。
- `if (selection.kind === "blur") { ... }` パネルを zoom パネルの直後に追加。
- 新規部品 `BlurRectControl`(X/Y/W/H の `NumInput`。倍率/中央プリセットなし)。
  type セグメントボタン+strength スライダーはパネル内にインラインでよい。

### `editor/client/index.html`
- `.tlClip.blur { background: <色>; top:5px; bottom:5px; }` を追加
  (zoom/wipeFull と同じ「薄い帯」スタイル。色は既存と重複しない一色、例
  `#4c1d95` 系や `#334155`。zoom=`#6d28d9` と識別できる色)。

### `editor/client/MaterialOverlay.tsx`
- **変更なし**(そのまま流用)。任意で `.matBox.blur` 色分けを足すなら
  `index.html` 側のみ。

### `editor/client/Timeline.tsx`
- **変更なし**(クリップは `clip.kind` の CSS クラスで汎用描画。トラックは
  `model.ts` の `buildTracks` から来る。空きドラッグ作成は `track.createKind`
  で汎用処理)。

### `src/types.ts`
- **変更なし**(BlurRegion は確定済み。`Overlays.blurs` も既存)。

---

## 3. タスク分解(1タスク=1コミット)

各タスク: ①変更 ②テスト方針 ③壊してはいけない既存挙動。
全タスク共通の不変条件: **zoom / 素材 / テロップ / insert / bgm / ショートの
編集・保存・ホットリロード・undo/redo が不変**。各コミットで `npm run typecheck`
と `npm test` が緑。

### T1: モデル層に blur の語彙とトラックを足す
- ①変更: `model.ts` の `SpanKind`/`AddKind`/`SelKind`/`TrackId` に `"blur"`、
  `TRACK_DEFS.blur` 追加、`buildTracks` に zoom 直後で挿入。
- ②テスト: `npm run typecheck`(型の網羅)。`buildTracks` に純関数テストが
  あれば blur トラックが zoom と cut の間に1本入ることを assert(`test/` に
  該当が無ければ typecheck + 起動目視)。headless: エディタ起動で「ぼかし」
  トラックが1行増えることを確認。
- ③不変: 既存トラックの並び・ラベル・reorderable・数(素材/テロップ可変本数、
  wipe/zoom/cut/bgm)が blur 追加以外変わらない。blur は非 reorderable・
  layerOrder 非対象(layerOrder を書き換えない)。

### T2: blur クリップをタイムラインに描く(読み取りのみ)
- ①変更: `App.tsx` の `clips`(本編ブランチ)に blur forEach を追加。
  `index.html` に `.tlClip.blur` の色。`selectionValid` に blur 分岐。
- ②テスト: blurs を1件持つ overlays.json を用意した収録で起動し、blur トラックに
  帯が出て、クリック選択が効く(Inspector はまだ次タスク)ことを headless で
  確認。`remapInterval` 経由なのでカット跨ぎで割れることも zoom と同じ。
- ③不変: blurs 無しの overlays では blur クリップは1つも出ない
  (`overlays.blurs ?? []` 空)。他 kind のクリップ描画・選択が不変。

### T3: プレビュー上の編集枠(移動・リサイズ)
- ①変更: `App.tsx` に `blurIntervals`/`visibleBlurKey`/`getVisibleBlurs`、
  JSX に blur 用 `<LiveMaterialOverlay>`(zoom の直後)、`updateBlur`
  (rect 反映・空で `blurs` キー削除ロジック込み)。`onDragMove` の blur ブランチ
  (move/trim)。
- ②テスト: 既存 blur を選択し、枠ドラッグで rect が動く/端でリサイズできることを
  headless で確認(matBox のドラッグ)。効果(Player の blur)が rect 追従で
  ずれることを目視。タイムライン上の move/trim で start/end が変わる。
- ③不変: zoom/素材の `LiveMaterialOverlay` が従来どおり(blur 枠は caption 枠
  より下、zoom 枠の隣。ポインタ優先順位が既存を崩さない)。`onDragMove` の
  zoom/insert/bgm/cut/short/overlays ブランチが不変。

### T4: 作成・削除の導線
- ①変更: `addBlurSpan`、`addByKind`/`onCreate` の blur 配線、`removeBlur`、
  `removeSelected` の blur 分岐。
- ②テスト: blur トラックの空きをドラッグ → 既定 rect の blur が1件でき選択される。
  Delete キー/選択解除で消える。最後の1件を消すと `blurs` キーが消える(保存 JSON
  を確認)。headless + 保存出力の目視。
- ③不変: 他トラックの空きドラッグ作成(zoom/wipe/overlays/bgm/caption/short)が
  不変。Delete の他 kind 挙動(cut は「カットに倒す」など)が不変。

### T5: Inspector パネル(rect / type / strength / start-end)
- ①変更: `Inspector.tsx` に blur パネル+`BlurRectControl`、props に
  `updateBlur`/`removeBlur`、`App.tsx` の `<Inspector>` に両 props を配線。
  type=blur・strength=0.5 の既定は undefined 渡しでキー削除。
- ②テスト: blur 選択で X/Y/W/H 編集・type 切替(blur⇄mosaic)・strength
  スライダー・start/end 編集が overlays.json に反映。既定値はキーが書かれない
  (JSON 最小)ことを保存出力で確認。rect を画面外に出す数値を入れて保存 →
  既存の validate error でトースト拒否(サーバ既存挙動)。
- ③不変: zoom/素材/insert/bgm/caption/cut の各 Inspector パネルが不変。
  `NumInput` の undefined 削除挙動が他パネルで不変。

### T6: validate 警告の GUI 表出(判断5)
- ①変更: `App.tsx` の `built`(本編ブランチ)に blur×zoom 重なり・blur+shorts の
  2警告を push(hideCaption と同じ流儀)。
- ②テスト: blur と zoom を時間で重ねる → `.warnbox` に警告が出る。shorts が
  あって blur がある → 継承なし警告。どちらも保存は通る(warn であり error で
  ない)。ショートモードでは blur 警告が出ない。
- ③不変: hideCaption 等の既存警告が不変。ショートブランチの警告が不変。

### T7(任意): 純関数の抽出とユニットテスト
- blur×zoom 重なり判定など、`built` 内のロジックが複雑なら小さな純関数に
  切り出して `test/` に unit を足す(既存の `renderProps`/`timeline` テスト方針に
  合わせる)。UI 依存部は headless 目視に委ねる。

---

## 4. 完了基準

- **blurs を1件も持たない overlays.json では、保存出力がバイト等価**:
  blur 由来のコードはすべて `overlays.blurs ?? []`(空)でノーオペになり、
  `blurs` キーを新規に書かない。既存収録を開いて他を触らず保存 → cutplan/
  overlays/transcript/bgm/shorts が従来と byte 一致。
  - 追加/削除を往復しても byte 等価に戻る(最後の blur を消すと `blurs` キーごと
    削除 = 空配列 `blurs: []` を残さない。`removeBlur`/`updateBlur` で保証)。
- 既存サーフェス(zoom・素材・テロップ・insert・bgm・カット・ショートの編集、
  保存、SSE ホットリロード、undo/redo)が不変。
- `npm run typecheck` / `npm test` が緑。
- 追加 UI(意図的な唯一の加算要素): タイムラインに常設の空「ぼかし」トラックが
  1本増える。これは **既存の空「ズーム」トラックと同性質**(zoom も blurs も
  無い収録で常時表示され、空きドラッグで作成する)であり、保存 JSON には影響
  しない。→ 「blur レス収録での UI 不変」は「保存バイト等価 + 既存トラック/
  クリップ/Inspector 挙動不変」を指し、空 blur トラックの1行だけが加算。
  - **設計判断の含み(要コーディネータ確認)**: 空トラック1行すら出したくない
    (厳密 UI 不変)なら、代替として「blur トラックは `overlays.blurs?.length>0`
    のときだけ描画し、最初の1件は別導線(例: 選択なし時のツールバー/右クリック)で
    作る」も可能。ただし zoom との一貫性・発見性は落ちる。**推奨は常設トラック
    (zoom と同型)** で、この含みを承知の上で採る。

---

## 5. 想定リスク

- **blur 枠と zoom 枠の見分け**: 同時刻に両方が再生ヘッド上にあると、プレビューに
  同色の `.matBox` が2枚重なる。実害は小さい(別選択・別トラック)が、必要なら
  `.matBox.blur` の色分けを足す(index.html のみ、任意)。
- **効果の二重掛け回避**: 判断1で「エディタ側で filter を掛けない」を守る限り
  安全。将来 blur 枠に効果プレビューを足したくなっても、Player が既に描くので
  不要(触ると二重掛け)。
- **既定 rect の妥当性**: 中央小矩形は叩き台。目隠し対象(端の API キー等)から
  外れることが多いので、Inspector 説明とプレビュー枠ドラッグで即調整できる導線を
  明記する。
- **undo/redo の一貫性**: blur は `overlays` に属すので `pushHistory` の
  overlays スナップショットに自動で乗る(bgm/zoom と同じ)。`updateBlur` の
  coalesceKey(`blur:i:drag` / `blur:i:rect`)を zoom と同じ粒度にすること。
- **strength スライダーの既定値表現**: 0.5 を「未指定(=既定)」と「明示 0.5」で
  区別しない設計(どちらも描画は同じ)。JSON 最小化のため既定と一致なら
  キーを消す方針を徹底する(type も同様)。
