# デザイン×render 統合プログラム — design 有効でも高速パスを失わない・plain にも届ける

> 状態: **稼働中の作業母艦**(初版 2026-07-14)。単発の feature 設計ではなく、
> 「ベースレイアウトのデザイン(`render.design`)と render 最適化(高速パス/
> チャンク/full-skip)を両立させ、さらに design と高速パスを plain 収録へ
> 一級展開する」取り組みを継続的にブラッシュアップする生きたドキュメント。
> 施策は §5 のフェーズで状態管理し、意思決定は §8 に追記する。
>
> **前提となる方針**(コーディネータ調査で確定・2026-07-14。§8-1):
> design は **cut.mp4 へ焼き込まない**。cut.mp4 は design 非依存に保ち、
> FAST 区間の ffmpeg 合成グラフに design を教える(理由は §3 原則5)。
>
> **作業ブランチ: `obs-canvas-design`(design 実装は main 未マージ)。**
> 設計・実装セッションは必ずこのブランチのコードを読むこと。main を読むと
> design.ts / designAsset.ts / props.design が「存在しない」ように見える
> (過去に同型の誤認事故あり。memory: opus-sonnet-relay-workflow 急所)。

関連文書: `docs/programs/render-fastpath-program.md`(高速パス母艦。FAST/SLOW
アーキテクチャ・P0〜P6 の実測・検証手法の出所。**本プログラムはその直接の
続編**)/ `docs/perf.md`(フェーズ0〜11。数値の出所)/
`docs/plans/plain-video-support.md`(plain 一級サポートの実装計画。F1〜B4 は
実装済み)/ `src/lib/design.ts` 冒頭コメント(design の意味論)

---

## 1. 目的とスコープ

**目的**: `render.design.enabled: true` にした瞬間に cold render が約2倍に
なる現状(高速パス全停止+フル経路自体の遅化)を解消し、design 有効収録でも
高速パスの大部分を回復する。あわせて design と高速パスを plain 収録
(カメラ無し通常動画)へ展開する。

**背景数値**(すべて実測または現物 props からの机上計算。対象は実収録
`~/Movies/cutflow/2026-07-12`、210.03s / 6301frames / fps30):

| 事実 | 数値 | 出所 |
|---|---|---|
| design **無し**・フルレンダー | 202.6s | docs/perf.md フェーズ11(P6検収) |
| design **無し**・高速パス(被覆100%) | 92.5〜102.2s | 同上 |
| design **有り**・現状(高速パス不発+フル) | **約360s(ユーザー実測6分)** | 2026-07-14 報告 |
| 二重 OffthreadVideo 抽出のコスト | 全体の約30% | docs/plans/perf-render-single-extraction.md |
| この収録の SLOW 必須区間(zoom1+wipeFull1+blur10、3s未満ギャップ吸収後) | **2島(0-12s / 23-50s)計38.6s** | render.props.json からの机上計算 |
| → 期待 FAST 被覆 | **81.6%**(閾値50%を余裕で通過) | 同上 |

**第一目標**: この収録の cold render **360s → 150〜180s**(P1)。
zoom/wipeFull/blur を使わない design 収録では **P6 同等(約100s)** まで戻す。

**スコープ**:
- P0: design 変更がキャッシュに黙殺される正確性バグ2件(即修正)
- P1: FAST 基底の design 対応(本命。高速パスの回復)
- P2: SLOW/フル経路の design 描画の軽量化(バックプレート統一)
- P3: design の plain 適用+plain の高速パス解禁

**スコープ外**:
- ショートへの design 継承(profile layout 経路は design を載せない現仕様を
  維持。renderProps.ts の `profile?.layout ? undefined : resolveDesign(...)`)
- design の時間変化(アニメーション背景等)。design は時間不変が前提
- render-fastpath 母艦の残バックログ(カラオケ/anim テロップの FAST 化等)

---

## 2. 確定済みの事実(2026-07-14 コーディネータ調査。**再調査不要**)

設計セッションはここを一次資料としてよい。行番号はブランチ進行でズレるので
**シンボル名で特定**すること。

