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
| `cutplan.json` | **どこを残すか**(`action`: keep/cut)。境界の秒数も手で微調整できる | preview を見て「切りすぎ」「ここは残す」 |
| `chapters.json` | **概要欄チャプター用メタデータ**(`start` / `title` のみ)。動画への描画には使われない: 章タイトルは plan が「章」という名前のテロップトラックとして transcript.json に書き、以降はただのテロップとして編集する | YouTube 概要欄に載せる章タイトルの言い換え |
| `overlays.json` | **演出**: 素材の表示(全画面または `rect` で部分配置。頭出し・音量・不透明度・フェード付き)・インサート編集・ワイプ全画面・**ズーム**(`zooms`: 画面の一部を拡大。下記参照)・**領域ぼかし**(`blurs`: 画面の一部を隠す。下記参照)・**注釈グラフィック**(`annotations`: 矢印/囲み/スポットライトで「ここを見ろ」を示す。下記参照)・**簡易カラー調整**(`colorFilter`: 全編一律の明るさ/コントラスト/彩度。下記参照)・字幕非表示・トラックの重なり順(`layerOrder`)・テロップトラックの標準設定(`captionTracks`: `{track, name, x, y, anchor, style}`。`name` はトラック名、`anchor: "topLeft"` で座標を左上基準に、位置・スタイルは個別指定の無いテロップに項目単位で効く) | B-roll を挟む、カメラだけの場面を作る、開発画面の API キーを隠す、画面の一点を指し示す(下の「演出」参照) |
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
「スタイルプロファイル抽出(style-profile)」参照)


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
