# design FAST 基底 + 静的バックプレート統合設計

親ドキュメント: `docs/programs/render-design-program.md` P1 / P2  
前提: P0 commit `a58a103` 完了。`fastPlan` の span 分類は変更しない。

## 1. 目的と非目的

目的は design 有効時も FAST span を ffmpeg で合成し、`Main`、SLOW、full、
frames、editor Player、FAST が同じ静的 design 資産を使うこと。通常区間の
毎フレーム box-shadow 描画を除き、design 無効時の argv、出力、キー、ログを
変えない。失敗時は既存 CSS design + full Remotion render へ退避する。

次は対象外とする。

- `fastPlan` の zoom / wipeFull / blur / anim / karaoke 分類変更
- `canBurnWipe` の意味変更、cut.mp4 への design 焼き込み
- wipeFull の FAST 化、SLOW の二重 `OffthreadVideo` 抽出削減
- short の `profile.layout` への design 適用

## 2. 設計判断

### D1. Main と共有する renderStill 資産

ffmpeg で影と角丸を近似せず、Main と同じ React/CSS 定義を `renderStill` する。
Chrome の影描画を内容アドレス式で一度だけ実行し、Main もその PNG を読む。
これにより将来 CSS 定数が変わっても FAST/SLOW の静的画素を構造的に揃える。

単一 PNG では camera 影の z-order を守れない。次の4役へ分割する。

```ts
export interface DesignAssetRefs {
  key: string;
  backdropFile: string;
  screenMaskFile: string;
  cameraShadowFile?: string;
  cameraMaskFile?: string;
}
```

- `backdrop`: 背景色/画像 + screen shadow。出力全面の opaque PNG
- `screenMask`: panel サイズの straight-alpha PNG
- `cameraShadow`: 出力全面の transparent RGBA PNG。camera 影だけ
- `cameraMask`: camera rect サイズの straight-alpha PNG

保存先は `render.fast/design/<key>.<role>.png`。P3 の camera 無し plain は
前半2枚だけを生成する。

### D2. 合成順と角丸

screen と camera はともに素材側 alpha に統一する。ffmpeg は
`format=rgba` + `alphamerge`、Main は同じ mask PNG を1:1で CSS alpha mask
として使う。premultiplied alpha をmask素材にしない。

通常 frame の順序は次のとおり。

```text
backdrop(background + screen shadow)
screen crop -> scale -> RGB colorFilter -> screenMask -> panel位置へoverlay
layerOrder:
  wipe位置: cameraShadow -> camera crop/cover -> scale -> colorFilter
            -> cameraMask -> camera位置へoverlay
  ov<N> / cap<N>
annotations
```

camera は screen 動画上へ影を落とすため、背景と一体化できない。また既存の
`layerOrder` で素材/テロップとの上下を変えられるため、常にscreen直後へ置かず
`wipe` の位置へ挿入する。`wipe` が欠ける/hiddenならcameraを描かない。
annotations は従来どおり全layerより上に置く。

### D3. wipeFull と P1/P2 の順序

`wipeProgress === 0` は静的 camera shadow/maskを使う。進行中はcameraだけ
現在の `wipeRectAt` + CSS shadow/radius描画へ戻す。wipeFullは必ずSLOWなので
形状を事前生成しない。screenのbackdrop/maskは継続利用する。

静的資産とMain共有(P2)を先に完成させ、その後FAST(P1)を同じ資産へ接続する。
コミットは分ける。FAST初回から境界parityを構造化できるためである。

### D4. FAST基底能力ゲート

`composite` 必須判定を、基底が構築可能かを返す純関数へ一般化する。

```ts
export type FastBaseCapability =
  | { ok: true; mode: "composite" }
  | { ok: true; mode: "design"; design: DesignAssetRefs }
  | { ok: true; mode: "plain-identity" }
  | { ok: false; reason: string };
```

`resolveFastBaseCapability` は `src/lib/fastRender.ts` か専用browser-safe moduleに
置く。P1では composite と asset完備のobs designだけを許可し、P3でplainを
有効化する。designには正のsource/output rect、canvas内source、出力内panel、
必要asset、cameraと`cameraRegion`の対応を要求する。

`decideFastPath` の順は config -> base capability -> 既存 `fastPlan` ->
video/audio eligibility -> coverage。`fastPlan` は変更しない。`canBurnWipe` は
cut.mp4生成能力の判定としてそのまま残す。

### D5. fastSegment の optional design branch

`FastSegmentSpec` に optional base unionを追加する。`base === undefined` は現行
compositeを意味し、既存 `buildFastSegmentFilter` / `buildFastSegmentArgs` の
文字列を一文字も変えない。

design branchはcut.mp4をtimestamp整列後にscreen/cameraへsplitする。各branchを
source regionでcropし、target aspectへcenter-crop、target sizeへ一度だけscale、
RGB `ffmpegColorFilterOf`、mask `alphamerge` の順で処理する。固定
`BASE_COLOR_FILTER` はsplit前、ユーザーcolorFilterは各動画branchのscale後。
overlay/caption/annotationには掛けない。

cameraは `resolveFastLayers` の既存結果やmerge規則を変えず、専用の
`design-camera` z-order barrierとしてwipe位置に挿入する。cover geometryは
`cropFitStyle` と同じ中心/aspect計算を純関数化し、整数丸めをtestする。

### D6. PNG入力上限

`MAX_FAST_PNG_INPUTS` は時間レイヤー用のまま維持し、span分割を変えない。
designはobs最大4、plain最大2の固定入力とし、別定数
`MAX_FAST_DESIGN_PNG_INPUTS = 4` で防御する。実argvの総PNGは既存上限+4以下、
既存120入力のspan列は不変とtestする。wall time/RSSを実測し、design FASTが
composite FASTの2倍を超えたらscale branchをprofileする。

