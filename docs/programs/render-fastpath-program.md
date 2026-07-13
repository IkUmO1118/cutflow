# render 高速パス プログラム — Chrome スクリーンショット方式の床を破る

> 状態: **稼働中の作業母艦**(初版 2026-07-13)。単発の feature 設計ではなく、
> 「cold render の速度の床(headless Chrome の per-frame 描画 ≈ 30ms/frame)を
> ffmpeg 直合成で回避する」取り組みを継続的にブラッシュアップする生きた
> ドキュメント。施策は §5 のフェーズで状態管理し、意思決定は §8 に追記する。
>
> **前提となる方針**(ユーザー確認済み・2026-07-13): 速度改善は「Remotion の
> 内側のチューニング」ではなく「経路の外側に高速パスを**作る**」で進める(案A)。
> 案B(Metal/CoreText のネイティブコンポジタ、190s→15〜30s 射程)は案Aの結果を
> 見てから判断する。

関連文書: `docs/perf.md`(フェーズ0〜9。数値の出所)/
`docs/plans/perf-render-single-extraction.md`(ワイプ焼き込み=本プログラムの
設計思想の前例)/ `docs/render-chunk-cache.md`(concat 無劣化検証・音声継ぎ接ぎ
不可の教訓=本プログラムの技術基盤)

---

## 1. 目的とスコープ

**目的**: cold render(キャッシュが効かない初回/大変更後の render)の Remotion 段
を、テロップ静止区間だけ ffmpeg 直合成に置き換えて短縮する。
第一目標: **190秒 → 75〜80秒**(出力尺の8割が適格な場合の試算)。

**背景数値(すべて実測。docs/perf.md)**:

| 事実 | 数値 |
|---|---|
| Remotion 段(6301f/210.9s 出力) | ≈190秒 ≒ 30ms/frame(焼き込み高速パス適用後) |
| render 中の CPU | 平均 300〜475% / 1000% — **飽和していない**(=計算量でなく方式が律速) |
| ffmpeg cut 段(decode+合成+VideoToolbox encode) | 210.9秒の動画を47秒 ≈ **4.5倍速** — 同じマシンで ffmpeg 経路は Chrome 経路の約4倍速い |
| 1フレーム原価の内訳 | 床 ~18ms(Chrome/DOM/スクショ/転送)+ cut.mp4 抽出 ~20ms×回数 |
| メモリ圧迫 | **解決済**(フェーズ9: offthreadVideoCacheMb=512)。本プログラムは速度が主題 |

**スコープ**:
- `render`(本編)の cold render 経路。チャンク差分レンダー(反復編集)は既に
  約5倍速なので対象外だが、共存は壊さない
- 対象レイヤー: ベース映像+静的テロップ(v1)→ 静的 annotation/blur・
  colorFilter・カラオケ(v2 以降、§5 P5)

**スコープ外**:
- 案B(ネイティブコンポジタ)
- エディタ Player(proxy 経路。ボトルネックでない)/ `frames` / `preview`
- ショート(v1 では対象外。本編で確立してから同型展開)

### 1.1 ヘッドレス Chrome は必須なのか(位置づけの整理)

必須ではない。Chrome は「GUI エディタのプレビュー(ブラウザ)と最終出力が
**同じ React コンポーネントで描かれるから絵が必ず一致する**」という CutFlow の
核となる保証と、CSS の表現力(縁取り・座布団・可変ウェイト・カラオケ)の対価
として使っている。遅いのは Chrome 自体ではなく「毎秒30回スクリーンショット」
という使い方。

| 段階 | Chrome の使い方 | cold render | 失うもの |
|---|---|---|---|
| 現状 | 全フレームをスクショ(この収録で6301回) | 190s | - |
| **案A(本プログラム)** | **テロップ1個=1回**(94回)。動画への合成は ffmpeg | ≈90〜100s | ほぼ無し(描画器が同じ=等価保証は構造のまま) |
| 案B(ネイティブコンポジタ) | ゼロ(CoreText/Metal 自前描画) | ≈15〜30s | 「同じコードだから一致」の保証。エディタは永遠にブラウザなので描画実装が2本になり、一致が恒久的なテスト負担へ |

libass / drawtext(ffmpeg の字幕焼き込み)という既製代替は、CSS とのピクセル
一致(縁取りの描画方式・座布団・改行・フォント)が取れないため不採用。
案Aの区間分割アーキテクチャは案Bの足場を兼ねる(FAST 区間の ffmpeg 合成部を
将来ネイティブ描画に差し替えても骨格は不変)。

---

## 2. 設計原則

1. **canBurnWipe の前例を踏襲する** — 「適格なときだけ高速パス、1つでも条件を
   欠いたら既存経路(バイト等価)へフォールバック」。誤爆より保守。既定は
   opt-in(`render.fastPath`)で始め、回帰期間後に既定化を判断する。
2. **ピクセル等価は「同じ描画器」で守る(二重実装しない)** — テロップ PNG は
   Main.tsx と**同一の JSX**(共有コンポーネント化した OutlinedText+配置ラッパ)
   を Remotion `renderStill` で焼く。CSS の縁取り・座布団・改行・フォント
   (data URL 焼き込み済み=フェーズ9)がそのまま使われるため、等価性が
   実装の性質として担保される。
3. **検証は decode 後ピクセルと機械検証で** — framemd5 / PSNR(chunk-cache 実装
   時に確立した手法)+ `verifyAssembled`(総フレーム数・duration・fps)。
4. **音声は常に1本の連続パスで作る** — チャンク実装時の実測で「AAC 部分音声の
   concat は境界ごと +56ms ドリフト」が確定している。部分音声の継ぎ接ぎは
   絶対にしない(v1: cut.mp4 音声をそのまま使える場合のみ発動。v2: 決定論
   BGM ミキサで連続音声を自前生成。§5 P4)。
5. **新しい中間生成物は最初から台帳に載せる** — `render.fast/`(テロップ PNG・
   セグメント・キー)を作る時点で `src/lib/files.ts` の GENERATED_FILES /
   `AGENTS_CONTRACT.md` / CLAUDE.md の中間生成物リスト / `clean` 対象 /
   `test/agentsMd.test.ts` に同時登録する。

---

## 3. アーキテクチャ概要

```
出力タイムライン(カット後秒)
├─ span 分割(純関数): FAST(base+静的テロップのみ)/ SLOW(それ以外)
│    境界はフレーム整数。短すぎる FAST は隣の SLOW に吸収(§4 境界規則)
├─ FAST span: ffmpeg 一発
│    cut.mp4 → trim → overlay(テロップ透過PNG, enable='between(t,a,b)')
│    → h264_videotoolbox(閉GOP・Remotion 出力とパラメータ一致)→ segNN.mp4
├─ SLOW span: 既存 Remotion
│    remotion render --frames=a-b --muted(チャンク再レンダーと同型)→ segNN.mp4
├─ concat -c copy(全セグメント)→ video.mp4
├─ 音声(1本の連続パス):
│    v1: cut.mp4 の音声ストリームを -c copy(BGM/素材音声が無い収録のみ発動)
│    v2: 決定論 BGM ミキサ(§5 P4)で mix.m4a を自前生成
└─ mux(chunkCache.muxVideoAudio 再利用)→ final.mp4 → verifyAssembled
```

- テロップ PNG は **1テロップ=1枚**(表示中は静的なので毎フレーム描く必要が
  ない、が本プログラムの核心)。`render.fast/` にキャッシュ
  (キー=テロップ内容+解決済みスタイル+出力解像度)。
- 既存キャッシュとの関係: `render.key.json`(full-skip)はそのまま最上位。
  チャンク差分レンダーとは排他(fastPath 発動時はチャンク種付けをスキップするか、
  fastPath 出力から種付けするかを P3 で決める)。

---

## 4. 適格判定(v1 の FAST 条件)と境界規則

span 内に以下が**1つも無い**こと(= Main.tsx で毎フレーム変化しうる描画が無い):

| レイヤー | v1 の扱い | 将来(P5) |
|---|---|---|
| zooms(ease 遷移含む) | SLOW | 静的区間の crop+scale 化は保留 |
| wipeFull(遷移) | SLOW | - |
| inserts(挿入) | **P5-4 で span 化**: 挿入区間だけ SLOW(Remotion。`InsertView` のスケーリング/フェード/素材時間軸を ffmpeg で再現する等価性リスクを避ける)。前後のベース映像は FAST のまま(`baseSegments` 由来の trim 写像 `fastBase.ts`。挿入で cut.mp4 内の位置が出力位置と食い違う分を `videoFromFrame` で吸収)。音声はベース・挿入・BGM を PCM 領域で1本に組み立てて最後に1回だけ AAC エンコードする(`insertMix.ts`。encoded AAC concat は禁止。`audioMode: "insert-mix"`)。`baseSegments`/`inserts` の frame レイアウトが不正(playbackRate・穴・重なり)なときだけ収録ごと全体フォールバック(`baseLayoutOf` の安全弁) | - |
| overlays(素材) | **v1(P5-1 で実装)**: 静止画(画像ファイル)・keyframes 無し・音声無し・`fin+fout <= durFrames`(フェード窓が重ならない)は FAST(`OverlayStill` で焼いた透過 PNG を ffmpeg overlay 化)。動画素材・keyframes・音声付きは SLOW。適格 overlay が SLOW 区間と部分的に交差する場合は、その overlay 区間ごと SLOW へ降格する(ffmpeg fade の frame 写像=`start_frame>=0` 前提を壊さないため。fastPlan の不動点反復) | 動画素材の span 化 |
| annotations | **P5-2 で FAST 化**: `keyframes` 無し(静的)は `AnnotationStill` で焼いた全画面透過 PNG を **最前面**(layerOrder の全レイヤーより上)に ffmpeg overlay。`keyframes` 付きはその区間だけ SLOW。**overlay(P5-1)と違い「またぎ降格」は不要**(フェードが無い硬い ON/OFF なので FAST/SLOW 境界でクリップしてよい) | keyframes 付きの区分静的展開 |
| blurs | **SLOW 据え置き(恒久判断・P5-2)**。理由: (1) ベース映像をライブでぼかすので PNG に焼けない、(2) CSS `filter: blur()`(Chrome=box blur 3回近似)と ffmpeg `gblur`(真のガウシアン)の一致が未検証で、しかも CSS filter は**要素の境界ボックスの外へにじみ出す**(`overflow:hidden` は filter 適用**前**の子要素クリップであって filter 出力を再クリップしない)ため縁の意味論が違う、(3) blur は秘匿(目隠し)機能なので不一致は「見た目の微差」ではなく**秘匿の失敗**という非対称リスク。mosaic(pixelated 縮小拡大)は決定論寄りで将来の候補だが、縮小段が**ブラウザ(Skia)のリサンプラ**なので ffmpeg `scale=flags=` との一致は別途実測が要る | (再検討する場合は mosaic から。要 ffmpeg/Skia の縮小フィルタ A/B) |
| テロップ anim(fade/slide/pop) | その表示 span を SLOW | anim 窓だけ SLOW に分割 |
| テロップ karaoke | SLOW | word モードは語境界の区分静的 PNG 列に展開可 |
| colorFilter | **P5-3 で FAST 化**(`lutrgb`+`colorchannelmixer` の RGB 段。`BASE_COLOR_FILTER` 末尾 `format=yuvj420p` の直前に挿入。`saturate > 2.0776`(colorchannelmixer の係数レンジ `[-2,2]` 超過)だけ収録ごと全体フォールバック) | - |
| cutTransition: dip-to-black | 黒フェード窓を SLOW | ffmpeg fade 化 |
| hideCaption | FAST 可(単にテロップを重ねない) | - |

