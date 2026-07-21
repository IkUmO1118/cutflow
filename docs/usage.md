# 使い方ガイド(人間が調整しながら使うワークフロー)

> **コマンドの書き方**: 以下すべて `node src/cli.ts <コマンド>` で書くが、
> `npm link` 済みなら **`cutflow <コマンド>` と読み替えてよい**(同じコードに落ちる)。
> 人間の日常操作は `cutflow` のほうが快適(リポジトリへ `cd` しなくてよい)。
> ドキュメントが `node src/cli.ts` で書かれているのは、リンクしていない環境
> ・エージェントでも必ず動く形だからで、優劣ではない。CLI が出すヒント
> (「先に `… materials <dir>` を実行してください」等)は、実際に使われた
> 入口に合わせて自動で書き分けられる。

CutFlow は「全部AI任せ」のツールではない。**まずエディタで全編 keep の動画を開き、
必要な自動処理だけを明示実行し、以降は人間が JSON を直しながら preview / render と
往復する**のが正しい使い方。

## 全体フロー

```
① 収録 → ~/Movies/cutflow/<日付-内容>/ に mkv を置く
     (企画ブリーフがあれば brief.md としてコピーしておくと plan の材料になる)

② node src/cli.ts editor <フォルダ>
     自動カットなしで開く。manifest / 空 transcript / 全編 keep cutplan が無ければ作られる
     OBS 拡張キャンバスなら: node src/cli.ts editor <フォルダ> --layout obs-canvas

③ 必要なら明示実行:
     node src/cli.ts transcribe <フォルダ>   文字起こし
     node src/cli.ts plan <フォルダ>         AI カット案・章立て

④ 人間の編集タイム(下の表のファイルを直す)

⑤ node src/cli.ts preview <フォルダ>
     カットのテンポを軽い動画(preview.mp4)で確認
     → 気に入らなければ ④⑤ を何度でも往復

⑥ node src/cli.ts approve <フォルダ>
     preview 確認 → y で承認(cutplan の keep 集合のハッシュを approvals.json に記録)

⑦ node src/cli.ts render <フォルダ>
     final.mp4 完成(音量は自動で -14 LUFS に正規化される)
     → テロップを直したくなったら transcript.json を編集して ⑦ だけ再実行
     → cutplan.json(keep 集合)を編集すると承認は自動失効するので、
       render 前に ⑥ をやり直す(approvals.json が現内容のハッシュと
       一致しないと render は拒否される)

⑧ meta.json のタイトル案・概要欄、chapters.json の章をYouTube投稿に使う
```

## detect の較正と無音圧縮 preset

`detect.calibration` は収録ごとの無音床から `silenceDb` を決める opt-in で、
固定 `-35dB` による弱い語尾の過剰検出を避ける。`silenceCompaction` は threshold を
変えず、`minSilenceSec / padSec / minKeepSec` の3ノブだけを組み込み preset で置換する。
どちらも省略または `enabled: false` なら従来の `cuts.auto.json` とバイト等価になる。

| preset | minSilenceSec | padSec | minKeepSec | 用途 |
|---|---:|---:|---:|---|
| `gentle` | 1.0 | 0.30 | 0.30 | V4 の余白を広げる系列 |
| `balanced` | 0.7 | 0.30 | 0.50 | V4 の余白を広げる系列 |
| `tight` | 1.0 | 0.30 | 0.80 | V4 の余白を広げる系列 |
| `compact-gentle` | 0.7 | 0.10 | 0.50 | 較正単独から穏やかに詰める |
| `compact-balanced` | 0.7 | 0.05 | 0.50 | 較正単独から中程度に詰める |
| `compact-tight` | 0.6 | 0.05 | 0.50 | 短い無音も対象にして強く詰める |

`compact-*` は `2026-07-12` で `boundary-check` discard 0 を維持し、除去量が
`270.74 → 278.46 → 295.23秒`と単調に増えるよう固定した opt-in 系列。
`edgeTrim` はこの候補の keep 端に残る静かな余白を実音声 RMS でさらに内側へ詰める
別機能であり、固定 threshold が既に捨てた語尾を救済する機能ではない。

V6 の offline 比較は、収録フォルダへ書き込まない次のコマンドで行う。

```sh
node src/cli.ts calibration-evaluate <フォルダ>
node src/cli.ts calibration-evaluate <フォルダ> --json
```

固定10 variant (`baseline` / `calibration-only` / `gentle` / `balanced` / `tight` /
`calibration+edgeTrim` / `compact-gentle` / `compact-balanced` / `compact-tight` /
`calibration+edgeTrim+compact-balanced`)を、`boundary-check` と同じ実音声測定系で比較し、
全行に discard / removed / keep 数を出す。approval hash が現在の `cutplan.json` と一致する
human final がある場合だけ、従来の agreement (`exact`) / rescue (`direction`) と V5 判定も
追加する。human final が無い収録ではそれらを省略し、V6 primary の3列だけを出す。

## 最小 config スターター(config.minimal.yaml)