### 2.1 高速パスが全停止するメカニズム(1本の因果鎖)

1. `canBurnWipe`(src/stages/render.ts)が `cfg.render.design?.enabled` で
   **無条件 false**(render.ts:117-130)。
2. → `composite = false` → cut.mp4 は 3840×1080 の**生キャンバスのまま**
   (画面+カメラ横並び。出力解像度ではない)。
3. → `decideFastPath`(src/lib/fastRender.ts)は `composite` を必須条件に
   しているため「**非composite経路(cut.mp4 が出力解像度でない)**」で不活性化
   (fastRender.ts:24)。`fastPlan` の適格性判定にすら到達しない。
4. さらにフルレンダー自体も遅化: (a) 非composite = 画面パネルとカメラ円で
   同一フレームを**2回 OffthreadVideo 抽出**(既知の約30%ボトルネックの復活)、
   (b) `SCREEN_SHADOW_CSS` / `CAMERA_SHADOW_CSS`(blur半径80px級の box-shadow
   2枚)を**毎フレーム** Skia が描画、(c) 背景画像レイヤーの合成。
   → 202.6s → 約360s はこの3点でほぼ説明がつく。

**重要な併発事実**: この収録には現在 zoom×1・wipeFull×1・blurs×10 が入って
いるため、**design を無効にしても** `canBurnWipe` は false(zoom/wipeFull で
不適格)。「design を外せば P6 の速度に戻る」は成立しない。span 単位の対処
(高速パスの適格判定は既に zoom/wipeFull/blur を SLOW span として扱える)が
本筋である根拠。

### 2.2 design の意味論(src/lib/design.ts)

- `DesignProps` = 背景(色 or 画像)+ 画面パネル(rect/radiusPx/shadow)+
  カメラ(rect/radiusPx/shadow)。**すべて時間不変**。唯一の時間変化は
  `wipeFull` 区間の `wipeRectAt`(カメラ矩形→全画面への補間)で、これは
  fastPlan が既に SLOW に落とす区間なので FAST 側は考えなくてよい。
- `resolveDesign` は `hasCamera`(manifest.video.cameraRegion の有無)で
  **plain を門前払い**(design.ts の `if (!hasCamera) return undefined`)。
  `DesignProps.camera` は現状**必須**フィールド。
- `designAsset.ts` の `renderCfgWithDesign` も `hasCameraRegion(dir)` で
  plain の取り込みを打ち切る(designAsset.ts:53)。
- 実収録の解決済み矩形(参考。1920×1080 出力): screen =
  `{x:100, y:22, w:1720, h:968}` radius24 / camera =
  `{x:1517, y:677, w:375, h:375}` radius96。**カメラは画面パネルの右下に
  大きく重なり、右・下端は背景の上に張り出す**。→ カメラの角丸の背面は
  「動的画素(画面映像)」なので静的窓では表現できず、素材側 alpha が要る。
  画面パネルの角丸の背面は静的(背景)なので窓でもマスクでも表現できる
  (P1 の設計論点)。

### 2.3 正確性バグ2件(P0。設計不要・即修正可)

- **chunk キャッシュが design を見ていない**: `globalVideoProps`
  (src/lib/chunkPlan.ts)の射影に `props.design` が無い。`chunkSec: 15` が
  既定 on の現運用では、フルレンダー済み収録で design だけ変えて再 render
  すると、render.key 不一致 → chunk 経路 → globalKey 一致 → 全チャンク
  「変更なし」→ **旧デザインのまま concat された final.mp4 が黙って出る**。
- **render.key が背景画像の中身を見ていない**: `materialFilesOf`
  (src/lib/renderKey.ts)は overlays/inserts/bgm の file しか stat しない。
  `render.design/teal.jpg` を同パスのまま中身だけ差し替えると full-skip が
  旧 final.mp4 を返す(designAsset の isFresh はコピーを更新するが
  render.key はそれを見ない)。