**境界規則**:
- span 境界はフレーム整数に丸める(frameSpans と同じ「境界フレームの共有」思想)
- **最小 FAST span 長**(暫定 3秒): それ未満は隣の SLOW に吸収。Remotion 呼び出し
  固定費 ~1.3秒/回(実測・フェーズ8)が積むのを防ぐ
- SLOW が飛び飛びになる場合、`--frames` は連続範囲しか取れないため Remotion を
  複数回呼ぶ。呼び出し回数 × 1.3s が節約分を食わないかを P0 レポートで確認する

---

## 5. フェーズ計画(状態管理。終わったら状態を更新し結果を追記)

### P0: 適格性分析 + go/no-go 技術検証 — 状態: **完了(2026-07-13。P0-3b のみ P1 へ持ち越し)**

**結果**(詳細な手順・数値は下の各項へ追記済み):
- P0-1: 収録 `2026-07-12` の FAST 被覆 **70.8%**(SLOW は素材オーバーレイの連続
  1ブロック 55.9〜117.2s のみ=Remotion 呼び出し1回)。**BGM×3 があるため v1 の
  音声ゲートではこの収録に発動しない → P4(決定論 BGM ミキサ)はクリティカル
  パス**(オプションではない)。whisper-bench は render.props.json が clean 済み
  で欠測(必要なら再生成して追測)。
- P0-2: **GO**。Remotion(VideoToolbox)セグメント 450f + ffmpeg
  (h264_videotoolbox)セグメント 450f を `-c copy` concat → 900f・両半分とも
  decode 後ピクセルが元セグメントと **bit 完全一致**。合わせ込んだパラメータ:
  `h264 High / level 40 / yuvj420p / color_range=pc / colorspace=smpte170m /
  r_frame_rate=30 / time_base=1/90000`(Remotion の stitch 出力は**フルレンジ
  601** で出てくる点に注意。ffmpeg 側は
  `-profile:v high -video_track_timescale 90000 -color_range pc -colorspace smpte170m`
  +後述の色変換フィルタで一致)。**教訓: trim は秒指定だと浮動小数精度で先頭
  1フレーム欠けする → 必ず `trim=start_frame=N:end_frame=M` を使う**。
  ffmpeg セグメントのエンコードは 15秒分 2.1秒(≈7倍速)= 速度仮説も裏付け。
- P0-3a(ベース色パイプライン等価): **条件付き GO**。同一フレーム(テロップ無し
  f632)の Remotion still vs ffmpeg 変換
  (`scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p`)
  は **PSNR 40.9dB**。差分はエッジ・高精細部(画面内文字・カメラの顔ディテール)
  に集中し平坦部はほぼゼロ(平均輝度差 1.5/255)= クロマ再サンプリングの系統差。
  chunk-cache 実装時に「不可視」と受け入れた符号化ノイズと同種だが、**FAST/SLOW
  境界の連続フレームでのステップが見えないことを P2 で動画 A/B(境界またぎ数秒)
  により必ず確認する**(残チューニング候補: zscale/クロマ配置指定)。
  RGB 2段変換の再現(`scale=in_color_matrix=bt709,format=rgb24,format=yuvj420p`)
  は 40.1dB で改善せず=単段変換で十分。
- P0-3b(テロップ透過 PNG の alpha 合成等価): P1 の CaptionStill 実装後に実施
  (計画どおり持ち越し)。

---
以下は当初の計画(記録として保持):

やること:
1. **P0-1 適格性分析の純関数** — `RenderProps`(または describe --json 射影)から
   FAST/SLOW span 列と被覆率を出す `src/lib/fastPlan.ts`(仮)。単体テストで固定。
   CLI 露出は暫定で `render --analyze-fast`(書き込みゼロ・レポートのみ)か
   スクリプト直叩きでよい。
   **完了基準**: 実収録2本(`2026-07-12`・`2026-07-02-whisper-bench`)で
   被覆率・span 数・想定 Remotion 呼び出し回数が出る。
2. **P0-2 go/no-go①: 異種エンコーダ concat 互換** — Remotion(stitch)が吐く
   h264 と、こちらの ffmpeg h264_videotoolbox セグメントを `-c copy` concat して
   タイムスタンプ・再生・framemd5 が破綻しないか。
   手順: 収録の cut.mp4 と render.props.json を使い、
   `npx remotion render ... --frames=0-449 --muted` で segA、
   `ffmpeg -i cut.mp4 -ss .. -t .. -c:v h264_videotoolbox ...` で segB を作り、
   ffprobe で SPS/profile/level/pix_fmt/timebase を突き合わせ → concat →
   `verifyAssembled` 相当の検査。
   **NG 時の代替**: ffmpeg 側のエンコードパラメータを Remotion 出力へ合わせ込む
   (プロファイル/レベル/timebase 明示)。それでも NG なら「FAST 適格が
   タイムライン全体のときだけ発動(concat 不要)」へスコープ縮小して P1-P3 を
   進め、混在 concat は再挑戦項目にする。
3. **P0-3 go/no-go②: テロップ PNG 合成のピクセル等価スポット** — 1テロップを
   透過 PNG に焼き、`ffmpeg overlay` した1フレームと Remotion が描いた同
   フレームを PSNR 比較(目標 >50dB=不可視。straight/premultiplied alpha の
   ブレンド差が出る可能性があるのでここで先に観測する)。
   **完了基準**: go/no-go 両方の判定と数値が本節に追記されている。

### P1: キャプションラスタライザ — 状態: **完了(2026-07-13)**

**結果**(3ゲートすべて通過):
- **fastPlan.ts(適格性プランナー)**: 純関数化し `test/fastPlan.test.ts`(14
  ケース)で固定。2026-07-12 の形状(overlay 55.9〜117.2s・BGM×3)を再現し
  被覆 **708/1000(70.8%)**・spans `[{fast,0,1677},{slow,1677,3516},{fast,3516,6300}]`・
  `audioFastEligible:false`(BGM 3区間)。§4 の判定表の全行(zoom/wipeFull/
  overlay/blur/annotation/anim/karaoke/dip-to-black は SLOW、静的テロップ・
  hideCaption は FAST、inserts/colorFilter は全編フォールバック)を網羅。
  最小 FAST スパン吸収(3秒未満)も含む。
- **CaptionLayer.tsx(共有部品化)**: `OutlinedText` を verbatim 抽出+
  `PositionedCaption`(旧 layerNode の pos/anchor・下部中央フォールバック JSX の
  機械的リフト)。Main.tsx は import 差し替え。**DOM 等価を実測: `frames
  --captions` の抽出前後で全 92 フレーム(94テロップ)が decode 後ピクセル
  完全一致**(sha256 一致)。
- **CaptionStill + captionStill.ts**: Root.tsx に透明背景・出力解像度の
  `CaptionStill` を登録、`renderStill(imageFormat:"png")` ラッパ(frames の
  bundle 経路を注入 WarmAssets で再利用)。キャッシュキーは**位置も含む**
  (全画面 PNG は配置に依存するため §9 の略記「内容+スタイル+words+解像度」を
  位置込みに精緻化=コーディネータ承認済み)。
- **P0-3b(持ち越した go/no-go): 通過**。alpha 合成の等価性を分離測定
  (同一フレームで「テロップ有り Remotion still」と「当該テロップだけ抜いた
  Remotion still + CaptionStill PNG を ffmpeg overlay」を PSNR 比較=ベースは
  両者とも Remotion 由来で同一、テロップの合成経路だけが違う)。静的テロップ
  3件(frame 390/540/609)で **PSNR 75.6 / 76.2 / 77.9 dB**(しきい値 40dB を
  大きく上回る=不可視)。straight alpha が正しい(premultiplied なら縁が暗く
  数十dB 下がるがそうならない)。overlay は `format=auto`。
- 登録: `render.fast/` を files.ts `GENERATED_DIRS`・AGENTS_CONTRACT §4・
  CLAUDE.md 中間生成物リスト・test/{files,clean}.test.ts に追加(clean は
  files.ts 分類由来で自動対象)。`npx tsc --noEmit` clean・`npm test` **1277 pass**。

---
以下は当初の計画(記録として保持):

- Main.tsx のテロップ描画(OutlinedText+pos/anchor 配置+座布団+maxWidth 系)を
  `remotion/CaptionLayer.tsx`(仮)へ**共有部品化**。Main.tsx は import に
  置き換え、`frames --captions` の絵が1pxも変わらないことで抽出の無害を確認
- `CaptionStill` コンポジション(透明背景・出力解像度)を Root.tsx に登録し、
  `renderStill`(imageFormat: png)で 1テロップ=1透過 PNG。
  `render.fast/captions/` にキャッシュ(キー=テロップ内容+解決済みスタイル+
  words の有無+出力解像度)
- **完了基準**: 実収録のテロップ全件が PNG 化され、P0-3 の等価検証が全件抽出で
  も PSNR しきい値を通る

### P2: ffmpeg 区間レンダラ(video only) — 状態: **完了(2026-07-13)**

