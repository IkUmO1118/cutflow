# 通常動画(plain)の一級サポート — 実装計画

対象: OBS 拡張キャンバス方式でない通常の動画(スマホ・カメラ・画面録画)を
ingest からエディタ・レンダーまで一級サポートする。**OBS 形式(obs-canvas)の
既存挙動は完全維持する。** 音声なし動画は対象外(ingest の既存エラーを維持)。

判断の要約は `docs/decisions.md` の該当エントリを参照。この文書は実装セッションへ
渡す実装分解(スキーマ差分+1タスク=1コミット)。

> **前提(このリビジョンの経緯)**: 初版は main ベースのコードを読んで書かれたが、
> その後 feature/editor-improvements(shorts / zooms / panels / チャンク差分
> レンダー / colorFilter / thumbnail / plan-shorts)がマージされた。本版は
> **マージ後のコード**で行番号・消費箇所・描画経路を取り直し、これらの新機能と
> plain の相互作用まで設計に含めている。初版にあった「引き継ぎ資料の訂正
> (profile.ts / zooms は幻)」の節は誤認だったので削除した(いずれも実在する)。

---

## 設計の核

現状 `manifest.video.screenRegion` は ingest 時に config から焼き込まれているのに、
出力解像度は **config から再び読まれている**(二重の真実源)。マージ後はこの
再読みが `src/lib/profile.ts` の `resolveProfile(cfg, "default")` に集約されており、
render / frames / thumbnail / editor がそこを通って `cfg.ingest.screenRegion` に
到達する。これを **manifest 一本に寄せる**のが plain 対応の要:

- **出力解像度 = `manifest.video.screenRegion.{w,h}`**(config ではなく manifest)。
  obs-canvas では値が同じなので出力はバイト同一。plain では screenRegion=全フレーム
  なので、縦動画は縦のまま・4K は 4K のまま、config を触らず自然に出る。
- **plain は「カメラの無い obs-canvas」として表現する。** `cameraRegion` を
  optional にし、plain では持たない。ワイプ(器の crop 元)が無い=ワイプ関連
  機能を出さない、という一点に集約される。`CroppedVideo` は screenRegion=全フレーム
  なら scale=1 の恒等クロップになり、既存の描画経路をそのまま流用できる。

### マージ後の新機能と plain の関係(要点)

| 機能 | カメラ依存か | plain での方針 |
|---|---|---|
| `wipeFull`(overlays.json) | **依存**(カメラを全画面化する演出) | validate **エラー**(crop 元が無い) |
| `zooms`(overlays.json) | 非依存(背景=画面クロップだけを拡大。Main.tsx:337) | そのまま可。validate の rect 上限は manifest.screenRegion で判定 |
| `colorFilter`(overlays.json) | 非依存(ベース映像への CSS filter。plain では画面クロップだけ) | そのまま可 |
| `thumbnail`(thumbnail.json) | 非依存(default profile で buildRenderProps を通す) | B1 のワイプガード後にそのまま可(全編 keep+texts のみ) |
| ショート(shorts.json / profile) | 縦プリセット `vertical` / `vertical-cover` は `source:"camera"` パネル前提(profile.ts:36,46) | 「plain にカメラは無い=カメラは全フレーム」の規約で `camera`→`screen` に解決。`vertical`(画面+カメラ2段)は validate エラー、`vertical-cover`(カメラ全面)と `default` は可(→ B4) |

---

## Manifest / RenderProps スキーマ差分(types.ts / remotion/props.ts)

### `src/types.ts` — Manifest

```ts
export interface Manifest {
  dir: string;
  source: string;
  durationSec: number;
  /** レイアウト。省略時は "obs-canvas"(旧 manifest 互換)。
   *  obs-canvas: 拡張キャンバス(画面+カメラ横並び)。cameraRegion を持つ
   *  plain:      通常動画。カメラ無し。screenRegion は全フレーム */
  layout?: "obs-canvas" | "plain";
  video: {
    width: number;
    height: number;
    fps: number;
    /** 出力に使う画面領域(=出力解像度)。obs-canvas は 3840x1080 内の
     *  画面部分、plain は全フレーム(= {x:0,y:0,w:width,h:height}) */
    screenRegion: Region;
    /** カメラ(ワイプ)領域。plain では無し(ワイプ非対応) */
    cameraRegion?: Region;   // ← optional 化(既存は必ず持つので後方互換)
  };
  audio: { micStream: number; systemStream: number | null; micWav: string };
  createdAt: string;
}

/** manifest のレイアウト(未指定は旧 manifest 互換で obs-canvas) */
export const manifestLayout = (m: { layout?: string }): "obs-canvas" | "plain" =>
  m.layout === "plain" ? "plain" : "obs-canvas";

/** ワイプ(カメラ)を持つレイアウトか。plain・cameraRegion 欠落は false */
export const hasCamera = (m: Manifest): boolean =>
  manifestLayout(m) === "obs-canvas" && m.video.cameraRegion != null;
```

