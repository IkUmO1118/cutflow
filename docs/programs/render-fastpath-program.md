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
| inserts(挿入) | **収録ごと全体フォールバック**(baseSegments が割れて trim 写像が複雑化するため。P0 の被覆データで span 化に格上げするか判断) | span 化 |
| overlays(素材) | SLOW | 静止画・フェード無し・不透明は ffmpeg overlay 化 |
| blurs / annotations | SLOW | keyframes 無し(静的)は ffmpeg / PNG 化 |
| テロップ anim(fade/slide/pop) | その表示 span を SLOW | anim 窓だけ SLOW に分割 |
| テロップ karaoke | SLOW | word モードは語境界の区分静的 PNG 列に展開可 |
| colorFilter | **収録ごと全体フォールバック**(全フレームに掛かるため) | CSS→ffmpeg 写像(contrast は eq と同式、brightness は乗算 lut、saturate は colorchannelmixer 行列)+ピクセルテスト |
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

### P4: 決定論 BGM ミキサ(音声 v2) — 状態: 未着手

- `duck.ts` のスパン+フェード+`loopVolumeCurveBehavior: extend` 相当を TS で
  ゲインエンベロープ化 → BGM を PCM デコード(ffmpeg)→ エンベロープ適用 →
  cut.mp4 音声と amix → 連続 mix.m4a。Remotion の `<Audio volume={f}>` 実装と
  同じ式(gain × duckFactor × fadeIn × fadeOut)なので決定論で一致するはず
- 検証: Remotion フルレンダーの音声とラウドネス曲線比較(`av` の
  short-term LUFS 包絡を再利用)± しきい値
- **完了基準**: bgm.json あり収録(2026-07-12 が該当)でも fastPath が発動し、
  聴感+LUFS 曲線で差が検出されない

### P5: 適格範囲の拡大 — 状態: バックログ(効き順は P0 の被覆データで決める)

- inserts の span 化 / 静的 annotation・blur / colorFilter 写像 /
  カラオケ word の区分静的 PNG 列 / anim テロップの窓分割 / ショート展開

### P6: 計測・既定化判断 — 状態: 未着手

- perf.md へ実測追記(cold 時間・PSNR・リソース。フェーズ9のモニタ手法を再利用)
- 数収録の実運用で問題が出なければ `render.fastPath: true` を既定化

---

## 6. リスク台帳

| # | リスク | 対処 |
|---|---|---|
| R1 | 異種エンコーダ concat 非互換(SPS/PPS/timebase) | P0-2 で最初に潰す。NG なら「全域 FAST のときだけ」へ縮小 |
| R2 | テロップ PNG のサブピクセル差(alpha ブレンド順) | P0-3 で観測。PSNR しきい値をゲートに |
| R3 | 音声パリティ(BGM mix) | v1 は BGM 無しゲートで回避、P4 で LUFS 曲線検証 |
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

---

## 9. 次セッションの着手手順(P0〜P3 は完了済み → **次は P4**)

> P0 の実施記録(2026-07-13)は §5 P0 と §8 にある。P0-1 は使い捨てスクリプトで
> 実施したため、P1 の冒頭で `src/lib/fastPlan.ts` として純関数+テストに固める
> ところから始めるとよい(判定表は §4、実測済みの入力例は 2026-07-12 の
> render.props.json)。

P1 の実装順(コールドスタートの Opus/Sonnet セッションを想定):

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

**P0 で確定済みの実装パラメータ**(再導出不要。出所は §5 P0):
- ffmpeg セグメントのエンコード:
  `-c:v h264_videotoolbox -profile:v high -b:v 8000k -video_track_timescale 90000 -color_range pc -colorspace smpte170m`
- 色変換フィルタ:
  `scale=in_range=limited:out_range=full,colorspace=all=smpte170m:iall=bt709:range=pc,format=yuvj420p`
- 区間切り出しは `trim=start_frame=N:end_frame=M,setpts=N/fps/TB`(秒指定禁止。
  **setpts は `PTS-STARTPTS` ではなく `N/fps/TB`**=frame 序数で CFR 再スタンプ。
  cut.mp4 は実測 VFR(avg 29.94fps)で、`PTS-STARTPTS` だと VFR が残り container
  duration が伸びて混在 concat 後に Remotion(厳密30fps)と食い違い verifyAssembled
  の duration 判定で落ちる=P3 で確定・修正済み)
- Remotion 側 SLOW セグメントは `--frames=a-b --muted`(+`remotionResourceArgs`)

**環境ノート**: 収録実データは `~/Movies/cutflow/2026-07-12/`(FAST 被覆 70.8%・
BGM×3)。ヘッドレス Chrome のフォント読込フレークと webpack キャッシュの罠は
docs/perf.md フェーズ9 参照(render が `Loading Noto Sans JP` で死んだらそれ)。