初回に本当に触る必要があるのは3点だけ: `recordingsDir`(収録の置き場所)/
`ai.provider`(生成 AI の入口。`claude-code` は APIキー不要の既定)/
`ingest.layout`(収録レイアウト。`plain`=通常動画 / `obs-canvas`=画面+カメラ)。
リポジトリ直下の `config.yaml`(全項目版・333行)を最初から読む必要はなく、
同じくリポジトリ直下にある `config.minimal.yaml`(必須セクションだけの完結ファイル・
約45行)を使うと過負荷を避けられる。使い方は2通り: 各コマンドに
`--config config.minimal.yaml` を付けるか、内容を `config.yaml` にコピーする。
省いた任意調整セクション(`plan` / `planMaterials` / `effectCheck` 等)は
`resolve*Cfg()` が既定値で埋めるので動作は変わらない(例: `plan.perception` が
無いと「全オフ」の警告が出るだけで停止しない)。

## どのファイルを直すと何が変わるか

時刻はすべて**元動画(収録ファイル)の秒**で書く。カット後の時刻への
換算はツールが自動でやるので、頭の中で引き算する必要はない。

| ファイル | 直すと変わるもの | 編集する場面 |
|---|---|---|
| `transcript.json` | **テロップ**の文言と表示タイミング。`track` でテロップトラック(既定 1)、`pos`(`{x, y}`: 出力px。トラックの `anchor` が無ければテキスト中心、`topLeft` なら左上)でそのテロップだけの表示位置。幅はテキストに自動で合い、折り返しは文言内の改行で指定、`style`(そのテロップだけの見た目。各項目とも省略可: `fontSizePx` / `color`(文字色)/ `outlineColor`(縁取り色。`"none"` で縁なし)/ `outlineWidthPx`(縁取りの太さ=出力px。0 以上。省略時はフォントサイズの 0.25 倍)/ `fontFamily`(CSS フォント指定)/ `fontWeight`(100〜900。既定フォントは同梱の Noto Sans JP 可変フォントで中間ウェイトも描き分ける)/ `background`(座布団=背景帯。`{color, paddingPx?, radiusPx?}`、または `"none"`。省略=指定なしで下の層(トラック標準 → `config.yaml` の `render.captionBackground`)から**継承**する。継承した帯をこのテロップだけ**消す**には `"none"` を書く=`outlineColor: "none"` と同じ流儀)/ `anim`(登場/退場アニメ。`{in?, out?, durationSec?}`。種別は `fade` / `slide-up` / `slide-down` / `slide-left` / `slide-right` / `pop` / `none`。省略時アニメ無し)/ `karaoke`(カラオケ表示。`{activeColor?, inactiveColor?, inactiveOpacity?, mode?}`。`mode` は `word`(既定・瞬時切替)/ `fill`(発話中の語を左→右に塗り進み)。`words[]` が無いテロップに指定しても通常表示にフォールバックする=壊れない))でそのテロップだけの見た目。`words`(語/トークン単位のタイミング。`{text, start, end, confidence?}[]`)は省略可の描画専用データで、`karaoke` 指定時の色替えタイミングに使う(それ以外では描画に影響しない)。`config.yaml` の `whisper.wordTimestamps`(既定 true。明示的に `false` を書けば無効化できる)のときだけ transcribe が付ける。既存収録(既定変更前に transcribe 済み)は words を持たないため、使うには再 transcribe が要る(`validate` が words 不在を警告する) | whisper の誤字修正、不要な字幕の削除、言い回し調整。位置はエディタのプレビュー上でドラッグ、**文言はプレビュー上のテロップをダブルクリックしてその場で編集**(Enter で確定・Shift+Enter で改行・Esc で破棄)、サイズ・色・フォント・座布団は右側のインスペクタ(クリップ選択時に常時表示)で変更できる |
| `cutplan.json` | **どこを残すか**(`action`: keep/cut)。境界の秒数も手で微調整できる。`segments[].reasonId` は任意の分類 id(`docs/edit-skills/cut/recipes/<id>.md`。13分類。省略可=未分類・opt-in)。`validate` は未知 id と action/系の不整合を警告する(エラーにはしない=人間が GUI で判断を戻した記録でありうるため) | preview を見て「切りすぎ」「ここは残す」 |
| `chapters.json` | **概要欄チャプター用メタデータ**(`start` / `title` のみ)。動画への描画には使われない: 章タイトルは plan が「章」という名前のテロップトラックとして transcript.json に書き、以降はただのテロップとして編集する | YouTube 概要欄に載せる章タイトルの言い換え |
| `overlays.json` | **演出**: 素材の表示(全画面または `rect` で部分配置。頭出し・音量・不透明度・フェード付き)・インサート編集・ワイプ全画面・**ズーム**(`zooms`)・**領域ぼかし**(`blurs`)・**注釈グラフィック**(`annotations`)・**簡易カラー調整**(`colorFilter`)・字幕非表示・重なり順・テロップトラック標準。zooms/blurs/annotations の `reasonId` は任意の演出分類 id(`docs/edit-skills/effects/recipes/<id>.md`。7分類)。未知 id と型/系不整合は警告、非文字列はエラー。`reasonId` は描画・承認hashに影響しない | B-roll を挟む、カメラだけの場面を作る、開発画面の API キーを隠す、画面の一点を指し示す(下の「演出」参照) |
| `bgm.json` | **BGM**を区間ごとに配置(`tracks[]`: `{start, end, file, volumeDb?, startFrom?, fadeInSec?, fadeOutSec?}`)。覆っていない区間は無音、別ファイルの区間で曲の切り替え・重奏。無ければ収録フォルダ直下の `bgm.*` を全編1曲で流す(後方互換) | イントロだけ BGM なし、途中で曲を変える、別の BGM を足す(下の「BGM」参照) |
| `shorts.json` | **ショート動画**の元データ(`shorts[]`: `{name, profile?, approved, ranges[], captionTracks?}`)。`name` は出力ファイル名(`shorts/<name>.mp4`)。`profile` は `default` / `vertical` / `vertical-screen` / `vertical-cover` から選ぶ組み込みレイアウト(省略時の既定は camera 有り→`vertical`、plain→`vertical-screen`)。`ranges` は元収録の秒で、本編 `cutplan.json` の keep とは独立したこのショート専用の keep 集合(本編でカットした素材も含められる)。`captionTracks` は `overlays.json` と同型の縦用テロップ位置/スタイル上書き。`approved` はこのショート(縦動画)を人間が確認したかどうかの**承認意図の表示**(**AI は自分で true にしない**。実際の render ゲートは `approvals.json` の承認レコード) | ショート動画を切り出したいとき |
| `thumbnail.json` | **サムネイル**(`thumbnail.png`)の元データ(`{t, texts[]}`)。下記「サムネイル生成」参照 | サムネイルを作りたいとき |
| `meta.json` | 動画には影響なし。タイトル・概要欄の**下書き** | 投稿時のコピペ元 |
| `rules.md` | **チャンネルの恒久ルール**(自由 Markdown。テロップ表記・トーン/声色・禁止語・ペーシング・章の付け方・タイトルの型など「毎回守る型」)。収録フォルダの親ディレクトリに置くと**チャンネル共通**、収録フォルダ直下に置くと**この収録だけの上書き/追加**(両方あれば連結し、収録固有が優先)。`plan` / `plan --cuts-only` / `remeta` / `plan-shorts` / `plan-materials` / `plan-effects` / `plan-bgm` の LLM プロンプトに注入される。`brief.md`(今回の見せ場・中身)とは役割が別(下記「チャンネル rules と learn」参照) | チャンネル全体の編集方針を一貫させたい、この回だけ例外を効かせたいとき |