後方互換: 既存 manifest は `layout` を持たない → `manifestLayout` が
"obs-canvas" を返し、`cameraRegion` も持つので `hasCamera` = true。挙動不変。

### `remotion/props.ts` — RenderProps

```ts
export type RenderProps = {
  ...
  screenRegion: Region;
  cameraRegion?: Region;   // ← optional 化(現在は必須)。plain では undefined
  ...
};
// defaultProps は obs-canvas のダミー値のまま(cameraRegion を持つ)。変更不要。
```

`cameraRegion` を optional にすると Main.tsx の直参照(`props.cameraRegion.h` 等、
現状 4 箇所)が型エラーになる。それを B1 で潰すのがこの計画の描画側の本体。

### `src/lib/config.ts` / `config.yaml` — ingest.layout

```ts
ingest: {
  screenRegion: Region;
  cameraRegion: Region;
  micTrack: number;
  systemTrack: number;
  /** 収録レイアウトの既定。省略時 "obs-canvas"(旧 config 互換)。
   *  auto = キャンバス寸法(W×H)が完全一致なら obs-canvas、それ以外は plain */
  layout?: "obs-canvas" | "plain" | "auto";
};
```

config.yaml は既定 `obs-canvas` を明記(既存 OBS 収録の挙動を1ミリも変えない)。

---

## タスク分解(1タスク=1コミット)

### 前半 — データモデル+非表示ロジック(types / ingest / validate / renderProps)

#### F1. Manifest / RenderProps / Config のスキーマ拡張(挙動変更なし)
- `src/types.ts`: `Manifest.layout?`、`video.cameraRegion?` optional 化、
  `manifestLayout` / `hasCamera` を追加。コメントも更新。
- `remotion/props.ts`: `RenderProps.cameraRegion?` optional 化。`defaultProps` は不変。
- `src/lib/config.ts`: `ingest.layout?` 追加。
- **テスト方針**: `npm run typecheck` が通る(props の `cameraRegion` を optional に
  すると Main.tsx / chunkPlan.ts の直参照が型エラーになるので、F1 内で最小限の
  `?.` / ガードだけ入れて型を通すか、B1 まで `!`(non-null 断言)で暫定的に
  通すかを選ぶ。**推奨は F1 では触らず、B1 完了までこのコミットの typecheck は
  通さない前提にしない** — 代わりに F1 では props 型を optional にしつつ、
  Main.tsx / chunkPlan.ts 側の参照は F1 と同じコミットで最小ガードを入れて緑を保つ)。
  `test/*.test.ts` に `manifestLayout` / `hasCamera` の単体テスト(layout 未指定
  →obs-canvas、plain→plain、cameraRegion 欠落→hasCamera=false)を追加。
- **壊してはいけない**: 既存 manifest(layout 無し)が同じ意味で読める。
  `defaultProps` の形は不変(Remotion Studio が動く)。この時点で ingest は
  まだ layout を書かない=生成物は完全に従来どおり。

> **実装メモ**: `cameraRegion?` を optional にした瞬間に落ちる直参照は
> `remotion/Main.tsx`(wipeH 計算 82-84 / renderPanels 200 / wipeLayer 235-252 /
> renderBase 呼び 247)と `src/lib/chunkPlan.ts`(120-121 の globalVideoProps)。
> chunkPlan は `props.cameraRegion` を `stableHash` に渡すだけで undefined を
> そのまま無視できる(JSON.stringify がキーごと落とす)ので**変更不要**。
> Main.tsx は B1 の本丸。F1 のコミットを緑に保つため、Main.tsx の 4 箇所は
> B1 で入れるガードを F1 で先に入れてしまう(絵は obs-canvas では不変なので
> F1 と B1 を1コミットに統合してもよい。分けるなら F1 は「型+ガードで緑」、
> B1 は「plain fixture で見た目確認」に責務を分担する)。

