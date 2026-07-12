# render 高速化: ワイプ焼き込みで cut.mp4 抽出を1回に

## 背景(実測)

`render` の cold 時間の約89%は Remotion 描画。300f スライス実測で 1フレーム原価 =
**床 ~18ms(Chrome/DOM/字幕/エンコード)+ cut.mp4 抽出 ~20ms × 回数**。
`Main.tsx` は画面クロップとワイプ(カメラ)を**別々の `<OffthreadVideo src=cut.mp4>` 2個**にしており、
同じ `(cut.mp4,同時刻)` を2回抽出する(Rust compositor は同一出力フレーム内の同時リクエストを
coalesce しない)。→ 抽出2回:57.6ms/f、1回:36.1ms/f(実測)。**冗長なワイプ抽出 ≈ 全体の約30%**。

## 方針

`render`(本編・横ワイプ経路)で **zoom/wipeFull が無いとき限定**に、ffmpeg cut 段で
画面+カメラワイプを **1920×1080 に焼き込んだ単一ベース** を作る。Remotion はワイプレイヤーを
描かず、単一ベースに字幕/素材を乗せるだけ=**抽出1回**。狙い: cold render 410s→約285s(−30%)。
cut.mp4 も 3840→1920 で cut 段のエンコードも軽くなる(相乗)。

## 適格条件(本編 render のみ。 short/preview/frames は対象外)

- `hasCamera(manifest)`(camera 無し plain は元々抽出1回)
- `overlaysIn.zooms` 空(zoom は背景 transform=焼き込んだワイプも拡大されるため不可)
- `overlaysIn.wipeFull` 空(ワイプ全画面化はワイプが動的=焼き込み不可)
- `overlaysIn.blurs` のうち**ワイプ矩形(右下 ww×wh)と交差するもの**が無い(交差 blur は
  現状=画面をぼかしてワイプが上に乗る/焼き込み=ワイプごとぼかす、で差が出る。保守的に除外)
- colorFilter は可(Remotion 側でベース全体に効く=画面+カメラ両方に効く現状と同一)

不適格なら従来どおり 3840 ベース+2抽出にフォールバック(挙動 bit 等価)。

## ワイプ幾何(Main.tsx と一致させる)

- `ww = cfg.render.wipeWidthPx`(既定480)、`wh = round(ww * cameraRegion.h / cameraRegion.w)`
- 位置: 右下 flush(overlay `x = outW-ww`, `y = outH-wh`)。角丸なし(現 wipeLayer に borderRadius 無し)
- カメラは cover 相当(cameraRegion と wipe box は同アスペクト=単純 scale)
- 出力寸法 outW/outH = screenRegion.w/h(=1920×1080)

## ffmpeg(cutFullRes の composite 分岐)

concat 後の `[vc]`(canvas=3840×1080)に対し:
```
[vc]split=2[s0][s1];
[s0]crop=SW:SH:SX:SY[scr];
[s1]crop=CW:CH:CX:CY,scale=WW:WH[cam];
[scr][cam]overlay=OW-WW:OH-WH[vout]
```
`-map [vout] -map [aout]`、`h264_videotoolbox -b:v 20000k`、音声フィルタは現状不変。
SW.. = manifest.video.screenRegion、CW.. = cameraRegion、OW/OH = SW/SH。

## props 上書き(composite 時、buildRenderProps の後)

- `canvas = { w: SW, h: SH }`(焼き込みベース寸法 1920×1080)
- `screenRegion = { x:0, y:0, w: SW, h: SH }`(ベースのクロップ=恒等)
- `wipeBurnedIn = true`(Main.tsx がワイプレイヤーを skip する新フラグ)
- `cameraRegion` は**そのまま残す**(字幕の reserve が `cameraRegion ? ww+margin*2 : 0` なので、
  残さないと字幕が焼き込みワイプに重なる=parity 崩れ)
- `videoFile` は "cut.mp4" のまま

blur の座標写像は `outputRectToCanvasRegion(rect, screenRegion, width, height)` を描画時に使うが、
screenRegion=full1920 / canvas=1920 でも現状(screenRegion={0,0,1920,1080}/canvas=3840, x=0・
w=out.w)と同一結果(scale=1,offset=0)。→ ワイプ外の blur は不変。

## 変更ファイル

1. `remotion/props.ts` — `RenderProps` に `wipeBurnedIn?: boolean`(描画専用フラグ)
2. `remotion/Main.tsx` — wipe ゲートに `|| props.wipeBurnedIn`(それ以外不変)
3. `src/lib/cutCache.ts` — composite 時だけ key に `baseComposite:true, wipeWidthPx`(false 時は
   キー byte 不変=既存 cut.keeps.json を無駄に失効させない)
4. `src/stages/render.ts` — 適格判定 `canBurnWipe`、幾何 `wipeGeom`、`cutFullRes` に composite 分岐、
   `render()` で判定→cutCacheKey/cutFullRes へ伝播→buildRenderProps 後に props 上書き

**触らない**: validate/schemas/AGENTS_CONTRACT(render.props.json は生成物で editable schema でない)、
preview(独自 ffmpeg 合成)、frames(proxy・同じ四角ワイプなので絵は一致)、short(縦 panels 経路)、
editor Player(proxy・2パネル live のまま。final と同じ四角ワイプ=同絵)。

## 検証

- `npm run typecheck` / `npm test`
- 実収録 `~/Movies/cutflow/2026-07-12` で:
  - cold render を composite 有無で A/B(render.key.json 削除で強制フル)→ 時間短縮を実測
  - `frames --every` の PNG と composite final の同時刻を目視 or framemd5 近似でワイプ位置一致
  - zoom を1つ足すと従来 3840 経路へ落ちる(fallback)ことを確認