**触らない第3カテゴリ**(編集ファイルにも中間生成物にも属さない):
`approvals.json`(**承認レコード**。`cutplan.json` / `shorts.json` 各ショートの
keep 集合の sha256 ハッシュに束縛され、`render` の唯一のゲート。内容が変わると
自動失効する。`node src/cli.ts approve` / `unapprove` コマンドと GUI エディタの
保存(チェックボックス)だけが書く。**人間や AI が直接編集・作成しない**。
詳細は下記「承認(approve/unapprove)」参照)。

**触らないファイル**(中間生成物。再実行すると上書きされる):
`manifest.json` / `cuts.auto.json` / `plan.raw.txt` / `plan-shorts.raw.txt`
(plan-shorts の LLM 生応答の記録) / `plan-materials.raw.txt`
(plan-materials の LLM 生応答の記録。用途は plan.raw.txt と同じ) / `render.props.json` /
`whisper-out.*` / `plan-bgm.raw.txt`(plan-bgm の LLM 生応答の記録。
用途は plan.raw.txt と同じ) / `cut.mp4` / `cut.keeps.json`(cut.mp4 の再利用可否を
判定するキャッシュキー。keeps・音声設定・元収録ファイルが前回と同じなら
render は ffmpeg cut を省略する。削除すれば常にフル再生成に戻る) /
`render.key.json`(final.mp4 の再利用可否を判定するキャッシュキー。
render.props.json の内容・cut.mp4・参照素材ファイル(overlays / inserts /
bgm)・hardwareAcceleration 設定が前回と同じなら render は Remotion 実行を
丸ごと省略する。削除すれば常にフル再生成に戻る) /
`render.report.json`(直近の本編 render の構造化サマリを記録する使い捨て
ログ。レンダーの副産物で編集対象ではない) / `proxy.key.json`
(proxy.mp4 の陳腐化を判定するキャッシュキー。ラウドネス(targetLufs)・
システム音声(systemAudio)・ノイズ除去(denoise)・プレビュー幅・エンコーダ・
元収録ファイルが前回の生成と同じなら陳腐化なしと判定する。無ければ常に
「陳腐化なし」扱いになる) / `render.chunks/`(チャンク差分レンダーのキャッシュ。
config.yaml の `render.chunkSec` > 0 のときだけ使う。`vNNN.mp4` =
チャンク映像・`audio.m4a` = 直前フルレンダーの連続音声・`chunks.key.json` =
再利用可否を判定するキー。映像に効く要素(テロップ・位置・ワイプ等)だけを
変えた再実行で変更チャンクだけを再レンダーして連結する。音声・keeps・
全域設定(layerOrder 等)の変更時は自動でフルレンダーに戻る。ディレクトリ
ごと削除すれば常にフル再生成に戻る) / `cut.<name>.mp4` / `cut.<name>.keeps.json` /
`render.<name>.props.json` / `render.<name>.key.json`(いずれもショート
`<name>` 専用の中間生成物。仕組みは無印の同名ファイルと同じで、チャンク
差分レンダーだけは無い。詳細は下記「ショート動画」参照) / `rules.suggested.md`
(`learn` が書く下書き。使い捨てで、次回の `learn` 実行で黙って上書きされる。
採用したい項目は人間が手で `rules.md` に転記する。詳細は下記「チャンネル
rules と learn」参照) / `av.probe/`(`av <dir>` の差分更新型キャッシュ。
`motion.json` / `sound.json` / `motion.strip.png`) / `plan-effects.raw.txt`
(plan-effects の LLM 生応答の記録。用途は plan.raw.txt と同じ) /
`style.probe/`(`style-profile` が channel 直下(収録フォルダの親、または
`--from` にファイルを渡したときはそのファイルの親)に書くスタイルプロファイル
集約。`<name>.json`。実行のたびに丸ごと再計算・上書きされる。詳細は下記
「スタイルプロファイル抽出(style-profile)」参照) / `hyperframe.<name>.key.json`
(`hyperframe <dir> --name <name>` の再利用可否を判定するキャッシュキー。
composition html の sha256・variables・width/height/fps/durationSec が
前回と同じなら `materials/hyperframes/<name>.mp4` の render を省略する。
詳細は下記「HyperFrames カード(hyperframe)」参照) /
`hyperframe-place.suggested.json`(`hyperframe-place <dir>` が書く使い捨ての
apply パッチ下書き。`material-fit.suggested.json` と同カテゴリで、次回
`hyperframe-place` 実行で黙って上書きされる。**自分で apply しない**=適用は
人間が確認して `apply --patch hyperframe-place.suggested.json` を叩く。詳細は
下記「HyperFrames 素材の配置(hyperframe-place)」参照) / `plan.first.json`
(`plan` / `plan --cuts-only` が最初の cuts/keeps 応答をパースした直後に書く、
AI 初版判断の **write-once** 記録。既に存在すれば `--force` 実行時でも
一切上書きしない。候補 id に加え元収録の秒(`start`/`end`)を併記するので、
`detect` の再実行や `candidates` 設定変更で候補番号が変わっても最終
`cutplan.json` と元秒で突き合わせられる。測定専用の副産物で
`render`/承認 hash には影響しない。`clean --cache-only`/`--logs-only` の
どちらにも含まれず、フル `clean` を実行したときだけ削除される) /
`plan-effects.first.json`(`plan-effects`のvalidate成功後に、決定論変換済みの
zoom/blur/annotationと上限付きnone判断を元秒で保存するwrite-once初版。
既存ファイルは壊れていても`--force`で上書きしない。`describe --json`の
`summary.effectReasonIds.firstVsFinal`が最終overlaysとの差を集計する。cleanの扱いは
`plan.first.json`と同じ)