#### F2. config.yaml に ingest.layout を追記(既定 obs-canvas)
- `config.yaml` の `ingest:` に `layout: obs-canvas` とコメントを追記。
- **テスト方針**: `loadConfig` が読めること(既存の config テストがあれば追随、
  無ければ手動 `node src/cli.ts validate` 系で起動確認)。
- **壊してはいけない**: `layout` キーの無い古い config.yaml でも
  `cfg.ingest.layout === undefined` として動く(F3 で undefined→obs-canvas 解決)。

#### F3. ingest の layout 解決と plain 書き出し
- `src/stages/ingest.ts`:
  - 実効 layout を決める純関数 `resolveLayout(explicit, cfgLayout, width, height, cfg)` を
    切り出す(テスト容易化)。優先順: 明示引数 > config > 既定 obs-canvas。
    `auto` はキャンバス寸法 **W=(screenRegion.w+cameraRegion.w) かつ H=screenRegion.h の
    完全一致で obs-canvas、それ以外は plain**。
  - plain のとき: `screenRegion = {x:0,y:0,w:width,h:height}`、`cameraRegion` は
    書かない、`width < expected` の警告(現 49-56 行)は出さない、
    `manifest.layout = "plain"`。
  - obs-canvas のとき: 従来どおり(screenRegion/cameraRegion を config から焼き込み、
    幅不足の警告も維持)+ `manifest.layout = "obs-canvas"` を明示的に書く。
  - `ingest()` に layout 引数(optional)を追加。
- 呼び出し口:
  - `src/cli.ts` の `ingest <dir>` / `run <dir>` に `--layout <plain|obs-canvas|auto>`
    フラグを追加し ingest へ渡す(未指定は config 既定)。
  - `src/stages/bootstrap.ts`: `bootstrapProject` が manifest 欠落時に呼ぶ
    `ingest(dir, findSource(dir), cfg)`(現 36 行)を **plain 明示**にする
    (`ingest(dir, findSource(dir), cfg, "plain")`)。動画だけのフォルダを
    editor で開く=通常動画のユースケースなので既定 plain が自然。
- **テスト方針**: `resolveLayout` の単体テスト(明示 plain / 明示 obs / auto の
  完全一致→obs / auto の 1920x1080→plain / auto の 3840x2160→plain / config 既定)。
- **壊してはいけない**: 既定(obs-canvas)経路の manifest は `layout: "obs-canvas"` が
  増える以外は従来と同一(screenRegion/cameraRegion/audio すべて同値)。既存 OBS
  収録に対する `run` の挙動不変。**auto は既定にしない**(3840x1080 の通常動画を
  誤判定するため。誤判定回避の明示手段として `--layout` を残す)。

#### F4. 出力解像度を manifest から読む(二重真実源の解消)
マージ後は「default プロファイル = 出力解像度」の解決が
`resolveProfile(cfg, "default")` に集約されている。ここを cfg ではなく
manifest 由来にするのが最小差分。

- `src/lib/profile.ts`: `resolveProfile` の "default" 分岐(現 59-61 行)が
  `cfg.ingest.screenRegion` を読んでいるのを、**出力サイズ引数**へ置き換える。
  推奨シグネチャ: `resolveProfile(defaultSize: {w:number;h:number}, name?)`
  ("default" は `{width: defaultSize.w, height: defaultSize.h}`、縦プリセットは
  defaultSize を無視して従来どおり固定サイズ)。`Config` 依存が消えるので
  profile.ts が config を import しなくなる(ブラウザ側とも共有しやすくなる)。
- 消費箇所を **manifest 由来の値**に全数差し替え(下記は全数調査済み):
  - `src/stages/render.ts:142` 本編: `resolveProfile(manifest.video.screenRegion, "default")`。
    `width/height`(149-150)はそのまま `profile.width/height`。
  - `src/stages/render.ts:333` ショート: `resolveProfile(manifest.video.screenRegion, short.profile ?? "vertical")`
    (縦プリセットは defaultSize を無視。`profile:"default"` のショートだけ
    manifest 由来になる=改善)。
  - `src/stages/frames.ts:107` 本編 / `:102` ショート: 同上。
  - `src/stages/thumbnail.ts:68`: `resolveProfile(manifest.video.screenRegion, "default")`。
  - `editor/server.ts:389` の `output`: `cfg.ingest.screenRegion` →
    `manifest.video.screenRegion`(loadProject 内で manifest を読んでいるので置換だけ)。
  - `editor/client/App.tsx:114` の `resolveShortProfile` は既に `output`(= 上の
    server が送る値)だけで "default" を解決している。server の output を manifest
    由来に切り替えれば**クライアントは無改造**でショートの "default" も manifest
    由来になる。
