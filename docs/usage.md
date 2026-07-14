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
丸ごと省略する。削除すれば常にフル再生成に戻る) / `proxy.key.json`
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

## テロップのデザインは3層(config → トラック標準 → クリップ)

テロップの見た目(`CaptionStyle`: `fontSizePx` / `color` / `outlineColor` /
`outlineWidthPx` / `fontFamily` / `fontWeight` / `background` / `anim` /
`karaoke`)は**項目単位**で下から積み上げて解決される:

| 層 | どこに書く | 効く範囲 |
|---|---|---|
| ① 全体の既定 | `config.yaml` の `render.caption*`(`captionFontSizePx` / `captionColor` / `captionOutlineColor` / `captionFontFamily` / `captionFontWeight` / `captionBackground`) | 全テロップ |
| ② トラック標準 | `overlays.json` の `captionTracks[].style` | そのトラックのテロップ全部 |
| ③ クリップ個別 | `transcript.json` の `segments[].style` | そのテロップ1件 |

**「テロップ」と「章」でデザインを変えたい**、は②で表現する。例えば章
(track 2)だけ帯なし・左寄せにしたいなら:

```json
// overlays.json
{
  "captionTracks": [
    { "track": 2, "name": "章", "anchor": "topLeft", "x": 80, "y": 80,
      "style": { "background": "none", "fontSizePx": 36, "fontWeight": 700 } }
  ]
}
```

GUI エディタでは**タイムラインのトラックラベル(「テロップ」「章」)を
クリック**するとインスペクタが②の編集に切り替わる(クリップを選ぶと③)。

### 帯(`background`)の `"none"` — 「未指定」と「帯なし」は違う

`background` だけは他の項目と違い、**省略(undefined)が「帯なし」を意味しない**。
省略は「指定なし=下の層から継承」なので、下の層(②や①)が帯を持っていると
継承されて帯が出る。ある層で**継承した帯を消す**には、キーを消すのではなく
明示的に `"none"` を書く:

```jsonc
// config.yaml で全テロップに帯を敷きつつ…
render:
  captionBackground: { color: "rgba(35,35,35,0.9)", paddingPx: 52, radiusPx: 20 }
```
```jsonc
// …章トラックだけ帯を消す(background を消すのではなく "none" を書く)
{ "track": 2, "style": { "background": "none" } }
```

これは `outlineColor: "none"`(縁取りを消す)と同じ流儀。どの層でも `"none"` で
その下を打ち消せる(③の `"none"` は②と①を、②の `"none"` は①を打ち消す)。
逆に、②が `"none"` でも③でオブジェクトを書けばそのテロップだけ帯が戻る。

> **よくある間違い**: 「帯を消したのに消えない」。`transcript.json` の
> `style.background` を**削除**しただけだと ①/② の帯が継承されて復活する。
> `"none"` を書くのが正解(GUI のインスペクタは「帯」のチェックを外すと
> 自動でこれを書く)。

## GUI エディタ起動中の外部 JSON 編集

GUI エディタを開いたまま、Claude Code や別のエディタで
`cutplan.json` / `transcript.json` / `overlays.json` / `bgm.json` /
`shorts.json` を編集してよい。GUI 側に未保存の編集が無ければ、外部変更は
従来どおり自動で読み込まれる。

GUI 側にも未保存の編集があるときは、エディタ上部に外部変更バナーが出る。
外部変更と GUI 側の未保存編集が別の hunk なら自動マージされ、同じ
id 付き要素の同じフィールド、または id が無い配列全体が衝突した場合だけ
「差分をレビュー」で選べる。レビューでは hunk ごとに「自分の版」か
「ディスク版」を選び、「適用」で GUI の live state に反映する。適用だけでは
ファイルには書かれないので、内容を確認してから通常どおり保存する。

GUI の AI コマンドも同じ差分レビューを通る。1 回の自然言語指示は
`提案 → static validation(planApply) → diff review → 適用 → 保存 → 任意の
frames 確認` を 1 つの workflow として扱い、レビュー画面から
`適用のみ` / `適用して保存` / `適用して確認` を選ぶ。`適用して確認` は
隠れた保存ではなく、保存してから確認フレームを生成する明示的な経路。

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

## AI provider 設定

AI は未設定でも deterministic な CLI / editor / render は動く。AI を使うときは
`config.yaml` の `ai:` で provider を設定する。旧形式の
`ai.provider` / `ai.model` と `llm.backend` はそのまま動くが、**新規設定は
profiles + routes を推奨**する。

```yaml
ai:
  profiles:
    local:
      adapter: openai-compatible
      protocol: chat-completions
      baseUrl: http://127.0.0.1:11434/v1
      model: qwen-local
      auth: { type: none }
      capabilities:
        structuredOutput: json-object
        imageInput: false

    cloud-vision:
      adapter: openai
      model: gpt-5.4-mini

  routes:
    text: local
    structured: local
    vision: cloud-vision
```

- `text`: 自由文生成
- `structured`: plan / remeta / plan-shorts / plan-materials / plan-effects / plan-bgm / editor AI 提案の schema 付き出力
- `vision`: still 比較の VLM review

組み込み adapter:

| adapter | text | structured | image | 備考 |
|---|---|---|---|---|
| `claude-code` | yes | native schema | no | `claude` CLI |
| `codex` | yes | prompt | no | `codex exec` |
| `openai` | yes | native schema | yes | `OPENAI_API_KEY` |
| `anthropic` | yes | native schema(tool) | yes | `ANTHROPIC_API_KEY` |
| `openai-compatible` | yes | explicit | explicit | local / self-hosted 用 |

`openai-compatible` は capability を推測しない。`structuredOutput` と
`imageInput` を明示する。

### AI doctor

接続確認は `ai doctor` で行う。収録フォルダは不要で、`config.yaml` だけを使う。

```sh
node src/cli.ts ai doctor
node src/cli.ts ai doctor --profile local
node src/cli.ts ai doctor --route vision
node src/cli.ts ai doctor --json
```

検査内容:

- config validation
- credential の有無
- text probe
- structured probe
- image probe

`imageInput=false` や `structuredOutput=none` の profile は対応 check を `skip`
する。`ai doctor` は recording JSON や artifact を書かない。

### VLM review と送信先

GUI の「画像もAIに確認させる」は既定 off。次の条件をすべて満たすときだけ使える。

- `editor.aiReview.vlm=true`
- `vision` route がある
- その profile が `imageInput=true`
- credential が揃っている

送るのは **縮小 still のみ**。raw 動画、raw 音声、full-res still、recording path、
`.env`、approval record は送らない。送信枚数は 2 または 4 枚に正規化される。
before/after のペアは崩さない。

### 失敗ポリシー

- plan / remeta / plan-shorts / plan-materials / plan-effects / plan-bgm / editor AI 提案: provider failure はその操作の error。
  editable JSON は変えない。
- VLM review: optional lane。失敗しても deterministic review bundle は成功させ、
  warning として表示する。
- provider 間の自動 fallback はしない。local failure で勝手に cloud へ送らない。

### Privacy / secret

- API key は `config.yaml` に書かず、環境変数名だけを使う
- browser / log / artifact に key 値は出さない
- custom endpoint は `https` または loopback `http` だけ許可
- redirect は拒否し、response size は上限付きで読む

id が付いた配列は要素/フィールド単位でレビューできる。id が無い配列は
安全のため配列まるごと1 hunk として扱う。`approved` はレビュー対象外で、
承認の実体は引き続き `approvals.json` と approve/unapprove 経路が担う。

## 安定 id / @-mention

編集ファイルの各要素(`cutplan.segments` / `transcript.segments` /
`overlays.json` の各配列 / `chapters.chapters` / `bgm.tracks` / 各ショートの
`ranges`・`captionTracks` / `thumbnail.texts`)には、任意で**安定 id**
(`id?: string`。例 `seg_a1b2c3`)を付けられる。文法は
`<種別を表す2〜3文字の接頭辞>_<英数字6桁>`(`seg`=cutplan の区間 / `cap`=テロップ /
`mat`=素材 / `ins`=挿入 / `zm`=ズーム / `bl`=ぼかし / `wf`=ワイプ全画面 /
`hc`=字幕非表示 / `ct`=テロップトラック標準設定 / `ch`=章 / `bg`=BGM区間 /
`rg`=ショートの range / `tx`=サムネのテキスト)。**shorts(ショート本体)だけは
`name` がそのまま id 代わり**で、別の id フィールドは持たない
(`@<name>` または `@short:<name>` で指せる)。

- **一度振ったら内容・位置が変わっても不変**(id は「この要素」を指す
  永続アドレス。`@id` で人間/AI が位置に依存せず参照できる)。
- **opt-in・sticky**: プロジェクトに `id` が1つも無ければ「id 無効」で、
  全コマンドの出力は本機能導入前と完全に同じ(バイト等価)。`id-stamp <dir>`
  を一度実行すると「id 有効」になり、以後は `plan` / `transcribe` /
  `plan-shorts` の再実行や GUI 保存が新規要素にだけ id を採番し、既存 id は
  常に保つ。**id 無効なプロジェクトを触らない限り、この機能は一切見えない**。
- **`id-stamp <dir>`**: 既存プロジェクトへの一括採番コマンド(冪等。既存 id は
  不変、無い要素にだけ新規採番。内容が実際に変わったファイルだけ書く)。
  `validate` と同じ検査を通してから書く。`approvals.json`(承認レコード)には
  一切触れない。
- **id の発見手段は `describe <dir> --json`**(散文 `describe` には出ない。
  golden 出力を汚さないため)。各要素の `index` の次に `id`(採番済みのものだけ)
  が載る。
- **`validate`** は id の重複・形式不正・(有効時の)欠落密度を**警告**で知らせる
  (id は render に一切影響しないため error にはしない。id が無いプロジェクトでは
  この検査自体が no-op で警告も増えない)。
- **id は render / preview / frames / 承認 hash に一切影響しない**(アドレッシング
  専用。cut 決定のハッシュは `[start, end]` のみを見るので、id を stamp しても
  承認は失効しない)。
- `@id` を宛先にした差分適用(パッチ)は `apply <dir>` コマンドで行う
  (下記「検査付きアトミック適用(apply)」参照)。配列添字を書かず、
  `@id` と1フィールドの新しい値だけで編集を当てられる。

## 検査付きアトミック適用(apply)

`cutplan.json` 等を Write/Edit で直接書き換える(=検査は書いた後の
`validate` 任せ)代わりに、`apply <dir>` は**「全部 valid なら全部書く、
1つでもエラーなら1バイトも書かない」全か無か**で編集を当てるコマンド。
GUI エディタの保存(`/api/save`)が既に持っていた「検査を通さないと保存
できない」を CLI/AI へ露出したもの(GUI と同じ merge+検査を共有=
`src/lib/applyEdits.ts` の `mergeBodyOverDisk`)。

```sh
node src/cli.ts apply <dir> --patch edit.json     # ファイルからパッチを読む
node src/cli.ts apply <dir> < edit.json           # stdin から(--patch 省略時)
node src/cli.ts apply <dir> --patch edit.json --dry-run   # 検査・要約だけ。書かない
```

パッチ(`ApplyPatch`。`src/types.ts`)は次の2形式を両方受け付ける(両方
あるときは ops を先に適用し、その結果へ replace を重ねる):

- **`ops`**(`@id` 指定の高水準オペレーション列。**推奨経路**): 配列添字を
  一切書かず、Feature 2 の安定 id(`describe --json` / `id-stamp` で確認)
  だけで宛先を指す。

  | op | target | 追加フィールド | 意味 |
  |---|---|---|---|
  | `set` | 既存要素の `@id` | `field`(ドット区切りパス。例 `"style.fontSizePx"`) / `value` | 指した要素の1フィールドを設定。パス末端の置換のみ(中間の欠落・配列添字(`words[0]`)はエラー。勝手に中間オブジェクトを作らない) |
  | `remove` | 既存要素の `@id` | — | 指した要素を所属配列から削除 |
  | `add` | コレクション選択子(例 `"cutplan.segments"`) | `value`(新要素オブジェクト) / `at?`(挿入位置。省略時は末尾) | コレクションへ新要素を追加。id 有効プロジェクトなら新要素にも自動採番される |

  `add` の選択子は allow-list(`cutplan.segments` / `transcript.segments` /
  `overlays.overlays` / `overlays.inserts` / `overlays.zooms` /
  `overlays.blurs` / `overlays.wipeFull` / `overlays.hideCaption` /
  `overlays.captionTracks` / `chapters.chapters` / `bgm.tracks` /
  `thumbnail.texts`)のみ。**shorts[] 自体の追加、および shorts 配下
  (`ranges`/`captionTracks`)への set/remove/add は対象外**(`@id` だけでは
  「どのショートか」を一意に復元できないため。全置換(`replace`)で編集する)。
  `cut`/`keep` も独立 op にせず `{op:"set", target:"@seg_x", field:"action", value:"cut"}`
  で表す。
- **`replace`**(ファイル単位の全置換。`SaveRequest` と同型の低水準の脱出
  ハッチ): split・要素の並べ替え・shorts[] 自体の追加など、`ops` の3種で
  表せない編集に使う。`bgm`/`shorts` は `null` で該当ファイルを削除できる
  (`undefined` はそのファイルを触らない)。

**守られる不変条件**(コードで強制。「自分の判断で回避」できない):

1. **`approvals.json` を一切書かない・読んで判定に使わない**。承認は
   `approve`/`unapprove` コマンドと GUI 保存の専権のまま。
2. **`approved` を変更できない**。`set` の `field` に `approved` を指定、
   `add` の `value` に `approved` を含める、`replace` で
   `cutplan.approved`/`shorts[].approved` をディスク現状と違う値にする
   —— いずれもエラーで拒否される(cutplan/short の `approved` は常に
   ディスク現状の値へ強制されて書き戻される)。承認を変えたいときは
   `approve <dir>` / `unapprove <dir>` を使う。
3. **エラー時ゼロ書き込み**: 宛先未解決・op 不正・JSON パース失敗・
   `validate` と同じ不変条件違反(keep の重なり・尺超え・overlays の file
   欠落等)のいずれでも、収録フォルダのファイルは1バイトも変わらない
   (`backups/` も作られない)。
4. **書き込みはファイル単位で `<file>.tmp` → rename(アトミック確定)**。
   書く前に `backupEditableFiles` と同じ仕組みで上書き対象の現状を
   `backups/<日時>/` へ退避する。
5. **apply が書けるのは cutplan/transcript/overlays/chapters/bgm/shorts/
   thumbnail の7ファイルだけ**(`meta.json` は id を持つ要素が無いため
   `apply` のスキーマ自体に含まれない。触りたいときは通常の Write/Edit で
   直接編集する)。`approvals.json` や中間生成物は物理的に書き込み対象に
   入らない。

**出力・exit code は `validate` と同形式**: エラーは `✖ file where: message`
(`(patch)` file は「JSON 本体・パッチ形式そのものの問題(未解決 @id・
未知の op 等)」を表す)、警告は `⚠ ...`。エラーがあれば(`--dry-run` でも)
exit 1。`--dry-run` は `@id` 単位の変更要約(`field: 旧 → 新`)と
`validate` 相当の検査結果を出し、書かずに検査だけしたいときに使う。

現状スコープ外: MCP サーバ本体(`applyEdits(dir, patch)` は
`process.exit`/`console` に依存しない純関数なので、将来 MCP tool から
呼び出す土台にはなっている)、split/move 等の複合 op。

## 編集後の意図検査(assert)

`validate` が答えるのは「この編集は**壊れていない**か」(スキーマ・keep の
重なり・参照ファイルの存在・尺超えという普遍の不変条件)。一方 `assert <dir>`
が答えるのは「この編集は**私が意図した状態になっている**か」——「ショートを
60秒以内に収めたはずだ」「@cap_x のテロップは本編に残っているはずだ」
「API キーを写した区間は目隠しできているはずだ」というこの収録固有の期待値
(`docs/plans/2026-07-07-visual-assertions-design.md` 設計)。

期待値は `assertions.json`(収録フォルダ直下)に平文で宣言する。人間/AI が
手で書く**第3の宣言ファイル**で、`rules.md` / `brief.md` と同じく
`EDITABLE_FILES`(plan/transcribe 再実行の退避対象)にも `GENERATED_FILES`
(中間生成物)にも属さない。**どの生成コマンドも上書きしない**ので、
`plan --force` で cutplan をやり直しても assertions.json は残り、そのまま
再評価できる。

```sh
node src/cli.ts assert <dir>            # Tier 1(構造)だけ評価。fail/error があれば exit 1
node src/cli.ts assert <dir> --visual   # Tier 1 + Tier 2(OCR)。非対応環境は Tier 2 を skip
node src/cli.ts assert <dir> --json     # AssertReport を純 JSON で stdout(パイプ可。診断の所要時間行は stderr へ)
```

`assertions.json` が無ければ「アサーションがありません」と表示して **exit 0**
(未使用時は無害)。

```jsonc
{
  "schemaVersion": 1,
  "assertions": [
    { "label": "本編は5分以内", "type": "outDuration", "op": "<=", "value": 300 },
    { "type": "keepCount", "op": ">=", "value": 3 },
    { "type": "captionVisible", "ref": "@cap_qs3bwg", "visible": true },
    { "type": "noCaptionOverlap" }
  ]
}
```

### 語彙(9種。type で判別)

各アサーションは共通で任意の `label?`(レポート表示用の作者ラベル。要素の
`@id` とは別物)を持てる。`op` は `"<=" | ">=" | "<" | ">" | "=="`。

**Tier 1(構造。`describe --json` 射影から。依存ゼロ・数ミリ秒・全環境。
既定 `assert <dir>` で評価される)**

| type | フィールド | 意味 |
|---|---|---|
| `outDuration` | `op, value, short?` | 出力尺の比較。`short` 指定でそのショートの `outDurationSec`、省略で本編 `summary.outDurationSec` |
| `keepCount` | `op, value` | keep 区間数(`summary.keepCount`)の比較 |
| `captionVisible` | `ref, visible?` | `@id` のテロップが出力に現れるか。`visible` 省略時 true |
| `captionText` | `ref, contains?, equals?` | `@id` のテロップ本文が部分一致/完全一致するか(手編集で文言が保たれたかの確認) |
| `timeKept` | `at, kept?` | 元収録秒 `at` が出力に残っているか(keep 内)。`kept` 省略時 true |
| `materialExists` | `ref` | `@id` の素材の参照ファイルが実在するか |
| `noCaptionOverlap` | `track?` | テロップの出力秒区間が同一トラック内で重ならない。`track` 省略で全トラックを検査 |