## HyperFrames backend 状態(hyperframe-backends)

収録フォルダを読まず、ファイルも書かない read-only コマンド。利用可能な
作図経路を4状態(`usable` / `material-routed` / `not-wired` / `out`)で表示し、
決定論 tier、CDN pin の URL/version、authoring 経路、`usable` 経路と
`material-routed` の実素材経路を実測する render fixture を同時に確認できる。自動処理では固定 `schemaVersion` を持つ
純 JSON を使う:

    node src/cli.ts hyperframe-backends
    node src/cli.ts hyperframe-backends --json

現状は CSS / WAAPI / SVG / DOM / Canvas 2D / GSAP / Anime.js / 生 WebGL/shader /
Raw WebGPU/WGSL / Three.js が`usable`、Lottie JSON は AE 素材持ち込み時だけの `material-routed`。
D3 / TypeGPU / maps 系 / `.lottie` container は `out`。

Anime.jsはmanual card限定。`animejs@3.2.2`のpin tagと
`data-hf-requires="anime"`を使い、すべての`anime()`/`anime.timeline()`へ
`autoplay:false`を指定する。返り値は`window.__hfAnime=[]`へpushし、Cutflowが
毎frame`pause(); seek(tMs)`する。`loop`は省略/false/有限非負整数のみ、
`play`/`restart`/`reverse`は禁止。実例は
`docs/hyperframes-skills/examples/hyperframes-animation--anime-timeline.html`。

Three.jsはmanual/core-only経路。最後のclassic UMD buildである`three@0.160.0`を
exact URL+SRIでpinし、`data-hf-requires="three"`/`perceptual`を宣言する。
`hf-seek`の`event.detail.time`(秒)を有限durationへclampしてscene状態を絶対値で
再構築し、`preserveDrawingBuffer:true`のrendererを同期`render()`する。
clock/animation loop/loader/worker/blob URLは使えない。実例は
`docs/hyperframes-skills/examples/hyperframes-animation--three-geometry.html`。

Raw WebGPUは依存/CDN pinなしのmanual/perceptual経路。rootへ
`data-hf-requires="webgpu"`を宣言すると、bootstrapが`navigator.gpu`をfail-fastで
確認し、`gpu-angle` profileを選ぶ。最初の`await`前に同期`hf-seek` listenerを置いて
絶対秒を`latestTime`へ保持し、adapter/device/context/WGSL/pipeline初期化Promiseを
`window.__hyperframes.__ready`へ接続する。`device.lost`はfatal channel、WGSL compile
errorは`getCompilationInfo()`で捕捉し、各frameを`device.queue.submit(...)`する。
実例は`docs/hyperframes-skills/examples/hyperframes-animation--raw-webgpu-wgsl.html`。
TypeGPUはpin/APIを仮定せず`out`のまま。

## HyperFrames カード(hyperframe)