- `src/lib/renderProps.ts`: `buildRenderProps` は既に `manifest` を受け取り
  `props.cameraRegion = manifest.video.cameraRegion`(現 250 行)を渡している。
  plain では undefined がそのまま載る(props も optional に済み)。呼び出し側が
  上記のとおり manifest 由来の width/height を渡すよう統一するだけ。
- **チャンク差分レンダー / render.key への影響**: `chunkPlan.globalVideoProps`
  (120-121)は `screenRegion` / `cameraRegion` / `width` / `height` を既にキーへ
  含む。plain は cameraRegion=undefined になるが `stableHash`(JSON.stringify +
  キーソート)は undefined キーを落とすだけで安定。obs↔plain は
  width/height/screenRegion/cameraRegion のどれかが必ず違うのでキーは自然に
  分かれる(layout タグをキーへ足す必要は無い=冗長)。`render.key.json`
  (buildRenderCacheKey)も props 全体をハッシュするので追随不要。**このタスクで
  chunkPlan / renderKey のコードは変更しない**が、テストで「plain props でも
  キーが決定的」を1件固定する。
- **テスト方針**: obs-canvas の manifest(screenRegion 1920x1080)で
  `buildRenderProps` の `width/height/screenRegion/cameraRegion` が従来と同値に
  なる単体テスト。plain の manifest(例 1080x1920・cameraRegion なし)で
  `width=1080,height=1920,cameraRegion=undefined` になるテスト。`resolveProfile`
  の default 分岐が defaultSize を返すテスト。
- **壊してはいけない**: OBS の出力解像度 1920x1080 がバイト同一。config と
  manifest で screenRegion が食い違う場合は **manifest を正**とする(=ingest 後に
  config を変えても出力が壊れない。これは改善方向で退行ではない)。既存の
  チャンク差分レンダー・full-skip キャッシュのヒット判定が obs 収録で不変。

#### F5. validate に plain の本編ルールを追加
- `src/stages/validate.ts`:
  - `manifest.video.cameraRegion` の有無(= `hasCamera` 相当)を判定。validate は
    config を読まないので manifest だけで判断する(現に `outputRegion` を
    `manifest?.video?.screenRegion` から取っている 117 行と同じ流儀)。
  - plain(カメラ無し)で `overlays.wipeFull` が非空 → **エラー**
    (「plain 動画にはカメラ(ワイプ)が無いため wipeFull は使えません」)。
  - plain で `overlays.layerOrder` に `"wipe"` が含まれる → **警告**(無視される旨。
    既存の「wipe が無い」警告 457 行とは逆向き)。
  - `manifest.video.cameraRegion` 欠落を「壊れ」とはみなさない(plain の正常形)。
    現状 validate は cameraRegion を検査していないので、plain で新たなエラーが
    出ないことを担保する。
  - `zooms` の rect 上限判定(376-398 行)は `outputRegion = manifest.screenRegion`
    で動くので plain(全フレーム)でもそのまま正しい。**変更不要**(確認だけ)。
- `docs/usage.md` のスキーマ表・`src/types.ts` コメントを揃えて更新(規約)。
- **テスト方針**: `test/*.test.ts`(validate 固定テスト)に plain fixture を追加。
  plain + wipeFull → エラー1件、plain + wipe in layerOrder → 警告1件、
  plain + zooms(rect 範囲内)→ エラーなし、**obs fixture は従来どおり pass**
  (退行検知)。
- **壊してはいけない**: obs-canvas の検査結果(エラー/警告の数と内容)が不変。

### 後半 — 描画+エディタ UI(Remotion / editor / ドキュメント)

#### B1. Remotion Main.tsx を cameraRegion optional に対応
`cameraRegion` を optional にすると型エラーになる 4 箇所を、**カメラが無ければ
ワイプを一切描かない**方針で潰す。既存のショート(`props.layout` あり)経路は
すでにワイプを null にしているので(323 行)、そこへ「plain=cameraRegion 無し」を
同格で足すのが素直。