**Tier 2(視覚。`frames --ocr` から。macOS 依存・重い。`--visual` のときだけ
評価。既定では `skip`)**

| type | フィールド | 意味 |
|---|---|---|
| `screenText` | `at, contains, present?` | 元収録秒 `at` の画面 OCR 全文に文字列が含まれる/含まれない |
| `regionClear` | `ref` | `@id` の blur 領域内に OCR テキスト行が無い(=目隠しできている) |

`ref` を取るアサーション(`captionVisible` / `captionText` / `materialExists` /
`regionClear`)は `@id` で対象を指す。**プロジェクトに id が1つも無い
(id-stamp 未実行)場合は `fail` ではなく `error`**(`id-stamp <dir>` を実行
してから @id で指定するよう促す)。ref が解決できない(id はあるが該当が
無い)場合も `error`。

### 結果の意味論

1件ごとに `pass`(成立)/ `fail`(不成立)/ `skip`(視覚アサーションで
`--visual` 無し、または OCR 非対応環境)/ `error`(宣言そのものが評価不能:
未知 type・ref 未解決・id 未採番・`at` が収録尺外 等)。**exit code は
`fail > 0 || error > 0` なら 1**(`skip` だけでは 1 にしない=非対応環境で
CI/ループが赤にならない優雅な劣化)。CLI 表示は `validate` に揃える:
`✔`(pass)/ `✖`(fail)/ `⚠`(error)/ `–`(skip)。

## 機械可読契約(JSON Schema / AGENTS_CONTRACT.md)

Claude Code に限らず、任意のコーディングエージェント・素の JSON エディタ・
外部バリデータが CutFlow の編集ファイルを機械的に検証・補完できるよう、
契約をコードから射影した2種類の成果物がある(`docs/plans/2026-07-07-machine-contract-design.md`
設計。types.ts / validate.ts / files.ts / ids.ts という**既存の単一の出所**の
射影であり、新しい真実は宣言しない。ずれたら `npm test`(`test/schema.test.ts` /
`test/agentsMd.test.ts`)が落ちる)。

- **`schemas/*.schema.json`**(draft 2020-12): 8編集ファイル
  (`cutplan` / `transcript` / `overlays` / `bgm` / `chapters` / `meta` /
  `shorts` / `thumbnail`)それぞれに1スキーマ + 共有 `$defs`
  (`schemas/common.schema.json`。`Region` / `CaptionPos` / `CaptionStyle` 系 /
  `WordTiming` / `Annotation` union / `CaptionTrackDef` / `id` パターン /
  `Interval`)。`schemas/apply-patch.schema.json` は `apply` コマンドの入力形
  (`ApplyPatch` / `EditOp`)。各スキーマの kitchen-sink 例は
  `schemas/examples/<file>.max.json`(全任意フィールドを1つ以上使う。
  ドキュメント兼・構造ドリフト検知の fixture)。
  - **ファイル自体には `$schema` キーを注入しない**(収録フォルダの JSON は
    このスキーマ導入前とバイト等価。ユーザーデータ不可侵)。エディタ/
    バリデータ側の設定で `<file>.json` ↔ `schemas/<file>.schema.json` の
    命名規約に紐づける。
  - 外部バリデータ(例: `ajv-cli`)で実収録フォルダの JSON を検証したい場合、
    `--schema schemas/<file>.schema.json` に加えて `schemas/common.schema.json`
    を(`$ref` 解決のため)一緒に読み込ませる。
  - `schemas/assertions.schema.json` は8編集ファイルには含まれない
    (`assertions.json` は「other」カテゴリの宣言ファイル。上の
    「編集後の意図検査(assert)」参照)。`test/schema.test.ts` の全単射
    テストは `common.schema.json` / `apply-patch.schema.json` と同様に
    これを除外している。
- **`AGENTS_CONTRACT.md`**(リポジトリ直下・英語・Claude 非依存): 能力・不変条件・
  承認境界・触ってよい/いけないファイル・`@id` アドレッシング・主要コマンドを
  宣言する emerging standard のエージェント向けマニフェスト。CLAUDE.md との
  役割分担は「AGENTS_CONTRACT.md=契約(何が編集可能か・不変条件・コマンド)の正、
  CLAUDE.md=Claude Code 向けの運用ニュアンス」。

依存追加はゼロ(ajv 等の runtime 依存は足していない)。`test/helpers/jsonSchema.ts`
はテスト専用の vendored な JSON Schema 部分集合バリデータ(`$ref` / `$defs` /
`type` / `required` / `properties` / `additionalProperties` / `enum` /
`const` / `pattern` / `items` / `oneOf` / `minimum` / `maximum` / `minItems`)。

## MCP サーバ(`mcp`)