- なお render.key.json 自体は props 全体(design 含む)を持つため、
  「design 変更で誤 full-skip」は**起きない**(問題は chunk 再利用と
  背景画像の in-place 差し替えの2点に限定)。

### 2.4 plain の現状

- plain は一級サポート実装済み(`Manifest.layout: "plain"`・`manifestLayout`/
  `hasCamera` in src/types.ts・validate の plain+wipeFull エラー・Main.tsx の
  カメラ無しワイプ非描画。docs/plans/plain-video-support.md の F1〜B4)。
- **plain は高速パスが永遠に不発**: plain の cut.mp4 は恒等クロップで最初から
  出力解像度なのに、`canBurnWipe` が `hasCamera` 必須のため composite=false
  → `decideFastPath` が「非composite経路」で拒否。実際には FAST の前提
  (cut.mp4 = 出力解像度のベース)を**既に満たしている**のにゲートが保守的
  すぎる、という既存ギャップ。
- design は plain に**意図的に**適用しない設計だった(design.ts コメント
  「カメラの無い収録に部分適用しても意図した絵にならない」)。本プログラムで
  この判断を覆す(ユーザー要望: 背景+パネルのみの部分適用を plain に許す)。

### 2.5 実収録 2026-07-12 の props 内訳(適格性の根拠)

captions 94(anim/karaoke **0**)/ overlays 33(全て画像・音声 **0**・動画 **0**)/
inserts 0 / zooms 1 / wipeFull 1 / blurs 10 / bgm 3 / baseSegments 1。
→ 音声ゲートは `bgm-mix` で通り、fastPlan の全編フォールバック要因は無い。
design 対応さえすれば FAST 被覆 81.6% で発動する収録。

### 2.6 既存インフラ(P1/P2 が再利用するもの)

- `withCaptionStillAssets`(src/lib/captionStill.ts): テロップ透過 PNG を
  Main.tsx と**同一の描画器**(Remotion renderStill)で焼き、
  `render.fast/captions/<key>.png` に差分キャッシュする既存機構。
  バックプレート生成の雛形。
- `fastPlan` / `fastSegment` / `fastBase`(src/lib/): FAST/SLOW span 分類と
  FAST セグメントの ffmpeg 合成。design を知らないのは**基底の組み立てだけ**
  (span 分類は zoom/wipeFull/blur を既に SLOW に落とせる)。
- `render.fast/` は差分更新型キャッシュ(全消ししない)。バックプレートも
  `render.fast/design/<key>.png` 等で同居させるのが自然。
- 高速パスの検証: `verifyAssembled` + per-frame PSNR(render-fastpath 母艦
  §7 の確立済み手法)。

---

## 3. 設計原則(render-fastpath 母艦 §2 を継承+本プログラム固有)

1. **誤爆より保守**: 適格なときだけ高速パス、1つでも条件を欠いたら既存経路へ
   1行ログ付きフォールバック。design-FAST が組めない収録は現状(フル)のまま。
2. **ピクセル等価は「同じ描画器」で守る(二重実装しない)**: design の
   静的画素(背景・影・角丸)は Main.tsx と同じ CSS/コンポーネントから
   renderStill で焼くのを第一候補とする。ffmpeg 側で影や角丸を「再実装」して
   近似することはしない(FAST/SLOW 境界で絵が割れる)。
3. **検証は decode 後ピクセルと機械検証で**: per-frame PSNR + verifyAssembled。
   FAST/SLOW 境界フレームの連続性は必ず PSNR の谷で確認する。
4. **音声は常に1本の連続パス**(既存 bgm-mix / insert-mix を無改造で使う。
   design は音に一切関与しない)。
5. **cut.mp4 は design 非依存に保つ**(本プログラムの中核判断・§8-1):
   design を cut.mp4 へ焼き込む案は不採用。理由: (a) design の調整反復
   (今まさにユーザーがやっている作業)のたびにフル解像度 concat が再生成に
   なる、(b) zoom/wipeFull の SLOW 区間は生キャンバスが必要で焼き込みと
   非互換、(c) cut.keeps.json のキーに design を混ぜる複雑化。