- `remotion/Main.tsx`:
  - `wipeH`(82-84 行): `props.cameraRegion` があるときだけ計算(無ければ 0 等の
    ダミーで、ワイプレイヤー自体を描かないので値は使われない)。
  - `wipeLayer`(235-252 行)と `renderBase(props.cameraRegion, …)`(247 行):
    `props.cameraRegion` 前提。wipe レイヤーを描かないので到達しないが、型の
    ために `cameraRegion` を非 optional に絞ったスコープで組む。
  - layerNode の `"wipe"` ノード(323 行): 現状 `id === "wipe" ? (props.layout ? null : wipeLayer) : null`
    を `props.layout || !props.cameraRegion ? null : wipeLayer` に(カメラ無しでも
    ワイプ非描画)。
  - 字幕の既定位置フォールバック(304-318 行、位置指定も captionDefaultPos も
    無いテロップの下部中央)の**ワイプ回避の右側予約**: `width: props.width -
    props.wipe.widthPx - props.wipe.marginPx*2` を、カメラが無ければ全幅にする
    (`const reserve = props.cameraRegion ? props.wipe.widthPx + props.wipe.marginPx*2 : 0;`
    を使って `width: props.width - reserve`)。plain の本編は字幕が全幅中央になる。
  - `renderPanels`(198-218 行)の `panel.source === "camera" ? props.cameraRegion`
    (200 行): **B4 で** plain のショート用に `camera`→`screen` 解決を足す
    (本編 plain は `props.layout` を持たないのでここは通らない。B1 では触らない)。
- **テスト方針**: 自動テストは無し(視覚)。plain の fixture 収録フォルダを1つ
  用意し、`node src/cli.ts frames <dir> --captions` と `--every 10` で
  「ワイプが出ない・字幕が全幅中央・縦動画/横動画が素の解像度のまま」を PNG で
  自己確認。`thumbnail.json` を置いて `node src/cli.ts thumbnail <dir>` が
  plain で落ちない(ワイプ非描画で texts が乗る)ことも確認。obs fixture でも
  frames を撮り、ワイプ・字幕予約が従来どおりを確認。
- **壊してはいけない**: obs-canvas のワイプ位置・サイズ、字幕の右側予約、
  zooms / colorFilter の見え方が同一(zooms は screen クロップだけに掛かるので
  plain でも obs でも経路は同じ)。

#### B2. エディタ(server + client)にレイアウトを伝え、ワイプ UI を出し分け
- `editor/client/apiTypes.ts`: `ProjectData` に `hasCamera: boolean` を追加。
  `output` のコメントを「config の screenRegion」→「manifest の screenRegion」に
  更新(実体は F4 で server が切替済み)。
- `editor/server.ts` `loadProject`: `hasCamera: hasCamera(manifest)` を詰める。
- `editor/client/App.tsx` / `model.ts`:
  - タイムラインへ渡す表示用 `layerOrder` から、カメラ無しなら `"wipe"` を除外
    する(`model.ts` の `buildTracks` は layerOrder を逆順に並べるだけなので、
    App 側で `hasCamera ? layerOrder : layerOrder.filter(id => id !== "wipe")` を
    渡すのが最小。overlays.json に保存する layerOrder は触らない=表示だけ隠す)。
    → ワイプトラック(全画面区間の作成 UI 含む)が plain では出なくなる。
  - ワイプ常駐クリップの push(App.tsx:933-936、`kind:"wipe"`)を `hasCamera` の
    ときだけに。wipeFull 属性スパン(937-945)は wipe トラックが無ければ描画先が
    無いので実害は無いが、`hasCamera` ガードを揃える。
  - `stdCaptionPos`(App.tsx:1175-1184)のワイプ回避予約を B1 と同じく
    「カメラ無し=全幅中央」に(`built.props.cameraRegion` の有無で分岐。
    `captionDefaultPos` があればそちら優先は現状維持)。
  - ドラッグでの区間作成(`addByKind` / track==="wipe" 経路、1876 行前後)は
    wipe トラックが出ないので到達しないが、防御的に `hasCamera` を見てよい。
- **テスト方針**: 自動テストは無し。**エディタ検証はサーバー再起動が必須**
  (client は起動時1回だけ bundle。`memory/editor-bundle-restart.md`)。
  plain fixture で `npm run editor <plain-dir>` を再起動して開き、ワイプトラックが
  無い・字幕が全幅中央・保存が通ることを確認。obs fixture で従来 UI(ワイプ
  トラック+全画面スパン+レイヤー並べ替え)が出ることを確認。headless 検証時は
  `memory/headless-chrome-muted-video-freeze.md` の注意に従う。
- **壊してはいけない**: obs-canvas のエディタでワイプトラック・wipeFull 作成・
  レイヤー並べ替えが従来どおり。ショートモード(SpanKind "short")の UI も不変。