無音の作図素材(章タイトル・説明カード・図解・kinetic typography)を、
HyperFrames の実行コード(engine/runtime)を一切導入せず、Cutflow 既存の
Remotion(native interpreter)で作る2段階コマンド。生成された HTML は
`node src/cli.ts validate` の対象外(編集ファイルではない)だが、check ゲート
(`checkComposition`: リモート URL 禁止・非決定的な駆動禁止・typed variables
必須等)を通ったものだけが render される:

    node src/cli.ts hyperframe <dir> --name <name> --from-brief
    # brief.md/rules.md + パターン番号メニュー(docs/hyperframes-skills/card-patterns.md)を
    # LLM に渡し、composition HTML の下書きを hyperframes/<name>.html へ書く(render はしない)。
    # 生応答は常に hyperframes/<name>.raw.txt に残るが、check ゲートを通らなければ
    # composition html 自体は書き込まれない(0バイト書込み)。既存ファイルがあれば --force 必須

    node src/cli.ts hyperframe <dir> --name <name> --from-brief \
      --asset ./logo.png --asset ./NotoSansJP-subset.woff2
    # PNG/JPEG/GIF/WebP と WOFF2 は magic bytes・拡張子・サイズを検査して
    # hyperframes/<name>.assets/ へ保存する。LLM には画像byteではなく
    # __HF_ASSET_1__ のようなtokenと寸法だけを渡す。fontもbyteを渡さず、
    # MIME/byte数、family HFAsset2、正確な @font-face と __HF_FONT_2__ tokenだけを
    # 渡し、応答後に data: URL を決定論的に焼き込む。存在しない番号や壊れたtokenを返した場合は失敗し、
    # raw.txt と .assets/ は再試行用に残るが html は書き換えない。

    node src/cli.ts hyperframe <dir> --name <name> --embed-lottie <animation.json>
    # 人間が AE/bodymovin から書き出した JSON と同じ directory 内の外部画像を
    # animationData/data: URL として埋め込んだ canonical SVG/byte card を書く(render はしない)。
    # w/h/fr/ip/op は JSON から導出するため author/render 用の上書き flag は併用不可。
    # 既存 hyperframes/<name>.html の置換には --force が必要

    node src/cli.ts hyperframe <dir> --name <name>
    # --from-brief 無しで実行すると、既存の hyperframes/<name>.html を render し
    # materials/hyperframes/<name>.mp4 へ atomic に公開する(temp render → ffprobe 検査 →
    # rename)。--var k=v(composition variables の上書き)/ --width / --height / --fps /
    # --durationSec で composition の data-* を上書きできる。hyperframe.<name>.key.json が
    # 一致すれば render 自体を省略する

生成された `materials/hyperframes/<name>.mp4` は通常の素材(B-roll)と同じ
1本の MP4 で、`overlays.json` の `overlays[]` / `inserts[]` へ既存の `apply`
境界を通して配置する(このコマンド自体は cutplan/approvals には一切触れない)。
配置候補の生成は次の `hyperframe-place` が担う。

添付素材の上限は `config.yaml` で調整できる。省略時は単枚 2MiB、1回の
author 合計 6MiB。WOFF2 はさらに固定 1MiB/枚の上限があり、設定値がそれより
小さければ小さい方に従う。画像・font は html に data URL として複製されるため、
上限超過時は自動圧縮/subset化せずエラーにする。CLI とエディタのカード作成UIは
同じ検査・合計上限を使う。公開後の正は data URL を含む html であり、
`.assets/` 内の素材だけを差し替えても html は変わらない。差し替えを反映するには
`--from-brief --force` で再生成するか、html を直接編集する。

日本語 full font は数MiBになりやすいので、Cutflowへ渡す前に外部 tool で必要文字だけを
subset化する。tool/依存はCutflowには同梱しない。fonttoolsが別途入っている場合の例:

```sh
pyftsubset remotion/fonts/NotoSansJP.woff2 \
  --output-file=/tmp/NotoSansJP-subset.woff2 --flavor=woff2 \
  --text='動画で使う文字だけ' --layout-features='*'
```

元fontのライセンス条件にも従う。このrepository同梱のNoto Sans JPは
`remotion/fonts/OFL.txt`を参照する。

```yaml
hyperframe:
  assets:
    maxBytes: 2097152
    maxTotalBytes: 6291456
```

composition html のルート要素には任意で `data-hf-determinism="byte"` /
`data-hf-determinism="perceptual"` を書ける(属性が無い・不正な値のときは
既定の `byte` として扱う。値の妥当性は check ゲートの Rule 7 が検査する)。
`byte` は「同じ入力からの再 render は毎回 byte 単位で同一になる」ことを
期待する composition(CSS アニメ+Web Animations 中心の静的カード)向けの
既定 tier。`perceptual` は GPU 系の演出(hf-seek / Lottie の `renderer:'canvas'`
等)で byte 一致まで求めず「見た目が同じなら OK」としたい composition 向けの
tier。
未変更の入力に対して `--force` で再 render すると、旧 mp4 と新 mp4 を
ffmpeg の signalstats(`blend=all_mode=difference` の luma max delta=YMAX、
0〜255)で比較した決定論判定を stdout に出す: 閾値は YMAX≤10(AA jitter は
無害・視覚的に区別不能という実測に基づく)。`byte` tier は byte が一致すれば
OK、不一致なら常に warn(YMAX≤10 なら「perceptual 宣言を検討」、それ以上
なら「視覚が乖離」)。`perceptual` tier は YMAX≤10 なら OK、それを超えたと
きだけ warn。入力が前回と異なる場合や ffmpeg 計測が失敗した場合は判定
自体をスキップする(判定不能を byte 不一致として扱わない)。