6. **未使用時バイト等価**: design 無効(および plain で design 無効)の収録の
   render 出力・キャッシュキー・ログが本プログラム前と変わらないことを
   既存テスト無改変の緑で証明する。

---

## 4. アーキテクチャ概要(目標形)

```
                     ┌─ render.key(full-skip。design は props 経由で既に効く)
render <dir> ────────┼─ chunk 差分(P0 で design を globalKey へ)
                     └─ decideFastPath
                          │  composite ∨ design-FAST可 ∨ plain恒等   ← P1/P3 でゲート一般化
                          ▼
                    fastPlan(変更なし。zoom/wipeFull/blur/anim/karaoke は SLOW span)
                          │
             ┌────────────┴────────────┐
           FAST span                  SLOW span
    ffmpeg 直合成(P1 拡張)        Remotion --frames(現状どおり)
    基底の組み立てが3形態:          design は Main.tsx が描く
      composite: cut.mp4 素通し      (P2 でバックプレート<Img>化して軽量化)
      design:    crop(screen)→scale(panel)→角丸→ overlay
                 + crop(camera)→scale→角丸alpha→ overlay
                 + バックプレートPNG(背景+影。renderStill 製・差分キャッシュ)
      plain:     cut.mp4 素通し(恒等。design 有効なら design 形態)
```

---

## 5. フェーズ計画(状態管理。終わったら状態を更新し結果を追記)

### P0 — design 陳腐化バグ2件の修正 【状態: 未着手 / 設計不要・実装直行可】

§2.3 の2件。純関数テストで固定でき render 実行不要。

- `chunkPlan.globalVideoProps` に `design: props.design ?? null` を追加
  (design 変更=全チャンク無効=フルレンダー行き、が正しい挙動)。
- `buildRenderCacheKey` の stat 対象に `props.design?.backgroundFile` を追加
  (パスは publicDir 相対で materials と同じ join(dir, file) で stat できる)。
- テスト: chunkPlan.test.ts(design 変更で globalKey が変わる/design 無しの
  キーは従来とバイト同一)・renderKey.test.ts(背景 stat が materials に載る/
  design 無し・backgroundFile 無しでは従来とバイト同一)。
- 壊してはいけない: design 無し収録のキーが従来と**バイト同一**(=既存
  キャッシュが無効化されない)。design 有り収録は初回だけ全キャッシュミスに
  なるが、それは正しい(今までが壊れていた)。

### P1 — FAST 基底の design 対応 【状態: 未着手 / **Opus 設計対象**】

**目的**: `decideFastPath` の composite 必須を外し、design 有効収録で FAST
span の ffmpeg 基底に design を合成する。第一目標 360s → 150〜180s。

**Opus に決めてほしい設計判断**(論点ごとに選択肢とトレードオフを比較する):

1. **バックプレート(背景+影)の生成方式**:
   (a) Main.tsx から design 静的レイヤーを共有コンポーネント化し renderStill
   で焼く(原則2に合致・captionStill の雛形あり・Chrome 起動コストは
   withCaptionStillAssets の warm に相乗り可)/(b) ffmpeg・自前描画で近似
   (軽いが二重実装・box-shadow のピクセル一致がほぼ不可能)。
   ※ 原則2から (a) が有力だが、キャッシュキー設計(design 全フィールド+
   出力解像度のハッシュ)と render.fast/ 内の置き場も含めて決めること。
2. **角丸の表現**: 画面パネルは背面が静的なので「バックプレートに角丸の
   透明窓を開けて上に被せる」方式が使えるが、**カメラ円は画面パネル(動的
   画素)の上に重なる**(§2.2 の矩形事実)ため素材側 alpha(角丸マスク PNG +
   alphamerge、または renderStill で焼いた RGBA)が必須。窓方式と素材 alpha
   方式のどちらに統一するか、混在させるか。カメラ影(動的画素の上に落ちる
   半透明)をバックプレートに含める場合の RGBA 合成順も決めること。