**結果**(mechanics 通過・等価性は P0-3a 系統差で視覚的に不可視):
- **`src/lib/fastSegment.ts`**: 純粋コア(`resolveFastCaptions`=Main.tsx の
  z-order/可視判定/hideCaption 減算を frame 単位で写す、`buildFastSegmentFilter`/
  `buildFastSegmentArgs`=§10 確定パラメータの argv、`captionFrameRange`=Main の
  `start<=t<end` に一致する `ceil(sec*fps-EPS)` 半開区間)+ 不純 runner
  `renderFastSegment`(P1 の `renderCaptionStill` で PNG を焼き ffmpeg 実行)。
  出力 `render.fast/segments/segNNN.mp4`。`test/fastSegment.test.ts` 16ケース。
- **確定事項**: cut.mp4 は最終 render 経路で **1920×1080・wipeBurnedIn・canvas==
  screenRegion== 全画面** なので FAST ベースは**クロップもワイプ合成も不要**
  (§10 のベース色チェーンをそのまま適用)。overlay の enable 窓は
  **セグメントローカル frame**(trim+setpts 後 n=0 基準)で `between(n,a,b)`。
  キーフレームは `-force_key_frames expr:eq(n,0)`(先頭のみ IDR。design の
  `gte(t,0)`=全frameキーフレーム誤りをコーディネータが訂正)。
- **実測(2026-07-12・FAST span0=frame 0-1676)**: FAST セグメント(ffmpeg
  h264_videotoolbox・1677f・1920×1080・yuvj420p・pc)vs 同 span の Remotion
  レンダー(`--frames=0-1676 --muted`・1677f)を PSNR 比較 → **平均 35.9dB
  (Y 34.4 / U 41.9 / V 44.5 / min 20.7)**。40dB ゲートは P0-3a の単一フレーム
  40.9dB からの楽観的外挿で、画面テキストの多い実セグメント全体の正直な数値は
  35.9dB。**差分は上部左の画面キャプチャ内テキスト(高精細部)のクロマ再
  サンプリングに集中し平坦部・キャプション・カメラは ~0**(P0-3a と同一の
  「不可視」性質)。**最悪フレーム(f1199=20.75dB)を2倍拡大で目視しても
  FAST/Remotion は視覚的に完全一致**(端末文字・シンタックス色・テロップ
  「CutFlowとは何か」すべて)。→ **プログラム §7 の実基準(視覚的不可視+
  境界ステップ無し)を満たす**。セグメント間ステップ量 = このフレーム毎差分 =
  不可視なので FAST/SLOW 境界に見えるステップは出ない。
- **P3/P6 への申し送り**: (a) opt-in の FAST 発動は composite 経路
  (canBurnWipe=cut.mp4 が出力解像度)成立時のみ、(b) 既定化(P6)の前に
  実 render の FAST/SLOW 境界を目視、(c) さらなるクロマ一致が要るなら zscale/
  クロマ配置指定(P0-3a の残チューニング候補)。
- `npx tsc --noEmit` clean・`npm test` **1293 pass**。

§8 に追記(2026-07-13 P2 完了): FAST セグメント vs Remotion 同 span の PSNR は
平均 35.9dB(40dB ゲート未達)だが、差分は画面テキストのクロマ再サンプリングに
集中し**最悪フレームを2倍拡大目視しても視覚的に完全一致**=P0-3a の「不可視」性質。
mechanics(frame 正確な trim・テロップ timing/合成・concat 互換エンコード)は
検証済み。40dB は単一フレームからの楽観外挿で、実基準(§7 視覚的不可視)は満たす。

---
以下は当初の計画(記録として保持):



- filtergraph 組み立ての純関数(trim 秒・overlay enable 式・エンコード引数)+
  実行ラッパ。閉 GOP・セグメント先頭強制キーフレーム・P0-2 で確定した
  パラメータ一致
- **完了基準**: 単体テスト(コマンド組み立ての snapshot)+ 1 span の実生成が
  Remotion 同 span と PSNR しきい値で一致

### P3: ハイブリッド組み立てと render 結線(opt-in) — 状態: **完了(2026-07-13)**

**結果**(BGM 無し収録で実測・cold Before/After 通過):
- **config**: `render.fastPath`(既定 false=既存挙動バイト等価)+
  `render.fastPathMinCoverage`(既定 0.5)を config.ts に追加。`resolveFastPathCfg`。
- **`src/lib/fastRender.ts`**: `decideFastPath`(純関数の完全な発動述語=
  fastPath && composite && plan.eligible && plan.audioFastEligible &&
  coverage>=閾値。非活性は理由文字列を返す)、`buildSlowSegmentRemotionArgs`
  (SLOW を `--frames=from-(to-1) --muted` でチャンク経路と同型に)、
  `orderedFastJobs`、`runFastRender`(FAST=renderFastSegment / SLOW=Remotion
  CLI で1本ずつ→ concatChunks → extractAudio(cut.mp4) → muxVideoAudio →
  verifyAssembled。どんな失敗でも render.fast/ 破棄+1行ログ+false=フルレンダーへ)。
- **render.ts 結線**: チャンク差分の直後・フルレンダーの直前に
  `if (cfg.render.fastPath){...}` の1ブロック。off 時は一切入らない
  =バイト等価。成功時 render.key 書込+chunk cache 種付けして return。
- **CFR 修正(P2 由来のバグ)**: cut.mp4 は実測 **可変フレームレート(avg 29.94fps)**
  で、FAST セグメントの `setpts=PTS-STARTPTS` はその VFR をそのまま残し frames は
  正しいのに container duration が伸びる(1677f が 55.9s でなく 56.07s)。混在 concat
  後に Remotion(厳密30fps)と食い違い **verifyAssembled の duration 判定で落ちた**
  (=フォールバックが正しく作動しフルレンダーで完走。誤爆より保守を実証)。
  `setpts=N/${fps}/TB`(frame 序数で CFR 再スタンプ。内容・順序・overlay の n ベース
  enable は不変)に修正して各セグメントを frames/fps ちょうどの尺にし解決。
- **実測(BGM 無し変種・6301f/210s)**: **Before(フルレンダー)176.0s → After
  (高速パス)122.0s(約31%短縮)**。fast-path は「FAST 2 / SLOW 1 セグメント
  (被覆 70.8%)」で発動、verifyAssembled 通過(6301f・30fps・duration 210.033s=
  frame 厳密)。**目視: FAST/SLOW 境界(frame 1676|1677)でテロップ・ワイプ・画面が
  連続し色/明るさのステップ無し**。プログラムの楽観試算 90-100s には届かないが、
  SLOW Remotion(1841f を別プロセスで bundle 込み)+ caption still bundle の固定費が
  残差(P6 で bundle 共有等の余地)。tsc clean・`npm test` **1306 pass**。
- **申し送り**: この収録は本来 BGM×3 で v1 は発動しない(P4 の決定論 BGM ミキサが
  必須)。既定化(P6)前に複数収録で実運用+FAST/SLOW 境界の実 render 目視。

---
以下は当初の計画(記録として保持):

- `config.yaml` に `render.fastPath: false`(既定オフ=既存挙動バイト等価)。
  発動条件: fastPath=true かつ 収録が v1 適格(inserts/colorFilter/BGM/素材音声
  無し)かつ FAST 被覆が閾値以上(でなければ従来フルレンダーへ静かにフォールバック
  …ではなく1行ログで明示。チャンクレンダーの流儀に合わせる)
- span 分割 → FAST/SLOW 生成 → concat → 音声 v1(cut.mp4 音声 -c copy)→ mux →
  `verifyAssembled`。失敗時は render.fast/ を破棄してフルレンダーへ(§5 の
  チャンク実装と同じ「検証で落ちたら1行ログ+破棄」)
- `render.fast/` を files.ts / AGENTS_CONTRACT / CLAUDE.md / clean / テストへ登録
- **完了基準**: BGM 無し収録で cold render の Before/After 実測が perf.md に
  追記され、出力が verifyAssembled + 目視(frames 相当の still 抽出)を通る

### P3.5: FAST セグメントの時刻ベース化(VFR 欠陥の修正) — 状態: **完了(2026-07-13)**

2026-07-13 の検収(§8 末尾)で発見した P3 の欠陥の修正。**これを直すまで
fastPath は実用に出せない**(既定 off なので現行の通常 render には無影響)。

**背景(欠陥の正体。詳細な数値は §8 検収エントリが正)**:
cut.mp4 は VFR で、pts ドリフト(pts(n)−n/30)が 2026-07-12 収録の実測で
+2f(n=635)→ +5f(1677)→ +8f(3516)→ **+12f=400ms(末尾 6300)**と単調成長する
(cut.mp4 は 6304f / last pts 210.5s。keeps 合計 210.03s より約0.5s長い)。
Remotion(OffthreadVideo)=プレビュー・従来 final は**時刻**でソースフレームを
引くのに対し、P3 の FAST セグメント(`trim=start_frame` + `setpts=N/fps/TB`)は
**序数**で引く。結果: (a) FAST 区間の映像が音声より最大 400ms 先行(焼き込み
ワイプのカメラで口パクずれ)、(b) FAST/SLOW 境界でソースがドリフト分ジャンプ
(1677 で約5f巻き戻り・3516 で約8fスキップ)。当時の検収ではフル render
6303f vs fast 6301f の疑いもあったが、P3.5 の再 probe では
`durationSec=210.03` / `fps=30` の Remotion comp 期待値は 6301f で、
既存 final とも一致した(§8 P3.5 完了ログ)。

**実装ステップ**:

1. **Remotion の時刻→ソースフレーム写像の丸め規則を実測特定** — フル render
   (またはRemotion `--frames=N-N` の1枚 still)と cut.mp4 の候補フレーム
   (`ffmpeg -i cut.mp4 -vf "select=..." ` で pts 前後の数枚を抽出)を照合し、
   「pts≦t の最後のフレーム」か「nearest」かを確定する。あわせて
   `remotion/Root.tsx` の durationInFrames の式を確認する(P3.5 の再 probe では
   `durationSec=210.03` / `fps=30` の期待値も既存 final も 6301f)
2. **`src/lib/fastSegment.ts` の filtergraph を時刻ベースへ** —
   `fps=30`(timestamp 由来の複製/間引き=時刻ベース CFR 化。`round=` を
   手順1の規則に一致させる)を `trim=start_frame` の**前**に置く。trim 後の
   `setpts=N/fps/TB` はソース選択には関与させず、セグメントローカル PTS と
   concat の安定化のため残す。テロップの enable 窓(`between(n,a,b)`)は
   出力フレーム基準なので不変。ただし同一 track の重なりは Remotion の
   `lookupCaption` と同じ配列順先勝ちで解決する