composition html 内のリモート URL(`http(s)://` / `//` 始まり)は check
ゲートで一律禁止だが、唯一の例外として `<script src>` が
`src/lib/hyperframeCdn.ts` の CDN ピン表(既定は gsap@3.14.2 /
lottie-web@5.12.2 の2本)に一致する URL と `integrity` を一字一句そのまま持ち、かつ
`crossorigin="anonymous"` が付いているときだけ許可される(それ以外の
remote 参照(img/video/audio/source/iframe の src・link href・srcset・
poster・data-composition-src・CSS `url()`/`@import`)は引き続き無条件で
エラー)。許可されたピン留めスクリプトは render 時に実際に jsdelivr から
取得される(HyperFrames 本来のモデルと同じ。ローカルにバンドルされる
わけではない)。srcdoc には `connect-src 'none'` を含む CSP が張られ、
読み込んだライブラリを実行はできるが outbound の fetch/XHR/WebSocket は
送れない。オフライン・integrity 不一致のときは `__failed` 経由で
render がはっきりしたメッセージ付きで止まる(壊れた mp4 が出力される
ことはない)。`hyperframe.<name>.key.json` のキャッシュキーと sidecar には
render profile(`default` / `gpu-angle`)も含まれる。html の sha256 は
`<script src>`/`integrity` の文字列ごと含むので URL や integrity の変更でも
キャッシュ miss する。
srcdoc の `script-src` も jsdelivr origin 全体ではなくピン表の完全 URL だけを
列挙する。`createElement('script')` / dynamic `import()` / `document.write()`
による動的 script 読み込みは check ゲートで拒否される。

Lottie(人間持ち込み AE 素材。LLM は作図しない)は `--embed-lottie` で JSON を
`animationData` としてカードへインライン埋め込みする(`path:` fetch は禁止=CSP
`connect-src 'none'` でブロックされ、cache key(html sha256)にも乗らない)。
`autoplay:false` / `loop:false` / `window.__hfLottie.push(anim)` は必須。
importer は `assets[].u + p` を JSON directory 内だけで解決し、PNG/JPEG/GIF/WebP
を magic bytes で検査して `data:` URL 化する。remote/protocol/absolute/path escape/
directory 外を指す symlink、拡張子と内容の不一致は拒否する。元 JSON は参照記録
(basename + sha256)だけを card に残し、画像 byte と JSON 本体は html sha256 に入る。
check が 0 errors / 0 warnings の場合だけ atomic publish し、失敗時は既存 card を
変更しない。対応は lottie-web JSON のみで `.lottie` コンテナは未対応。
importer は SVG/byte 専用で canvas へ自動 fallback しない。手書き card の
`renderer:'canvas'` は `data-hf-determinism="perceptual"` を宣言する(詳細は
`docs/hyperframes-skills/authoring-contract.md` の「Lottie」節)。

GPU/WebGL/WebGPU/shader カードは `hf-seek` イベント(`window.addEventListener`
で購読・ハンドラ内で同期描画・rAF 不使用)で自己描画し、
`data-hf-determinism="perceptual"` を宣言する(Rule 9)。生 WebGL はライブラリ・
CDN いずれも不要。Rule 9 と共有する profile resolver が GPU card だけを
`gpu-angle` に分類し、その render だけ Chrome を
`chromiumOptions:{gl:"angle"}` で起動する。非 GPU card は従来どおり
`openBrowser("chrome")` のまま。WebGL context の要求が1回以上あり成功が
ゼロなら、author script/readiness 後または `hf-seek` 直後に明示エラーで
render を中止し、黙った黒画面 MP4 を公開しない。ANGLE の結果は GPU/driver
依存なので byte 一致を一般化せず perceptual tier で検証する。Raw WebGPUとThree.jsも
同じ`gpu-angle`経路でusableだが、X3はcore-onlyで外部asset loaderを許可しない(詳細は
`docs/hyperframes-skills/authoring-contract.md` の「GPU / WebGL / shader
カード」節)。

## HyperFrames 素材の配置(hyperframe-place)

`hyperframe <dir> --name <name>` で render 済みの
`materials/hyperframes/<name>.mp4` を、`overlays.json` の `overlays[]`
(既定)または `inserts[]`(`--as insert`)へ配置する apply パッチ下書きを
書くコマンド。`material-fit` / `effect-check` / `bgm-fit` と同じ
「\*-fit → \*.suggested.json」の下書きパターンで、**収録フォルダの編集
ファイルは1バイトも書かない**(出力は使い捨ての
`hyperframe-place.suggested.json` だけ):

    node src/cli.ts hyperframe-place <dir> --name <name> --at <元収録の秒>
    # 既定は overlay(全画面 or --rect で部分配置)。--as insert で
    # ベース映像への挿入編集にできる(insert は --rect / --track を取らない)

尺(`durationSec`)は決定論的に解決する: `--duration <s>` を明示すればそれ、
無ければ `hyperframe.<name>.key.json` の `durationSec`、それも無ければ
`materials/hyperframes/<name>.mp4` を ffprobe した実尺(この優先順は
`hyperframePlace` の `durationSource: "flag" | "key" | "ffprobe"` として
結果に残る)。`--fade <s>` は `fadeInSec`/`fadeOutSec` を同じ値でセットする。
`--at` が `cutplan.json` の keep 区間外なら警告(非致命。下書きは書く)。

`overlays.json` が既に存在するかどうかで下書きの op 形が変わる(`apply` の
`add` は既存ファイルへの追記専用で、ファイルが無いと拒否されるため):
既存なら `overlays.overlays` / `overlays.inserts` への `add` 1件、
無ければ `overlays.json` を1件だけの配列で新規作成する whole-file
`replace`。どちらも `apply --patch` にそのまま食わせられる(挙動の違いは
`hyperframe-place` 実行時の stdout に「overlays.json を新規作成」/
「既存の overlays.json に追記」として出る)。

