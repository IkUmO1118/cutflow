# スタイルの一貫性とチャンネル学習

> スタイルプロファイルの抽出・逸脱検出と、チャンネル rules / learn による学習。
> 関連: [cut-planning.md](cut-planning.md) / [ai-agents.md](ai-agents.md) / [../usage.md](../usage.md)

## スタイルプロファイル抽出(style-profile)

`node src/cli.ts style-profile --from <path> [--from <path> ...] [--name <名前>]` は、
任意の動画/収録パスから**スタイルプロファイル**(テンポ・字幕密度/位置・
ラウドネス・構成の観測統計)を抽出し、channel(最初の `--from` の親ディレクトリ)の
`style.probe/<名前>.json`(省略時 `default.json`)へ書くコマンド。他コマンドと違い
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
しているか**を決定論で測り、warn/info(**常に exit 0**)で報告するコマンド。
母艦の言う「J(主観)次元が
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