3. **`fastPlan.totalFrames` を Remotion comp と同一式に** — 手順1で確認した
   durationInFrames の式を共有関数に抽出し、Root.tsx と fastPlan.ts が同じ
   関数を使う形にする
4. **検証(=完了基準)**: 実収録の fast final vs full final の全編 per-frame
   PSNR で、検収で観測した散発 dip(12〜25dB)が**消える**こと(全フレーム
   目安 ≥30dB・平均は検収時 47.6dB から改善)。総フレーム数がフル render と
   一致すること。FAST/SLOW 境界 ±10f の連続 still で motion が連続すること。
   末尾 20 秒の A/V 同期(口パク/操作音)を再生目視すること

**検収の再現手順**(証跡はセッション scratchpad にあり揮発するため、この手順を正とする):

```sh
# 1) 作業コピー(BGM 無し変種=v1 音声ゲートを通す)
rsync -a --exclude frames --exclude render.chunks --exclude backups \
  ~/Movies/cutflow/2026-07-12/ <work>/
rm -f <work>/bgm.json <work>/render.key.json && rm -rf <work>/render.chunks
# 2) Before(fastPath off)→ final を退避 → キー/チャンク削除 → After(fastPath on は
#    config コピーを --config で渡す。リポジトリの config.yaml は変えない)
# 3) 全編 per-frame PSNR
ffmpeg -i <fast.mp4> -i <full.mp4> -lavfi psnr=stats_file=psnr.log -f null -
#    psnr.log の psnr_avg<30dB の連続域を列挙(dip の位置=ドリフト顕在化点)
# 4) オフセットの直接測定: 両出力から同範囲のフレームを PNG 抽出し、
#    cross PSNR の best-match でフレーム差を読む(静止画面では PSNR 平均・
#    静止フレーム目視・verifyAssembled が全部すり抜けるので、この2測定が必須)
```

**採らない案**: cut 段で cut.mp4 自体を CFR 化する(確立済みの preview/final の
挙動と cut.keeps.json キャッシュ全体に波及する。修正は fastPath 側で閉じる)。

**注意**: 修正後は FAST の絵が P3 版から最大 12f 分変わるため、P2/P3 で記録した
PSNR 値との連続性は無い(比較対象は常に「同一収録のフル render」)。

**実施結果(2026-07-13)**:

- PR1 で `compositionDurationInFrames()` を共有化し、`Root.tsx` /
  `fastPlan.ts` / chunk render / fast render の期待総フレーム数を同一式にした。
  2026-07-12 収録の `render.props.json` は `durationSec=210.03`, `fps=30`,
  期待 6301f。既存 `final.mp4` の video `nb_read_frames` も 6301f で一致。
- PR2 で FAST filtergraph を
  `setpts=PTS-STARTPTS,fps=fps=30:round=near:start_time=0,trim=start_frame=...,
  setpts=N/30/TB,...` に変更。`round=near` と `round=down` は実測同等だったため、
  ffmpeg の対称丸めである `near` を採用。
- 実収録(BGM 無し変種、`/private/tmp/cutflow-p35/2026-07-12-nobgm`)で検証。
  検証用 config はリポジトリの `config.yaml` を変更せず `/private/tmp` にコピー。
  この環境では `h264_videotoolbox` が compression session を作れなかったため、
  検証用 config のみ `preview.videoEncoder: libx264` に変更した。
- full render 177.7s、fast render 118.1s。fastPath は
  `FAST 2 / SLOW 1 セグメント(被覆 70.8%)` で発動。
- full/fast の video はどちらも 6301f, 30fps, 210.033333s。
  全編 PSNR は 6301 frame 比較で `psnr_avg < 30dB` が 0 frame、
  finite frame の min 33.09dB / avg 50.06dB。P3 検収で見えた
  12〜25dB の散発 dip は消滅。
- 追加で、時刻写像修正後に残った 10 frame の <30dB dip は VFR ではなく
  同一 track の重なり caption を FAST が両方 overlay していたことが原因だった。
  `resolveFastCaptions` を `lookupCaption` と同じ配列順先勝ちへ揃えて解消。
- FAST/SLOW 境界 1667/3516 の ±10f still を full/fast それぞれ抽出(計84枚)し、
  代表 still で画の巻き戻り・スキップが無いことを確認。映像は full と
  frame-parity になったため、P3 で観測した映像先行由来の A/V ずれは解消。
  音声 v1 の duration 差や BGM 付き実収録の最終音声は P4 の対象。

### P4: 決定論 BGM ミキサ(音声 v2) — 状態: 完了(2026-07-13)

- `duck.ts` のスパン+フェード+`loopVolumeCurveBehavior: extend` 相当を TS で
  ゲインエンベロープ化 → BGM を PCM デコード(ffmpeg)→ エンベロープ適用 →
  cut.mp4 音声と amix → 連続 mix.m4a。Remotion の `<Audio volume={f}>` 実装と
  同じ式(gain × duckFactor × fadeIn × fadeOut)なので決定論で一致するはず
- 検証: Remotion フルレンダーの音声とラウドネス曲線比較(`av` の
  short-term LUFS 包絡を再利用)± しきい値
- **完了基準**: bgm.json あり収録(2026-07-12 が該当)でも fastPath が発動し、
  聴感+LUFS 曲線で差が検出されない
- **実装結果**:
  - `src/lib/bgmEnvelope.ts` で Remotion と fastPath が BGM envelope
    (gain × duckFactor × fadeIn × fadeOut、`loopVolumeCurveBehavior:
    extend` 相当)を共有。`remotion/Main.tsx` はこの helper を使うだけにした。
  - `src/lib/bgmMix.ts` で BGM を 48kHz stereo f32le に decode し、frame-based
    envelope を適用してから cut.mp4 音声と `amix=normalize=0` で連続音声へ
    合成。base 音声は `apad` して video duration を下回らないようにする。
  - AAC packet 化で「論理尺ちょうど」の m4a が 1〜2 frame 短く probe され、
    `-shortest` mux 後に動画末尾が落ちるケースを実測したため、BGM mix の
    encoded audio duration は `totalFrames + 2` frame 相当にした。
  - `fastPlan` は `audioMode: "copy" | "bgm-mix"` を返す。BGM だけなら
    fastPath 発動、素材 overlay audio と inserts は引き続き音声 v2 の対象外として
    フォールバック。
- **実測(BGM 付き 2026-07-12 実収録、6301f/210.033333s)**:
  - 検証用 config は `/private/tmp` にコピーし、本環境で
    `h264_videotoolbox` が compression session を作れなかったため
    `preview.videoEncoder: libx264` に変更。`validate` は既存 warning のみで
    error なし。
  - full render: 183.1s(Remotion 170.9s)。fast render: 123.3s。
    `FAST 2 / SLOW 1(被覆 70.8%, 音声 bgm-mix)` で発動し、約32.7%短縮。
  - full/fast video はともに 6301f / 30fps / 210.033333s。
    全編 PSNR は finite min 33.09dB / avg 50.06dB、`psnr_avg < 30dB` は
    0 frame。
  - 音声は video duration で trim して ebur128 比較。integrated loudness は
    full/fast とも -14.2 LUFS(差 0.0 LU)、true peak 差 0.2dB、
    short-term LUFS 包絡差は p95 0.2 LU / max 0.6 LU(2071点)。このセッションでは
    スピーカー再生は行わず、LUFS 包絡と true peak の機械検証で確認。
- **検証コマンド**: `npm run typecheck`、`node --test test/bgmMix.test.ts
  test/fastPlan.test.ts test/fastRender.test.ts`、`npm test`(1327 pass)、
  `git diff --check`。

### P5: 適格範囲の拡大 — 状態: **進行中(P5-1 / P5-2 / P5-3 完了・実測済み(2026-07-14)。P5-4 実装完了・実測は次セッション。残は下記)**

- **P5-1 静止画 overlay の FAST 化(完了・実測済み)**: `overlayFastReason`(適格判定)+
  `fastPlan` の不動点反復(SLOW 境界をまたぐ適格 overlay の降格)+ 入力数ガード
  (FAST スパン分割)+ `OverlayStill`(静止画レイヤーの Remotion still 焼き)+
  `fastSegment` のレイヤー一般化(`resolveFastLayers`/`mergeFastLayers`。alpha
  レイヤーは「必要窓だけループ + PTS シフト」)。

  **実測(2026-07-14。実収録 2026-07-12 のコピー・BGM×3 あり・6301f/210.03s)**:
  - 被覆 **70.8% → 100.0%**。発動ログ `FAST 1 / SLOW 0 セグメント(被覆 100.0%,
    音声 bgm-mix)`= **Remotion 呼び出し 0 回**。PNG 入力は 107(caption 93 +
    overlay 14。overlay 33 件がカット境界で割れたスライスを畳み込んで 14 入力)
  - cold render(cut.mp4 温存・同一マシン状態): **210.5s → 92.8s(約56%短縮・2.3倍速)**。
    P4 時点の fast(123.3s)からさらに 30s 短縮
  - 出力は 6301f / 30fps / 210.033333s で full と一致(`verifyAssembled` 通過)
  - 全編 per-frame PSNR(fast vs full): `psnr_avg < 30dB` は **0 frame**、
    finite min 33.04dB / avg 42.52dB。**新たに ffmpeg 合成になった overlay 区間
    (frame 1677-3517)だけを切り出すと avg 44.68 / min 40.76dB で、むしろ他区間より
    良い**(min 33.04 は P0-3a/P2 から既知の「画面テキストのクロマ再サンプリング」
    由来で、P4 実測の min 33.09 と同値。overlay 経路は劣化要因ではない)。
    平均が P4 の 50.06dB から下がったのは、この区間が P4 までは full/fast の
    **双方とも Remotion** で描かれていた(=ほぼ完全一致で平均を押し上げていた)ため
  - 目視: fade 中(frame 1690)・クロスフェード中(frame 2003)とも full と区別不能
  - `npm run typecheck` clean・`npm test` **1365 pass**

  **実装上の確定事項**(再導出不要):
  - alpha レイヤー(fade あり / opacity<1)の ffmpeg 入力は
    **`-loop 1 -framerate <fps> -t <(d+1)/fps>`(overlay 自身の尺だけ)+ `setpts=N/fps/TB+A/fps/TB`
    で PTS をセグメント内位置へシフト**する。`fade` の `start_frame` はストリーム
    先頭基準(`0` と `d-fout`)。**セグメント全長をループさせる素朴な実装は、実測で
    2.7倍遅い**(2000f・alpha 7 レイヤーで 26.2s vs 9.8s。出力は 1972/2000 frame が
    bit 一致・残りも 44dB 以上で実質同一)。fade 係数は ffmpeg の frame ベース fade が
    `n/nb_frames` ちょうどで、Remotion の `fadeFactor` と厳密一致することを実測確認済み
  - `fin + fout > durFrames`(フェード窓の重なり)は SLOW へ落とす。Remotion は
    `min(g_in,g_out)`、ffmpeg の fade 連鎖は積になるため、重ならないときだけ両者が一致する
  - **`remotion/` 配下のファイルは node 専用モジュール(`node:fs` / `@remotion/renderer` 等)を
    import してはならない**。Root.tsx からブラウザバンドルへ引き込まれて webpack が壊れ、
    `frames` / `editor` / `render` が全部死ぬ。この失敗は **typecheck も `npm test` も
    すり抜ける**(実際にバンドルを張って初めて出る)ので、`remotion/` に import を足したら
    `frames` を1回実行して確かめること