書いた下書きは人間が確認してから適用する:

    node src/cli.ts frames <dir> --t <at>
    node src/cli.ts preview <dir>
    node src/cli.ts effect-check <dir>
    node src/cli.ts apply <dir> --patch hyperframe-place.suggested.json --dry-run
    node src/cli.ts apply <dir> --patch hyperframe-place.suggested.json

**自分で apply しない**(placement は人間が review してから適用する)。

## HyperFrames カードの動的監査(hyperframe-check)

`hyperframe-check <dir> --name <name>` は、render せずに
`hyperframes/<name>.html` の動的な振る舞いを検品するコマンド
(`effect-check` と同じ家風: 決定論のみ・常に exit 0・warn/info のみ・
収録フォルダの編集ファイルは一切書かない)。srcdoc を headless Chrome に
読み込み、composition 尺を時間グリッドで seek しながら**論理アニメーション
状態**(ピクセルではなく、要素の可視性/opacity/rect・WAAPI/GSAP/Lottie の
進行状態)を採取し、静的な check ゲート(`checkComposition`)では見えない
「動かしてみないと分からない」欠陥を検出する:

warn を出すのは **terminal-unfinished** と **seek-unresponsive** の2つだけ
(残りは info)。画面外終端は本質的に曖昧(意図的な whip/pan 系
transition-out か、壊れた欠陥かを幾何学だけでは区別できない)なため info に
留める:

- **terminal-unfinished**(warn): 単一パス(ループ・往復ではない)のアニメー
  ションが、composition の最終フレームで完了進捗(0..1)が閾値(既定0.4)
  未満のまま終わる(「壊れて途中で止まる」演出の失敗パターン。尺の絶対比較
  ではなく進捗で判定するため、長い timeline を短い窓で意図的に見せる演出は
  誤検出しない)
- **empty-terminal**(info): composition が「空のフレーム」で終わる(かつて
  実質的なコンテンツが画面上にあったのに、終端では実質的なコンテンツが
  1つも画面内に無い)。zero-area(SVG defs/gradient/filter 等)・full-bleed
  (背景)要素は対象外
- **element-offscreen-terminal**(info): composition 終端で、実質的な
  コンテンツ要素が画面外にある(pivot/whip 系の意図的な画面外への退場を
  「欠陥」として warn にはしない個別要素単位の観測)
- **seek-unresponsive**(warn): WAAPI/GSAP/Lottie が宣言されているのに、
  seek しても描画状態が一切変わらない(paused-timeline の登録漏れ・配線
  ミスの兆候。id/`.clip`/`data-start` のどれも持たない被アニメ要素
  (例: CSS 点滅のみのカーソル)も `document.getAnimations()` の target
  経由で追跡対象に含める。
  textContent の変化(typewriter 等)も描画状態に含めて判定する)
- **dead-zone**(info): 描画状態が変化しない区間が composition 尺の半分を
  超える
- **simultaneous-entry**(info): 複数の実質的なコンテンツ要素が composition
  開始直後にまとめて登場する(個々の登場感が無い)

```
node src/cli.ts hyperframe-check <dir> --name <name>
node src/cli.ts hyperframe-check <dir> --name <name> --step 0.05   # サンプル間隔を細かく
node src/cli.ts hyperframe-check <dir> --name <name> --no-vlm      # 決定論チェックのみ
```

出力は `hyperframe.probe/<name>/index.json`(カードの sha256・寸法・
determinism tier・グリッド情報・findings)。`materials/hyperframes/<name>.mp4`
が render 済みなら、head/mid/tail + 各 WARN finding の時刻を ffmpeg で
still(PNG)抽出する(`hyperframe.probe/<name>/<role>.png`。mp4 が無ければ
「先に render してください」という `stillsNote` を残すだけで決定論
findings には影響しない)。vision route が設定されていて `--no-vlm`/
config `hyperframeCheck.useVlm=false` でなければ、`effect-check` と同じ
判定専用の VLM 二次確認(座標は生成させない)も任意で行い、
「意図に沿わない(フレーム端で切れる/終端で凍結・空/判読できない)」と
判定された still は `vlm-mismatch` の warn として findings に追加される。
vision route 不在・still 抽出失敗・`--no-vlm` はいずれも優雅に劣化し
(`vlm.ran: false` + 理由)、exit 0 を維持する。
`cutplan.json` / `approvals.json` は読まない・書かない。


## 環境プリフライト(doctor)

`node src/cli.ts doctor` は収録に入る前の環境チェック(読み取り専用)。
node(>=23.6)/ffmpeg/ffprobe/有効エンコーダの整合/whisper バイナリ・モデル/
AI route 到達性を 1 コマンドで検査する。収録フォルダは不要で、config.yaml だけを使う。

    node src/cli.ts doctor
    node src/cli.ts doctor --json     # DoctorReport を JSON で(パイプ可)
    node src/cli.ts doctor --no-ai    # AI 到達性のネットワークプローブを省く

- 必須(node/ffmpeg/ffprobe)が欠けていれば exit 1。収録/AI 系(whisper・model・
  encoder・AI route)は warn で exit 0(editor までは到達できる)。