3. **ゲートの再設計**: `decideFastPath` の `composite` 必須を「FAST 基底が
   組める」判定(composite / design-composable / plain-identity の3形態)に
   一般化する関数の置き場・命名・fastPlan との責務分担。`canBurnWipe` は
   composite 焼き込みの適格判定として現状のまま残る(design 有効時 false は
   正しい。焼き込みはしないのだから)。
4. **ffmpeg フィルタグラフの構成とコスト**: crop→scale→(角丸)→overlay×2 +
   バックプレートを既存 `fastSegment` のグラフ(trim・caption PNG overlay・
   colorFilter)へどう挿入するか。`MAX_FAST_PNG_INPUTS`(120)への影響
   (バックプレート+マスクは数枚の定数増)と、per-frame scale のコスト見積り。
5. **FAST/SLOW 境界の等価性戦略**: SLOW 側は Main.tsx が design を描く
   (現状 box-shadow を毎フレーム)。P2(バックプレート <Img> 化)を P1 と
   同時にやれば FAST/SLOW の design 画素が**構造的に同一 PNG** になり境界
   パリティが自明になる。P1→P2 の順にやるか、P2 を P1 に統合するかを決める
   (推奨検討: 統合。ただしコミットは分ける)。

**期待成果物**: docs/plans/2026-07-14-design-fastpath-design.md(判断+
スキーマ/キー案+「1タスク=1コミット」分解。各タスクにテスト方針と
「壊してはいけない既存挙動」)。

**壊してはいけない既存挙動**(全タスク共通):
- design 無効収録の高速パス(composite 経路)が argv レベルでバイト等価
  (fastSegment のテストが無改変で緑)。
- fastPlan の span 分類は無改造(design は基底の話であって span の話ではない)。
- 高速パス失敗時のフルレンダー自動退避(runFastRender の catch)は維持。

**受け入れ実測**(実装セッションで。コーディネータのセッションでは render を
回さない): 2026-07-12 収録の cold render 1回(fastPath ログで
`FAST n / SLOW 2(被覆 ~81%)` を確認)+ render-fastpath 母艦 §7 の
per-frame PSNR で design 画素含む等価性を確認。

### P2 — SLOW/フル経路のバックプレート統一 【状態: 未着手 / **Opus 設計対象**(P1 と同一設計 doc でよい)】

**目的**: Main.tsx の design 描画から毎フレームの box-shadow を排除し、
P1 のバックプレート PNG を `<Img>` として使う。SLOW span・フルレンダー・
frames・editor Player すべてが軽くなり、FAST/SLOW パリティが構造化される。

**Opus に決めてほしい設計判断**:
1. **Player(ブラウザ)と frames の供給経路**: Main.tsx は PNG を生成できない。
   バックプレートを事前生成するのは誰か(render/frames はサーバ側で
   withCaptionStillAssets 同様に warm、editor Player は server が起動時/
   design 変更検知時に生成して publicDir 経由で配る、等)。生成が無い/失敗した
   ときのフォールバック(従来の CSS box-shadow 描画に劣化)を残すか。
2. **wipeFull 区間の扱い**: wipeRectAt でカメラが全画面へ広がる間、影と角丸は
   補間される=この区間だけは静的 PNG で表現できない。SLOW 専用の従来 CSS
   描画を残す(wipeFull は常に SLOW なので自然に整合)でよいか。
3. 二重 OffthreadVideo 抽出(design 有効時の画面+カメラ)は**構造的に必要**
   (別形状で別位置に置くため)。P2 では触らない前提でよいか、それとも
   SLOW 区間限定の追加最適化(例: 抽出解像度の削減)に踏み込むか。

**壊してはいけない**: design 無効収録の Main.tsx 描画が不変(バックプレートは
design 有効時のみのレイヤー)。frames の PNG が render と同じ絵(既存の
「frames は最終合成と同じ見た目」契約)。

### P3 — plain への展開(design 部分適用+高速パス解禁) 【状態: 未着手 / **Opus 設計対象**】