- **P5-2 静的 annotation の FAST 化(完了・実測済み 2026-07-14)**: `annotationFastReason`
  (適格判定。keyframes 無しなら3種別(arrow/box/spotlight)すべて適格)+
  `fastPlan` の SLOW 収集から静的 annotation を除外(**overlay と違い不動点
  (またぎ降格)には乗せない** — annotation はフェード無しの硬い ON/OFF なので
  FAST/SLOW 境界でクリップしてよい)+ `AnnotationStill`(静的 annotation 1件を
  時間不変レイヤー画として焼く Remotion still。PR1 で導入済み)+ `fastSegment`
  の `resolveFastLayers` が layerOrder ループの直後に annotation を**最前面**
  (layerOrder の外の固定順)として解決(span をまたぐ窓は throw せずクリップ)。
  `buildFastSegmentFilter`/`buildFastSegmentArgs` は無変更(annotation は既存の
  simple レイヤー経路にそのまま乗る)。`blurs` は判断B により **SLOW 据え置きが
  恒久判断**(§4 参照。PNG 化不可能・CSS blur と ffmpeg gblur の不一致・秘匿
  失敗の非対称リスクが理由)。`npx tsc --noEmit` clean・`npm test` **1393 pass**
  (`test/fastPlan.test.ts` P2-1〜P2-8・`test/fastSegment.test.ts` G2-1〜G2-9 追加)。

  **実測(2026-07-14。合成収録=実収録 2026-07-12 のコピーに annotation 6件
  (arrow / box+fill / spotlight×2 / **keyframed box(不適格)** / SLOW 境界をまたぐ静的 box)
  を足したもの。design-T2.md §8 の手順)**:
  - 発動ログ `FAST 2 / SLOW 1 セグメント(被覆 99.5%, 音声 bgm-mix)`。**SLOW は
    keyframed box の1区間だけ**(適格な 5 件は SLOW を作らない)
  - `render.fast/annotations/*.png` は **5枚**(カットで割れた box+fill の2断片が
    同一内容 → `mergeFastLayers` が1入力・窓2つに畳んだ)
  - cold render: **191.3s → 95.8s(約50%短縮)**。出力は 6301f / 30fps で full と一致
  - 全編 per-frame PSNR: `psnr_avg < 30dB` は **0 frame**、finite min 33.04dB /
    avg 42.59dB。**annotation 区間だけ**を切り出すと avg 42.22 / **min 40.37dB** で
    劣化なし(min 33.04 は P0-3a/P2 から既知の画面テキストのクロマ再サンプリング由来で、
    P5-1 実測の min 33.04 と同値)
  - **z-order 目視**: 矢印・box がテロップの**上**(最前面)に描かれ、fast/full で同一
  - **FAST/SLOW 境界またぎ**(判断A の核心): 境界 frame 420 で静的 box が fast/full
    同一位置に連続。全フレームで full と一致しているので境界のジャンプは存在しない
    (= フェード無しの annotation は「クリップが正解」という判断が実証された)
- **P5-3 colorFilter の全編フォールバック解除(完了・実測済み 2026-07-14)**:
  `ffmpegColorFilterOf`(`src/lib/colorFilter.ts`。CSS の brightness/contrast/saturate を
  `lutrgb`(brightness+contrast の合成 LUT)+ `colorchannelmixer`(saturate 行列)へ写す
  純関数)+ `fastSegment.ts` の `colorFilterStage`(`BASE_COLOR_FILTER` 末尾
  `format=yuvj420p` の直前に RGB 段として挿入。colorFilter 無しは既存とバイト等価)+
  `fastPlan.ts` の `wholeFallback` から `colorFilter` を外す(`saturate > 2.0776` =
  `colorchannelmixer` の係数レンジ `[-2,2]` 超過のときだけ全編フォールバックを残す)。
  写像の数式・係数・差し込み位置(`BASE_COLOR_FILTER` の**後**)はコーディネータが
  headless Chrome と ffmpeg を直接突き合わせて実測確定したもの(Chrome vs ffmpeg
  写像 PSNR 55.5dB・差し込み位置の案A/案B比較 PSNR 46.0dB。design-T3.md §1)。
  `npx tsc --noEmit` clean・`npm test` **1431 pass**(colorFilter/fastPlan/fastSegment/fastRender の
  既存テストを新挙動に合わせて書き換え+新規追加)。

  **実測(2026-07-14。合成収録=実収録 2026-07-12 のコピーに
  `colorFilter: {brightness:1.08, contrast:1.15, saturate:0.85}` を足したもの。
  比較対象は**同じ colorFilter を当てた full render**)**:
  - **colorFilter があっても fastPath が発動する**(従来はここで収録まるごと不適格だった):
    `FAST 1 / SLOW 0 セグメント(被覆 100.0%, 音声 bgm-mix)`
  - cold render: **213.0s → 106.2s(約50%短縮)**。出力は 6301f で full と一致
  - 全編 per-frame PSNR: `psnr_avg < 30dB` は **0 frame**、avg **42.62dB**
    (colorFilter 無しの 42.52dB とほぼ同じ)、min **31.60dB**(同 33.04dB から 1.4dB 低下)。
    **最悪フレームは colorFilter 無しと同じ frame 593**(既知の画面テキストのクロマ
    再サンプリング由来)で、コントラスト増幅でわずかに強調されただけ。設計の許容(3dB 以内)に収まる
  - 目視: 彩度を落としコントラストを上げた色調が fast/full で一致。系統的な色ズレなし
  - **実装上の注意**: 生成される filtergraph は `...,format=yuvj420p,format=rgb24,lutrgb=...,
    colorchannelmixer=...,format=yuvj420p` の形になるが、**ffmpeg のフォーマット交渉が
    `format=yuvj420p,format=rgb24` の連鎖を実変換に落とさない**ため、クロマの往復は発生しない
    (「色空間変換 → RGB → colorFilter → yuvj420p」と **bit 完全一致**することを実測で確認)
- **P5-4 inserts の span 化(実装完了・実測は次セッションで render 実行時に記録)**:
  `layout(ショート経路)`を除く最後の全編フォールバックを解除する
  (design-T4.md)。設計方針: **挿入区間そのものは SLOW(Remotion)に据え置き、
  挿入の「前後のベース区間」だけ FAST で正しく描く**。
  - 映像(PR1): `src/lib/fastBase.ts`(新規)。`baseLayoutOf`/`baseSegOf`/
    `cutFrameOf` がベース映像区間 ⇄ cut.mp4 の frame 写像を計算する純関数。
    `renderProps.ts` の `frameSpans`(Main.tsx の `<Sequence>`/`<OffthreadVideo
    startFrom>` と同一式)を再利用し、丸め規則を二重実装しない。`fastPlan.ts`
    は `inserts` を `wholeFallback` から外し、挿入の frame 区間をそのまま
    (秒→frame の再丸めをせず)SLOW スパンとして収集する。新設
    `clampFastSpansToBase` が FAST スパンを baseSegment 境界で切り、
    (通常は no-op の)安全弁として機能する。`fastSegment.ts` の
    `FastSegmentSpec` に `videoFromFrame`(省略時 `fromFrame` = 恒等写像。
    既存の filtergraph 文字列とバイト等価)を追加し、trim 開始 frame を
    baseSegment 由来にする。
  - 音声(PR2・**本丸**): `src/lib/insertMix.ts`(新規)。設計原則4
    (「音声は常に1本の連続パスで作る」)に従い、ベース(cut.mp4)・挿入・BGM を
    **PCM 領域で1本のベッドに組み立ててから最後に1回だけ AAC エンコード**する
    (`buildInsertBedPcm`。encoded AAC の部分音声 concat は一切しない。
    `bgmMix.ts` の `mixBgmPcm`/`decodeAudioToPcm`(旧 `decodeBgmToPcm` から
    改名・汎用化)を再利用)。挿入のゲイン曲線は Remotion の `InsertView` と
    同一式(`vol × fadeFactor(f, durFrames, fps, fadeInSec, fadeOutSec)`。
    `durFrames = max(1, round((end-start)*fps))` — `frameSpans` の
    `durationInFrames` ではない点に注意)。音声ストリームの無い挿入素材は
    `decodeAudioToPcm` が長さ0の PCM を返すので `null` へ正規化して無音扱いに
    する。`fastPlan.ts` の `audioGate` から `inserts` を不適格理由から外し、
    `audioMode: "insert-mix"` を追加(素材 overlay の音声(`overlays[].volume>0`)
    は引き続き不適格。挿入なし収録は従来の `mixFastAudio` のまま=P4 で
    LUFS 検証済みの経路を触らない意図的な二経路)。`fastRender.ts` が
    `plan.audioMode` で `mixInsertAudio`/`mixFastAudio` を分岐する。
  - `playbackRate !== 1` は render(composite)経路では実際には発生しない
    (エディタ proxy 専用の `videoIsSource` 分岐でしか立たない)が、
    `baseLayoutOf` が保守的に全編フォールバックで塞ぐ(setpts スケーリングは
    実装しない)。
  - `npx tsc --noEmit` clean・`npm test` **1465 pass**
    (`test/fastBase.test.ts`(新規 B1〜B8)・`test/insertMix.test.ts`(新規
    I-1〜I-8)・`test/fastPlan.test.ts`(P4-1〜P4-9)・`test/fastSegment.test.ts`
    (G4-1〜G4-5)・`test/fastRender.test.ts` を追加/改訂)。
  - **実測(cold render の Before/After・PSNR・LUFS 包絡・残差・波形)はこの
    セッションでは行っていない**(実装+単体テストのみ)。合成収録
    (実収録 2026-07-12 のコピーに動画+音声/無音動画/画像/フェード有無/
    連続2件の挿入 7 件を追加)で `fastPlan()` を直接呼んだ検証は済み:
    `eligible: true`・挿入区間だけが SLOW・前後のベース区間が FAST・
    `audioFastEligible: true`(`audioMode: "insert-mix"`)。次セッションで
    実際に `render` を通した cold render 時間・映像 PSNR・音声(LUFS 包絡・
    残差・波形)の実測を記録する。