- 非 mac で preview.videoEncoder 未設定なら有効エンコーダは自動で libx264(A2)。
- doctor は編集ファイル・approvals.json を一切書かない。
- AI エージェントにセットアップ自体を委任するなら、`doctor --json` を背骨にした収束手順を
  [SETUP_WITH_AI.md](../SETUP_WITH_AI.md) が案内する(承認・render には触れない環境構築のみ)。

## ログ出力(log.level / --verbose)

外部プロセス(ffmpeg/ffprobe/whisper/Remotion)・AI 呼び出し・render/preview の
ステージ内訳は `config.yaml` の `log.level` で stderr への出し方を切り替えられる
(stdout は `describe --json` 等のパイプ可能な純 JSON のまま level に関わらず不変):

- `quiet`: workflow ログをほぼ抑止(AI 行も出さない)
- `normal`(既定): AI 呼び出し行(`✦ AI: purpose=...`)とステージ行
  (`▸ Remotion (42.3秒)` 等)を出す。既存の AI 行出力と同じ可視性
- `verbose`: 上に加えて外部ツール1回ごとの行(`⚙ ffmpeg   cut (1.8秒)` 等)を出す。
  `run()` は hot loop でも呼ばれるため既定では出さない(spam 防止)

優先順位はグローバルフラグ `-v, --verbose` / `-q, --quiet` > 環境変数
`CUTFLOW_LOG`(`quiet`/`normal`/`verbose`)> `config.yaml` の `log.level` > 既定
`normal`。例: `node src/cli.ts --verbose preview <dir>` /
`CUTFLOW_LOG=verbose node src/cli.ts render <dir>`。


## ガイド一覧(目的別)

このページは概要と索引。詳しい手順は目的別ガイド(`docs/guides/`)へ分割した。
「初めて触る人が何を探しに来るか」で1ファイルの範囲を決めている。

| 何をしたいか | ガイド |
|---|---|
| AI のカット案を作って育てる(plan / cutplan、知覚・候補格子・harness・editMode・システム音声) | [guides/cut-planning.md](guides/cut-planning.md) |
| 字幕・帯・ベースレイアウト・カット境界演出・見た目調整 | [guides/captions-layout.md](guides/captions-layout.md) |
| 素材(B-roll)を把握して差し込む(materials / plan-materials / material-fit) | [guides/materials.md](guides/materials.md) |
| ズーム/ぼかし/囲みの演出(overlays / plan-effects / effect-check) | [guides/effects.md](guides/effects.md) |
| 音量・BGM・A/V フィードバック(plan-bgm / bgm-fit / av) | [guides/audio-bgm.md](guides/audio-bgm.md) |
| スタイルの一貫性とチャンネル学習(style-profile / style-check / rules / learn) | [guides/style-and-rules.md](guides/style-and-rules.md) |
| 承認して書き出す・ショート・サムネイル(approve / render / shorts / thumbnail) | [guides/export.md](guides/export.md) |
| AI プロバイダ・MCP・GUI の AI 提案/検索をつなぐ | [guides/ai-agents.md](guides/ai-agents.md) |
| AI やスクリプトで安全に編集する(id / apply / assert / 契約) | [guides/safe-editing.md](guides/safe-editing.md) |
| GUI エディタ運用・frames-serve・掃除(clean) | [guides/tools-and-ops.md](guides/tools-and-ops.md) |
| コマンドを「いつ使うか」で引く早見表 | [guides/command-reference.md](guides/command-reference.md) |

### 旧セクションの移動先

以前このページにあった節は次のガイドへ移した(見出し名で検索するときの対応表)。

| 旧セクション | 移動先 |
|---|---|
| テロップのデザインは3層 / 帯の "none" / ベースレイアウトのデザイン / カット境界のディップ / 見た目の調整(Remotion Studio) | [guides/captions-layout.md](guides/captions-layout.md) |
| GUI エディタのバックグラウンド起動(--detach)/ 起動中の外部 JSON 編集 / frames-serve / 掃除とディスク(clean) | [guides/tools-and-ops.md](guides/tools-and-ops.md) |
| AI provider 設定 / AI doctor / VLM review / MCP サーバ / AI提案の比較・高水準編集・ローカル検索 | [guides/ai-agents.md](guides/ai-agents.md) |
| 安定 id / @-mention / 検査付きアトミック適用(apply)/ 編集後の意図検査(assert)/ 機械可読契約 | [guides/safe-editing.md](guides/safe-editing.md) |
| ⚠️ plan の再実行は手編集を消す / plan の知覚・スタイル注入・候補格子・観測ループ・エージェント化・編集モード / cutplan の連続被覆 / システム音声の文字起こし | [guides/cut-planning.md](guides/cut-planning.md) |
| 個別コマンドの使い分け | [guides/command-reference.md](guides/command-reference.md) |
| 素材(materials)/ plan-materials / material-fit | [guides/materials.md](guides/materials.md) |
| plan-effects / effect-check / 検品を閉じる(E6/E7)/ 演出(overlays.json) | [guides/effects.md](guides/effects.md) |
| A/V(av)/ bgm-fit / 音量 / BGM / plan-bgm | [guides/audio-bgm.md](guides/audio-bgm.md) |
| スタイルプロファイル抽出 / profile 逸脱検出 / チャンネル rules と learn | [guides/style-and-rules.md](guides/style-and-rules.md) |
| 承認(approve/unapprove)/ ショート動画 / サムネイル生成 / render の高速化 / render 中のマシン負荷 | [guides/export.md](guides/export.md) |