#### B3. ドキュメント整備(ユーザー向け)
- `docs/usage.md`: manifest スキーマ表に `layout` / `cameraRegion?` を追記
  (F5 で未了ならここで補完)。ワイプ系が plain 非対応、zooms / colorFilter /
  thumbnail は plain でも使える旨。ショートの plain 対応(profile の可否)も一行。
- `docs/getting-started.md` / `docs/recording-guide.md`: 「通常動画を動画だけの
  フォルダに置いて editor で開く(plain として自動 bootstrap)」フローを追記。
  `--layout` フラグと config `ingest.layout` の説明。
- **テスト方針**: ドキュメントのみ(コード変更なし)。記述と実装の一致を目視確認。
- **壊してはいけない**: 既存の OBS 収録手順の記述。

#### B4. plain のショート対応(profile の camera→screen 解決 + validate ガード)
plain のショートを一本の作業でまとめて成立させる(validate ガードと描画の
camera→screen 解決は同じ機能の両輪なので1コミット)。

- **描画(remotion/Main.tsx `renderPanels`)**: `panel.source === "camera"` を、
  `props.cameraRegion` が無ければ `props.screenRegion`(=plain の全フレーム)へ
  解決する。plain の「カメラ」は概念上「収録全体=画面」なので、`vertical-cover`
  (カメラ全面)は「画面全体を縦へ cover」になり、スマホ縦動画(元から縦=
  screenRegion が縦)なら追加加工なしで綺麗に成立する。
- **validate(src/stages/validate.ts、shorts.json 検査 579-611 行)**: plain の
  manifest で、ショートの profile の **layout に screen パネルと camera パネルが
  両方ある**(= `vertical`)場合は **エラー**(「vertical は画面+カメラの2段構成
  用。plain には vertical-cover か default を使ってください」)。camera のみ
  (`vertical-cover`)・screen のみ・layout 無し(`default`)は許可。判定は
  profile 名ではなく `PROFILES[name].layout.panels` の source 集合で行う
  (将来プリセットが増えても壊れない)。
- **frames --short**(`src/stages/frames.ts:102`)も同じ resolveProfile 経路を
  通るので描画修正だけで縦プレビューが出る。
- **thumbnail / zooms / colorFilter は追加作業なし**(いずれもカメラ非依存。
  Decision 3 で確認済み。plain のショートは overlays.json を継承しない既存設計
  D2 のため zooms も自動的に無関係)。
- **テスト方針**:
  - validate 固定テスト: plain + short(profile `vertical`)→ エラー1件、
    plain + short(profile `vertical-cover`)→ エラーなし、obs + どちらも従来どおり。
  - 視覚: 縦のスマホ動画で plain fixture を作り、`shorts.json` に
    `profile: "vertical-cover"` のショートを1本置いて
    `node src/cli.ts frames <dir> --short <name> --every 10` で「全画面が縦へ
    cover され、テロップが縦レイアウトの既定位置に出る」を PNG 確認。
    横動画 plain + `vertical-cover` は上下が切れる(cover 仕様どおり)ことも確認。
- **壊してはいけない**: obs-canvas のショート(`vertical` / `vertical-cover`)の
  縦レイアウトが従来どおり(camera パネルは cameraRegion を使い、remap は
  発火しない)。plain の本編描画(B1)に影響しない。

### スコープ外(今回やらない)
- plain の `fit: cover` による横→縦の自動リフレーミング(顔追従トリミング等)
  — 将来課題。B4 は「元から縦、または全体を cover で縦へ」までを扱う。
- 多カメラ・複数画面など obs-canvas を超えるレイアウト — 掛かりは
  `Manifest.layout` の文字列ユニオン拡張で受けられるが今回は作らない。

---

## 実装順序と依存

```
F1 → F2 → F3 → F4 → F5   （前半・直列。F1 が全ての土台。F4 は resolveProfile 集約点の付け替え）
                  ↘
                   B1（Remotion 本編ワイプ非描画） ── B3（docs）
                   B2（editor）                   ──┤
                   B4（plain ショート）※B1 の後  ──┘
```
F4 完了時点で「plain の manifest を手で置けば render が縦/横動画を素の解像度で
正しく出す」まで到達(本編描画のワイプ非描画は B1 が必要)。B1・B2 は F 群
完了後に並行可、B4 は B1(renderPanels のガード地点)完了後。各コミットで
`npm run typecheck` と関連 `npm test` を緑に保つ。