**目的**: (a) plain 収録に design(背景+パネルのみ。カメラ項なし)を適用
できるようにする。(b) plain 収録で高速パスを発動させる(design 無しなら
恒等基底=composite 同等、design 有りなら P1 の design 基底からカメラ項を
除いた形)。

**Opus に決めてほしい設計判断**:
1. **スキーマ**: `DesignProps.camera` を optional 化するか、plain 用の別型に
   するか。optional 化なら Main.tsx / P1 の ffmpeg 基底 / validate /
   schemas(RenderProps は schemas 対象外だが types コメント・docs は5点セット
   規約に従う)への波及を全数列挙すること。
2. **ゲートの緩和**: design.ts `resolveDesign` の hasCamera 門前払いと
   designAsset.ts `hasCameraRegion` 打ち切りを外す際、「plain では camera
   設定キーを無視する(書いてあっても warn しない/する)」のどちらにするか。
3. **plain の縦横比**: plain は出力解像度が manifest 由来(縦動画は縦のまま)。
   パネル矩形の解決(marginXPx/marginBottomPx)は縦出力でも成立するが、
   既定値(横1920前提の margin 100px 等)が縦 1080×1920 で破綻しないかの
   検査(resolveDesign の余白バリデーション)をどう拡張するか。
4. **plain 高速パスのゲート**: P1 で一般化した判定に plain-identity
   (cut.mp4 = 出力解像度の恒等)を足す形。canBurnWipe(camera 前提)とは
   独立に判定できることを確認済み(§2.4)だが、実装の置き場と
   「plain + design 有効」が P1 基底のカメラ無し変種へ自然に落ちる形を設計する。

**壊してはいけない**: obs-canvas 収録の design・高速パス(P1/P2 の成果)が
不変。plain + design 無効の render 出力がバイト等価(高速パスが新規発動する
ことによる final.mp4 のエンコード差は PSNR 等価で扱う=render-fastpath 母艦と
同じ基準)。validate の plain+wipeFull エラー等の既存 plain ルールは不変。

---

## 6. リスク台帳

| リスク | 兆候 | 手当て |
|---|---|---|
| ffmpeg の crop→scale→overlay×2 追加で FAST 段が想定より遅い | P1 受け入れ実測で FAST 段が composite 比 2倍超 | scale を panel 解像度で1回に固定(拡大縮小の連鎖を作らない)。それでも遅ければ設計に戻り基底だけ事前展開(ベースプレーン中間ファイル)を検討 |
| renderStill 製バックプレートと Main.tsx の描画差(将来のスタイル変更で乖離) | PSNR の谷が FAST/SLOW 境界に出る | P2 の「同一 PNG を両経路で使う」統合で構造的に封じる(P1 単独で出すなら境界 PSNR をテストに固定) |
| バックプレートのキャッシュ陳腐化(design 変更が PNG に反映されない) | design 変更後も絵が変わらない | キーは解決済み DesignProps 全フィールド+出力解像度のハッシュ(P0 の教訓をここで最初から適用) |
| ffmpeg RGBA 入力のメモリ増(既知: PNG 107入力で 2.4GB) | FAST 段の RSS | バックプレート+マスクは定数枚(2〜4)なので影響は微小のはず。実測で確認だけする |
| plain の縦出力で design 既定値が破綻 | resolveDesign の余白エラー/歪んだパネル | P3 論点3。縦横で既定を分けるか、比率ベースの既定に改めるかを設計で決める |
| 設計子が main を読んで design 実装を幻と誤認 | 設計 doc に「design.ts は存在しない」系の断定 | 冒頭の作業ブランチ宣言。設計プロンプトにも明記 |

---

## 7. 測り方

- **時間**: cold render の壁時計(cut.mp4 温存・render.key/render.chunks/
  render.fast 削除の「cold」定義は render-fastpath 母艦 §7 と同一)。
- **等価性**: per-frame PSNR(avg/min/30dB未満フレーム数)+ verifyAssembled。
  design 画素は静的なので、境界フレームの PSNR 谷が最重要の観測点。