`AGENTS_CONTRACT.md`(機械可読契約)を JSON ファイルの読み書き規約として公開するのに
加え、`node src/cli.ts mcp <dir>` は同じ契約を [Model Context Protocol](https://modelcontextprotocol.io/)
の tool として露出する。Claude Desktop・codex 等、任意の MCP 対応ホストが
この収録フォルダを発見・操作できるようになる(`docs/plans/2026-07-07-mcp-server-design.md`
設計)。依存追加はゼロ(公式 SDK は使わず、`node:readline`/`node:process` だけの
自前 stdio JSON-RPC 2.0 最小実装。schema バリデータを自前実装した前例と同じ
判断軸)。

### 起動方法

```sh
node src/cli.ts mcp <dir>
```

起動すると1つの収録フォルダ `<dir>` に**束縛**される(dir は起動時に固定、
各 tool は dir 引数を取らない)。プロセスはこのフォルダの外に読み書きできない。
標準入出力で改行区切りの JSON-RPC 2.0 をやり取りする(`initialize` /
`notifications/initialized` / `tools/list` / `tools/call` / `ping`)。ログ・
診断は標準エラーへ出す(標準出力は JSON-RPC 専用チャネル)。終了は Ctrl+C。

### ホストへの登録例

**収録フォルダごとに1エントリ**を追加する(dir 束縛の設計上、複数の収録を
1サーバで扱うことはしない)。3つのホストで **`command`/`args` は完全に同じ**で、
置き場所(設定ファイル)だけが違う。

- `<REPO>` = CutFlow を clone した**絶対パス**(例: `/Users/you/dev/cutflow`)。
- `<REC>` = 対象の収録フォルダの**絶対パス**(例: `/Users/you/Movies/cutflow/2026-07-02-xxx`)。
  **相対パスは不可**(ホストの作業ディレクトリ次第で解決に失敗する)。

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cutflow-2026-07-02-xxx": {
      "command": "node",
      "args": ["<REPO>/src/cli.ts", "mcp", "<REC>"]
    }
  }
}
```

**Claude Code** — プロジェクト直下の `.mcp.json`(上と同じ `mcpServers` 形式)、
または CLI 一発:

```sh
claude mcp add cutflow -- node <REPO>/src/cli.ts mcp <REC>
```

**Cursor** — `.cursor/mcp.json`(同じ `mcpServers` 形式):

```json
{
  "mcpServers": {
    "cutflow": {
      "command": "node",
      "args": ["<REPO>/src/cli.ts", "mcp", "<REC>"]
    }
  }
}
```

> **Node のバージョンに注意**: CutFlow はビルド無しで TS を直接実行する
> (Node **23.6 以上**の type-stripping)。ホストが PATH 上の古い node を拾うと
> TS 構文エラーで即死する。`node --version` が 23.6 未満なら、`command` に
> 23.6+ の node バイナリの**絶対パス**(例: nvm の `~/.nvmrc` 相当)を書く。
> `cwd` 設定は不要(スキーマ等は実行ファイル位置から解決する)。

### 露出する tool

「読む」+「承認スコープ外の安全編集」に限定している(AGENTS_CONTRACT.md §11 が正の
一覧・信頼モデル宣言):

| tool | 種別 | 対応する CLI |
|---|---|---|
| `cutflow_describe` | 読取 | `describe <dir> --json` |
| `cutflow_validate` | 読取 | `validate <dir>` |
| `cutflow_frames` | 読取(知覚) | `frames <dir>` |
| `cutflow_materials` | 読取 | `materials <dir>` |
| `cutflow_av` | 読取 | `av <dir>` |
| `cutflow_assert` | 読取(検証) | `assert <dir>` |
| `cutflow_apply` | 安全編集 | `apply <dir>`(`dryRun` 引数で `--dry-run` 相当) |
| `cutflow_id_stamp` | 安全編集 | `id-stamp <dir>` |

`approve` / `unapprove` / `render` / `plan` / `remeta` / `plan-shorts` /
`plan-materials` / `plan-effects` / `plan-bgm` / `run` / `ingest` / `transcribe` / `detect` / `preview` / `thumbnail` /
`editor` / `frames-serve` / `learn` は**レジストリに存在せず、tool として
一切呼べない**(汎用の「CLI を実行する」tool も無い)。承認は人間だけの
行為であり、その実体は `approvals.json` の keep 集合ハッシュに束縛された
承認レコード(「承認の実体」節参照)。`cutflow_apply` は `apply <dir>` と同じ
`applyEdits`/`planApply` をそのまま呼ぶので、`approvals.json` 非改変・
`approved` 変更不可の保証を一切緩めない。

ドメイン層の失敗(`validate` がエラーを検出・`apply` が検査で拒否)は
JSON-RPC エラーではなく `tools/call` の成功 result に `isError: true` +
構造化 JSON として返る(呼び出し側のエージェントが読んで自己修正できる
ように)。不正な JSON-RPC・未知メソッド・未知 tool 名・引数の型違反は
標準の JSON-RPC エラーコード(`-32700`〜`-32603`)で返る。

### 承認境界を deny テンプレで固める(`.claude/settings.json`)

MCP 経由なら承認は **safe by construction** で守られる(上表の露出 tool に
`approve`/`render`/`plan` は無く、`AGENTS_CONTRACT.md` §11 の信頼モデルが正)。
一方で、Claude Code 等が **MCP を介さず収録フォルダの JSON を直接 Write/Bash**
できる場合は、`承認レコード(approvals.json)を自分で書く`・`approve --yes を
強行する` といった意図的バイパスをコードだけでは塞げない。これを塞ぐ層が
Claude Code の権限設定(deny ルール)で、SD-A5 はそれを**ターンキーの実ファイル**
として同梱する:

```sh
cp docs/examples/claude-settings-deny.json <あなたのプロジェクト>/.claude/settings.json
```

`<あなたのプロジェクト>` は Claude Code が project ルートとみなす場所(CutFlow
リポジトリ直下、または収録フォルダ直下のどちらでもよい。deny グロブは `**/` 前置
なので階層を問わず収録フォルダ内の `approvals.json` に一致する)。テンプレの中身:

```json
{
  "permissions": {
    "deny": [
      "Write(**/approvals.json)",
      "Edit(**/approvals.json)",
      "Bash(node src/cli.ts approve*)"
    ]
  }
}
```

- **load-bearing(本質)は上の3行**。`Write/Edit(**/approvals.json)` が承認
  レコードの物理的な書き込みを止める(母艦 §2 原則4・CLAUDE.md「権限設定」)。
  `Bash(node src/cli.ts approve*)` は `approve --yes` の反射実行を止める
  best-effort(コマンドの綴り替えで回避され得るので belt 扱い)。
- 同梱ファイル(`docs/examples/claude-settings-deny.json`)には、これに加えて
  **中間生成物/キャッシュへの誤書き込み**を防ぐ belt グロブ(`manifest.json` /
  `*.key.json` / `*.raw.txt` / `frames/**` / `render.chunks/**` / `*.probe/**`
  ほか)も入っている。これらは `src/lib/files.ts` の `GENERATED_FILES` /
  `GENERATED_NAME_PATTERNS` / `GENERATED_DIRS` から派生した一覧で、`files.ts` が
  分類の**単一の出所**(母艦 §2 原則5)。`files.ts` を変えたらこのテンプレも追随
  させる。belt が未網羅でも承認境界(load-bearing)は変わらない。
- deny グロブは**編集ファイル**(`cutplan.json` / `chapters.json` / `meta.json` /
  `transcript.json` / `overlays.json`)には一切当たらない(`transcript.system.json`
  は別名の生成物)。= 「cut は編集させるが承認は書かせない」を表現する。

## ⚠️ 最重要の注意: plan の再実行は手編集を消す

`plan`(と `run`)を再実行すると **cutplan.json / chapters.json / meta.json と
「章」トラックのテロップが上書きされる**(他のトラックのテロップは保たれる)。
手編集を始めたら plan は再実行しないこと。
「LLM の案は最初の1回だけ、以降は人間が育てる」が原則。

運用ルールだけには頼らない二重の防御がある:

- 生成物が既にあるときの `plan` / `run` は **`--force` を付けないとエラーで
  止まる**(初回は今までどおり何も聞かれない)
- `--force` で実行しても、上書き前に手編集ファイル一式(cutplan / chapters /
  meta / transcript / overlays)が **`backups/<日時>/` へ自動退避**される。
  消してしまったら退避先のファイルを収録フォルダ直下へコピーし直せば戻る
  (`transcribe` の単体再実行も transcript.json を同じ場所へ退避する)

## 個別コマンドの使い分け

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | 自動下書きを一括生成したい上級/バッチ用。2回目以降は `--force` が必要(実行前に backups/ へ退避) |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる。transcribe の再実行はテロップの手編集ごと上書きする(既存の transcript.json は backups/ へ退避される)。`whisper.wordTimestamps`(既定 true)が有効だと transcribe が各テロップに `words[]`(語単位タイミング。テロップの `style.karaoke` が消費する)を付ける。既存収録は再 transcribe が要る(明示的に `false` を書けば付けない従来挙動に戻せる)。`whisper.captionSplit`(省略時オフ=whisper のチャンク幅そのまま)を書くと、transcribe が長い 1 発話を「約 `maxChars` 文字」の読みやすい 1 テロップへ割り直す(日本語の文節末=助詞・句末表現+無音ギャップ+文字数上限で折る決定論処理。LLM も再文字起こしも使わない。`words[]` があれば分割後の時刻は語境界そのもの・カラオケ補助も各断片へ引き継ぐ)。`maxChars` 以下のテロップは一切改変しない |
| `editor <dir> --layout <plain\|obs-canvas\|auto>` / `ingest <dir> --layout …` / `run <dir> --layout …` | 収録レイアウトを明示するとき。既定は `plain`=通常動画(1画面・カメラ無し。出力解像度=収録の実寸)。OBS 拡張キャンバスでワイプを使う場合は `--layout obs-canvas`。`auto` はキャンバス寸法が `screenRegion + cameraRegion` と完全一致、または十分な超横長なら obs-canvas、それ以外は plain |
| `ingest <dir> --mic-track <n>` / `--system-track <n>`、`run <dir> --mic-track <n>` / `--system-track <n>` | OBS の音声トラック割当が `config.yaml` の `ingest.micTrack`/`systemTrack`(既定 1/2)と違うとき、一時的に上書きする(1始まりの番号)。`ingest` はまず設定値を尊重するが、範囲外なら音声トラックが1本ならそれを mic とみなし、複数本あってトラックのメタデータ(タイトル)から mic が一意に決まれば推定し、それでも判別できなければ**見つかった全トラックの一覧(コーデック/チャンネル数/タイトル)を提示して停止**する(黙って別トラックを mic として抽出することはない)。提示された番号を `--mic-track` に指定するか、`config.yaml` の `ingest.micTrack` を恒久的に直す |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(上記。2回目以降は `--force` が必要) |
| `plan <dir> --cuts-only` | カット判断だけをやり直したいとき(章立て・タイトル案・概要欄は変えたくない)。cutplan.json / plan.raw.txt だけを書く(chapters / meta / transcript の章テロップ / overlays の章トラックには触らない) |
| `remeta <dir>` | **カットは手編集済みだが、章立て・タイトル案・概要欄だけ作り直したい**とき。現在の cutplan の keep 区間(=完成動画)を見て chapters / meta と「章」トラックのテロップだけを再生成する。cutplan は触らないのでカットの手編集は保たれる(実行前に transcript / chapters / meta を backups/ へ退避) |
| `plan-shorts <dir>` | **長尺1本からショートの下書きを作りたい**とき。detect の候補区間を LLM に番号で選ばせ、`shorts.json`(各ショート `profile`(camera 有り→`vertical`、plain→`vertical-screen`)/ `approved: false` / 時間順の `ranges`。尺は `config.yaml` の `planShorts.maxDurationSec`(既定60秒)以下)を生成する。時刻は LLM に生成させず番号選択のみ。承認は人間(preview / エディタのショートモードで確認して `approve <dir> --short <name>`)。既存 `shorts.json` があるときは `--force` 必須で、実行前に shorts.json ごと backups/ へ退避する |
| `plan-materials <dir>` | **手持ちの素材(B-roll)をどこに置くか下書きしたい**とき。要 `materials <dir> --all` の事前実行。cutplan の keep span(アンカー)× 実在素材に番号を振り、LLM に (アンカー番号, 素材番号) のペアだけを選ばせて `overlays.json` の `overlays[]` を下書きする。時刻・ファイルパスは LLM に生成させず番号選択のみ。cut / 承認には一切触れない。承認不要(overlays は承認スコープ外)だが下書きなので preview / エディタで見て要らなければ削る。既存 `overlays.json` があるときは `--force` 必須で、実行前に backups/ へ退避する。詳細は下記「素材配置候補の自動生成(plan-materials)」参照 |
| `plan-effects <dir>` | **画面の一部を拡大/隠す/囲みたい下書きが欲しい**とき。要 `frames <dir> --ocr` と `av <dir>` のいずれか(両方推奨)の事前実行。画面OCR・動き検出・発話から演出アンカーに番号を振り、LLM に (アンカー番号, 種別) のペアだけを選ばせて `overlays.json` の `zooms`/`blurs`/`annotations` を下書きする。座標・時刻・色は LLM に生成させず番号+種別選択のみ(座標は知覚が決めた実在矩形から)。cut / 承認には一切触れない。承認不要だが下書きなので preview / frames で見て要らなければ削る。既存の zooms/blurs/annotations があるときは `--force` 必須で、実行前に backups/ へ退避する。`--observe` を付けると前回の `effect-check.json` の警告を参考情報としてプロンプトへ渡す(E7・opt-in・省略時はバイト等価)。詳細は下記「演出候補の自動生成(plan-effects)」「検品を閉じる(E6/E7)」参照 |
| `plan-bgm <dir>` | **手持ちの曲をどこに敷くか下書きしたい**とき。区間境界(切替アンカー)は章境界(`chapters.json`)+ 大カット境界から決定論で列挙し、曲は `materials/` の音声ファイル ∪ 収録直下 `bgm.*` の実在集合から番号選択する。LLM に渡すのはスロット一覧と曲一覧の2リストだけで、応答は (slotId, file: 曲番号 or null) のペアのみ。時刻・ファイルパス・音量は LLM に生成させない。cut / 承認には一切触れない。承認不要(bgm は承認スコープ外)だが下書きなので preview / エディタで聴いて要らなければ削る。既存 `bgm.json` があるときは `--force` 必須で、実行前に backups/ へ退避する。詳細は下記「BGM 配置候補の自動生成(plan-bgm)」参照 |
| `learn <dir>` | **直前の LLM 生成を人間がどう仕上げたかから、次回用のチャンネルルール追記案を作りたい**とき。`plan.raw.txt`(AI の最初の案)と `describe(dir)` + `meta.json`(人間の仕上げ)を LLM に見せ、`rules.suggested.md` に追記案の下書きを書く。**channel の `rules.md` には一切書き込まない**(採用は人間が内容を確認して手で `rules.md` に転記)。`plan.raw.txt` が無ければ先に `plan` か `run` を実行するよう促してエラー終了。詳細は下記「チャンネル rules と learn」参照 |
| `validate <dir>` | JSON を手編集した後は毎回。整合性エラー(exit 1)と警告を出す。概要欄チャプター(chapters.json)と画面表示の章タイトル(「章」トラックのテロップ)が食い違うと警告するので、片方だけ直した取りこぼしに気づける。GUI の保存も同じ検査を通す(壊れた JSON は保存できない)。`frames/index.json` が現在の JSON より古ければ「frames を撮り直せ」も警告する(下記) |
| `preview <dir>` | cutplan.json を編集するたび。承認前でも動く |
| `approve <dir>` / `approve <dir> --short <name>` | preview(または縦動画)を確認して承認したいとき。`approvals.json` に keep 集合のハッシュを記録し、`cutplan.approved`(または該当ショートの `approved`)を true に同期する。対話操作(preview 確認の y/N を挟む)で、非対話環境からは `--yes` が無いと拒否される。詳細は下記「承認(approve/unapprove)」参照 |
| `unapprove <dir>` / `unapprove <dir> --short <name>` | 承認を取り消したいとき。`approvals.json` のレコードを消し、boolean を false に戻す(安全側の操作なので確認プロンプトは無い) |
| `render <dir>` | `approve` 済み(= `approvals.json` に現内容のハッシュと一致するレコードがある状態)のときだけ実行できる。cutplan.json の `approved: true` を書くだけでは通らない(下記「承認(approve/unapprove)」参照)。transcript.json 修正後の再実行も速い(再文字起こし不要) |
| `render <dir> --short <name>` / `--shorts` | `shorts.json` のショートを書き出すとき(下記「ショート動画」参照)。承認はショート単位(本編の承認とは別のレコード) |
| `clean <dir>` | **収録フォルダのディスクを空けたい**とき。中間生成物/キャッシュを安全削除(分類は `src/lib/files.ts` の `GENERATED_FILES`/`fileRole` 由来。編集ファイル・`approvals.json`・`materials/`・元収録・成果物(`final.mp4`/`thumbnail.png`)には触れない)。`--dry-run`(消さず一覧)/ `--cache-only`(proxy/cut/render.chunks/frames/shorts/*.probe 等の重いキャッシュだけ消し、`manifest.json`/`whisper-out.*` 等は残す)/ `--json` |
| `describe <dir>` | AI/人間が JSON 群を全部読まずに編集状態(keep/カットの並び・各区間の発言・カット理由・演出・章・ショート)を把握したいとき。人間可読の散文で出す(発言は36字で切り捨て、タイトル案は先頭3件のみ)。元秒⇔出力秒を併記する。末尾に frames の現況(何の絵が `frames/` に入っているか)か、古ければ撮り直し勧告を添える(下記) |
| `describe <dir> --json` | **散文では切り捨てられる情報まで含めて機械的に処理したい**とき。発言・タイトルを一切切り捨てない機械可読な完全射影を stdout に純 JSON で出す(`schemaVersion` / `source` / `summary` / `keeps` / `cuts`(消える発言も全文) / `captions`(全文・`pos`/`style`/`words`・元秒⇔出力秒) / `overlays`(素材・挿入・ワイプ・ズーム・ぼかし・色調整の全フィールド) / `chapters` / `meta`(タイトル全件・概要欄全文) / `bgm` / `shorts`)。パイプ/`JSON.parse` 可能(所要時間の診断行は stderr に出る)。`--json` を付けない限り `describe` の散文出力は完全に不変。**id-stamp 済みのプロジェクトでは各要素に `id` が載る(散文には出ない。@-mention の発見手段はここ)**(下記「安定 id / @-mention」参照) |
| `id-stamp <dir>` | **既存プロジェクトの各要素に `@id` を一括採番したい**とき(冪等。既存 id は保持し、無い要素にだけ振る)。詳細は下記「安定 id / @-mention」参照 |
| `apply <dir> --patch <file>` | **`@id` 指定の編集を検査付きで当てたい**とき(生 JSON を丸ごと書き換えず、配列添字も書かない)。全部 valid なら全書き込み、1つでもエラーなら1バイトも書かない。`--dry-run` で書かずに変更要約だけ見られる。詳細は下記「検査付きアトミック適用(apply)」参照 |
| `frames <dir> --t ... \| --captions \| --every N` | AI がその時刻の絵を確認したいとき(テロップ位置・ワイプ被り・素材の見え方)。`frames/*.png` に出力(実行のたびに古い PNG は全消し) |
| `frames <dir> ... --ocr` | 画面内のコード・ターミナル・エラー文をテキストとして読みたいとき。元収録のフル解像度の画面領域を Apple Vision で OCR し `frames/out<秒>s.ocr.json`(`text` / `lines[].{text,confidence,box}`)に書く。macOS 専用・オフライン。非対応環境では警告のうえ PNG 出力のみ続行し、`--ocr` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames <dir> ... --full-res` | 画面キャプチャ内の文字を絵として鮮明に見たいとき。ベース映像をプロキシ(幅1280px)ではなく元収録のフル解像度にした**合成込み**(テロップ/ワイプ/素材/ズーム/ぼかし込み)still を出す。`--ocr` はテキスト抽出、こちらは見た目そのものの鮮明化(レイアウト込みで確認したいとき)。`--ocr` と併用可。`--full-res` を付けない限り既存の `frames` 挙動は完全に不変 |
| `frames-serve <dir>` | **JSON 微調整ループ(編集 → `frames --t …` → 確認 → 編集 → …)を何度も回すとき**。bundle(webpack)+headless Chrome を暖めたまま待ち受ける opt-in の常駐デーモン(下記「frames-serve(常駐フレームサーバ)」参照)。起動していなければ `frames` は現状どおりの単発実行(挙動・出力は不変) |
| `materials <dir>` | **素材(B-roll)の中身を知りたい**とき(尺・解像度・fps・音声有無・`overlays.json`/`bgm.json` との参照クロスリンク・未使用/dangling 検出)。既定は ffprobe だけ。`--frames`/`--ocr`/`--transcribe`/`--all` で見た目・画面文字・音声発話まで opt-in で取得(下記「素材(B-roll)の中身を知る(materials)」参照) |
| `material-fit <dir>` | **既存の素材参照(overlay/insert)の尺不整合や dangling/unused を直したい**とき。要 `materials <dir>` の事前実行と overlays の `@id`。修正案は収録フォルダへ直接書かず `apply` パッチ下書き(`material-fit.suggested.json`)として出す(下記「素材参照の不整合検出と修正パッチ(material-fit)」参照) |
| `av <dir>` | **keep 後タイムラインの動きと音を知りたい**とき。`av.probe/motion.json` / `sound.json` / `motion.strip.png` に、motion(scene score・freeze・フィルムストリップ)と sound(LUFS 包絡・無音・mic/system 被り・BGM/duck 設定)を出す。`--range` / `--every` / `--short` / `--full-res` / `--motion-only` / `--sound-only` を持つ |
| `bgm-fit <dir>` | **既存の `bgm.json` の音量/duck/フェードが実測と合っているか直したい**とき。要 `av <dir>` の事前実行と bgm トラックの `@id`。修正案は収録フォルダへ直接書かず `apply` パッチ下書き(`bgm-fit.suggested.json`)として出す。章が複数あるのに BGM が単調/fallback のままなら `plan-bgm` へ誘導する(下記「BGM の音量/被り/単調の検出と調整提案(bgm-fit)」参照) |
| `style-profile --from <path>` | **任意の動画/収録からテンポ・字幕密度/位置・ラウドネス・構成の統計(スタイルプロファイル)を抽出したい**とき。`<dir>` ではなく `--from`(複数可)で入力を集める。収録プロジェクトなら観測統計+補正デルタ(own-project)、素の動画/フォルダなら観測統計のみ(bare-video)。決定論のみ・編集ファイルは書かず、channel 直下の `style.probe/<name>.json` に書く(下記「スタイルプロファイル抽出(style-profile)」参照) |
| `mcp <dir>` | **任意の MCP 対応エージェントにこの収録フォルダを機械的に開かせたい**とき。stdio 上で `describe`/`validate`/`frames`/`materials`/`assert`/`apply`/`id-stamp` 相当の tool を露出する常駐サーバ(上記「MCP サーバ(mcp)」参照)。承認/render/plan 等は露出しない |

`frames` は撮影のたびに、その絵を決める編集 JSON(本編経路は cutplan/
transcript/overlays、`--short` 経路は shorts/transcript/overlays)の内容
フィンガープリントを `frames/index.json` に記録する(stale-PNG 対策。
frames は毎回全消し+撮り直すので安全だが、frames を**呼ばずに**古い PNG を
Read すると編集前の絵を見てしまう罠がある)。これを踏まえ、`validate`(必ず
編集後に叩く)と `describe`(最初に見る)が現在の JSON と突き合わせ、
食い違えば「frames を撮り直せ」と警告する。`frames/index.json` が無い
(未撮影・機能導入前)フォルダでは警告しない。**`config.yaml` の変更
(caption サイズ等)はこの検出の対象外**(JSON 手編集の撮り直し漏れが対象
のため。config を変えたときは自分で撮り直す)。

### frames-serve(常駐フレームサーバ)

`frames` は1回の実行の中では bundle(webpack)と headless Chrome を使い
回すが、CLI は呼び出しのたびに別プロセスなので、微調整ループ(JSON 編集 →
`frames --t 90` → 確認 → JSON 編集 → `frames --t 90` → …)は毎回そのコールド
コストを払い直す。`frames-serve <dir>` はこれを暖めたまま待ち受ける**opt-in**
の常駐デーモン:

```sh
node src/cli.ts frames-serve <dir>          # 起動(bundle+browser を暖機。数十秒)
node src/cli.ts frames-serve <dir> --port 5000  # ポートを変えたいとき(既定 4311)
```

起動している間、`frames <dir> --t ...` 等は自動でデーモンを検出して撮影を
委譲する(何も指定しなくてよい)。**暖めるのは bundle(webpack)と browser
だけ**で、`config.yaml` と編集 JSON(cutplan/transcript/overlays/shorts)は
毎リクエスト読み直すので、デーモン経由でも単発実行と出る絵は完全に同一
(config 編集・JSON 編集は即座に反映される)。

- **opt-in**: `frames-serve` を明示的に起動しない限り、`frames` の挙動・
  出力は現状と1バイトも変わらない(portfile 有無の `existsSync` 1回が
  増えるだけ)
- **中間生成物**: `frames/.serve.json`(`{port, pid}`)。デーモン起動中だけ
  存在し、終了(Ctrl+C)時に自動で消える。`props.json`/`index.json` と同じ
  位置づけで、手で編集・作成しない
- **remotion を触ったら**: `remotion/*.tsx` の変更は mtime で検知して
  自動的に再バンドルする(`node_modules/.cache/webpack` の陳腐化ごと
  作り直す)ので、通常は再起動不要。ただしバンドル自体に失敗する等の
  異常時は一度 Ctrl+C で再起動すれば復旧する
- **終了**: Ctrl+C。`frames/.serve.json` を残さない
- 1 デーモン = 1 収録(bundle が対象フォルダに束縛されるため)。別の収録を
  同時に暖めたいときはポートを変えて別プロセスを立てる

`preview` / `render` は GUI エディタのヘッダーの「プレビュー生成」「レンダー」
ボタンからも起動できる(未保存の編集は自動保存してから走る。render は
「承認済み」チェックが要る)。完了したレンダーは Finder で開く。

AI のカット判断を使いたくない回は、plan を1回走らせてから cutplan.json を
全部自分で直せばよい(実質手動編集)。cutplan.json を自分でゼロから
書いても動く(必要なのは keep 区間のリストと、preview 確認後の
`node src/cli.ts approve <dir>` だけ)。

## 素材(B-roll)の中身を知る(materials)

`overlays.json`(`overlays[].file` / `inserts[].file`)・`bgm.json`
(`tracks[].file`)から相対パスで参照される素材(B-roll・スライド・BGM 等。
`materials/` 直下が基本だが、参照は `materials/` 外(root の `bgm.mp3` 等)も
指しうる)の中身を知る知覚コマンド。それまで AI が得られるのは
`describe --json` の `overlays.materials[].file`/`.exists`(参照先のファイル名
と存在有無)だけで、実尺・解像度・音声の有無・画面内テキスト・素材音声の
発話は一切不可視だった。

```sh
node src/cli.ts materials <dir>                 # ffprobe だけ(尺・解像度・fps・音声有無)
node src/cli.ts materials <dir> --frames         # + 代表フレーム PNG
node src/cli.ts materials <dir> --ocr            # + フレーム/画像 OCR(--frames を含意)
node src/cli.ts materials <dir> --transcribe     # + 音声付き素材の文字起こし
node src/cli.ts materials <dir> --all            # = --frames --ocr --transcribe
```

**対象範囲**: `materials/` 配下の実在ファイル(present 集合)と、
overlays/inserts/bgm の参照集合(referenced 集合)の**和集合**。これで
1回の実行で2つの用途を賄う:

- **棚卸し**: `used:false, present:true` = 参照が無い素材(消し忘れ)
- **検証**: `used:true, present:false` = 参照されているのに `materials/` に
  無い素材(dangling。`describe` の `exists:false` と同じ事故を素材側から
  捕捉)

各素材の `references[]` にどの overlay/insert/bgm が指すか(`@id` があれば
併記)を載せるので、`describe --json` の `MaterialEntry.id` と同じ発想で
アドレス可能。`.DS_Store` 等の非メディアは `kind:"unknown"` として一覧には
出すが probe しない。

**出力**: `materials.probe/index.json`(機械可読な集約。stdout にも1行要約が
出る)。`frames/` と違い**実行のたびの全消しはされない差分更新型の
キャッシュ**(`render.chunks/` と同じ位置づけ)で、素材ごとの mtime+size
フィンガープリントが前回と一致し、かつ要求した層が既に取得済みなら再取得
をスキップする(重い層ほどキャッシュが効く)。ディレクトリごと削除すれば
常にフル再生成に戻る。`materials/` 自体(人間の素材置き場)は引き続き
`fileRole` が `"other"` のまま(生成物は別名の `materials.probe/` に集約)。

**opt-in 層**(すべて直交・加算):

- `--frames`: 動画は尺の**中点1枚**を `materials.probe/<slug>.png` に抽出。
  画像は複製せず自身のパスを `frame.file` に記録する
- `--ocr`: 動画に対しては `--frames` を含意(OCR には PNG が要るため)。
  画像は自身をそのまま OCR する。box は**素材フレーム自身のピクセル座標**
  (`coordSpace: "material-frame-px"`)で表現される。`frames --ocr` の box が
  **本編 screenRegion 出力px**であるのとは別の座標系なので混同しないこと。
  全文は `materials.probe/<slug>.ocr.json` に、index にはプレビュー(先頭
  数行)+件数+パスだけを載せる。macOS 以外・Apple Vision 非対応環境では
  `frames --ocr` と同じく警告のうえ probe/frame の出力のみ成功で返る
- `--transcribe`: `hasAudio` な素材だけを対象に、先頭音声ストリームを
  16kHz mono wav へ抽出して whisper.cpp(`-oj`。語単位タイミングは不要)で
  文字起こしし、`materials.probe/<slug>.transcribe.json` に書く。whisper
  モデルが無ければ**その素材だけ**警告してスキップする(他の層の出力には
  影響しない)。本編の `transcript.json`/`whisper-out.*` には一切触れない
- `--all` = `--frames --ocr --transcribe`

**`<slug>` の生成**: 相対パスのパス区切り(`/`)を `__` に置換するだけの
安全化(`materials/slide-01.png` → `materials__slide-01.png`)。同一 stem・
別拡張子(`a.mp4` と `a.png`)や `materials/` 直下以外の参照でも衝突しない。

素材メタは**操作エージェント(Claude Code)向けの露出**であり、カット判断
LLM 自身(`plan`/`plan --cuts-only`/`remeta`)の入力には接続していない
(`src/stages/plan.ts` と `config.yaml` の `plan.perception` は本機能の対象外)。

## 素材配置候補の自動生成(plan-materials)

`plan-materials <dir>` は、手持ちの素材(B-roll)を編集済みタイムラインの
どこに置くか、LLM に**番号選択**だけさせて `overlays.json` の下書きを作る
コマンド(§docs/plans/2026-07-11-m1-material-placement-candidates-design.md)。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **前提**: 先に `node src/cli.ts materials <dir> --all` を実行し
  `materials.probe/index.json` を作っておく必要がある。無ければ実行方法を
  告げて exit 1(例外にはしない)。配置候補にできる素材(present な
  video/image)が0件のときも同様に告知して終了する
- **アンカー(素材を置けるスロット)**: `cutplan.json` の keep span をそのまま
  使う(`config.yaml` の `planMaterials.minSpanSec`、既定3.0秒未満は除外)。
  時刻は常に実在の keep 区間なので LLM が時刻を捏造する余地がない
- **番号選択のみ**: LLM に渡すのはアンカー一覧(`#id [開始-終了] 発話内容`)と
  素材一覧(`#id 種別 実尺 音声有無 / 画面文字 / 発話プレビュー`。実測は
  `materials.probe/index.json` から)の2リストだけ。LLM の応答は
  `{ "placements": [{ "anchorId": N, "materialId": M, "reason": "..." }] }`
  のみで、時刻・ファイルパス・尺は一切書かせない。番号 → 実体の変換、
  存在しない番号の無視、動画実尺による尺 cap(素材の実尺 < span 尺なら
  span を詰める。尺超過を作らない)はすべてコード側が行う
- **overlays[] 限定**: `inserts[]`(タイムラインシフトを起こす挿入)は生成
  しない。overlays は既存映像に重ねるだけで尺・時刻写像を動かさないため、
  cut と直交して安全に試せる
- **`overlays.json` の他フィールド保持**: `inserts`/`wipeFull`/`zooms`/
  `blurs`/`annotations`/`captionTracks`/`layerOrder`/`colorFilter` は既存
  のまま保持し、`overlays[]` 配列だけを差し替える
- **書き込み前検査(all-or-nothing)**: 組んだ overlays 下書きを、書く前に
  `validate` と同じ検査(尺超過・dangling file・不正 rect 等)へ通す。1つでも
  不正なら1バイトも書かない
- **既存 overlays.json は `--force` 必須**(実行前に `backups/` へ退避)
- **承認不要・下書き扱い**: overlays の編集は承認 hash を失効させない
  (§承認(approve/unapprove))ため、生成しても既存の cutplan/short の承認は
  生きたまま。ただし人間が preview / エディタで見て、要らなければ消す前提
- **測定の注意**: LLM 出力は非決定的なので、単発 diff で配置の質(話題と
  素材の一致度)は採点できない。決定論部分(アンカー生成・尺 cap・参照整合)
  はテストで固定し、当否の判断は人間が `frames`/preview で行う

```sh
node src/cli.ts materials <dir> --all   # 前提知覚(初回・素材変更時)
node src/cli.ts plan-materials <dir>    # overlays.json へ配置下書きを生成
node src/cli.ts validate <dir>          # 尺超過・dangling が無いことを確認
node src/cli.ts frames <dir> --t <配置区間の秒>  # 実際に見えるか目視
```

## 素材参照の不整合検出と修正パッチ(material-fit)

`material-fit <dir>` は、**既に置かれている**素材参照(`overlays.json` の
`overlays[]`/`inserts[]`)の不整合を検出し、修正案を `apply` パッチ下書き
(`material-fit.suggested.json`)として出すコマンド
(§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md)。素材の
**新規配置**候補を作る `plan-materials` とは役割が別(重複実装ではない)。

- **前提**: 先に `node src/cli.ts materials <dir>` を実行し
  `materials.probe/index.json` を作っておく必要がある。無ければ実行方法を
  告げて exit 1(例外にはしない)。`overlays.json` / `bgm.json` がどちらも
  無ければ「検出対象なし」で正常終了(exit 0)
- **`@id` が前提**: 修正案は `apply` の `@id` 宛先 op(`set`/`remove`)として
  出すため、overlay/insert に `@id` が1つも無ければ「先に `id-stamp <dir>`
  を実行してください」と告げて exit 1
- **M2(尺整合)**: `materials.probe/index.json` の実尺(`probe.durationSec`)と、
  overlay の宣言尺(`end - start`)/ insert の宣言尺(`durationSec`)を突き合わせる
  - **尺超過(overrun)**: 素材が足りず最後のフレームで停止する状態。
    insert は `{ set durationSec = 実尺 - startFrom }`、overlay は
    `{ set end = start + (実尺 - startFrom) }` を提案する
  - **尺不足(underrun)**: 実尺が宣言尺よりかなり長い(大半が未使用)。
    既定は情報提示のみ(`set` を出さず reason だけ)。延長 `set` を出したい
    ときは `config.yaml` の `materialFit.suggestUnderrunExtend: true`
  - 画像素材(尺の概念が無い)は対象外
- **M3(dangling の修正提案)**: `used:true, present:false`(参照先ファイルが
  `materials/` に無い)を検出し、① 参照を消す `remove` op と、② `materials/`
  に実在する未使用ファイルへの貼り替え候補(ファイル名の類似度で上位数件。
  `config.yaml` の `materialFit.maxReplacements`)を提示する
- **M3(unused の橋渡し)**: `used:false, present:true`(一度も参照されない
  素材)を列挙し、配置候補は作らず `plan-materials <dir>` へ誘導する
  (重複実装禁止)
- **収録フォルダへ直接書かない**: 出力は `material-fit.suggested.json`
  (使い捨ての下書き。再実行のたびに上書き)と stdout レポートだけ。
  `overlays.json` 等の編集は必ず人間が `apply --patch` を経由する
- **補正値は実測からの算術のみ・LLM は使わない**: `durationSec`/`end` の
  提案値は `probe.durationSec` からの計算で一意に決まる。貼り替え候補も
  実在ファイル名の集合からの選択(存在しないパスを提案しない)
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない

```sh
node src/cli.ts materials <dir>          # 前提知覚(未実行なら先にこれ)
node src/cli.ts id-stamp <dir>           # overlays/inserts に @id が無ければ
node src/cli.ts material-fit <dir>       # 不整合を検出しパッチ下書きを書く
node src/cli.ts apply <dir> --patch material-fit.suggested.json --dry-run  # 変更内容を確認
node src/cli.ts apply <dir> --patch material-fit.suggested.json           # 適用
node src/cli.ts validate <dir>           # 適用後、整合性を再確認
```

## 演出候補の自動生成(plan-effects)

`plan-effects <dir>` は、編集済みタイムラインのどこを拡大/隠す/囲むか、
LLM に**番号+種別選択**だけさせて `overlays.json` の下書きを作るコマンド
(§docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md)。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **前提**: 先に `node src/cli.ts frames <dir> --every 10 --ocr` と
  `node src/cli.ts av <dir>` のどちらか(両方推奨)を実行しておく必要がある。
  どちらも無ければ実行方法を告げて exit 1(例外にはしない)。演出アンカーが
  0件のときも同様に告知して終了する
- **演出アンカー(演出を置ける候補)**: 3つの知覚から決定論的に組む。
  画面OCR(`frames/*.ocr.json` の各行。box が十分大きいものだけ)・
  動き(`av.probe/motion.json` の sceneScore 超のサンプル・長い静止区間)・
  発話(十分な尺の keep span ごとの意味づけ用アンカー)。**座標(rect)は
  OCR box または画面変化領域から取り、LLM は一切触らない**。rect の無い
  アンカー(発話のみ由来)は zoom/blur/annotation の対象にできない
- **番号+種別選択のみ**: LLM に渡すのはアンカー一覧
  (`#id [開始-終了] source [座標] テキスト`)だけ。LLM の応答は
  `{ "decisions": [{ "anchorId": N, "effect": "zoom"|"blur"|"annotation"|"none", "reason": "..." }] }`
  のみで、座標・時刻・色は一切書かせない。番号 → 実体の変換、存在しない
  番号の無視はすべてコード側が行う
- **annotation は box(囲み)限定**: arrow(矢印)・spotlight は v1 では
  生成しない(座標・パラメタが多く番号選択で安全に決めにくいため)
- **zoom は重ならない**: validate はズーム区間の重なりをエラーにするため、
  時間衝突する zoom は先着優先で間引く。blur/annotation の rect は出力
  解像度内へ clamp する(blur の画面外は validate エラー)
- **`overlays.json` の他フィールド保持**: `overlays[]`/`inserts`/`wipeFull`/
  `captionTracks`/`layerOrder`/`colorFilter`/`hideCaption` は既存のまま保持し、
  `zooms`/`blurs`/`annotations` の3配列だけを差し替える
- **書き込み前検査(all-or-nothing)**: 組んだ演出下書きを、書く前に
  `validate` と同じ検査(zoom 重なり・blur 画面外・annotation の型等)へ通す。
  1つでも不正なら1バイトも書かない
- **既存の zooms/blurs/annotations は `--force` 必須**(実行前に `backups/`
  へ退避)
- **承認不要・下書き扱い**: overlays の編集は承認 hash を失効させないため、
  生成しても既存の cutplan/short の承認は生きたまま。ただし人間が
  preview / frames で見て、要らなければ消す前提
- **測定の注意**: LLM 出力は非決定的なので、単発 diff で演出の質(種別選択・
  対象の妥当性)は採点できない。決定論部分(アンカー生成・rect 由来・
  zoom 重なり間引き・clamp)はテストで固定し、当否の判断は人間が
  `frames`/preview で行う

```sh
node src/cli.ts frames <dir> --every 10 --ocr   # 前提知覚(画面OCR)
node src/cli.ts av <dir>                        # 前提知覚(動き検出)
node src/cli.ts plan-effects <dir>              # overlays.json へ演出下書きを生成
node src/cli.ts validate <dir>                  # zoom 重なり・blur 画面外が無いことを確認
node src/cli.ts frames <dir> --t <演出区間の秒>  # 実際に効いて見えるか目視
```

## 演出の検品(effect-check)

`effect-check <dir>` は、`overlays.json` の `zooms`/`blurs`/`annotations` が
**座標として妥当**なだけでなく**対象を外していないか**を検品するコマンド
(§docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md)。
`plan-effects` が演出を**作る**のに対し、こちらは既存(生成/手書き問わず)の
演出を**検品する**役割で、演出そのものは一切生成しない。

- **決定論チェック(常に実行・必ず成功する)**:
  - **E4(zoom×固定px演出の相互作用)**: `blurs`/`annotations` は zoom に
    追従しない出力px固定のため、zoom と時間が重なると指す/隠す位置がずれる。
    zoom の rect が blur/annotation(box・spotlight)の rect を包含していれば
    「rect を zoom 領域いっぱいへ広げる」、包含していなければ「zoom 終端の
    後ろへずらす」補正候補を出す。arrow(rect を持たない)は常にずらす候補
  - **E5(密度ガード)**: `densityWindowSec` 秒の窓に演出(zoom+blur+annotation)
    が `maxPerWindow` 本を超えて詰まっていたら警告(`chapters.json` があれば
    章区間を見せ場とみなし、見せ場内は抑制する)。annotation の表示尺が
    `maxAnnotationSec` を超えていたら「表示尺を詰める」補正候補を出す
  - **E3(座標視覚検証・決定論の一次判定)**: テロップ(`pos` が明示された
    ものだけ。v1 では既定の下部中央フローは対象外)の推定矩形が
    blur/annotation/素材(`overlays[]` の `rect` 付き)と時間・座標の両方で
    重なっていたら `caption-overlap` 警告
- **still 撮影(E3)**: 演出ごとの表示中間の時刻を、既存の `frames` 経路
  (合成込みの見た目)で1回にまとめて撮る。`frames-serve` が起動中なら自動で
  速くなる。v1 は after(演出込み)の still のみ
- **VLM 二次確認(任意・優雅に劣化)**: `ai.routes.vision` が設定されていて
  `config.yaml` の `effectCheck.useVlm`(既定 true)かつ `--no-vlm` を付けて
  いなければ、after still を最大4枚まで vision route に見せ「この演出は
  目的(隠す/指す/見せる)を満たすか」を `ok`(true/false)+短い理由だけで
  問う。**座標・修正案は一切生成させない**(判定専用。母艦 原則4)。
  vision route が無い/`--no-vlm`/呼び出しが失敗した場合は例外を投げず
  「VLM 未実行(決定論のみ)」と明示して決定論の結果だけを返す(exit 0)
- **収録フォルダへ直接書かない**: 出力は検品結果 `effect-check.json`
  (機械可読。警告一覧・撮った still・VLM 実行有無)+ stdout の人間向け
  レポート + 補正候補があるときだけの `effect-fix.suggested.json`
  (使い捨ての `apply` パッチ下書き)。`overlays.json` 等の編集は必ず人間が
  `apply --patch` を経由する
- **補正値は決定論の算術のみ**: rect を広げる/ずらす・annotation の表示尺を
  詰めるは、すべて既存の zoom rect・区間からの計算で一意に決まる。VLM は
  判定だけで座標は書かない
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない
  (演出の時刻は元収録秒、座標は出力pxで完結し、cut 決定に依存しない)

```sh
node src/cli.ts effect-check <dir>          # 決定論チェック + (可能なら)VLM 二次確認
node src/cli.ts effect-check <dir> --no-vlm # 決定論チェックのみ(CI・vision route 未設定向け)
node src/cli.ts apply <dir> --patch effect-fix.suggested.json --dry-run  # 補正候補を確認
node src/cli.ts apply <dir> --patch effect-fix.suggested.json           # 適用
node src/cli.ts validate <dir>              # 適用後、整合性を再確認
```

## 検品を閉じる(E6: レビューイベント化 / E7: 提案ループへ戻す)

`effect-check` の検品結果は、それだけでは人間/AI が読む止まりで終わりうる。
これを既存のレビュー(GUI エディタの AI 提案レビュー)と次の `plan-effects`
再実行へ**配線する**のが E6/E7(§docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md)。
どちらも**新コマンドは無い**(既存の関数/コマンドへの追記・フラグ)。

- **E6(レビューイベント化)**: `src/lib/reviewEvents.ts` の `buildReviewEvents`
  が `effectWarnings?`(effect-check の `EffectWarning[]`)を受け取れるように
  なった。渡すと、時間帯(元収録秒)+種別(zoom/blur/annotation)が一致する
  既存の `ReviewEvent` へ警告・種別ごとの確認観点
  (zoom=見せたい所が中心か / blur=覆えているか / annotation=指す先が合うか)
  ・撮影/確認理由を追記する。一致するイベントが無ければ、その演出単独の
  `ReviewEvent` を1つ作る。補正候補(`suggestions`)がある警告は
  `effect-fix.suggested.json#@<id>` という参照が `warnings` に載る(**自動
  適用はしない**。適用は人間が `apply --patch effect-fix.suggested.json`)。
  `effectWarnings` を渡さない(undefined/空配列)ときは、この変更導入前と
  バイト等価(cut/caption/insert 等の既存イベントは一切変わらない)
- **E7(検品観点を提案ループへ戻す・opt-in)**: `plan-effects <dir> --observe`
  (または `config.yaml` の `effectReview.observe: true`)を付けると、前回の
  `effect-check.json` があればその警告件数サマリ(例: 「前回の effect-check
  で演出の警告が3件ありました(ぼかし×ズーム重なり2件・密度過多1件)。
  これは参考情報であり、必ず直すべき指示ではありません」)をプロンプトへ
  1ブロック追記し、次の演出候補生成が「前回の失敗」を踏まえられるようにする。
  **命令ではなく観測**(「必ず直せ」とは書かない・番号選択の枠は変えない)。
  `--observe` を付けない/`effectReview.observe` が既定(false)のときは、
  `effect-check.json` の有無に関わらずプロンプトは SD-E1 導入時とバイト等価
  (観測ブロックは一切追記されない)
- **`src/lib/planLoop.ts` の `withEffectObservation`**: cut の `plan --cuts-only`
  ループ(`planLoop.ts`)向けの同型 opt-in フック(観測 `warnings` 配列へ
  演出観測の1行を足す純関数)。既定では呼び出されない(観測ソースが
  演出であって cut と別ドメインのため、統合は今後の横展開課題)

```sh
node src/cli.ts effect-check <dir>                # effect-check.json を更新
node src/cli.ts plan-effects <dir> --observe --force  # 前回警告を観測して演出候補を作り直す
```

## A/V フィードバックを知る(av)

`av <dir>` は、AI が keep 後タイムラインの**動き**と**音**を機械可読に読むための
知覚コマンド。動画再生 UI は作らず、ffmpeg だけで観測を JSON に落とす。

```sh
node src/cli.ts av <dir>
node src/cli.ts av <dir> --range 10-25.5
node src/cli.ts av <dir> --short intro --sound-only
node src/cli.ts av <dir> --full-res --motion-only
```

**出力**: `av.probe/motion.json` / `av.probe/sound.json` /
`av.probe/motion.strip.png`

- `motion.json`
  - keep 後タイムライン上のフィルムストリップのタイル時刻
  - `sceneScore` の時系列
  - `freezedetect` による freeze 区間
- `sound.json`
  - mic+system ベッドの統合 LUFS / true peak / short-term LUFS 包絡
  - 無音区間
  - mic/system の window ごとの RMS とどちらが大きいか
  - BGM 区間と duck 区間(実測ではなく render props 由来の解析値)
- `motion.strip.png`
  - keep 後タイムラインを `--every` 秒ごとに並べたフィルムストリップ

**主なオプション**

- `--range <a-b>`: **出力(カット後)秒**で部分区間を切る
- `--every <sec>`: motion サンプル間隔
- `--short <name>`: `shorts.json` の対象ショートの `ranges` を使う
- `--full-res`: motion の基映像に `proxy.mp4` ではなく元収録を使う
- `--motion-only` / `--sound-only`: 片側だけ取得

**キャッシュ**

- `av.probe/` は `materials.probe/` と同じ差分更新型
- 同じ入力 key なら JSON を再利用し、ffmpeg を再実行しない

## BGM の音量/被り/単調の検出と調整提案(bgm-fit)

`bgm-fit <dir>` は、**既に置かれている** BGM(`bgm.json`)の音量/duck/フェードが
`av.probe/sound.json`(要 `av <dir>` の事前実行)の実測と合っているかを検品し、
補正案を `apply` パッチ下書き(`bgm-fit.suggested.json`)として出すコマンド
(§docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md)。`plan-bgm`(SD-B1)が
BGM の区間割り・選曲を**作る**のに対し、こちらは既存の BGM を**直す**役割で、
区間割り・選曲は一切行わない。**LLM を一切使わない決定論コマンド**(補正値は
すべて `av.probe/sound.json` の実測値からの算術)。

- **B2(無音/被り回避の音量・フェード補正。常に成功)**:
  - **speech-overlap**: `tracks.samples` を BGM の active 区間(`av` の
    `bgm.spans` から。トラックの `file` で対応付け)へ突き合わせ、`louder`
    が発話(mic)以外優勢の区間を「BGM が発話に被っている」とみなし、
    発話 RMS を `bgmFit.speechHeadroomDb` 下回るところまで `volumeDb` を
    下げる補正を出す
  - **silence-float**: `silences`(発話の無い区間)に BGM が原音量のまま
    乗っている箇所を「浮いている」とみなし、`bgmFit.silenceDuckDb` 下げる
    補正を出す
  - **loud**: `mix.integratedLufs` が `bgmFit.targetLufs` を超過していれば、
    BGM が主因という前提で全トラックへ超過分の `volumeDb` 減を出す
  - **no-fade**: 動画終端まで続くトラックに `fadeOutSec` が無ければ
    `bgmFit.minFadeSec` の付与を出す
  - **二重 duck 回避**: `av` の `bgm.duckSpans`(render が既に発話ダッキングを
    掛けている区間)を過半含む問題区間には補正を出さない(render 側で
    既に下がっているため)
  - 1トラックにつき `volumeDb` の補正は高々1本(speech-overlap →
    silence-float → loud の優先順)。v1 はトラック全体の `volumeDb` を
    下げる提案に留め、区間限定の減衰(トラック分割)は今後の拡張
- **B4(単調/fallback 検出。区間割り・選曲はしない)**: `bgm.json` が無く
  収録直下 `bgm.*` の全編1曲 fallback、または `bgm.json` が単一 file で
  総尺の `bgmFit.monotoneCoverRatio` 超を覆っているとき、章数が
  `bgmFit.minChaptersForVariety` 以上あれば「章が複数なのに BGM が単調」と
  警告し `plan-bgm <dir>` へ誘導する
- **収録フォルダへ直接書かない**: 出力は検出結果 `bgm-fit.json`(機械可読。
  findings 一覧 + 単調/fallback 判定)+ stdout の人間向けレポート + 補正候補が
  あるときだけの `bgm-fit.suggested.json`(使い捨ての `apply` パッチ下書き)。
  `bgm.json` の編集は必ず人間が `apply --patch` を経由する
- **bgm トラックの `@id` は補正が出るときだけ必要**: id の無いトラックに
  実際に B2 補正(volumeDb/fadeOutSec の set)が出る場合に限り「先に
  `id-stamp <dir>`」と告げて exit 1(補正 op の宛先に `@id` が要るため)。
  B4 の単調誘導だけ・検出なしのときは id 不要で通し exit 0(`plan-bgm` の
  出力は id 無しなので、この緩和で通常鎖 `plan-bgm` → `av` → `bgm-fit` が
  止まらない)
- **av.probe の欠如は優雅に拒否**: `av.probe/sound.json` が無ければ「先に
  `av <dir>`」と告げて exit 1
- **render の duck 実装は変えない**: `src/lib/duck.ts` は無改修。本コマンドは
  「配置意図」を `volumeDb`/`fadeOutSec` の補正案として `bgm.json` へ提案する
  だけで、render 時の動的ダッキングはそのまま効く
- **cut / 承認不変**: `cutplan.json` / `approvals.json` は読まない・書かない

```sh
node src/cli.ts bgm-fit <dir>       # 検出し apply パッチ下書きを書く
node src/cli.ts apply <dir> --patch bgm-fit.suggested.json --dry-run  # 変更内容を確認
node src/cli.ts apply <dir> --patch bgm-fit.suggested.json           # 適用
node src/cli.ts validate <dir>      # 適用後、整合性を再確認
```

## スタイルプロファイル抽出(style-profile)

`node src/cli.ts style-profile --from <path> [--from <path> ...] [--name <名前>]` は、
任意の動画/収録パスから**スタイルプロファイル**(テンポ・字幕密度/位置・
ラウドネス・構成の観測統計)を抽出し、channel(最初の `--from` の親ディレクトリ)の
`style.probe/<名前>.json`(省略時 `default.json`)へ書くコマンド
(§docs/plans/2026-07-12-sd-t0-style-profile-design.md)。他コマンドと違い
位置引数 `<dir>` を取らず、`--from` 主導で入力を集める。

- 入力の種類は `--from` のパスごとに自動判定する:
  - **収録プロジェクト**(`manifest.json` + `cutplan.json` があるフォルダ)=
    `own-project`。`describe --json` と同じ射影から観測統計を作り、
    `av.probe/sound.json`(あれば)から音響統計、`plan.raw.txt`(あれば)から
    AI 提案→人間仕上げの**補正デルタ**(cut/章/タイトル/概要欄の件数比較)を
    追加で持てる
  - **素の動画ファイル/plain フォルダ** = `bare-video`。ffprobe レベル(尺・
    解像度・fps・音声有無)の観測統計のみ(+同じ場所に既に `av.probe/` が
    あればそれも読む)。テロップ・構成・補正デルタは持てない(完成品に
    「何を切ったか」は残らないため。能力境界であって欠陥ではない)
- **決定論のみ**(LLM/VLM は呼ばない)。**収録フォルダの編集ファイルは
  1バイトも書かない**。書くのは channel 直下の `style.probe/<名前>.json` だけ
- `av <dir>` を先に走らせておくと音の統計(LUFS・無音・BGM 有無)が加わる
  (無くても動くが、その section の confidence が 0 になり警告が出る)
- `--from` 複数で1プロファイルへ集約する(shots/captions は配列プーリング=
  平均の平均にしない、比率は尺で加重)。**作風が違う動画は混ぜず `--name` で
  分ける**(同じ `--name` に入れた入力は同一作風という前提で畳む)
- 各集約値(cutDensity/captions/audio/structure/correctionDelta)は
  `confidence`(0..1)を持つ。入力が1本(cold-start)だと意図的に低く出る
  (「1本の癖を全体の型と誤認しない」ための可視化)

```sh
node src/cli.ts av <dir>                                   # 先に音の統計を用意(任意)
node src/cli.ts style-profile --from <dir>                  # style.probe/default.json
node src/cli.ts style-profile --from <dir1> --from <dir2> --name multi  # 複数集約
node src/cli.ts style-profile --from <動画ファイル> --name bare-test    # bare-video
```

## profile からの逸脱検出(style-check)

`node src/cli.ts style-check <dir> [--profile <名前>]` は、この収録の**現在の編集
(候補)**の観測統計が `style-profile` で抽出した**学習分散帯からどれだけ逸脱
しているか**を決定論で測り、warn/info(**常に exit 0**)で報告するコマンド
(§docs/plans/2026-07-12-sd-t1-style-check-design.md)。母艦の言う「J(主観)次元が
プロファイル導入で D(決定論)へ落ちる」の測定面そのもの(SD-T1)で、`style-profile`
(プロファイルを**作る**側)に対し、こちらは既存の編集をそこへ**照らす**側。

- **要 `style-profile --from <dir>` の事前実行**: channel(`<dir>` の親)の
  `style.probe/<名前>.json`(省略時 `default`)を reference として読む。無ければ
  「先に `style-profile --from <dir>`」と告げて exit 1(前提エラーのみ exit 1。
  逸脱報告自体は常に exit 0)
- **候補は `style-profile` と同じ集約経路で畳む**: `describeJson` の射影を
  `observeOwnProject` → `mergeObservations(["_candidate"])` に通し、reference と
  同じ形の `StyleProfile` にしてから距離を測る(統計・ラベル写像の二重実装ゼロ)。
  `av.probe/sound.json` があれば音の統計も混じる(無くても動く。audio section が
  丸ごと skipped/info に優雅に劣化する=「先に `av <dir>`」を促す)
- **v1 は cut/caption/audio に閉じる**(profile v1 scope。演出密度・BGM 切替
  cadence・構成は profile が値を持たない/v1 名指しスコープ外のため defer。
  effect-check の密度ガード(config 固定閾値)とは別物 — 学習値化は profile v2 待ち)
- **二層帯(inner/outer)モデル**: 各 metric の学習帯を「広げる前(inner)」と
  「参照 section の `confidence` で広げた後(outer)」の二重で持つ。inner 内側=
  finding なし、inner の外・outer の内=`borderline`(info、confidence の不確実性
  マージンとして許容)、outer の外=`deviation`(warn、不確実性マージンを超えた
  実逸脱)。confidence が低い(cold-start・N=1 など)ほど outer が広がり、cold-start
  特有の過剰 warn を防ぐ。ペースの学習帯は full 分布ではなく `style-profile` が
  持つ `shotSecP10`/`shotSecP90` の帯を使う(KS 距離は profile v2 の拡張点)
  - relative モードの metric(`sceneChangesPerMin`/`avgDisplaySec` 等)は、
    参照値がほぼ0だと相対トレランス(±30%)が幅0の点に縮退してしまうため、
    その場合は帯を作らず `skipped`(info)に落ちる(0 基準では相対距離を
    測れないという能力境界の明示。偽の deviation/warn を防ぐ)
- **カテゴリ/boolean metric**(`cutAggressiveness`/`density`/`positionHint`/
  `bgmLikely`)はラベル一致で判定。どちらかが `"mixed"` なら吸収(finding なし)、
  不一致は参照 confidence が閾値以上なら `mismatch`/warn、未満なら `mismatch`/info
- **収録フォルダの編集ファイルは1バイトも書かない**。書くのは
  `<dir>/style-check.json`(機械可読。findings 一覧+counts)だけ
- **能力境界を偽らない**: プロファイルが測れるのは *rate/placement 統計*
  (ペースが速すぎる/遅すぎる・caption が薄い/位置が違う・ラウドネスがずれる)
  までで、「この重複テイクの綺麗な方を選べたか」のような *instance semantics*
  は測れない(残る真の J)

```sh
node src/cli.ts av <dir>                       # 先に音の統計を用意(任意。無くても audio は skipped で優雅に劣化)
node src/cli.ts style-profile --from <dir>      # style.probe/default.json を用意
node src/cli.ts style-check <dir>               # 候補を profile に照らして距離を測る
node src/cli.ts style-check <dir> --profile multi  # 別名の profile に照らす
```

## 承認(approve/unapprove)

**承認の実体は `approved` という boolean ではなく `approvals.json`**
(収録フォルダ直下の別ファイル。触らない第3カテゴリ)。`render` はこの
ファイルの承認レコードだけを見る **strict なゲート**で、`cutplan.json` /
`shorts.json` の `approved: true` を書くだけでは通らない。

```jsonc
// approvals.json(自動生成。人間や AI が直接書かない)
{
  "version": 1,
  "cutplan": { "hash": "sha256:…", "approvedAt": "2026-07-07T…", "by": "cli" },
  "shorts": {
    "highlight-1": { "hash": "sha256:…", "approvedAt": "2026-07-07T…", "by": "gui" }
  }
}
```

- `hash` は **cutplan(または当該ショート)の keep 集合**(`mergeIntervals`
  後・ms 丸め)から決定論で計算した sha256。`reason` や cut セグメント、
  境界を保ったままの分割(GUI の分割編集)は keep 集合を変えないので
  hash は変わらない。overlays / transcript / bgm の編集も承認スコープ外
  (承認は「cut の出来」だけに束縛される、というのが今日までの運用と同じ
  意味になるよう設計されている)
- **keep 集合そのものが変わる編集をすると hash が不一致になり、
  承認は自動失効する**。古い内容のまま render されることはない
- 承認・取消は専用コマンドで行う:
  ```sh
  node src/cli.ts approve <dir>                    # 本編を承認
  node src/cli.ts approve <dir> --short <name>      # 指定ショートを承認
  node src/cli.ts approve <dir> --yes               # 非対話環境でも承認する(意図的バイパス)
  node src/cli.ts unapprove <dir> [--short <name>]  # 承認を取り消す
  ```
  `approve` はまず `validate` を通し(エラーがあれば承認しない)、
  端末が対話環境(TTY)なら preview 確認の y/N プロンプトを挟む。
  **非対話環境(Bash からの実行・子エージェント等)では `--yes` が無いと
  拒否される**——「承認して」と頼まれても AI が反射的に承認を通すことは
  ない。承認できたら `approvals.json` にレコードを書き、
  `cutplan.approved`(または該当ショートの `approved`)を `true` に同期する
  (boolean は表示用に揃えるだけで、判定には使わない)
- GUI エディタのチェックボックス+保存でも同じレコードが作られる
  (`by: "gui"`)。UI 側の操作感は変わらない
- 過去(この機能導入前)に `approved: true` で承認済みだったフォルダは、
  `approvals.json` を持たないため次の `render` で拒否される。
  `node src/cli.ts approve <dir>` を1回実行すれば復旧する(データ破壊なし・
  冪等)。`validate` はこの状態(`approved: true` なのにレコードが無い/
  陳腐化している)を警告するので、render を待たずに気づける

**AI 向けの注意**: `approvals.json` は自分で作成・編集しない。承認は
`approve` コマンドか人間の GUI 操作でのみ行う(CLAUDE.md 参照)。

## チャンネル rules(rules.md)と learn

`.cursor/rules` の動画版。テロップ様式・トーン/声色・禁止語・ペーシング・
章の付け方・タイトルの型など、**チャンネルで毎回守りたい恒久的な方針**を
自由 Markdown の `rules.md` に書いておくと、`plan` / `plan --cuts-only` /
`remeta` / `plan-shorts` / `plan-materials` / `plan-effects` / `plan-bgm` の LLM プロンプトに自動で注入される。

- `brief.md` = **今回の中身**(見せ場・狙い・絶対に切らない内容。収録ごと)
- `rules.md` = **毎回守る型**(恒久的な様式。チャンネル + 収録固有)

### 置き場所

- **チャンネル共通**: 収録フォルダの**親ディレクトリ**に `rules.md` を置く
  (`~/Movies/cutflow/2026-07-02-xxx/` なら `~/Movies/cutflow/rules.md`)。
  そのディレクトリ配下の全収録に効く
- **この収録だけ**: 収録フォルダ直下に `rules.md` を置く(この回だけの
  上書き・追加)。両方あれば連結され、**収録固有が共通ルールより優先**される
- rules ファイルが無ければプロンプトは注入前と完全に同じ(既定挙動は不変)

```markdown
# このチャンネルの編集ルール

## トーン・声色
- ですます調。初学者に語りかける柔らかさ。煽り・過度な誇張はしない。

## テロップ様式
- 専門用語は初出でカッコ書きの短い補足を付ける(例: 「ホットリロード(保存で即反映)」)。

## 禁止語・言い換え
- 「めっちゃ」「ヤバい」は使わない → 「かなり」「大きく」に。

## ペーシング・カット
- 沈黙の“ため”は1秒までは残す(考えている間も味)。切りすぎない。
```

**注意**: `~/Movies/cutflow/` 直下に複数チャンネルを平置きすると
`rules.md` は全チャンネルに効いてしまう。チャンネルを分けたい場合は
サブフォルダを切って(例: `~/Movies/cutflow/series-a/2026-.../`)、その
サブフォルダ直下に `rules.md` を置く運用にする。

### 修正からの学習(`learn <dir>`)

「人間が LLM の生成物をどう直したか」を材料に、次回のための rules 追記案を
LLM に下書きさせるコマンド:

```sh
node src/cli.ts learn <dir>
```

- 入力: `plan.raw.txt`(AI が最初に出した案)・`describe(dir)`(人間が仕上げた
  タイムライン)・`meta.json`(人間が仕上げたタイトル・概要欄)・既存の
  channel `rules.md`(あれば)。すべて読むだけ
- 出力: `<dir>/rules.suggested.md` に追記案の下書きを書く。**channel の
  `rules.md` には一切書き込まない**(「AI は自分で承認しない」原則。採用は
  人間が内容を読んで手で `rules.md` に転記する)
- `rules.suggested.md` は使い捨ての下書き。既存があれば黙って上書きされる
  (次の `learn` 実行で消える前提。採用したい項目は早めに `rules.md` へ転記する)
- `plan.raw.txt` が無い(まだ `plan` / `run` を実行していない)ときは、
  先に実行するよう促してエラー終了する

## plan の知覚(config.yaml の plan.perception。標準 config は audio/ocr を明示オン)

`plan` / `plan --cuts-only` / `remeta` は `config.yaml` の `plan.perception`
に従って、発話テキストに加えて detect の既存情報や画面 OCR を LLM 入力へ添えられる。
**現行の標準 `config.yaml` は `audio: true` / `ocr: true` を明示**している。
一方、古い config や最小 config で `plan.perception` 自体が無い場合は互換のため
コード fallback が全オフのままで、`plan` / `remeta` 実行時に CLI が警告する。
この未指定ケースでは LLM 入力・`plan.raw.txt` は導入前と1バイトも変わらない。

```yaml
plan:
  perception:
    audio: true        # 無音・間の注記(決定論・追加依存なし。まずこれから)
    ocr: true          # 画面OCRテキスト(macOS/Apple Vision 必要・区間数ぶん重い)
    ocrMaxSegments: 40
    ocrMaxLines: 6
    systemSpeech: false # システム音声の発話(要 whisper.systemAudio。下記参照)
```

- `audio`: 各区間の `尺` / `直前カット`(直前に落ちた素材秒)/ `内無音`(区間内に
  残った無音の合計秒)を秒で記述文にして添える。すべて `cuts.auto.json`(detect
  の結果)と番号区間だけから計算する純関数で、**新規の音量計測はしない**。
  決定論・追加依存なしなので、まず有効にするならこちら
- `ocr`: 各区間の代表フレーム(元収録の中点)を `frames --ocr` と同じ
  Apple Vision OCR にかけ、画面内の文字(コード・ターミナル・エラー文)を
  記述文にして添える。macOS + Apple Vision が必要で、無い環境では警告のうえ
  OCR 部分を省いて続行する(plan 自体は止まらない)。区間数ぶんの ffmpeg
  クロップ+Vision が走るため `ocrMaxSegments`(既定40。超過時は尺の長い区間を
  優先)・`ocrMaxLines`(区間ごとにプロンプトへ載せる行数の上限。既定6)で
  コストを抑える
- `plan` / `remeta` / `run` は実行前に今回の知覚状態を必ず表示する。
  例: `plan 知覚: audio=on / ocr=on(max 40 segments, 6 lines) / systemSpeech=off`
- `plan.perception` 未指定時は
  `警告: plan.perception が config.yaml にありません。...` を先に出し、
  `audio=off / ocr=off / systemSpeech=off` と表示して継続する
- どちらも LLM に算術はさせない(値はこちらで丸めて記述文として渡し、番号選択
  だけをさせる)。`plan-shorts` はこの機能の対象外(触らない)
- 画像(スクリーンショット)そのものを LLM に渡すマルチモーダル入力は
  **やらない**(既定 provider の claude-code では画像添付が難しく、provider 非依存の
  `complete` 設計に反するため。開発系チャンネルは画面の主役が文字なので OCR で
  代替する)
- `systemSpeech`: システム音声(デモ音・再生動画・TTS)の発話を各区間へ添える。
  `whisper.systemAudio: true`(下記)で `transcript.system.json` を先に作っておく
  必要があり、無ければ自動で省略(劣化)する

## plan のスタイル注入(config.yaml の plan.styleProfile。既定オフ)

`plan` / `plan --cuts-only` は、`style-profile` が抽出した style profile
(`style.probe/<name>.json`)を **候補選択のソフトな prior** として LLM の
プロンプトへ添えられる(§docs/plans/2026-07-12-sd-t4-style-injection-design.md)。
既定オフで、オフのとき LLM 入力・`plan.raw.txt` は導入前と1バイトも変わらない
(`plan.perception` と同じ不変条件)。

```yaml
plan:
  styleProfile:
    enabled: true    # 既定 false(バイト等価)
    profile: default # 読む profile 名(style.probe/<profile>.json)。既定 "default"
```

- 有効化には先に `node src/cli.ts style-profile --from <dir>` で
  `style.probe/<name>.json`(このプロジェクトの**親ディレクトリ=channel**直下)を
  作っておく必要がある。無い/壊れている場合は警告して注入をスキップするだけで
  `plan` は止まらない(前提エラーにしない。§優雅な劣化)
- 注入されるのは **cut / caption / structure の3面だけ**(音量・章タイムライン
  そのものは載せない)。それぞれ「目標平均ショット長・積極度・学習帯」
  「字幕カバレッジ・密度・位置・強調スタイル」「冒頭フック秒・CTA有無」を
  日本語の圧縮 summary(raw JSON ではない)として1ブロックにまとめる
- 各行に `[prior:強め/中程度/弱い(cold-start・参考程度)]` を付け、profile の
  confidence(観測数が少ないほど低い)をそのまま LLM に伝える。承認済み収録
  1本だけの cold-start(N=1)では常に「弱い」になり、LLM に「参考程度」と
  明示する
- ブロックの先頭に「brief.md(今回の意図)に劣後する参考情報」である旨と
  「番号選択の重み付けにだけ使い、精密な数値やタイムスタンプは生成しない」旨を
  明記する。**番号選択方式(`cuts: [{id, reason}]`)は変わらない**。LLM に
  座標や秒数を新たに書かせることは一切ない
- プロンプト内の配置順は `brief` → `rules` → `perception` → `styleProfile`
  で、style prior は最も弱い・最後尾の参考情報として置かれる(brief/rules が
  常に優先)
- `plan` 実行時に知覚状態と同様、注入状態を必ず表示する。
  例: `plan スタイル注入: on(profile=default)` / 未設定時は
  `警告: plan.styleProfile が config.yaml にありません。スタイル注入はオフです。`
  に続けて `plan スタイル注入: off`
- v1 の注入先は **plan / plan --cuts-only の cut 判断プロンプトのみ**。
  `remeta`(章立て・タイトル・概要欄)・`plan-shorts` / `plan-materials` /
  `plan-effects` / `plan-bgm` は対象外(v2 拡張点として明示 defer)。
  `plan --cuts-only` の観測ループ(`plan.loop`)を使う場合も、再調整の
  critique 反復にはこのブロックを渡さない(生成ターンにだけ渡す)

## cutplan は元収録の全時間を keep/cut で連続被覆する(無音も戻せる)

`cutplan.segments` は元収録 `[0, 全長]` を **keep と cut で隙間なく覆う**。
`detect` が無音から作る「残す候補区間」は keep か(LLM がカットと判断すれば)
cut になり、**候補にすらならなかった無音区間も `action:"cut"` として記録される**
(reason は `config.yaml` の `detect.silenceCutReason`、既定「無音」)。

そのため切られた区間は**すべて**エディタのタイムライン(映像トラック)に
「カットされた区間」の印として現れ、選択して**「この区間を動画に戻す」**で
復元できる(隣の keep と重なる分だけ縮めて戻り、戻した区間は前後の keep と
連続再生される)。発話の語尾が無音判定で切れていても、その部分は無音 cut として
残っているので取り戻せる。**印が出るのは `action:"cut"` の区間だけ**なので、
無音を cut として明示記録することが「全ての映像を戻せる状態」の前提になる。

- 無音 cut を足しても **keep の start/end は変わらない**ので、承認レコード
  (`approvals.json` の keep 集合ハッシュ)は失効しない(承認スコープは cut 決定
  =keep 集合のみ)。無音 cut にも `@id`(`seg_*`)が採番され、他の segment と
  同じく apply の宛先にできる
- この挙動は `detect` → `plan`(単発 / `--cuts-only` / 観測ループ / harness)の
  全経路で自動。旧来の穴あき cutplan(本機能の導入前に生成したもの)を全被覆へ
  移すには `plan --cuts-only` で作り直す(cut 判断が変わりうる点に注意)

## plan の候補格子を語境界で細分化する(config.yaml の candidates。既定オフ)

`plan` / `plan --cuts-only` は、`detect` が無音から作った「残す候補区間」に
番号を振って LLM に渡し、LLM は番号単位で cut/keep を選ぶ(番号選択方式。
ハルシネーション対策は `docs/decisions.md` 2026-07-02 参照)。`config.yaml` の
`candidates.enabled: true`(既定 false)にすると、この候補格子を **語タイムスタンプ
(`transcript.json` の `words[]`。要 `whisper.wordTimestamps: true`、既定オン)由来の
語境界でも細分化**し、無音検出だけでは拾えない微小ポーズ・フィラーの境界を
候補に足す。**番号選択方式そのものは変わらない**(LLM は今までどおり
`cuts: [{id, reason}]` を返すだけで、時刻を書いたり apply したりはしない)。

- `splitOnlyLongerThanSec`(既定 6): これより長い keep だけを分割対象にする
- `minSplitGapSec`(既定 0.3): 語間ギャップがこの秒以上なら分割点候補にする
  (通常 `detect.minSilenceSec` 未満の間を拾う)
- `minCandidateSec`(既定 0.5): 分割後の各断片の最小尺。これ未満になる分割は
  間引かれる(隣へ併合)
- `fillers`(既定 `["えー","えっと","あの","あのー","まあ","その","なんか"]`):
  フィラー語の前後を分割点にし、フィラー単体を候補として切り出せるようにする
- 分割点は必ず語間ギャップの中点に置かれる(カット境界が語の途中に落ちない)
- 候補のテキストは、その候補内に**実際に残る語**(語の中点が候補区間に入るもの)
  だけを連結する。既存の「重なる whisper チャンクの全文」方式(境界をまたぐと
  実際には残らない語が混ざる)より正確
- **すべての sub-candidate を keep したままなら最終出力は分割前と完全に同一**
  (分割はタイル状=隙間なく元 keep を覆うだけで、隣接する同速 keep は
  describe/render 側で自動的に繋がる)。`enabled` が出力を変えるのは LLM が
  実際に sub-candidate を cut したときだけ
- words を持たない収録(`whisper.wordTimestamps` 無効時に撮った素材等)では
  分割点が作れず候補は分割されない(例外を投げず、実質 disabled 相当に劣化)
- `enabled: false`(既定)のときは候補格子・LLM 入力とも導入前とバイト等価
- `remeta` / `plan-shorts` は対象外(触らない)

## plan --cuts-only の観測ループ(config.yaml の plan.loop。既定オフ)

`plan --cuts-only` だけは opt-in で、カット判断を「生成 → describe/assert による
観測 → LLM への再調整依頼」の有限反復にできる。`maxIterations` が未指定・0・1
のときは従来どおり1ショットで、`plan.loop.json` も書かない。

```yaml
plan:
  loop:
    maxIterations: 3              # 2以上で有効。生成1回 + 再調整を最大2回
    targetOutDurationSec: 300     # 任意。outDuration <= 300 を内部期待値に足す
    stopWhenAssertionsPass: true  # assertions.json + 目標尺が満たされたら停止
```

- 対象は `plan --cuts-only` のみ。通常の `plan`、`remeta`、`plan-shorts` は従来どおり
  1ショット
- 観測は `describe --json` 相当の構造射影と `assertions.json` の Tier 1 構造評価だけを
  使う。OCR や実 A/V の重い観測はこのループには接続しない
- ループ有効時は各反復の候補 `cutplan.json` を書いて観測し、最終応答を
  `plan.raw.txt`、全履歴を `plan.loop.json` に残す。`cutplan.approved` は常に
  `false` で、`approvals.json` は触らない
- 停止条件は `maxIterations` 到達、期待値の fail/error が0、直前と同じ cut 集合の
  3つ。どれも決定論的に判定される

## plan のエージェント化(config.yaml の plan.harness。既定オフ・H1/H2)

`plan --cuts-only` だけは opt-in で、カット判断を「事前計算した知覚をプロンプトへ
焼き込む push 型・単発 completion」から、判断 LLM が read-only の tool を自分で
引きながら生成する「pull 型知覚 + 検証ループ主体」のエージェントに切り替えられる。

```yaml
plan:
  harness:
    agentic: true      # 既定 false。要 ai の structured route が anthropic 等
                        # completeAgentic 対応アダプタ(非対応なら警告のうえ
                        # 従来の単発/pushループ経路へ自動フォールバック)
    maxToolCalls: 16    # 1生成ターンあたりの tool 呼び出し上限(コスト/レイテンシの天井)
    tools:
      frames: true      # 迷った候補だけ最終合成の実画像を見る(get_frames)
      av: true          # 出力レンジの motion/sound を読む(probe_av)
      materials: true   # 素材(B-roll)のメタを読む(probe_materials)
      ocr: true         # 候補の画面テキストを OCR で読む(ocr_screen)
```

- 対象は `plan --cuts-only` のみ。通常の `plan`、`remeta`、`plan-shorts` は従来どおり
  1ショット(触らない)
- LLM が握れるのは read-only の知覚 tool(`describe_timeline` / `get_frames` /
  `probe_av` / `probe_materials` / `ocr_screen`)と検証 tool(`set_cuts` /
  `run_assert`)の7種のみ。`describe_timeline`/`set_cuts`/`run_assert` は常時
  有効で、`plan.harness.tools` で個別に切れるのは `frames`/`av`/`materials`/
  `ocr` の4つだけ
- **最終出力は今までと同じ番号選択(`cuts:[{id,reason}]`)**。`set_cuts` は
  候補 id 配列しか受理せず、存在しない id は拒否されて書込みが起きない
  (ハルシネーション耐性・R0(候補内部を割らない)は不変)
- `plan.harness.agentic: true` でも `plan.loop.maxIterations` が2未満なら、
  agentic の検証往復が最低1回の再調整を持てるよう内部で2へ昇格する
  (プロンプト・cutplan は harness off のときと無関係に決まる)
- tool-use 非対応のアダプタ(anthropic 以外)や実行中の回復不能なエラーは、
  警告のうえ tool 無しの単発経路へ自動フォールバックする(例外で `plan` 全体を
  落とさない・`cutplan.json` は必ず生成される)
- 各反復の tool 往復(引数・結果は生値ではなく短いダイジェストのみ)は
  `plan.loop.json` の該当 iteration に `agenticTrace` として残る(中間生成物・
  手編集対象外)
- `plan.harness` を省略、または `agentic: false`(既定)のときは、生成
  プロンプト・`cutplan.json` は導入前と**バイト等価**

### 候補内部の語境界分割(config.yaml の plan.harness.applySplit。既定オフ・H6)

`plan.harness.agentic: true` の**内側**でさらに opt-in すると、判断 LLM は候補丸ごとの
keep/cut(番号選択)に加えて、**1つの候補の内部を語境界で割って一部だけを cut** にできる
(SD1〜SD4 が保存してきた「候補は分割しない」という壁=R0 を初めて直接崩す施策)。

```yaml
plan:
  harness:
    agentic: true
    applySplit: true   # 既定 false。要 agentic:true + whisper.wordTimestamps:true
    maxSplits: 4        # 1ターンの分割上限(確信区間のみ=全面移行はしない)
```

- **LLM は時刻を一切生成しない。** 新しい read tool `list_words {id}` が候補内の語を
  1始まり index 付きで返し、write tool `split_candidate {id, cutWordRanges:[{i,j,reason}], ...}`
  で「語 i〜j(両端含む)の sub-span を cut にする」と指す。境界時刻は必ず
  `transcript.words` の語境界(gap 中点。SD2/C1 と同じ規約)へスナップされる。
  存在しない語 index・逆順・語タイムスタンプの無い候補は機械的に**拒否**される
  (番号選択と同型のハルシネーション耐性を語粒度で維持)
- **書込みゲートは `validate`+`assert`。** `split_candidate` は分割後の試作 cutplan を
  一度 `cutplan.json` へ書き、`validate(dir)` と `assert(dir)` を走らせる。どちらかに
  error があれば**直前の内容へロールバック**し(部分書き込みは残らない)、LLM へ却下理由を
  返す。番号選択が担っていた「候補格子=安全網」を `apply`+検査へ置き換える(母艦 D1)
- **確信区間だけ・有界。** `maxSplits`(既定4)で1ターンの分割数を上限し、各
  sub-segment は `candidates.minCandidateSec`(既定 0.5 秒)未満になる分割は拒否される
- `set_cuts`(候補id単位)は引き続き残り、置き換えられない。最終 cutplan は
  「候補選択(`buildCutplan`)→確定済み分割の適用(`applyCandidateSplits`)」の2段で
  組み立てられ、候補を後から `set_cuts` で丸ごと cut にすると、その候補に対する
  分割は自然に無意味化する
- **候補内部分割は keep 集合を変えるので、既存の承認(`approvals.json`)は
  hash 不一致で自動失効する**(正しい挙動。人間の再承認待ちになる)
- 分割の試行(候補id・語 range・採否・検査結果ダイジェスト。生の args は含まない)は
  `plan.loop.json` の該当 iteration に `splitOps` として残る(中間生成物)
- `plan.harness.applySplit` を省略、または `false`(既定)のときは、tool セット・
  cutplan は `applySplit` 導入前(SD4)と**バイト等価**

## plan の編集モード(config.yaml の plan.editMode。既定 balanced)

`plan` / `plan --cuts-only`(生成・再調整の両方)は、プロンプトの
「カットの判断基準」の最後の1行を編集モードで切り替える。3値:

- `safe`: 「迷ったら残す。過剰カットより冗長の方がまし」(X4 導入前の固定文と
  **バイト等価**。回帰基準線の再現に使う)
- `balanced`(**既定**): 明確な冗長・言い直し・脱線は積極的に切ってテンポを作る。
  見せ場と説明の要点は必ず残す。判断がつかない中間区間は残す
- `aggressive`: 冗長・重複・長い沈黙・脱線はためらわず切る。テンポ最優先。
  見せ場だけは必ず残し、それ以外は「残す理由があるか」で判断する

```yaml
plan:
  editMode: balanced   # safe / balanced(既定) / aggressive
```

- 優先順位: `brief.md` のマーカー行 > `rules.md` のマーカー行 > `config.yaml`
  の `plan.editMode` > 既定(balanced)。マーカー行の書式は
  `編集モード: aggressive` または `edit-mode: safe`(前後空白可・大小文字不問)。
  同じファイル内に複数あれば最後の一致が勝つ
- `config.yaml` に未対応の値(`safe`/`balanced`/`aggressive` 以外)が来ても
  例外は投げず、警告のうえ既定(balanced)にフォールバックする
- 効くのは「カットの判断基準」の最後の1行だけ。言い直し/脱線/エラーの3行や
  章立て・タイトル・概要欄の指示、brief/rules 本文は不変
- `plan.loop.targetOutDurationSec` が設定されていれば(ループが無効でも)、
  モード行の直後に「目標の出力尺は約 N 秒。冗長を削ってこの尺に近づける」の
  1行が単発 `plan` のプロンプトにも足される。未設定なら何も足されない
- `remeta` / `plan-shorts` は対象外(cut 判断ではないので触らない)

## システム音声の文字起こし・keep 内の間(AI の耳の強化。既定オフ)

マイク音声(あなたの声)は `transcript.json` に描画用テロップとして起こされるが、
最終出力に mix される**システム音声**(デモアプリの音・再生した動画・TTS の
読み上げ)は従来 AI から不可視だった。これを**知覚専用**に文字起こしできる。

```yaml
whisper:
  systemAudio: false  # true でシステム音声(ingest.systemTrack)を第2トラックとして
                      # 文字起こしし transcript.system.json を書く
describe:
  pauses: false       # keep 内に残った無音(間)の位置と長さを describe に出す
  pauseMax: 3         # 1 keep あたりに出す間の件数上限
  pauseMinSec: 0.6    # これ以上の長さの間だけ出す(秒)
```

- **システム音声の文字起こし(`whisper.systemAudio`)**: 収録にシステム音声トラック
  (`ingest.systemTrack`)があるとき、`ingest` が `audio/system.wav` を抽出し、
  `transcribe` が第2回 whisper で `transcript.system.json`(`speaker: "system"`)を
  書く。これは**描画されない・編集されない・`@id`/承認/apply の対象外の知覚専用
  生成物**で、`transcript.json`(テロップの描画契約)には混ざらない。`describe`
  (散文は `[システム音声]「…」`、`--json` は `systemAudio` キー)と、`plan` の
  `plan.perception.systemSpeech` で読める。既定 false のとき出力は一切変わらない
  (収録に system トラックが無ければ true でも自動で無視)。
- **話者分離について(正直な宣言)**: CutFlow の「話者分離」は**収録トラック起源の
  音源分離**(マイク=あなた / システム=アプリ・デモ・TTS)であって、1本の音声波形
  から複数の人間の声を聞き分ける**音響的 diarization ではない**。OBS の2トラック
  収録では声とアプリ音が物理的に別トラックに録れているため、トラックを分けて
  文字起こしするだけで実用上の分離になる。1マイクに複数人が乗る収録の分離は
  重い ML 依存(pyannote 等)を招くため**やらない**(ローカル・決定論・ソロ保守の
  方針)。
- **keep 内の間(`describe.pauses`)**: `plan.perception.audio` が区間内無音の
  **合計秒**を渡すのに対し、これは残した keep の**どこに何秒**の間があるかを
  `describe`(散文/`--json`)に出す(「ここを詰める/カットを足す」判断の材料)。
  `cuts.auto.json` の無音区間から算出する純関数で**新規計測はしない**。既定 false。

## ショート動画(shorts.json)

本編とは別に、収録の一部を縦動画(YouTube ショート等)として切り出せる。
収録フォルダに `shorts.json` を書く:

```jsonc
{
  "shorts": [
    {
      "name": "hook-mistake",          // 出力: shorts/hook-mistake.mp4
      "profile": "vertical",           // 省略時は camera 有り→"vertical"、plain→"vertical-screen"
      "approved": false,               // 承認意図の表示(render --short の実ゲートは approvals.json)
      "ranges": [                      // 元収録の秒。このショート専用の keep 集合
        { "start": 120.0, "end": 158.0 }
      ],
      "captionTracks": [               // 縦用テロップ位置/スタイルの上書き(任意)
        { "track": 1, "y": 1600, "style": { "fontSizePx": 92 } }
      ]
    }
  ]
}
```

- `ranges` は複数指定でき、飛び区間をまとめて1本にできる(フィラーを
  飛ばしたいときはレンジを分割する)。**本編 `cutplan.json` の keep とは
  独立**(本編でカットした素材もショートに含められる。交差判定はしない)
- `profile` は組み込みレイアウトから選ぶ: `vertical`(camera上+screen下
  スタック)/ `vertical-screen`(画面だけを縦に contain。下は字幕帯の黒帯)/
  `vertical-cover`(camera全画面)/ `default`(横・本編と同じワイプ経路)。
  実体は `src/lib/profile.ts` の組み込み定数で、**config.yaml には追加しない**
  (閉じたプリセット。設定爆発の回避)。**省略時の既定**は収録に camera が
  あるか(`manifest.layout: "obs-canvas"` かつ `cameraRegion` あり)で自動的に
  決まる: camera 有り→`vertical`、通常動画(plain)→`vertical-screen`
  - 通常動画(`manifest.layout: "plain"`。カメラの無い収録)では `vertical`
    (画面+カメラの2段構成)は使えない(`validate` がエラーにする)。
    `vertical-screen`(画面だけを縦の枠へ contain。16:9 の画面録画でも左右
    上下を切らない。既定)/ `vertical-cover`(収録全体を縦へ cover。元から
    縦のスマホ動画なら綺麗に決まるが、16:9 画面録画では両端が切れる)/
    `default` のいずれかを使う。plain の「カメラ」は収録全体=画面として
    解決される
- `captionTracks` は `overlays.json` と同じ形式・解決順(セグメント個別 →
  トラック標準 → 既定)。テロップの文言・タイミング自体は `transcript.json`
  を流用する(ショート専用のテロップファイルは無い)

書いたら validate → 承認 → 書き出しの順:

```sh
node src/cli.ts validate <dir>                        # name の重複・ranges・座標を検査
node src/cli.ts approve <dir> --short hook-mistake     # 縦動画を確認してから承認(承認(approve/unapprove)参照)
node src/cli.ts render <dir> --short hook-mistake      # 1本だけ
node src/cli.ts render <dir> --shorts                  # 承認済みな全ショート(未承認はスキップしログ表示)
```

- **承認はショート単位の別レコード**(本編 `cutplan.json` の承認とは別。
  縦・字幕再配置後の別の絵なので、本編の承認では代用しない)
- キャッシュの考え方は本編と同じ(full-skip: 編集内容・素材・profile が
  前回と同じなら Remotion 実行ごとスキップ)だが、**チャンク差分レンダーは
  ショートには使わない**(短尺なので恩恵が小さい)。生成される中間ファイルは
  `cut.<name>.mp4` / `cut.<name>.keeps.json` / `render.<name>.props.json` /
  `render.<name>.key.json`(いずれも触らない)

**v1 の制限**: 本編 `overlays.json` の素材/インサート/ワイプ全画面/字幕非表示と
`bgm.json` は**継承しない**(rect が横向き前提で縦に翻訳できない・inserts は
尺を変えるため)。ショートに演出や BGM を足したい場合は今後の対応を待つ。

## サムネイル生成(thumbnail.json)

収録フォルダに `thumbnail.json` を書くと、`thumbnail` コマンドで
サムネイル静止画(`thumbnail.png`)を書き出せる。

```jsonc
{
  "t": 754.2,
  "texts": [
    { "text": "配線1本で\n直った", "pos": { "x": 640, "y": 400 },
      "style": { "fontSizePx": 160, "color": "#ffff00", "outlineColor": "#000000" } }
  ]
}
```

- `t` は元収録の秒。**frames と違いスナップしない**: カットされた瞬間
  (`cutplan.json` で cut にした区間)も指定できる(サムネは動画に入って
  いない絵を使ってもよい)
- `texts[]` は表示するテキスト要素の配列(複数指定で見出し+補足など重ねられる)。
  `pos`(`{x, y}`: 出力px のテキスト中心)は必須(サムネに「既定の下部中央」は
  無い)。`style` は transcript のテロップと同じ `CaptionStyle`
  (`fontSizePx` / `color` / `outlineColor` / `outlineWidthPx` / `fontFamily` /
  `fontWeight` / `background` / `anim` / `karaoke`)を共有する(動画と見た目の言語を揃える
  ため)。`anim` / `karaoke` は静止画には意味を持たない(サムネ生成は無視する。
  構文検査は通るが害はないので書いても構わない)
- 合成は最終レンダーと同じ見た目機構を通す: keep は全編(カットの有無を
  問わずどの瞬間も使える)、テロップは `texts` のみ(`transcript.json` は
  使わない)、`overlays.json` の `wipeFull` / `zooms` / `colorFilter` は
  本編と同じに乗る(素材オーバーレイ・インサート・字幕非表示・レイヤー順は
  対象外)
- ベースは `frames` のプロキシ経路と違い**元収録のフル解像度**を使う
  (静止画1枚の可読性が命なので proxy 品質では出さない)
- `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格)。キャッシュは
  作らない(1枚の still は数秒で済むため)

```sh
node src/cli.ts validate <dir>     # t・texts・pos・style を検査
node src/cli.ts thumbnail <dir>    # thumbnail.png を書き出す
```

**v1 の制限**: エディタ(GUI)対応はしていない。`thumbnail.json` を直接編集
→ `validate` → `thumbnail` 再実行 → Read で確認、の AI/CLI ループで完結させる。

## 音量

- **最終出力は自動で -14 LUFS(YouTube 基準)に正規化される**ので、
  収録音量の多少のばらつきは気にしなくてよい(config.yaml `render.targetLufs`)
- **システム音声(OBS トラック2)は収録にあれば自動でマイクとミックス**されて
  出力に入る(render / preview / proxy 共通)。バランスは config.yaml
  `render.systemAudio.volumeDb`、`mix: false` でマイクのみ(従来どおり)に戻せる。
  正規化はミックス後の全体にかかる
- ただし**収録時のゲインが低すぎるのは別問題**: detect の無音判定
  (-35dB 以下=無音)に発言が引っかかってカットされる危険がある。
  OBS のメーターで、普通に喋って黄色ゾーン(-20〜-10dB)を目安に
- **マイクの環境ノイズが気になる場合**は config.yaml `render.denoise.mic: true`
  でノイズ除去(ffmpeg afftdn)がかかる(既定 false)。**マイク音声にのみ**
  かかり、システム音声(アプリ音・デモ音)は対象外(デジタル由来でノイズが
  無く、通すと音楽・効果音が劣化するため)。強さは `noiseFloorDb`(既定 -25。
  下げるほど控えめ、上げるほど強い)で調整。正規化(loudnorm)より前段に
  入るため、ノイズ除去後の音声に対して -14 LUFS へ揃う

## BGM

いちばん簡単なのは収録フォルダに `bgm.mp3`(または bgm.m4a / bgm.wav)を
置いて render するだけ。全編に自動ループで流れ、終端でフェードアウトする。

**区間ごとに BGM を出し分けたい**(イントロだけ無音、途中で別の曲に切り替え、
2曲を重ねる…)ときは収録フォルダに `bgm.json` を書く。`bgm.json` があると
上の `bgm.*` 全編1曲は無効になり、`tracks[]` の区間だけが流れる。

```jsonc
{
  "tracks": [
    // イントロ(元 0〜42.5 秒)は覆わない → 無音
    { "start": 42.5, "end": 600, "file": "bgm.mp3", "fadeInSec": 1 },
    // エンディングだけ別の曲(materials/ に置く)。終端でフェードアウト
    { "start": 600, "end": 640, "file": "materials/outro.mp3", "volumeDb": -18, "fadeOutSec": 3 }
  ]
}
```

- `start` / `end` は他の編集ファイルと同じく**元収録の秒**。ツールがカット後の
  時刻へ写像する(カットをまたぐ区間は自動でひと続きに繋がる)
- `file` は収録フォルダからの相対パス。**素材と同じように** `materials/` に
  別の BGM を置いて参照すればよい(アップロードはエディタの素材パネルからでも
  OK)。区間を並べれば曲の切り替え、区間を重ねれば重奏になる
- `volumeDb`(省略時は config の `render.bgm.volumeDb`)/ `startFrom`(頭出し)/
  `fadeInSec` / `fadeOutSec` を区間ごとに指定できる
- 音量は config.yaml `render.bgm.volumeDb`(デフォルト -22dB)。
  「BGMがうるさい動画」になるのを避けるため、声より20dB前後小さくが目安
- **発話中は自動でダッキング**(さらに `render.bgm.ducking.duckDb` 下げる。
  デフォルト -8dB、`fadeSec` 秒で滑らかに下げ・戻し)。どの区間の BGM にも
  効く。発話区間は無音検出(cuts.auto.json)から決定的に求めるので LLM は
  使わない。`duckDb: 0` で無効。エディタのプレビューでも同じ聞こえ方になる
- `bgm.json` を編集したら `validate` で検査する(区間・ファイル存在を確認)

## BGM 配置候補の自動生成(plan-bgm)

`plan-bgm <dir>` は、編集済みタイムラインのどこにどの曲を敷くか
(または無音のままにするか)、LLM に**番号選択**だけさせて `bgm.json` の
下書きを作るコマンド(§docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md)。
cut(`cutplan.json`)・承認(`approvals.json`)には一切触れない独立軸。

- **切替アンカー(B3・決定論)**: BGM を切り替える/区切る境界を機械的に
  列挙する。ソースは①**章境界**(`chapters.json` の各 `start`。あれば)と
  ②**大きなカット境界**(`cutplan.json` の cut 区間のうち尺が
  `config.yaml` の `planBgm.bigCutSec`(既定3.0秒)以上の所)。先頭(0)と
  末尾(総尺)も端アンカーに含める。`planBgm.minSlotSec`(既定8.0秒)未満の
  間隔で近接するアンカーは1つへマージする(章タイトルなど情報量の多い方を
  優先して残す)
- **区間スロット(B1)**: 隣り合うアンカーで挟まれた区間をスロットとして
  番号で列挙する。`minSlotSec` 未満のスロットは前後のスロットへ吸収され、
  `planBgm.maxSlots`(既定12)を超えるぶんは打ち切る(区切りすぎ防止。
  末尾の未カバー区間は BGM を敷かない=無音のままになる。これは正当な
  出力)。各スロットには章タイトル等の意味づけと、カット控除後にその
  区間で実際に再生される秒数(可視秒)を添えて LLM に渡す
- **曲候補**: `materials/` の音声ファイル(拡張子 `.mp3`/`.m4a`/`.wav`/
  `.aac`/`.flac`/`.ogg`)∪ 収録フォルダ直下の `bgm.mp3`/`bgm.m4a`/`bgm.wav`
  の実在集合に番号を振る。0件のときは「BGM 候補ファイルが無い」と告げて
  exit 1(例外にはしない)
- **番号選択のみ**: LLM に渡すのはスロット一覧(`#id [開始-終了] 可視Ns
  意味づけ`)と曲一覧(`#id ファイル名`)の2リストだけ。LLM の応答は
  `{ "assignments": [{ "slotId": N, "file": M または null, "reason": "..." }] }`
  のみで、時刻・ファイルパス・音量は一切書かせない。番号 → 実体の変換、
  存在しない番号の無視、**隣接スロットが同じ曲番号なら1トラックへ連結**
  (無駄な切れ目を作らない)、`file: null`(無音)のスロットは track を
  作らない、はすべてコード側が行う
- **音量/duck は触らない**: `volumeDb` 等は書かず config 既定
  (`render.bgm.volumeDb`)に任せる。無音・被り回避(B2)や fallback 検出
  (B4)は別コマンドの対象(本コマンドのスコープ外)
- **書き込み前検査(all-or-nothing)**: 組んだ `bgm.json` 下書きを、書く前に
  `validate` と同じ検査(区間・ファイル実在等)へ通す。1つでも不正なら
  1バイトも書かない
- **既存 `bgm.json` は `--force` 必須**(実行前に `backups/` へ退避)
- **承認不要・下書き扱い**: bgm の編集は承認 hash を失効させない
  (§承認(approve/unapprove))ため、生成しても既存の cutplan/short の承認は
  生きたまま。ただし人間が preview / エディタで聴いて、要らなければ消す前提
- **chapters.json が無くても動く**: 章境界アンカーが作れないだけで、
  大カット境界だけで区間割りする(区間の意味づけは薄くなる旨を告知)
- **測定の注意**: LLM 出力(選曲)は非決定的なので、単発 diff で選曲の質
  (区間と曲の雰囲気の一致度)は採点できない。決定論部分(アンカー生成・
  スロット化・連結・番号安全網)はテストで固定し、選曲の当否は人間が
  preview で聴いて判断する

```sh
node src/cli.ts plan-bgm <dir>          # bgm.json へ配置下書きを生成
node src/cli.ts validate <dir>          # 区間・ファイル実在を確認
node src/cli.ts av <dir>                # sound レポートで BGM spans の反映を確認
```

## 演出(overlays.json)

収録フォルダに `overlays.json` を手で書くと、render 時に演出が合成される。
無ければ何も起きない(plan は生成しないので上書きの心配もない)。
時刻は他のファイルと同じく**元動画の秒**で書く。

```json
{
  "overlays": [
    { "start": 12.0, "end": 18.5, "file": "materials/bench-table.png" },
    { "start": 30.0, "end": 36.0, "file": "materials/demo.mp4", "layer": "over", "fit": "cover" },
    { "start": 60.0, "end": 66.0, "file": "materials/pip.mp4",
      "rect": { "x": 1200, "y": 60, "w": 640, "h": 360 },
      "startFrom": 3.0, "volume": 0.5, "opacity": 0.9,
      "fadeInSec": 0.5, "fadeOutSec": 0.5 }
  ],
  "inserts": [
    { "at": 40.0, "file": "materials/broll.mp4", "durationSec": 4.0, "startFrom": 5.0,
      "volume": 0.8, "fadeInSec": 0.3, "fadeOutSec": 0.3 }
  ],
  "wipeFull":    [ { "start": 50.0, "end": 55.0 } ],
  "zooms": [
    { "start": 70.0, "end": 85.0,
      "rect": { "x": 480, "y": 270, "w": 960, "h": 540 },
      "easeSec": 0.4 }
  ],
  "blurs": [
    { "start": 90.0, "end": 96.0,
      "rect": { "x": 1200, "y": 300, "w": 500, "h": 120 },
      "type": "blur", "strength": 0.6 }
  ],
  "annotations": [
    { "type": "arrow", "start": 100.0, "end": 104.0,
      "from": { "x": 300, "y": 200 }, "to": { "x": 600, "y": 350 } },
    { "type": "box", "start": 100.0, "end": 104.0,
      "rect": { "x": 1200, "y": 300, "w": 400, "h": 120 } },
    { "type": "spotlight", "start": 108.0, "end": 114.0,
      "rect": { "x": 400, "y": 200, "w": 700, "h": 500 }, "shape": "ellipse" }
  ],
  "hideCaption": [ { "start": 50.0, "end": 55.0 } ],
  "colorFilter": { "brightness": 1.05, "contrast": 1.1 }
}
```

- **overlays**: 素材(画像/動画)を表示する。素材ファイルは収録
  フォルダ内に置く(相対パス)。`layer` 省略時は `under`
  - `under`: 背景(画面キャプチャ)だけ覆う。ワイプ・字幕は見える
  - `over`: ワイプごと覆う。字幕だけ素材の上に出る
  - `fit`: `contain`(全体を見せる・全画面時の余白は黒/省略時)か
    `cover`(領域を埋める・端が切れる)
  - `rect`: 表示領域 `{x, y, w, h}`(出力px)。省略時は全画面。指定すると
    ピクチャ・イン・ピクチャ的な部分配置になる(`contain` の余白は透過)。
    エディタではプレビュー上で枠をドラッグして移動・端のハンドルでリサイズできる
    (その素材が再生ヘッド上にあるとき)
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・動画のみ)
  - `volume`: 音量(0〜2、1=素材のまま)。**省略時 0=無音**(動画のみ。
    マイク音声・BGM はそのまま重なる)
  - `opacity`: 不透明度(0〜1。省略時 1)
  - `fadeInSec` / `fadeOutSec`: 表示区間の頭/末尾のフェード(秒。音量も連動)
- **inserts**: ベース映像を割って素材を差し込む(Premiere のインサート編集相当)。
  `at`(元収録の秒)の手前に `file` を `durationSec` ぶん挿入し、後続の映像・
  テロップ・章・素材は尺のぶん後ろへずれる。overlays と違い**音声込み**で全面に出る
  - `startFrom`: 頭出し(In点)。素材ファイル内の再生開始秒(省略時 0=頭から・
    動画のみ有効)。エディタでは挿入クリップの左端ドラッグでも調整できる
  - `fit`: `contain`(省略時)か `cover`
  - `volume`: 音量(0〜2。**省略時 1=素材のまま**、0 で無音)
  - `fadeInSec` / `fadeOutSec`: 黒からの明転/黒への暗転(秒。音量も連動)
- **wipeFull**: ワイプ(カメラ)を全画面にして背景を隠す区間。出入りは
  config.yaml の `render.wipeTransitionSec`(既定 0.3 秒、0 で瞬時。エディタの
  設定画面 ⌘, からも変更可)でなめらかに遷移する。遷移は区間全体の頭と末尾に
  だけ入り、カット・挿入・隣接エントリで区間が繋がっている継ぎ目では走らない
  - 通常動画(`manifest.layout: "plain"`。カメラの無い収録)では**使えない**
    (ワイプの crop 元が無いため。`validate` がエラーにする)。`layerOrder` に
    `wipe` を含めても無視されるだけ(警告)
- **zooms**: 画面の一部を拡大して見せる(Ken Burns 的な寄り)。「画面のこの
  部分に注目」を作る演出で、区間どうしは重ならないこと(validate がエラーにする)
  - `rect`: 拡大する矩形 `{x, y, w, h}`(出力px。テロップ `pos` や overlays の
    `rect` と同じ座標系)。この矩形を全画面へ一様拡大する(歪ませない)。
    拡大率は書かせない: `scale = 出力幅 / rect.w` が rect から一意に決まる
    (倍率と rect の二重指定は矛盾の温床になるため)
  - `easeSec`: 区間の頭でズームイン・末尾でズームアウトする遷移秒数。省略時
    config.yaml の `render.zoom.easeSec`(既定 0.4)。区間が遷移2回分より
    短いときは遷移を区間の半分へ縮める(`wipeFull` と同じ規則)
  - かかるのは**ベース映像の背景レイヤー(画面クロップ)だけ**。ワイプ・
    テロップ・素材オーバーレイ・挿入クリップの位置・可読性は変わらない
  - エディタでは専用の「ズーム」トラックにドラッグで区間を作り、プレビュー上の
    枠をドラッグ・リサイズして `rect` を調整する(素材の部分配置と同じ操作感)
  - ショート(`shorts.json` の縦動画)には効かない(overlays.json を継承しない
    既存設計により自動的に除外される)
- **blurs**: 画面の一部にぼかしを掛けて隠す(開発画面の API キー・
  PII・パスワード等の秘匿情報向け)
  - `rect`: 隠す矩形 `{x, y, w, h}`(出力px。テロップ `pos` や `zooms` の
    `rect` と同じ座標系)。画面外へはみ出すと `validate` がエラーにする
  - `strength`: 強度(0〜1。省略時 0.5)。ぼかし半径(出力px)へ変換される。
    **0 は効果なし**(その区間は何も描画されない。0 超は最低限の強さの床から
    始まる)
  - かかるのは**下層(ベース映像+挿入クリップ)だけ**。テロップ・素材
    オーバーレイはぼかしの上に描画される(隠れない)
  - 遷移(フェード)は無い硬い ON/OFF。秘匿はなめらかに現れてはいけないため
  - `rect` は `zooms` に追従しない(出力px固定)。描画は矩形内に実際に
    描かれている映像(zoom 後の見た目)をその場でぼかす(backdrop-filter)。
    zoom 区間と時間が重なると `validate` が警告する(隠したい情報が矩形から
    ずれて露出しうるため。重ねないか rect を広げて対処する)
  - ショート(`shorts.json` の縦動画)には**継承されない**(本編の座標系
    (1920x1080 基準)がショートの座標系と一致しないため。座標がずれた矩形を
    黙って継承する方が継承しないより危険という判断。shorts.json があると
    `validate` が警告する。ショートに秘匿情報が写る場合は別途対処が必要)
- **annotations**: 矢印(`arrow`)・囲み(`box`)・スポットライト(`spotlight`)の
  描画プリミティブで、画面上の一点/矩形を指し示す「ここを見ろ」を作る
  (dev screencast で使う場面を想定)。`type` で種別を判別する
  - 共通: `start` / `end`(元収録の秒)。**登場/退場アニメは無い**(硬い
    ON/OFF。テロップの `anim` のような遷移は v1 では持たせない)
  - `arrow`: `from` → `to`(どちらも出力px の `{x, y}`)へ線を引き矢尻を付ける。
    `color`(既定 `#ff3b30`)・`widthPx`(既定 8)・`headPx`(既定 28)は省略可。
    `from` と `to` が同一点は退化した矢印として `validate` がエラーにする
  - `box`: `rect`(出力px)を枠線で囲む。`color`(既定 `#ff3b30`)・`widthPx`
    (既定 6)・`radiusPx`(既定 8。角丸)・`fill`(塗り色。省略時は塗りなし・
    枠線だけ)は省略可
  - `spotlight`: `rect` の外側を暗くして注目を集める。`shape`(`"rect"`
    省略時既定 / `"ellipse"`)・`dim`(外側の暗さ0〜1。既定 0.6)・
    `featherPx`(縁のぼかし幅。既定 24)・`radiusPx`(`shape:"rect"` の角丸。
    省略時0)は省略可
  - 描画レイヤーは**独立・最前面**(テロップより上。`layerOrder` には載らない)。
    最前面なので、`spotlight` の暗幕が重なった部分のテロップも一緒に
    暗くなる(意図した挙動。テロップの下に置くと矢印がテロップを指せなく
    なるトレードオフを避けた)
  - `zooms` には**追従しない**(出力px固定)。`blurs` と違い、zoom 区間と
    時間が重なっても `validate` は警告しない(「寄って指す」がむしろ想定用途
    のため)
  - `rect` / 矢印の端点が出力解像度の外にはみ出すと `validate` が**警告**
    (blurs と違いエラーにしない。画面端でクリップされるだけで render は
    壊れず、画面外から指す構図もあるため)
  - ショート(`shorts.json` の縦動画)には**継承されない**(`blurs` と同じ
    理由。座標が本編基準のため。shorts.json があると `validate` が警告する)
- **hideCaption**: 字幕(全テロップトラック)を出さない区間
- **colorFilter**: 全編一律の簡易カラー調整(区間指定はできない)。
  `{brightness?, contrast?, saturate?}` の各キーは省略可・既定 1.0(無補正)、
  実装は CSS filter。かかるのは**ベース映像(画面クロップ+カメラ=同一収録
  動画)だけ**で、素材オーバーレイ・挿入クリップには効かない。有効範囲は
  各値とも 0 より大きく 3 以下(`validate` が検査する)
  - **ショート(`shorts.json` の縦動画)にも例外的に効く**(演出ではなく
    「収録の見た目補正」という扱いのため。本編とショートで肌色が変わる
    事故を防ぐ)。他の `overlays.json` の演出(素材・インサート・ワイプ・
    zooms 等)はショートに継承されないのと対照的
  - **サムネイル(`thumbnail.json`)にも同じに効く**(下記「サムネイル生成」
    参照)
  - チャンク差分レンダー(`render.chunkSec`)では全域設定扱い: 変更すると
    フルレンダーになる(wipe 幾何等と同じ側)

注意: カット境界をまたいでも区間は1つに繋がったまま扱われ、動画素材も
連続再生される。ただしカットで消えた分だけ表示時間は短くなるため、
素材を最後まで見せたいときはカットされない区間内に収めるのが無難。
インサート(挿入)で時間が割り込まれる場合だけ区間が複数に割れ、
動画素材は挿入のあとも続きから再生される。

## カット境界のディップ・トゥ・ブラック(config.yaml `render.cutTransition`)

既定(`type: none`)ではカット境界(keep区間の継ぎ目)は瞬時に切り替わる。
`type: dip-to-black` にすると、境界の前後で黒フェードが入る(ジャンプカットの
繋ぎ目を和らげる演出)。`sec` は黒への往復の合計秒(前半でフェードアウト、
後半でフェードイン)。カット段(cut.mp4)自体には触れない Remotion 合成層の
オーバーレイなので、動画の総尺・音声・テロップのタイミングは変わらない。

```yaml
render:
  cutTransition:
    type: dip-to-black
    sec: 0.3
```

境界ごとの個別指定はできない(全境界に一律で効く)。`hardwareAcceleration` /
`chunkSec` と同じく config.yaml のみの設定で、GUI エディタの設定画面には
専用の UI はない(エディタのプレビューは render.props.json を最終レンダーと
共有しているため、config.yaml を変えれば自動でプレビューにも反映される)。

ズーム演出(`overlays.json` の `zooms`)の遷移秒数の既定値も同じ扱いで、
config.yaml の `render.zoom.easeSec`(既定 0.4)のみで変更する
(`zooms[].easeSec` で個別指定があればそちらが優先)。

## ベースレイアウトのデザイン(config.yaml `render.design`。既定オフ)

既定(`enabled: false` / キーを書かない)では、ベース映像は収録レイアウト本来の
見た目のまま(この機能の導入前と同じ)。`enabled: true` にすると、

  背景画像 → 角丸+影の画面パネル → 右下の角丸正方形カメラワイプ → テロップ

の重ね順で合成する。テロップ・素材・注釈はすべてこのデザインの**上**に出る。
通常動画(`plain`)にも背景画像/色と角丸+影の画面パネルを適用するが、カメラ
ワイプは載せない。`render.design.camera` はOBS拡張キャンバスと共通の設定を
置けるようplainでは警告なしに無視する。ショート(縦プリセット)にはdesignを
継承しない。

```yaml
render:
  design:
    enabled: true
    # 省略時は backgroundColor の単色。3通りの書き方を解決する:
    #   assets/backgrounds/teal.jpg … リポジトリ同梱(誰の環境でも動く)
    #   ~/Movies/obs/bg.jpg         … 自分の素材(絶対パス。~ は展開される)
    #   materials/bg.jpg            … その収録フォルダ内のファイル
    backgroundFile: assets/backgrounds/teal.jpg
    backgroundColor: "#1b1b1f"   # 背景画像の下地・画像が無いときの背景
    screen:                       # 画面(screenRegion)パネル
      marginXPx: 100              # 左右の余白(出力px)
      marginBottomPx: 90          # 下の余白。高さは 16:9 維持の成り行き(上余白 22px)
      radiusPx: 24
      shadow: true
    camera:                       # OBSのカメラ(ワイプ)。plainでは無視する
      sizePx: 375                 # 一辺(出力px)
      marginPx: 28                # 右・下からの余白
      radiusPx: 96                # sizePx/2 でクランプ(そこが最大の丸み = 円)
      shadow: true                # 画面パネルの shadow とは独立
```

背景が収録フォルダの外(同梱 `assets/` / 絶対パス)にあるときは、合成前に収録
フォルダの `render.design/` へ自動コピーされてから参照される(Remotion が読めるのは
publicDir = 収録フォルダの中だけのため)。収録ごとの手コピーは要らない。中間生成物
なので `clean` で消えるが、次の実行で自動的に復帰する。背景が見つからないときは
警告だけ出して `backgroundColor` の単色へ劣化し、レンダーは止まらない。

**注意点**:

- **render高速パス(`render.fastPath`)はplainにも対応する。** design無しの
  plainは恒等基底、design有りは背景+画面パネル基底としてFAST区間を合成する。
  必要な静的資産が無い/生成できない、または既存の適格条件を満たさない場合は、
  壊れた高速出力を作らず通常のRemotionレンダーへ保守的に退避する
- OBS拡張キャンバスでは`overlays.json`の`wipeFull`(ワイプ全画面)はデザイン
  有効時も効く。区間に
  入るとカメラが右下の角丸正方形から**出力の全画面**へ広がり(背景画像・画面
  パネルは覆い隠される)、角丸も 0 へ補間されるのでデザイン無しの `wipeFull` と
  同じ絵になる。出入りの遷移時間は同じ `render.wipeTransitionSec`
- plainではカメラ映像が無いため`wipeFull`自体が`validate`エラーになる
- テロップの `pos`・`blurs.rect`・`annotations` の座標系は**変わらない**(従来どおり
  出力px)。デザイン有効時はベース映像がパネルに縮んで置かれるため、`zooms` /
  `blurs` / `frames --ocr` の box は内部でパネル座標へ写して辻褄を合わせている
  (§`src/lib/design.ts`)
- GUI エディタに専用 UI は無い(`cutTransition` と同じく config.yaml のみの設定。
  プレビューは render props を最終レンダーと共有しているので自動で反映される)

## 見た目の調整(Remotion Studio)

ワイプの大きさ・余白・字幕サイズ・テロップ既定の色/縁/フォントは
GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)から変更できる
(実体は config.yaml の `render` セクションなので YAML 手編集でもよい)。
黒帯などデザインそのものを変えたいときは `remotion/Main.tsx` を編集する。

設定画面で保存した変更のうちラウドネス(`targetLufs`)・システム音声・
ノイズ除去(`denoise`)・プレビュー幅は proxy.mp4 に焼き込まれるため、
エディタのプレビューへ反映するにはプロキシの再生成が必要(保存後に
バナーで案内が出る。書き出しには再生成なしで反映される)。

## render の高速化(config.yaml `render.hardwareAcceleration`)

`render` の Remotion 合成段は `if-possible`(既定)で GPU ハードウェア
エンコーダ(macOS は VideoToolbox)を使い、`disable` で従来のソフトウェア
エンコードに戻せる。`if-possible` はハードウェアエンコーダが使えない
環境では自動でソフトウェアエンコードにフォールバックする(エラーには
ならない)。実測は docs/perf.md 参照。

`proxy.mp4` / `preview.mp4` は config.yaml `preview.videoEncoder`(既定
`videotoolbox`)で同じくハードウェアエンコーダを使う。生成時間は
`libx264` とほぼ同じだがファイルサイズが小さい。`libx264` を指定すると
従来の ultrafast+CRF に戻る。

## render 中のマシン負荷(config.yaml `render.offthreadVideoCacheMb` / `render.concurrency`)

render 中に Mac 全体が重くなる主因はメモリで、Remotion の OffthreadVideo
フレームキャッシュは既定で「利用可能メモリの半分」まで成長する(16GB 機では
compositor 単体が数GB)。CutFlow は既定でこれを
`render.offthreadVideoCacheMb: 512`(MB)に制限する。render 速度は変わらず
(実測は docs/perf.md フェーズ7・9)、render 中のスワップ・他アプリの鈍化を
防ぐ。`0` で Remotion 既定(無制限)に戻せる。

`render.concurrency` は Remotion の並列レンダータブ数(省略時は Remotion
既定=CPU コア数の半分)。1タブ ≈ 350〜400MB なので、render 中のメモリを
さらに絞りたいときだけ下げる(速度と引き換え)。

どちらも出力の画・音には影響しないため render キャッシュ
(`render.key.json`)のキーには含まれない=変更しても `final.mp4` の
再生成は誘発されない。本編・チャンク差分・ショートの全 render 経路に
同じ値が効く。

また、テロップ既定フォント(Noto Sans JP)は `remotion.config.ts` で
バンドルへ data URL 焼き込み(asset/inline)している。Remotion 既定の
HTTP 配信(asset/resource)だと、render 中の OffthreadVideo フレーム抽出が
同一ホストへの Chrome の同時接続枠(6本)を占有し、フォント取得が接続待ちの
まま `delayRender` タイムアウト(`Loading Noto Sans JP ... not cleared`)で
render 全体が落ちることがある(実測は docs/perf.md フェーズ9)。

```sh
# レイアウトだけ確認(動画部分はプレースホルダー表示)
npx remotion studio

# 実際の収録データを流し込んで確認(render を1回実行した後に使える)
npx remotion studio --props <収録フォルダ>/render.props.json --public-dir <収録フォルダ>
```

Studio はブラウザで開く動画エディタ風の画面で、Main.tsx を保存すると
即座に反映される。デザインが決まったら通常の `render` を実行する。

## AI提案の比較・高水準編集・ローカル検索

GUIのAI提案では、保存前にbefore/after still、任意の30秒以内のclip、
structure/motion/sound/OCRの決定論的checkを生成できる。画像対応API providerを
使う場合だけ、次を明示設定したうえで比較画面のチェックボックスを有効にすると、
最大4枚を長辺1600px以下へ縮小して外部APIへ送る。既定はoffで、VLMの失敗は
保存や決定論的reviewを失敗させない。

```yaml
editor:
  aiReview:
    vlm: false
    maxImages: 4
```

過去recordingとmaterialは外部APIなしで索引・検索できる。

```sh
node src/cli.ts index
node src/cli.ts search "ログイン画面" --kind material --json
```

MCPでは`cutflow_review`、`cutflow_edit`、`cutflow_search`を利用できる。
`cutflow_edit`は`dryRun`が必須で、書き込み時も既存の`planApply`検査を通る。
検索はread-onlyで、結果に絶対pathを含めず、他recordingの素材をコピーしない。

## 掃除とディスク(clean)

`node src/cli.ts clean <dir>` は収録フォルダに溜まった中間生成物・キャッシュを安全に消す。
削除対象の分類は `src/lib/files.ts` の `fileRole`(単一の真実)由来で、**role が
`generated` のトップレベル子エントリだけ**を消す。`cutplan.json` 等の編集ファイル・
`approvals.json`(承認レコード)・`materials/`(人間の素材)・元収録(raw)・成果物
(`final.mp4` / `thumbnail.png` / `bgm.*`)には1バイトも触れない。非 generated ディレクトリ
(`materials/` / `backups/`)には降りないので、その配下は常に安全。

- 既定: すべての中間生成物(`manifest.json` / `cuts.auto.json` / `proxy.mp4` /
  `cut*.mp4` / `render.chunks/` / `frames/` / `shorts/` / 各 `*.probe/` / `whisper-out.*` /
  `*.suggested.json` 等)を削除。
- `--cache-only`: 再生成の重いキャッシュ(`proxy.mp4` / `cut*.mp4` / `render.chunks/` /
  `frames/` / `shorts/` / `materials.probe/` / `av.probe/` / `review.probe/` /
  `preview.mp4` / `*.key.json` / `render.props.json`)だけを消す。再文字起こしが数分かかる
  `whisper-out.*` や `manifest.json` / `cuts.auto.json` 等の**軽くて再生成が高価**な
  中間生成物は残す。
- `--dry-run`: 何も消さず、削除対象の一覧と解放バイトだけを表示。
- `--json`: `CleanPlan`(targets / fileCount / dirCount / bytes / dryRun)を純 JSON で
  stdout に出す(`--dry-run` と併用で機械可読なプレビュー)。
- 冪等: 2回目以降は対象なしで exit 0。存在しないファイルは無視する。

```sh
node src/cli.ts clean <dir> --dry-run           # 何が消えるか確認するだけ
node src/cli.ts clean <dir> --cache-only        # 重いキャッシュだけ掃除(whisper-out等は残す)
node src/cli.ts clean <dir>                     # 全中間生成物を掃除
node src/cli.ts clean <dir> --dry-run --json    # 機械可読な削除計画(パイプ可)
```