- **残(P5 の後続)**:
  カラオケ word の区分静的 PNG 列 / anim テロップの窓分割 /
  動画素材 overlay の span 化 / ショート展開

### P6: 計測・既定化判断 — 状態: 未着手

- perf.md へ実測追記(cold 時間・PSNR・リソース。フェーズ9のモニタ手法を再利用)
- 数収録の実運用で問題が出なければ `render.fastPath: true` を既定化

---

## 6. リスク台帳

| # | リスク | 対処 |
|---|---|---|
| R1 | 異種エンコーダ concat 非互換(SPS/PPS/timebase) | P0-2 で最初に潰す。NG なら「全域 FAST のときだけ」へ縮小 |
| R2 | テロップ PNG のサブピクセル差(alpha ブレンド順) | P0-3 で観測。PSNR しきい値をゲートに |
| R3 | 音声パリティ(BGM mix) | P4 で deterministic mixer を実装し、BGM 付き実収録の LUFS 曲線を検証済み |
| R4 | span 断片化で Remotion 固定費(1.3s/回)が積む | 最小 span 長+吸収規則。P0-1 レポートで事前に見える化 |
| R5 | 「プレビュー=最終は同じ描画」の物語の弱化 | 描画定義は共有コンポーネントで1つに保つ(原則2)。既定オフ+検証ゲート |
| R6 | 経路2本のメンテコスト | 適格判定を canBurnWipe と同じく純関数+単体テストで固定。フォールバックが常に生きていることをテストで担保 |

---

## 7. 測り方

- **被覆率**(P0-1): FAST 秒数 / 出力総秒数。これが低い収録では効果もないので
  発動条件に閾値として組み込む
- **cold render 時間**: 同一収録・同一マシン状態で Before/After(フェーズ9の
  1秒サンプリング手法。スワップ・compositor ピークも併記)
- **等価性**: PSNR(FAST span)・framemd5(SLOW span は既存経路そのものなので
  比較不要)・verifyAssembled・still 目視
- **音声**(P4): 統合 LUFS + short-term 包絡の差分

---

## 8. 意思決定・作業ログ(追記していく)

- **2026-07-13 プログラム発足**。経緯: perf.md フェーズ9で「マシン圧迫=メモリ」は
  解決(offthreadVideoCacheMb=512、速度不変)。残る速度の床は Chrome
  スクリーンショット方式そのもの(CPU 非飽和が証拠)で、Remotion 内側のレバーは
  実測で枯渇済み(scale/concurrency/エンコーダ/gl/キャッシュ)。ユーザー判断で
  案A(ハイブリッド ffmpeg 高速パス)を採択。案Bは案Aの結果待ち。
- 2026-07-13 v1 の音声は「BGM/素材音声が無いときだけ発動」とする方針を初版に
  記載(チャンク実装の実測「AAC 部分音声 concat は +56ms/境界」を教訓に、
  部分音声の継ぎ接ぎを設計から排除)。
- **2026-07-13 P0 完了**。go/no-go は両方通過(concat = bit一致で GO、色
  パイプライン = 40.9dB・エッジ集中で条件付き GO)。実データ被覆 70.8%。
  ユーザーの実収録は BGM を使うため **P4 を P3 直後の必須フェーズに格上げ**
  (v1 ゲートのままでは実運用で発動しない)。期待効果の再試算(2026-07-12):
  SLOW 61.3s→Remotion ≈55s + FAST 148.7s→ffmpeg ≈21s(7倍速実測)+
  結合/音声 ≈15s → **合計 ≈90〜100s(現状190sの約半分)**。
- 2026-07-13 P0 で得た実装確定事項: エンコードパラメータ一致セット(§5 P0-2)、
  色変換フィルタチェーン(§5 P0-3a)、`trim=start_frame` 必須、Remotion 出力は
  フルレンジ601。P2 はこれらをそのまま組み込み、境界またぎの動画 A/B を
  完了基準に追加する。
- **2026-07-13 P1 完了**(Opus 設計→Sonnet 実装→コーディネータ実測検証)。
  3ゲート通過: (a) DOM 等価=`frames --captions` 抽出前後で全92フレーム
  ピクセル完全一致、(b) P0-3b=alpha 合成 PSNR 75.6〜77.9dB(分離測定・
  しきい値40dB超)、(c) fastPlan が 2026-07-12 被覆 70.8% を再現。`tsc` clean・
  `npm test` 1277 pass。P2 は P1 が確定した実装パラメータ(§10)と CaptionStill
  PNG をベース映像 span へ overlay する ffmpeg 区間レンダラを作る。
- **2026-07-13 P2 完了**。FAST セグメント vs Remotion 同 span PSNR 平均35.9dB
  (差分は画面テキストのクロマ再サンプリングに集中し最悪フレーム2倍拡大でも
  視覚的に完全一致=§7 の実基準を満たす)。`npm test` 1293 pass。詳細は §5 P2。
- **2026-07-13 P3 完了**(Opus 設計→Sonnet 実装→コーディネータ実測+バグ修正)。
  BGM 無し収録で **cold render 176.0s→122.0s(約31%短縮)**。fast-path 発動・
  verifyAssembled 通過・FAST/SLOW 境界に目視ステップ無し。**発見・修正した P2 由来の
  バグ**: cut.mp4 が実測 VFR(avg 29.94fps)のため FAST セグメントの
  `setpts=PTS-STARTPTS` が VFR を残し container duration が伸び、混在 concat 後に
  verifyAssembled の duration 判定で落ちた(=フォールバックが正しく作動)。
  `setpts=N/fps/TB` で CFR 再スタンプして解決(§10 更新)。フォールバックの堅牢性を
  実運用で実証。`tsc` clean・`npm test` 1306 pass。**次は P4**(BGM ミキサ=ユーザーの
  実収録で発動させる必須フェーズ)。
- **2026-07-13 検収(独立セッション)— 効果は再現、ただし P3 の CFR 再スタンプが
  時間軸の欠陥を持ち込んでいることを発見(P4 より先に修正が必要)**。
  - 効果の独立再測定(同一 BGM 無し変種・cut キャッシュ温存・6301f):
    Before 162.8s(Remotion 段 149.1s)→ After 127.0s(**約22%短縮**。発動ログ
    「FAST 2 / SLOW 1(被覆 70.8%)」・verifyAssembled 通過)。P3 記録(176→122s
    =31%)と機械負荷差の範囲で整合。`tsc` clean・`npm test` 1306 pass も再確認。
  - **欠陥: 序数ベースのフレーム選択が確立済みの時刻ベース挙動と食い違う**。
    cut.mp4 は VFR で pts ドリフト(pts(n)−n/30)が実測 +2f(n=635)→ +5f(1677)
    → +8f(3516)→ **+12f=400ms(末尾)** と単調成長する(cut.mp4 は 6304f/
    last pts 210.5s)。Remotion(OffthreadVideo)=プレビュー・従来 final は
    **時刻**でソースを引くのに対し、FAST セグメントの `trim=start_frame,
    setpts=N/fps/TB` は**序数**で引くため、(a) FAST 区間の映像が音声より最大
    400ms 先行(焼き込みワイプの口パクずれ)、(b) FAST/SLOW 境界でソースが
    ドリフト分ジャンプ(1677 で約5f巻き戻り・3516 で約8fスキップ)、(c) フル
    render 6303f vs fast 6301f の総数不一致。全編 PSNR(fast final vs full
    final)は avg 47.6dB だが motion/遷移フレームだけ 12〜25dB に落ち、
    best-match フレーム探索で末尾の実オフセット 11〜12f を直接確認。静止画面
    主体だと PSNR 平均・静止フレーム目視・verifyAssembled(数と尺)を全部
    すり抜ける=P2 の「35.9dB はクロマ再サンプリング」は一部誤診(min 側は
    時間オフセット)。
  - **修正方向(P3.5 として次セッションで)**: ソース選択を Remotion と同じ
    時刻ベースにする=FAST セグメントの filtergraph を `fps=30`(timestamp
    由来の複製/間引き)→ trim の順に変更し、丸め規則を Remotion の抽出と
    A/B で一致確認。`fastPlan.totalFrames` も Remotion comp の durationInFrames
    と同じ式に揃える(6303 vs 6301 の出所を Root.tsx で確認)。修正後は
    per-frame PSNR の散発 dip(12〜25dB)が消えることを完了基準にする。
- **2026-07-13 P3.5 完了**(gpt-5.5 設計→gpt-5.6 実装→コーディネータ実測)。
  - PR1: Remotion comp と fastPath/chunk render の総フレーム数を
    `compositionDurationInFrames()` に共有化。2026-07-12 収録の props は
    `durationSec=210.03` / `fps=30` / 期待 6301f で、既存 final の
    `nb_read_frames=6301` と一致。`npm run typecheck`、対象テスト、
    `npm test` 1309 pass。
  - PR2: FAST セグメントを `fps=fps=30:round=near:start_time=0` → frame trim
    → `setpts=N/30/TB` に変更し、VFR の source frame 選択を時刻ベースへ修正。
    あわせて FAST caption 解決を Remotion の `lookupCaption` と同じ
    配列順先勝ちへ揃え、同一 track の重なり caption による residual dip を解消。
    `npm run typecheck`、対象テスト、`npm test` 1311 pass。
  - 実収録検証(BGM 無し変種、`/private/tmp/cutflow-p35/2026-07-12-nobgm`)。
    検証用 config は `/private/tmp` にコピーし、`h264_videotoolbox` が本環境で
    compression session を作れなかったため検証時だけ `preview.videoEncoder:
    libx264` に変更。full 177.7s、fast 118.1s、fastPath は
    `FAST 2 / SLOW 1(被覆70.8%)` で発動。
  - full/fast video はともに 6301f / 30fps / 210.033333s。全編 PSNR は
    `psnr_avg < 30dB` が 0 frame、finite min 33.09dB / avg 50.06dB。
    P3 検収の 12〜25dB dip は消滅。境界 1667/3516 の ±10f still(計84枚)
    でも代表 still に巻き戻り・スキップ無し。映像は full と frame-parity になり、
    P3 の映像先行由来の A/V ずれは解消。音声 v1 の duration 差と BGM 付き音声は
    P4 の対象。