- **実測は実装セッションが行う**。コーディネータのセッションではサンプルへの
  試験 render を回さない(セッション時間の制約。2026-07-14 ユーザー指示)。
  受け入れは各フェーズ1回の cold render 実測+PSNR で足りる。
- 実収録の器: `~/Movies/cutflow/2026-07-12`(design 有効・FAST 被覆 81.6% 見込み)。
  検証で JSON を触る場合は scratch へコピーし、実収録は汚さない。

---

## 8. 意思決定・作業ログ(追記していく)

### 8-1. 2026-07-14 プログラム発足・「焼き込まない」方針の確定(コーディネータ調査)

- 6分化の因果鎖(§2.1)・正確性バグ2件(§2.3)・plain のゲャップ(§2.4)を
  コード読解+props 机上計算で確定。render の実測はユーザー報告値(6分)と
  docs/perf.md フェーズ11 の P6 実測を採用(本セッションでは render せず)。
- **design は cut.mp4 へ焼き込まない**(§3 原則5)。FAST 基底の ffmpeg 合成に
  design を教える方式を本命とする。焼き込み案は design 反復調整で cut.mp4
  再生成・zoom/wipeFull 非互換・cut キー複雑化の3点で棄却。
- フェーズ構成: P0(バグ修正・設計不要)→ P1(FAST 基底 design 対応)→
  P2(バックプレート統一。P1 と同一設計 doc 可)→ P3(plain 展開)。
  P1〜P3 を Opus 設計子へ委任する(§9)。

---

## 9. コールドスタート用の前提(設計セッションが最初に読むもの)

**Opus 設計子への委任範囲**: P1〜P3 の設計(§5 の各「Opus に決めてほしい
設計判断」に答える)。P0 は設計不要(実装直行)。

**成果物の形式**:
- docs/plans/2026-07-14-design-fastpath-design.md(P1+P2)と
  docs/plans/2026-07-14-design-plain-design.md(P3)。P3 は P1 のゲート設計に
  依存するので、1本にまとめてもよい(判断は設計子に任せる)。
- 各設計 doc は: 判断リスト(選択肢とトレードオフ・採用理由)→ スキーマ/
  キー差分 → 「1タスク=1コミット」のタスク分解(各タスクに: テスト方針・
  壊してはいけない既存挙動・実装が読むべきシンボル名)。
- 行番号ではなく**シンボル名**でコードを特定する(ブランチ進行でズレるため)。
- 設計子は**読み取り専用**(リポジトリのファイルを書かない。設計テキストを
  返すだけ。母艦・レビュー等の正データを「ついで」に書き換えない)。

**先に読むべきコード**(優先順):
1. この母艦全体(特に §2 確定事実・§3 原則・§5 論点)
2. src/lib/design.ts(design の意味論)/ src/lib/designAsset.ts(取り込み)
3. src/stages/render.ts の `canBurnWipe`・`render`(composite の流れ)
4. src/lib/fastRender.ts(decideFastPath / runFastRender)
5. src/lib/fastPlan.ts(span 分類。**変えない**ことを確認するために読む)
6. src/lib/fastSegment.ts(FAST の ffmpeg グラフ。P1 の挿入先)
7. src/lib/captionStill.ts(renderStill+差分キャッシュの雛形)
8. remotion/Main.tsx の design 描画(背景 Img・panelRect・wipeRectAt・
   box-shadow)/ src/lib/renderProps.ts の design 解決
9. src/lib/chunkPlan.ts の globalVideoProps(P0 の対象+チャンクとの共存)
10. docs/programs/render-fastpath-program.md §2〜§4(継承する設計原則と
    FAST/SLOW アーキテクチャ)/ docs/plans/plain-video-support.md(P3 の前提)

**検証の急所**(memory: opus-sonnet-relay-workflow から本件に効くもの):
- ブランチは `obs-canvas-design`。main と比較してからコードの存否を断定する。
- 実装子には「Agent ツール禁止・各タスク即コミット・既存 golden の書き換えが
  要るなら設計違反として停止」を明記する。
- 速度改善の主張は before/after の PSNR/md5 等価とセットで示す。
