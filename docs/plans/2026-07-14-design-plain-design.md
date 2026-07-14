# plain design + plain FAST 基底設計

親ドキュメント: `docs/programs/render-design-program.md` P3  
依存: `2026-07-14-design-fastpath-design.md` のP1/P2完了。

## 1. 目的

plain収録へ背景+screen panelのdesignを適用し、camera無しを正規形にする。
design無しplainは出力解像度のcut.mp4をidentity FAST基底にし、design有りは
P1のcamera無しdesign基底を使う。縦plainでもaspectを維持し、obs-canvas、
short、plain+wipeFull validate規則を変えない。

## 2. 設計判断

### D1. `DesignProps.camera` をoptional化

別unionやdummy cameraではなく `camera?` を採用する。差分はcamera branchの
有無だけで、背景/screen/cache/FAST graphを共有できる。dummyはwipe誤描画、
別unionは全消費箇所の判別を増やす。

波及先は `DesignProps`, `resolveDesign`, `wipeRectAt`, `Main`, `DesignStill`,
`prepareDesignStillAssets`, `FastBaseCapability`, `FastSegmentBaseSpec`,
`renderFastSegment`, `buildRenderProps`, panel/OCR座標関数、cache keys、editor、docs。
`wipeRectAt` は `NonNullable<DesignProps["camera"]>` を取り、callerでguardする。

### D2. plainにもdesignを解決

`resolveDesign` はenabledなら常にbackground + screenを解決し、`hasCamera` がtrueの
ときだけcameraを付ける。obsの具体JSONは変えない。channel共通configでcamera
設定が存在してもplainでは警告せず無視する。これは編集データ上の不正である
plain+wipeFull errorとは別問題で、後者は維持する。

`renderCfgWithDesign` の `hasCameraRegion` 打ち切りを外す。enabledかつ外部/
repo背景ならplainでも `render.design/` へcopyし、recording相対、missing時の
color fallback、disabled時の無副作用を維持する。

### D3. portrait geometry

現行screen式をlandscape/portrait共通で使う。

```ts
w = width - 2 * marginXPx
h = round(w * height / width)
x = marginXPx
y = height - marginBottomPx - h
```

source/output aspectを保つため歪まない。1080x1920、既定marginなら
`{x:100,y:266,w:880,h:1564}`。orientation別defaultや比率defaultは導入せず、
出力pxという既存契約を守る。

width/height、margin、radius、camera値のfinite/非負、正のrect、出力内rectを
検証する。radiusは `min(radius, w/2, h/2)`。小解像度でmargin過大なら自動縮小
せず明示errorにする。1920x1080 obs/plain、1080x1920、720x1280、小幅、負値、
camera出力外をtestする。

### D4. Mainのcamera無し分岐

`props.layout ? undefined : props.design` のshort除外を維持する。plainはbackdrop、
screenMask、screen videoだけを描き、design.cameraとcameraRegionが両方あるときだけ
cameraを構築する。`layerNode("wipe")` の既存camera guardを維持し、placeholderも
出さない。asset無しはscreenのCSS radius/shadow fallbackを使う。

### D5. plain identity能力

camera無しだけでは誤爆するため、実geometryでidentityを証明する。

```ts
export function isPlainIdentityBase(props: RenderProps): boolean {
  return !props.layout && !props.design && !props.cameraRegion &&
    props.canvas.w === props.width && props.canvas.h === props.height &&
    props.screenRegion.x === 0 && props.screenRegion.y === 0 &&
    props.screenRegion.w === props.width && props.screenRegion.h === props.height;
}
```

editor-only mute/hidden propsは既存gateまたは能力gateで拒否する。manifest layoutを
propsへ新設せず、実寸法から証明する。

### D6. camera無しdesign能力

`resolveFastBaseCapability` の優先順は composite -> design -> plain-identity ->
false。design有りはbackdrop/screenMaskを必須とし、cameraが無ければcamera assetを
要求しない。plain design graphはscreen branchだけ、identityは現行compositeの
base argvをそのまま再利用する。