- **2026-07-13 P4 完了**(gpt-5.5 設計→gpt-5.6 実装→コーディネータ実測)。
  - PR1: Remotion BGM envelope を `src/lib/bgmEnvelope.ts` に共有化。
    `<Audio volume={f}>` と同じ gain × duckFactor × fadeIn × fadeOut を
    frame-based に計算し、`loopVolumeCurveBehavior: extend` 相当を固定。
    `npm run typecheck`、対象テスト、`npm test` 1316 pass。
  - PR2: `src/lib/bgmMix.ts` に deterministic BGM PCM mixer を追加。
    BGM を 48kHz stereo f32le へ decode し、共有 envelope を適用してから
    cut.mp4 音声と `amix=normalize=0` で合成する。base 音声は `apad` で
    video duration 以上に保つ。`npm run typecheck`、対象テスト、
    `npm test` 1325 pass。
  - PR3: `fastPlan` に `audioMode: "copy" | "bgm-mix"` を追加し、BGM だけなら
    fastPath を許可。素材 overlay audio と inserts は引き続きフォールバック。
    初回の BGM 付き fast render で AAC packet 化後の m4a が期待尺より短く
    probe され、`-shortest` mux 後に動画が 2 frame 落ちる問題を検出。
    `totalFrames + 2` frame 相当で BGM mix を encode する修正後、verify 通過。
  - 実収録検証(BGM 付き `/private/tmp/cutflow-p4/2026-07-12-bgm`)。
    検証用 config は `/private/tmp` にコピーし、`h264_videotoolbox` が本環境で
    compression session を作れなかったため検証時だけ `preview.videoEncoder:
    libx264` に変更。`validate` は既存 warning のみで error なし。
    full 183.1s(Remotion 170.9s)、fast 123.3s。fastPath は
    `FAST 2 / SLOW 1(被覆70.8%, 音声 bgm-mix)` で発動し、約32.7%短縮。
  - full/fast video はともに 6301f / 30fps / 210.033333s。全編 PSNR は
    `psnr_avg < 30dB` が 0 frame、finite min 33.09dB / avg 50.06dB。
    音声は video duration で trim して ebur128 比較し、integrated loudness は
    full/fast とも -14.2 LUFS(差0.0 LU)、true peak 差0.2dB、
    short-term LUFS 包絡差は p95 0.2 LU / max 0.6 LU(2071点)。
    `npm run typecheck`、対象テスト、`npm test` 1327 pass。
- **2026-07-14 P5-1 完了(静止画 overlay の FAST 化)**(Opus 設計→Sonnet 実装→
  コーディネータ実測)。実収録の SLOW ブロックは**33 件すべてが静止画 PNG の全画面
  overlay** だったため、これを FAST 化して**被覆 70.8%→100%・Remotion 呼び出し 0 回**に。
  **cold render 210.5s→92.8s(56%短縮)**。全編 PSNR は 30dB 未満 0 frame
  (min 33.04 / avg 42.52dB)で、新規に ffmpeg 合成となった overlay 区間だけを見ると
  avg 44.68 / min 40.76dB と**他区間より良い**(min 側は従来から既知の画面テキストの
  クロマ再サンプリング)。数値・実装上の確定事項は §5 P5 を正とする。
  - **設計段階で実測により覆した点**: 設計は alpha レイヤー(fade)の PNG を
    「セグメント全長でループ」して読む形だったが、実測で 2.7 倍遅い(fade フィルタが
    全フレーム分のフルHD RGBA を処理する)。「必要窓だけループ + PTS シフト」へ変更し、
    出力の bit 一致を確認した上で採用。
  - **実装段階で実測により捕まえたバグ**: `remotion/OverlayStill.tsx` が node 専用の
    `src/lib/overlayStill.ts` を import し、ブラウザバンドル(webpack)が壊れて
    `frames`/`editor`/`render` が全滅する回帰。**typecheck も `npm test`(1334 pass)も
    すり抜けた**(実際にバンドルを張って初めて出る)。純関数を browser-safe な
    `overlayFade.ts` へ移して解消。→ 教訓は §5 P5 に恒久ルールとして記載。

- **2026-07-14 P5-2 完了(静的 annotation の FAST 化 / blur は SLOW 据え置きを恒久判断)**
  (Opus 設計→Sonnet 実装→コーディネータ実測)。annotation 6件を足した合成収録で
  **FAST 2 / SLOW 1(被覆 99.5%)・cold render 191.3s→95.8s(50%短縮)**。全編 PSNR は
  30dB 未満 0 frame、annotation 区間だけ見ると min 40.37dB で劣化なし。z-order(テロップより上)と
  FAST/SLOW 境界の連続性も目視で確認。数値は §5 P5 を正とする。
  - **設計の核心的判断**: annotation は**フェードを持たない硬い ON/OFF** なので、overlay(P5-1)で
    必要だった「またぎ降格の不動点」が**不要**(境界でクリップしてよい。SLOW 側は Remotion が
    同じ絵を描く)。実装量とリスクが大きく下がり、実測で境界の連続性も確認された。
  - **blur を FAST 化しない恒久判断**(§4 判定表に記録): PNG 化が原理的に不可能(ライブ映像を
    ぼかす)、CSS `filter: blur()` は要素の境界ボックスの外へにじみ出す(`overflow:hidden` は
    filter 適用**前**のクリップ)ため縁の意味論が ffmpeg と違う、そして何より **blur は秘匿
    (目隠し)機能なので不一致は「見た目の微差」ではなく秘匿の失敗**という非対称リスク。
    速度のために取るべき賭けではない。

- **2026-07-14 P5-3 完了(colorFilter の全編フォールバック解除)**(Opus 設計→Sonnet 実装→
  コーディネータ実測)。**colorFilter があっても fastPath が発動する**ようになり、
  合成収録で **FAST 1 / SLOW 0(被覆 100%)・cold render 213.0s→106.2s(50%短縮)**。
  全編 PSNR は 30dB 未満 0 frame(avg 42.62 / min 31.60dB)で、colorFilter 無しの実測
  (42.52 / 33.04dB)とほぼ同水準。数値は §5 P5 を正とする。
  - **設計に入る前にコーディネータが実測で潰した2つの不確実性**: (a) CSS の
    brightness/contrast/saturate が **sRGB 値に直接掛かる**こと(headless Chrome と ffmpeg の
    `lutrgb`+`colorchannelmixer` を直接突き合わせて **PSNR 55.5dB** 一致)、(b) **差し込み位置は
    46dB の差を生む**こと(色空間変換の前に掛けるか後に掛けるかで変わる。Remotion の合成順序に
    対応するのは「後」)。**この2つを先に測ったので、設計は推測ではなく実測の上に立っている**。
  - 設計が追加で潰した制約: ffmpeg の `colorchannelmixer` は係数が `[-2,2]` に制限され、
    **`saturate > 2.0776` は表現不能**(`validate` は 3 まで許す)。この帯だけ全編フォールバックを残す。
  - **`eq` フィルタは使わない**(YUV 平面で動くので CSS の RGB チャンネル毎演算とは別物)。