### D7. 内容アドレスキー

キーは generator version、出力解像度、assetsを除く解決済みDesignProps全値、
背景file path/null、背景bytesのSHA-256を含む。背景内容を同pathで差し替えても
keyを変える。`camera:null` を正規形にしP3にも備える。hashはSHA-256の先頭を使い、
一時fileへrenderStill後renameして公開する。

`DesignAssetRefs.key` と現在propsからの再計算が一致するときだけattachする。
design無しではassets fieldを追加せず、既存render/chunk keyを変えない。

### D8. render / frames / editorへの供給

新規 `remotion/DesignStill.tsx` と `src/lib/designStill.ts` に共通生成器を置く。
既存 `WarmAssets` を注入でき、cache hitならChromeを起動しない。

- render: `renderCfgWithDesign` -> `buildRenderProps` -> prepare -> attach -> props/key
- frames: `renderFrames` のwarmを渡しcomposition選択前にattach
- editor: `startEditor` とdesign config変更時にprepare。`loadProject` は既存refsを
  同期返却し、client `built` がkey検証後attachする
- editor media URL: backgroundに加え全asset pathを `/media/` へ変換

生成失敗は警告1行でassetsを付けず、Mainは現在の背景、border-radius、CSS影へ
fallbackする。render/frames/editor自体は止めない。能力不足ならFASTは通常renderへ
落ちる。

### D9. FAST失敗時cleanup

現在の `runFastRender` は失敗時に `render.fast/` 全体を消すため変更必須。
content-addressedな captions/overlays/annotations/design は残し、segments、
assembled video、audio、一時finalだけを消す。PNG decode、ffmpeg、verify失敗は
既存catchからfull renderへ退避する。design assetsを消すと直後のfull Mainが
参照不能になるため、全消去は禁止する。

## 3. 型差分

P1/P2の `DesignProps.camera` は現状どおり必須でもよいが、asset型と
`DesignStill` はcamera無しを許容する。`DesignProps.assets?` はgenerated refsで
あり、`DesignConfig` のユーザー入力には追加しない。P3でcameraをoptional化する。

## 4. テスト

- key: design全値、解像度、背景bytes、versionの変更でkey変更。design無しは無し
- asset: path、atomic publish、cache hit、実bundle/renderStill、alpha channel
- Main: asset/fallback、wipe開始/進行/全画面/終了、shadow/radius/background
- capability: composite、design完備/不足、region不正、ログ理由
- graph: input index、crop/scale/alphamerge/overlay順、wipe z-order、colorFilter位置
- parity: base未指定の既存golden無改変、既存 `resolveFastLayers` とspan列不変
- fallback: asset生成、ffmpeg、verify失敗後もcacheが残りfull render成功
- editor/frames: media path、warm供給、finalと同frame
- `npm run typecheck`, `npm test`, `git diff --check`, Remotion bundle smoke

## 5. 1タスク=1コミット

### P2-1. DesignStillとcache

対象: `DesignProps`, 新規 `DesignStill`, Remotion root、新規 `designStill.ts`、tests。
4 asset生成、背景内容hash、atomic publish、camera無し内部構造を実装する。

ゲート: 1920x1080の4 PNG生成、alpha確認、2回目cache hit。Mainはまだ変えず、
design無しprops/keyとcaption warm lifecycleを変えない。

### P2-2. Main、render、frames、Player共有

対象: `Main`, `render`, `renderFrames`, editor `startEditor`/`loadProject`/config、
client `built`, snapshot context。通常frameでassetsを使い、wipe中cameraだけCSSへ戻す。

ゲート: fastPath offのlegacy CSS版とasset版を全編PSNR比較し、30dB未満0 frame。
wipe境界±10 frame、frames代表3点、Player、full wall timeを実測する。design無し、
short layout、proxy/time mapping、背景欠落fallbackを壊さない。

### P1-1. 基底能力ゲート

対象: `FastBaseCapability`, `resolveFastBaseCapability`, `decideFastPath`, render配線。
design graph接続前は誤activationしない。composite decision/plan/logと
`canBurnWipe`を不変にする。

### P1-2. design fastSegment graph

対象: `FastSegmentSpec`, filter/argv/render、layer解決、cover純関数、tests。
optional design branch、固定PNG、screen/camera mask、wipe z-orderを実装する。

ゲート: 1 FAST spanをRemotion muted spanとPSNR比較。screen角、camera角/影crop、
RSS/wall timeを測る。design無しargvはbyte equality、span分類は不変。

### P1-3. activationとcleanup

対象: `runFastRender`, render配線、cleanup、`docs/usage.md`, generated cache説明。
prepared assetsを渡してdesign FASTを有効化し、失敗時は一時物だけ消す。

ゲート: scratchの実収録 `2026-07-12` でcold render。ログが
`FAST n / SLOW 2`、被覆約81.6%、音声bgm-mix。`verifyAssembled`、frame/fps/
duration一致、全編PSNR 30dB未満0 frame、全境界±10 frame、領域crop、LUFS、
wall time 150〜180秒目標を記録する。

## 6. 完了条件

- Main/full/SLOW/frames/Playerが通常区間で同じassetsを使う
- wipeFullはCSS fallbackで正しく、asset失敗でも各経路が動く
- design実収録でFAST約81.6%、`fastPlan` span列不変、verify成功
- full/fastで30dB未満0 frame、境界に段差なし
- design無しのargv、キー、出力、ログに回帰なし