`canBurnWipe` はcameraをcut.mp4へ焼く判定として変更しない。責務は
`canBurnWipe`=cut生成、base capability=現在のcutから基底構築、`fastPlan`=時間span。
`fastPlan` は一切変更しない。

### D7. cacheとfallback

asset keyのcamera無し正規形は `camera:null`。plain identityはassetを作らない。
asset生成失敗、能力不足、寸法不一致、ffmpeg/verify失敗はいずれもfull renderへ
退避する。design無しplainのprops/render/chunk keyはP3前と同じにする。新規FASTで
encoded bytesが変わるため、出力同値はdecode後PSNRで判定する。

## 3. docs / 契約差分

- `src/lib/design.ts` とconfig/typeコメントのobs限定記述を更新
- `docs/usage.md` にplainは背景+screenのみと記載し、旧fastPath制限を削除
- `AGENTS_CONTRACT.md` の `render.design/` からcameraRegion限定を除去
- `src/lib/files.ts` generated cache説明とdrift testsを同期
- 過去計画 `plain-video-support.md` は履歴として改変しない

editable JSON schemaとmanifest schemaは変更しない。designはconfig.yamlであり、
ユーザーschemaは現状存在しない。

## 4. テスト

- resolve: enabled plainはcamera無し、obsは従来deep equality、disabledはundefined
- geometry: landscape/portrait、小幅、負/非finite、camera出力外
- designAsset: plain copy、relative、missing、disabled、cache hit
- Main/props: camera無し、wipe非描画、asset/fallback、obs snapshot、short除外
- capability: identity正負、canvas/screen mismatch、camera無しasset完備/不足
- graph: identity argv同一、plain designにcamera input無し、portrait crop/scale
- validate: plain+wipeFull errorとplain layerOrder warning不変
- integration: portrait/landscape frames、Player、FAST failure full fallback
- `npm run typecheck`, `npm test`, `git diff --check`, Remotion bundle smoke

## 5. 1タスク=1コミット

### P3-1. camera optionalとplain design解決

対象: design types/resolve/wipe、render props、Main、DesignStill、tests。
plain screen design、portrait validation、camera guard、無警告ignoreを実装する。

ゲート: 1080x1920 scratch framesで背景/panel/radius/shadow/aspect、camera/wipe無しを
確認。obs代表framesをP2時点と比較し、typecheck/全test/diff-checkを通す。

### P3-2. plain background asset供給と文書契約

対象: `renderCfgWithDesign`, designAsset tests、editor config/load、usage、contract、
generated cache説明。camera gateを外しplainでもcopy/media配信する。

ゲート: repo、absolute、recording-relative、missingの4背景ケース。Player初回と
config変更後、full/framesで同じ背景、古いasset URLを使わないことを確認する。

### P3-3. plain identity/design FAST

対象: `isPlainIdentityBase`, capability/decision、fastSegment base/filter/argv、tests。
厳密identity gate、camera無しgraph、activationと理由logを実装する。

ゲートA(design無し): landscape/portraitでfull/fast、FAST/SLOW log、verify、
frame/fps/duration、全編PSNR 30dB未満0、境界±10 frame、LUFS。

ゲートB(design有り): 同じ2収録でpanel角/影/背景の領域crop、PSNR、portraitの
歪み/clip無し、asset失敗full fallback、obs P1数値の回帰を確認する。

### P3-4. 回帰・実測記録

対象: program、`docs/perf.md`、必要な回帰test。P3状態、commits、wall time、RSS、
PSNR、fallback証跡を記録する。旧制限文言を`rg`で除去し、landscape/portrait
plain、obs design、design無しcomposite、failure fallbackを最終再実測する。

## 6. 完了条件

- plain designで背景+screenがrender/frames/Playerに出てcamera fieldが無い
- channel共通camera configはplainで無警告、portraitでaspect維持
- design無しplainはidentity FAST、design有りはcamera無しdesign FASTが発動
- `fastPlan`、plain+wipeFull、obs design/composite、short layoutに回帰なし
- asset/ffmpeg/verify失敗時にfull render成功
- 全比較でverify、frame数、duration、PSNR、音声確認を通過