- **2026-07-14 P5-4 実装完了(inserts の span 化。実測は次セッション)**(Opus 設計
  (design-T4.md)→ Sonnet 実装。2 コミット: PR1=映像(`fastBase.ts` 新規・
  `fastPlan.ts`/`fastSegment.ts` の trim 写像)、PR2=音声(`insertMix.ts` 新規・
  `bgmMix.ts` の `decodeAudioToPcm` 改名・`fastRender.ts` の audioMode 分岐)。
  `layout`(ショート経路)を除く**最後の全編フォールバックが消えた**。
  - **設計の核心的判断**: 挿入区間そのものは **SLOW(Remotion)に据え置く**
    (ffmpeg で `InsertView` を再現するとスケーリング一致(P5-2 の blur と同じ
    未検証リスク)+素材ごとの時間軸(fps・VFR・startFrom・尺超過)の罠を
    新たに引き受けることになり、得られる短縮(挿入は短く数秒)に見合わない)。
    「挿入=SLOW・前後=FAST」で被覆の9割以上は取れる、という判断
    (design-T4.md §2-A)。
  - **音声が本丸**: 設計原則4(「音声は常に1本の連続パスで作る」)を守るため、
    ベース(cut.mp4)・挿入・BGM を **PCM 領域で1本のベッドに組み立ててから
    最後に1回だけ AAC エンコード**する(`insertMix.ts`。encoded AAC の部分
    音声 concat は一切しない。`bgmMix.ts` の `mixBgmPcm`/`decodeAudioToPcm`
    (旧 `decodeBgmToPcm`)を再利用し実装追加ゼロで共有)。
  - **frame 写像の二重実装を避ける**: `fastBase.ts` の `baseLayoutOf` は
    `renderProps.ts` の `frameSpans`(Main.tsx の `<Sequence>`/
    `<OffthreadVideo startFrom>` と同一式)をそのまま呼ぶ。挿入の SLOW 区間も
    `frameSpans` が出した frame をそのまま使い、秒→frame の再丸め
    (floor/ceil)を通さない(通すと Remotion の `<Sequence>` と1frameずれる)。
  - `playbackRate` は render(composite)経路では実際には発生しない
    (`videoIsSource` はエディタ proxy 専用)ことをコードで確認済み
    (`renderProps.ts:359`)。setpts スケーリングは実装せず、保守的に
    `baseLayoutOf` が全編フォールバックで塞ぐだけにした。
  - `npx tsc --noEmit` clean・`npm test` **1465 pass**。合成収録
    (実収録 2026-07-12 のコピーに動画+音声/無音動画/画像/フェード有無/
    連続2件の挿入 7 件を追加)で `fastPlan()` を直接呼んだ検証は完了
    (`eligible:true`・挿入区間だけ SLOW・`audioMode:"insert-mix"`)。
    **cold render の Before/After・PSNR・LUFS・残差・波形の実測はこの
    セッションでは行っていない**(design-T4.md §7 の完了基準は次セッションで
    実行する)。

---

## 9. 次セッションの着手手順(P0〜P4・P5-1・P5-2・P5-3・P5-4(実装) は完了済み → **次は P5-4 の実測と P6**)

**直近の最優先**: P5-4(inserts の span 化)は実装・単体テストのみ完了し、
design-T4.md §7 の実測(cold render Before/After・全編 PSNR・LUFS 包絡・
残差・波形・挿入なし回帰)はまだ行っていない。合成収録
(`/private/tmp/cutflow-p5-t4/2026-07-12/` に作業コピーあり)で `render` を
通し、§7 の手順どおり full/fast を突き合わせてから §5 P5-4 と本節を更新する。

**次の着手手順(コールドスタートの設計/実装セッションを想定。次はここから)**:

1. まず §10(コールドスタート用の前提)→ §5 P5/P6→ §8 の P5-4 完了ログの順に読む。
   映像時刻写像(P3.5)・BGM 付き連続音声(P4)・inserts の frame 写像(P5-4)は
   実装済みだが、P5-4 だけはまだ full render との実測比較が無い。
2. **最優先は P5-4 の実測**(§8 の該当ログ・design-T4.md §7 を参照)。合成収録
   (`/private/tmp/cutflow-p5-t4/2026-07-12/`)で `render` を通し、cold render
   Before/After・全編 PSNR・LUFS 包絡・残差・波形・挿入なし回帰を記録する。
   `layout`(ショート経路)を除く全編フォールバックはこれで無くなったので、
   P5 の残りは「動画素材 overlay の span 化 / カラオケ word の区分静的展開 /
   anim テロップ窓分割 / ショート展開」(§5 P5「残」参照。優先度は低い)。
3. P6 は計測・既定化判断。複数収録で cold 時間、PSNR、LUFS 包絡、リソースを
   perf.md に追記し、`render.fastPath: true` の既定化可否を決める。

---
(記録)P1 の実装順(P1 は完了済み。実施記録は §5 P1 と §8):

> P0 の実施記録(2026-07-13)は §5 P0 と §8 にある。P0-1 は使い捨てスクリプトで
> 実施したため、P1 の冒頭で `src/lib/fastPlan.ts` として純関数+テストに固める
> ところから始めるとよい(判定表は §4、実測済みの入力例は 2026-07-12 の
> render.props.json)。

1. **fastPlan.ts の本実装** — §4 の判定表を純関数に(入力: RenderProps、出力:
   FAST/SLOW span 列+全体フォールバック理由+被覆率)。`test/fastPlan.test.ts`
   で固定。P0-1 の実測(被覆 70.8%・SLOW 1ブロック)を再現できること
2. **テロップ描画の共有部品化** — `remotion/Main.tsx` の `OutlinedText`
   コンポーネント(と、テロップの配置ラッパ=`layerNode` 内の pos/anchor 分岐
   ・下部中央+ワイプ予約幅のフォールバック配置)を `remotion/CaptionLayer.tsx`
   (仮)へ抽出し、Main.tsx は import に置き換える。**DOM が1ノードも変わらない
   こと**が完了条件(検証: 抽出前後で `frames <dir> --captions` を撮り比べ、
   PNG がピクセル一致すること。frames-serve は使わず単発で)
3. **CaptionStill コンポジション** — `remotion/Root.tsx` に登録(出力解像度・
   透明背景・入力は「解決済みテロップ1件」= props.captions[] の1要素と同型)。
   `@remotion/renderer` の `renderStill`(imageFormat: "png")で焼く小さな
   ラッパを `src/lib/captionStill.ts`(仮)に。bundle は `frames` 経路
   (`src/lib/framesClient.ts`)の bundle 再利用が可能か先に確認する
4. **P0-3b(持ち越した go/no-go)** — 1テロップを PNG 化 → cut.mp4 の該当
   フレームに `ffmpeg overlay` → 同フレームの Remotion still と PSNR 比較。
   透過 PNG の alpha が straight であること(premultiplied だと縁が暗くなる)に
   注意。**しきい値: テロップ画素領域で不可視(全面 PSNR なら 40dB 以上+
   拡大目視で縁のリンギング無し)**。NG なら overlay のブレンド指定
   (`format=auto`/`alpha` 系)を調整して再測
5. キャッシュ(`render.fast/captions/`)とキー(テロップ内容+解決済み
   スタイル+出力解像度)。**この時点で files.ts / AGENTS_CONTRACT / CLAUDE.md /
   clean / test/agentsMd.test.ts へ登録**(原則5)
6. 結果(PSNR・判定)を §5 P1 と §8 に追記してから P2 へ

## 10. コールドスタート用の前提(実行セッションが最初に読むもの)

**このリポジトリの流儀**: リポジトリ直下の CLAUDE.md(特に「コードを触るとき」
= Node 23 type stripping の制約・5点セット・`npm run typecheck` / `npm test`)。
収録フォルダの JSON は編集しない(このプログラムはコード側の仕事。ユーザーの
収録フォルダは**読み取り専用**で、cut.mp4 / render.props.json を scratchpad へ
コピーして使う)。

**読むべきコード**(P1〜P3 の実装対象と依存):

| ファイル | 何のために読む |
|---|---|
| `remotion/Main.tsx` | 合成の全レイヤー定義。テロップ描画(OutlinedText・layerNode)の抽出元。§4 の判定表はこのファイルの描画分岐と1対1 |
| `remotion/props.ts` | RenderProps 型(fastPlan.ts の入力) |
| `src/lib/renderProps.ts` | props の組み立て(テロップの pos/style 解決・出力秒への写像がどこで済んでいるか) |
| `src/stages/render.ts` | 結線先。`canBurnWipe`(フォールバック設計の前例)と `remotionResourceArgs`(全 Remotion 呼び出しに付くフラグ)/ `cutFullRes` |
| `src/lib/chunkCache.ts` / `chunkPlan.ts` | concat・mux・verifyAssembled・境界計算(P3 で再利用する部品) |
| `src/lib/framesClient.ts` / `src/stages/framesServe.ts` | 既存の bundle+headless Chrome 経路(CaptionStill の renderStill が相乗りできるか) |
| `docs/render-chunk-cache.md` | concat 無劣化検証の手法・音声継ぎ接ぎ不可(+56ms/境界)の実測根拠 |
| `docs/perf.md` フェーズ9 | webpack/バンドルキャッシュの罠(bundler 設定変更が反映されない)・リソース計測の手法 |
| `src/lib/overlayFade.ts` | overlay/fade の共有純関数(`fadeFactor`/`isImageFile`/`overlaySeqRange`/`fadeFrames`/`overlayFastReason`/`overlayStillItem`)。Remotion 描画と ffmpeg 高速パスの唯一の定義元(P5-1) |
| `remotion/OverlayLayer.tsx` | Main.tsx から抽出した `OverlayLayer`/`OverlayItemView`(verbatim)。`OverlayStill.tsx` も再利用する |
| `remotion/OverlayStill.tsx` | 静止画 overlay 1件を時間不変なレイヤー画として焼く Remotion コンポジション(`CaptionStill.tsx` と同型) |
| `src/lib/overlayStill.ts` | `renderOverlayStill`/`overlayStillKey`/`overlayStillPath`(node 側。`captionStill.ts` と同型) |
| `remotion/AnnotationLayer.tsx` | Main.tsx から抽出した `AnnotationItemView`(verbatim)。`AnnotationStill.tsx` も再利用する(P5-2) |
| `remotion/AnnotationStill.tsx` | 注釈グラフィック(arrow/box/spotlight)1件を時間不変なレイヤー画として焼く Remotion コンポジション(`OverlayStill.tsx` と同型) |
| `src/lib/annotationStill.ts` | `renderAnnotationStill`/`annotationStillKey`/`annotationStillPath`(node 側。`overlayStill.ts` と同型) |
| `src/lib/colorFilter.ts` | CSS filter(`cssFilterOf`)と ffmpeg 写像(`ffmpegColorFilterOf`)の唯一の定義元。`remotion/Main.tsx` が import する=ブラウザバンドルに載るので node 専用モジュールを import してはならない(P5-3) |
| `src/lib/fastBase.ts` | ベース映像区間 ⇄ cut.mp4 の frame 写像(`baseLayoutOf`/`baseSegOf`/`cutFrameOf`)。`renderProps.ts` の `frameSpans` を再利用する純関数(P5-4) |
| `src/lib/insertMix.ts` | 挿入クリップ込みの連続音声(`buildInsertBedPcm`/`buildPcmEncodeArgs`/`mixInsertAudio`)。PCM 領域でベース・挿入・BGM を1本に組み立て、最後に1回だけ AAC エンコードする(P5-4。設計原則4) |

**P0 で確定済みの実装パラメータ**(再導出不要。出所は §5 P0):
- ffmpeg セグメントのエンコード:
  `-c:v h264_videotoolbox -profile:v high -b:v 8000k -video_track_timescale 90000 -color_range pc -colorspace smpte170m`
- 色変換フィルタ:
  `scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p`
- 区間切り出しは `setpts=PTS-STARTPTS,fps=fps=30:round=near:start_time=0,
  trim=start_frame=N:end_frame=M,setpts=N/fps/TB`(秒指定禁止)。`fps` を
  `trim=start_frame` の前に置き、cut.mp4 の timestamp から CFR 30fps 格子を
  作ってから frame trim する。これで Remotion(OffthreadVideo) と同じ
  時刻ベースのソース選択になる。trim 後の `setpts=N/fps/TB` はソース選択には
  関与せず、セグメントローカル PTS と concat の安定化だけを担う(P3.5 で確定)。
- Remotion 側 SLOW セグメントは `--frames=a-b --muted`(+`remotionResourceArgs`)

**環境ノート**: 収録実データは `~/Movies/cutflow/2026-07-12/`(FAST 被覆 70.8%・
BGM×3)。ヘッドレス Chrome のフォント読込フレークと webpack キャッシュの罠は
docs/perf.md フェーズ9 参照(render が `Loading Noto Sans JP` で死んだらそれ)。
